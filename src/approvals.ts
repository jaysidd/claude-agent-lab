// Per-task approval gates primitive. Standalone — no Express, no Agent SDK,
// no host-specific imports. Designed to lift into Clawless if and only if the
// per-task vs per-tool analysis lands "portable" (see backlog C16d + the
// `docs/analysis/c16d-per-task-vs-per-tool.md` deliverable).
//
// Shape:
//   - pending_approvals rows live in SQLite and persist across restarts
//   - In-memory `waiters` Map holds the Promise resolvers; populated when a
//     hook calls create() and awaits awaitDecision(); cleared on decide()
//   - decide() updates the row AND resolves the in-memory waiter; if the
//     server restarted between create() and decide() there's no waiter to
//     resolve — the row is updated, the agent run is gone, the user re-runs
//   - expireOrphaned() called at boot marks rows from previous WORKER_IDs
//     as 'expired' so the kanban doesn't show ghosts
//
// See .notes/c16d-approval-gates-design.md for the full design rationale.

import type DatabaseConstructor from "better-sqlite3";
import { randomUUID } from "node:crypto";

type Database = DatabaseConstructor.Database;

// ============================================================================
// Public types
// ============================================================================

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type DecidedBy = "operator" | "auto_expire" | "orphan_sweep" | "sdk_aborted";

export type Approval = {
  id: string;
  taskId: string;
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
  cwd: string | null;
  status: ApprovalStatus;
  decisionReason: string | null;
  decidedBy: DecidedBy | null;
  workerId: string;
  createdAt: number;
  decidedAt: number | null;
};

export type CreateInput = {
  taskId: string;
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
  cwd?: string | null;
  workerId: string;
};

export type Decision = {
  status: "approved" | "rejected" | "expired";
  reason?: string;
};

export type CreateHandle = {
  id: string;
  // Promise that resolves when the operator decides (or rejects on expire).
  // Caller awaits this from inside the SDK hook callback.
  awaitDecision: () => Promise<Decision>;
};

export type ApprovalsOptions = {
  now?: () => number;
};

// ============================================================================
// Constants
// ============================================================================

const TOOL_INPUT_MAX_BYTES = 64 * 1024;

