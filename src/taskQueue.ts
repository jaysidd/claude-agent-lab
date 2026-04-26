// Durable task queue with atomic checkout. Standalone primitive — no Express,
// no Agent SDK, no host-specific imports. Designed to be lifted directly into
// Clawless's B54 Phase B. Schema and API locked rev. 2 across both projects.
//
// See .notes/c16b-task-queue-design.md for the full design rationale.

import type DatabaseConstructor from "better-sqlite3";
import { randomUUID } from "node:crypto";

type Database = DatabaseConstructor.Database;

// ============================================================================
// Public types
// ============================================================================

export type TaskStatus =
  | "queued"
  | "checked_out"
  | "done"
  | "failed"
  | "cancelled";

export type TaskFailure = { message: string; details?: unknown };

export type Task = {
  id: string;
  description: string;
  agentId: string;
  priority: number;
  status: TaskStatus;
  workerId: string | null;
  leaseExpiresAt: number | null;
  attemptCount: number;
  maxAttempts: number;
  result: unknown;
  error: TaskFailure | null;
  createdAt: number;
  updatedAt: number;
  scheduledFor: number | null;
  metadata: Record<string, unknown> | null;
};

export type NewTask = {
  description: string;
  agentId: string;
  priority?: number;
  maxAttempts?: number;
  scheduledFor?: number;
  metadata?: Record<string, unknown>;
};

export type TaskFilter = {
  status?: TaskStatus | TaskStatus[];
  agentId?: string;
  limit?: number;
};

export type TaskQueueOptions = {
  defaultLeaseSeconds?: number;
  defaultMaxAttempts?: number;
  now?: () => number;
};

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_LEASE_SECONDS = 300;
const DEFAULT_MAX_ATTEMPTS = 3;
const METADATA_SOFT_CAP_BYTES = 64 * 1024;

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "done",
  "failed",
  "cancelled",
]);