// ============================================================================
// Schema
// ============================================================================

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS pending_approvals (
    id              TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL,
    tool_name       TEXT NOT NULL,
    tool_use_id     TEXT NOT NULL,
    tool_input_json TEXT NOT NULL,
    cwd             TEXT,
    status          TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    decision_reason TEXT,
    decided_by      TEXT,
    worker_id       TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    decided_at      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_approvals_pending
    ON pending_approvals (created_at)
    WHERE status = 'pending';
  CREATE INDEX IF NOT EXISTS idx_approvals_task
    ON pending_approvals (task_id);
`;

// Idempotent. Host calls this during its own migration phase before
// constructing an Approvals instance.
export function migrate(db: Database): void {
  db.exec(SCHEMA_DDL);
}

// ============================================================================
// Approvals
// ============================================================================

export class Approvals {
  private readonly db: Database;
  private readonly now: () => number;
  private readonly waiters: Map<
    string,
    {
      resolve: (decision: Decision) => void;
      reject: (err: Error) => void;
    }
  > = new Map();

  constructor(db: Database, opts: ApprovalsOptions = {}) {
    this.db = db;
    this.now = opts.now ?? (() => Date.now());
  }

  // --------------------------------------------------------------------------
  // Hook-side API
  // --------------------------------------------------------------------------

  /**
   * Create a pending approval row AND register an in-memory waiter that the
   * host's hook callback will await. The two-step shape (`{id, awaitDecision}`)
   * lets the caller register the awaiter and INSERT atomically — there's no
   * window between insert and listener-attach where a fast `decide()` could
   * be lost.
   */
  create(input: CreateInput): CreateHandle {
    if (!input.taskId || typeof input.taskId !== "string") {
      throw new Error("create: taskId required");
    }
    if (!input.toolName || typeof input.toolName !== "string") {
      throw new Error("create: toolName required");
    }
    if (!input.workerId || typeof input.workerId !== "string") {
      throw new Error("create: workerId required");
    }

    const inputJson = JSON.stringify(input.toolInput ?? null);
    if (Buffer.byteLength(inputJson, "utf8") > TOOL_INPUT_MAX_BYTES) {
      throw new Error(
        `tool_input exceeds ${TOOL_INPUT_MAX_BYTES} byte cap (${Buffer.byteLength(inputJson, "utf8")})`,
      );
    }

    const id = randomUUID();
    const now = this.now();

    // Atomic prefix: register the waiter BEFORE the INSERT commits, so a race
    // where decide() runs between INSERT and Map.set() can't lose the resolve.
    // Concretely: a sibling code path can't see the row in the DB until the
    // INSERT statement returns, and `this.waiters.set(id, ...)` is synchronous
    // and happens before `awaitDecision()` is even available to call.
    let resolveDecision!: (d: Decision) => void;
    let rejectDecision!: (err: Error) => void;
    const decisionPromise = new Promise<Decision>((res, rej) => {
      resolveDecision = res;
      rejectDecision = rej;
    });
    this.waiters.set(id, { resolve: resolveDecision, reject: rejectDecision });

    try {
      this.db
        .prepare(
          `INSERT INTO pending_approvals
             (id, task_id, tool_name, tool_use_id, tool_input_json, cwd,
              status, decision_reason, decided_by, worker_id, created_at, decided_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL)`,
        )
        .run(
          id,
          input.taskId,
          input.toolName,
          input.toolUseId,
          inputJson,
          input.cwd ?? null,
          input.workerId,
          now,
        );
    } catch (err) {
      // INSERT failed — drop the orphan waiter so it doesn't leak.
      this.waiters.delete(id);
      throw err;
    }

    return {
      id,
      awaitDecision: () => decisionPromise,
    };
  }

  // --------------------------------------------------------------------------
  // Decide-side API (operator-facing)
  // --------------------------------------------------------------------------

  /**
   * Resolve a pending approval. Returns the updated row, or null if the
   * approval was already decided / expired / never existed. Both DB and
   * in-memory waiter are updated atomically from the caller's POV.
   */
  decide(
    id: string,
    decision: "approved" | "rejected",
    reason: string | null,
    decidedBy: DecidedBy = "operator",
  ): Approval | null {
    const now = this.now();
    const updated = this.db
      .prepare(
        `UPDATE pending_approvals
            SET status = ?,
                decision_reason = ?,
                decided_by = ?,
                decided_at = ?
          WHERE id = ?
            AND status = 'pending'
          RETURNING *`,
      )
      .get(decision, reason, decidedBy, now, id) as ApprovalRow | undefined;

    if (!updated) return null;

    // Wake the awaiter, if there is one. (Server may have restarted between
    // create() and decide() — in that case the waiter is gone, the agent run
    // is dead, and the user re-runs the task. The DB row still flips to its
    // terminal state for kanban accuracy.)
    const w = this.waiters.get(id);
    if (w) {
      this.waiters.delete(id);
      w.resolve({ status: decision, reason: reason ?? undefined });
    }

    return rowToApproval(updated);
  }

  /**
   * Mark a pending approval expired (operator timed out, SDK aborted, etc.).
   * Internal version of decide() that records an expiry without an operator
   * decision. Used by the hook's abort-signal listener and the periodic
   * timeout sweep.
   */
  expire(id: string, reason: DecidedBy = "auto_expire"): Approval | null {
    const now = this.now();
    const updated = this.db
      .prepare(
        `UPDATE pending_approvals
            SET status = 'expired',
                decided_by = ?,
                decided_at = ?
          WHERE id = ?
            AND status = 'pending'
          RETURNING *`,
      )
      .get(reason, now, id) as ApprovalRow | undefined;

    if (!updated) return null;

    const w = this.waiters.get(id);
    if (w) {
      this.waiters.delete(id);
      w.resolve({ status: "expired", reason: `expired: ${reason}` });
    }

    return rowToApproval(updated);
  }

  /**
   * Restart-recovery sweep. Marks any pending row whose worker_id is NOT the
   * current process's worker_id as 'expired' — those rows belong to dead
   * server instances, no in-memory waiter exists for them, and the agent
   * runs they were guarding are gone. Idempotent.
   */
  expireOrphaned(currentWorkerId: string): { swept: number } {
    const now = this.now();
    const r = this.db
      .prepare(
        `UPDATE pending_approvals
            SET status = 'expired',
                decided_by = 'orphan_sweep',
                decided_at = ?
          WHERE status = 'pending'
            AND worker_id != ?`,
      )
      .run(now, currentWorkerId);
    return { swept: r.changes };
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  list(filter?: { status?: ApprovalStatus | ApprovalStatus[]; taskId?: string }): Approval[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter?.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      // Single-status filter uses `status = ?` so SQLite picks the partial
      // index `idx_approvals_pending` (which is defined `WHERE status = 'pending'`).
      // `status IN (?)` does NOT trigger partial-index matching and falls back
      // to a full table scan + temp B-tree sort. C16d perf audit P1.
      if (statuses.length === 1) {
        where.push(`status = ?`);
        params.push(statuses[0]);
      } else {
        where.push(`status IN (${statuses.map(() => "?").join(",")})`);
        params.push(...statuses);
      }
    }
    if (filter?.taskId) {
      where.push("task_id = ?");
      params.push(filter.taskId);
    }

    const sql = `
      SELECT * FROM pending_approvals
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY created_at DESC
    `;

    const rows = this.db.prepare(sql).all(...params) as ApprovalRow[];
    return rows.map(rowToApproval);
  }

  get(id: string): Approval | null {
    const row = this.db
      .prepare("SELECT * FROM pending_approvals WHERE id = ?")
      .get(id) as ApprovalRow | undefined;
    return row ? rowToApproval(row) : null;
  }

  // --------------------------------------------------------------------------
  // Diagnostics
  // --------------------------------------------------------------------------

  /** Live count of in-memory awaiters. Useful for tests + memory-leak watch. */
  awaitingCount(): number {
    return this.waiters.size;
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

type ApprovalRow = {
  id: string;
  task_id: string;
  tool_name: string;
  tool_use_id: string;
  tool_input_json: string;
  cwd: string | null;
  status: ApprovalStatus;
  decision_reason: string | null;
  decided_by: DecidedBy | null;
  worker_id: string;
  created_at: number;
  decided_at: number | null;
};

function rowToApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    taskId: row.task_id,
    toolName: row.tool_name,
    toolUseId: row.tool_use_id,
    toolInput: safeParse(row.tool_input_json),
    cwd: row.cwd,
    status: row.status,
    decisionReason: row.decision_reason,
    decidedBy: row.decided_by,
    workerId: row.worker_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Re-exported for tests.
export const __INTERNALS__ = {
  TOOL_INPUT_MAX_BYTES,
};