// ============================================================================
// Schema
// ============================================================================

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id                TEXT PRIMARY KEY,
    description       TEXT NOT NULL,
    agent_id          TEXT NOT NULL,
    priority          INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL CHECK (status IN ('queued','checked_out','done','failed','cancelled')),
    worker_id         TEXT,
    lease_expires_at  INTEGER,
    attempt_count     INTEGER NOT NULL DEFAULT 0,
    max_attempts      INTEGER NOT NULL DEFAULT 3,
    result_json       TEXT,
    error_json        TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    scheduled_for     INTEGER,
    metadata_json     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority DESC, created_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_lease          ON tasks(status, lease_expires_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_scheduled      ON tasks(status, scheduled_for);
  CREATE INDEX IF NOT EXISTS idx_tasks_agent_status   ON tasks(agent_id, status);
`;

// Idempotent. Host calls this during its own migration phase before constructing
// a TaskQueue. Designed to coexist with any host-side migrations runner.
export function migrate(db: Database): void {
  db.exec(SCHEMA_DDL);
}

// ============================================================================
// TaskQueue
// ============================================================================

export class TaskQueue {
  private readonly db: Database;
  private readonly defaultLeaseSeconds: number;
  private readonly defaultMaxAttempts: number;
  private readonly now: () => number;

  constructor(db: Database, opts: TaskQueueOptions = {}) {
    this.db = db;
    this.defaultLeaseSeconds = opts.defaultLeaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.defaultMaxAttempts = opts.defaultMaxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.now = opts.now ?? (() => Date.now());
  }

  enqueue(input: NewTask): Task {
    const id = randomUUID();
    const now = this.now();
    const metaJson = serializeMetadata(input.metadata);

    this.db
      .prepare(
        `INSERT INTO tasks (id, description, agent_id, priority, status, attempt_count,
                            max_attempts, created_at, updated_at, scheduled_for, metadata_json)
         VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.description,
        input.agentId,
        input.priority ?? 0,
        input.maxAttempts ?? this.defaultMaxAttempts,
        now,
        now,
        input.scheduledFor ?? null,
        metaJson,
      );

    const task = this.get(id);
    if (!task) {
      throw new Error(`enqueue: task ${id} disappeared after insert`);
    }
    return task;
  }

  // Atomic. Picks the highest-priority queued task whose scheduled_for has
  // passed (or is null), marks it checked_out, leases it to workerId. Returns
  // null when nothing is takeable. Two concurrent callers cannot win the same
  // row — BEGIN IMMEDIATE serializes writers.
  checkout(workerId: string, opts?: { leaseSeconds?: number }): Task | null {
    const leaseMs = (opts?.leaseSeconds ?? this.defaultLeaseSeconds) * 1000;
    const now = this.now();

    const txn = this.db.transaction((): TaskRow | undefined => {
      const winner = this.db
        .prepare(
          `SELECT id FROM tasks
            WHERE status = 'queued'
              AND (scheduled_for IS NULL OR scheduled_for <= ?)
            ORDER BY priority DESC, created_at ASC
            LIMIT 1`,
        )
        .get(now) as { id: string } | undefined;

      if (!winner) return undefined;

      return this.db
        .prepare(
          `UPDATE tasks
              SET status            = 'checked_out',
                  worker_id         = ?,
                  lease_expires_at  = ?,
                  attempt_count     = attempt_count + 1,
                  updated_at        = ?
            WHERE id = ?
            RETURNING *`,
        )
        .get(workerId, now + leaseMs, now, winner.id) as TaskRow;
    });

    const row = txn.immediate();
    return row ? rowToTask(row) : null;
  }

  // Like checkout, but targets a specific task by id. Returns null if the
  // task isn't queued (already running, terminal, or doesn't exist) or if
  // its scheduled_for is still in the future. Used by manual "run this now"
  // UIs where a worker picks a specific task rather than draining FIFO.
  checkoutById(
    taskId: string,
    workerId: string,
    opts?: { leaseSeconds?: number },
  ): Task | null {
    const leaseMs = (opts?.leaseSeconds ?? this.defaultLeaseSeconds) * 1000;
    const now = this.now();

    const txn = this.db.transaction((): TaskRow | undefined => {
      const row = this.db
        .prepare(
          `UPDATE tasks
              SET status            = 'checked_out',
                  worker_id         = ?,
                  lease_expires_at  = ?,
                  attempt_count     = attempt_count + 1,
                  updated_at        = ?
            WHERE id = ?
              AND status = 'queued'
              AND (scheduled_for IS NULL OR scheduled_for <= ?)
            RETURNING *`,
        )
        .get(workerId, now + leaseMs, now, taskId, now) as TaskRow | undefined;
      return row;
    });

    const row = txn.immediate();
    return row ? rowToTask(row) : null;
  }

  // Renews lease_expires_at. Returns false if the worker no longer holds the
  // task (reaped, completed, cancelled, or never owned it). Worker should
  // stop on false.
  heartbeat(
    taskId: string,
    workerId: string,
    opts?: { leaseSeconds?: number },
  ): boolean {
    const leaseMs = (opts?.leaseSeconds ?? this.defaultLeaseSeconds) * 1000;
    const now = this.now();
    const result = this.db
      .prepare(
        `UPDATE tasks
            SET lease_expires_at = ?,
                updated_at       = ?
          WHERE id = ?
            AND worker_id = ?
            AND status = 'checked_out'`,
      )
      .run(now + leaseMs, now, taskId, workerId);
    return result.changes === 1;
  }

  // Marks done. Throws if the worker no longer holds the task — that almost
  // always means the lease expired and a reaper requeued; the caller should
  // log and let the requeued attempt run.
  complete(taskId: string, workerId: string, result: unknown): void {
    const now = this.now();
    const resultJson = JSON.stringify(result ?? null);
    const r = this.db
      .prepare(
        `UPDATE tasks
            SET status           = 'done',
                worker_id        = NULL,
                lease_expires_at = NULL,
                result_json      = ?,
                updated_at       = ?
          WHERE id = ?
            AND worker_id = ?
            AND status = 'checked_out'`,
      )
      .run(resultJson, now, taskId, workerId);
    if (r.changes !== 1) {
      throw new Error(
        `complete: task ${taskId} not held by worker ${workerId}`,
      );
    }
  }

  // Marks failed (or requeues if attempt_count < max_attempts). Throws if the
  // worker no longer holds the task.
  fail(taskId: string, workerId: string, error: TaskFailure): void {
    const now = this.now();
    const errorJson = JSON.stringify(error);

    const txn = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT attempt_count, max_attempts FROM tasks
            WHERE id = ? AND worker_id = ? AND status = 'checked_out'`,
        )
        .get(taskId, workerId) as
        | { attempt_count: number; max_attempts: number }
        | undefined;

      if (!row) {
        throw new Error(
          `fail: task ${taskId} not held by worker ${workerId}`,
        );
      }

      const requeue = row.attempt_count < row.max_attempts;
      this.db
        .prepare(
          `UPDATE tasks
              SET status           = ?,
                  worker_id        = NULL,
                  lease_expires_at = NULL,
                  error_json       = ?,
                  updated_at       = ?
            WHERE id = ?`,
        )
        .run(requeue ? "queued" : "failed", errorJson, now, taskId);
    });

    txn.immediate();
  }

  // Worker-initiated. requeue=true (default): graceful shutdown, task goes
  // back to queued. requeue=false: cancelled. Throws if the worker no longer
  // holds the task.
  release(
    taskId: string,
    workerId: string,
    opts?: { requeue?: boolean },
  ): void {
    const now = this.now();
    const requeue = opts?.requeue ?? true;
    const r = this.db
      .prepare(
        `UPDATE tasks
            SET status           = ?,
                worker_id        = NULL,
                lease_expires_at = NULL,
                updated_at       = ?
          WHERE id = ?
            AND worker_id = ?
            AND status = 'checked_out'`,
      )
      .run(requeue ? "queued" : "cancelled", now, taskId, workerId);
    if (r.changes !== 1) {
      throw new Error(
        `release: task ${taskId} not held by worker ${workerId}`,
      );
    }
  }

  // Operator override. Idempotent against terminal states (done/failed/
  // cancelled stay where they are). A worker holding the task will discover
  // it on its next heartbeat (returns false) and should stop.
  cancel(taskId: string, reason?: string): void {
    const now = this.now();
    const errorJson = reason ? JSON.stringify({ message: reason }) : null;
    this.db
      .prepare(
        `UPDATE tasks
            SET status           = 'cancelled',
                worker_id        = NULL,
                lease_expires_at = NULL,
                error_json       = COALESCE(?, error_json),
                updated_at       = ?
          WHERE id = ?
            AND status NOT IN ('done', 'failed', 'cancelled')`,
      )
      .run(errorJson, now, taskId);
  }

  // Walks every checked_out row whose lease has expired. Requeues if
  // attempt_count < max_attempts, fails otherwise. Idempotent — safe to call
  // frequently. Cost is bounded by the number of expired leases.
  reapExpired(): { requeued: number; failed: number } {
    const now = this.now();
    const txn = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id, attempt_count, max_attempts FROM tasks
            WHERE status = 'checked_out'
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at < ?`,
        )
        .all(now) as Array<{
        id: string;
        attempt_count: number;
        max_attempts: number;
      }>;

      let requeued = 0;
      let failed = 0;

      const requeueStmt = this.db.prepare(
        `UPDATE tasks
            SET status           = 'queued',
                worker_id        = NULL,
                lease_expires_at = NULL,
                updated_at       = ?
          WHERE id = ?`,
      );

      const failStmt = this.db.prepare(
        `UPDATE tasks
            SET status           = 'failed',
                worker_id        = NULL,
                lease_expires_at = NULL,
                error_json       = ?,
                updated_at       = ?
          WHERE id = ?`,
      );

      const expiredErr = JSON.stringify({
        message: "lease expired, max attempts reached",
      });

      for (const r of rows) {
        if (r.attempt_count >= r.max_attempts) {
          failStmt.run(expiredErr, now, r.id);
          failed++;
        } else {
          requeueStmt.run(now, r.id);
          requeued++;
        }
      }

      return { requeued, failed };
    });

    return txn.immediate();
  }

  list(filter?: TaskFilter): Task[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter?.status) {
      const statuses = Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
      where.push(`status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    if (filter?.agentId) {
      where.push("agent_id = ?");
      params.push(filter.agentId);
    }

    const limitClause =
      filter?.limit && Number.isFinite(filter.limit) && filter.limit > 0
        ? `LIMIT ${Math.floor(filter.limit)}`
        : "";

    const sql = `
      SELECT * FROM tasks
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY priority DESC, created_at ASC
      ${limitClause}
    `;

    const rows = this.db.prepare(sql).all(...params) as TaskRow[];
    return rows.map(rowToTask);
  }

  get(taskId: string): Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(taskId) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

type TaskRow = {
  id: string;
  description: string;
  agent_id: string;
  priority: number;
  status: TaskStatus;
  worker_id: string | null;
  lease_expires_at: number | null;
  attempt_count: number;
  max_attempts: number;
  result_json: string | null;
  error_json: string | null;
  created_at: number;
  updated_at: number;
  scheduled_for: number | null;
  metadata_json: string | null;
};

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    description: row.description,
    agentId: row.agent_id,
    priority: row.priority,
    status: row.status,
    workerId: row.worker_id,
    leaseExpiresAt: row.lease_expires_at,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    result: row.result_json !== null ? safeParse(row.result_json) : null,
    error:
      row.error_json !== null
        ? (safeParse(row.error_json) as TaskFailure | null)
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    scheduledFor: row.scheduled_for,
    metadata:
      row.metadata_json !== null
        ? (safeParse(row.metadata_json) as Record<string, unknown> | null)
        : null,
  };
}

function serializeMetadata(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null;
  const json = JSON.stringify(meta);
  if (Buffer.byteLength(json, "utf8") > METADATA_SOFT_CAP_BYTES) {
    throw new Error(
      `metadata exceeds 64 KB soft cap (${Buffer.byteLength(json, "utf8")} bytes)`,
    );
  }
  return json;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Re-exported for tests that want to assert against the constant directly.
export const __INTERNALS__ = {
  DEFAULT_LEASE_SECONDS,
  DEFAULT_MAX_ATTEMPTS,
  METADATA_SOFT_CAP_BYTES,
  TERMINAL_STATUSES,
};
