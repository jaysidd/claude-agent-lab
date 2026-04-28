// Cron-style scheduler primitive. Standalone — no Express, no Agent SDK,
// no host-specific imports. Designed to lift cleanly into Clawless's stack
// alongside taskQueue.ts and costGuard.ts.
//
// Shape:
//   - Schedule rows live in SQLite (`schedules` table)
//   - A single tick (default 30s) fires due schedules: enqueues a task into
//     the host's task queue and invokes an injected `onFire` callback that
//     runs the actual SDK call. The scheduler doesn't know what an SDK is.
//   - next_fire_at is advanced BEFORE the async fire begins (in the same
//     transaction as the enqueue), so a slow fire can't double-trigger.
//   - OAuth-dead detection is the host's job; the scheduler just exposes
//     pause(scheduleId, reason) for the host to call when it sees an auth
//     error from the SDK.
//   - 3-strike auto-pause for non-OAuth recurring failures is built in.
//
// See .notes/c16a-scheduler-design.md for the full design rationale.

import type DatabaseConstructor from "better-sqlite3";
import { randomUUID } from "node:crypto";

type Database = DatabaseConstructor.Database;

// ============================================================================
// Public types
// ============================================================================

export type ScheduleStatus = "enabled" | "paused";

export type PausedReason = "manual" | "oauth_unavailable" | "too_many_failures";

export type LastStatus = "success" | "error" | "budget_exhausted";

export type Schedule = {
  id: string;
  agentId: string;
  prompt: string;
  cron: string;
  cwd: string | null;
  enabled: boolean;
  pausedReason: PausedReason | null;
  nextFireAt: number;
  lastFiredAt: number | null;
  lastTaskId: string | null;
  lastStatus: LastStatus | null;
  consecutiveFailures: number;
  createdAt: number;
  updatedAt: number;
};

export type NewSchedule = {
  agentId: string;
  prompt: string;
  cron: string;
  cwd?: string | null;
  enabled?: boolean;
};

export type ScheduleUpdate = Partial<{
  agentId: string;
  prompt: string;
  cron: string;
  cwd: string | null;
  enabled: boolean;
}>;

export type FireOutcome =
  | { kind: "success" }
  | { kind: "error"; message: string }
  | { kind: "oauth_dead"; message: string }
  | { kind: "budget_exhausted"; reason: string };

export type FireContext = {
  taskId: string;
  scheduleId: string;
  agentId: string;
  prompt: string;
  cwd: string;
};

export type OnFire = (ctx: FireContext) => Promise<FireOutcome>;

export type EnqueueAdapter = (input: {
  description: string;
  agentId: string;
  metadata: Record<string, unknown>;
}) => string; // returns the task id

// CronEvaluator is injected so the primitive doesn't pin a parser dependency.
// Returns the next epoch-ms after `from` (exclusive). Throws on invalid cron.
export type CronEvaluator = (cron: string, from: number) => number;

export type SchedulerOptions = {
  defaultMaxConsecutiveFailures?: number;
  now?: () => number;
};

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_TICK_INTERVAL_MS = 30_000;
const PROMPT_MAX_LEN = 8_000;
const CRON_MAX_LEN = 100;

// ============================================================================
// Schema
// ============================================================================

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS schedules (
    id                   TEXT PRIMARY KEY,
    agent_id             TEXT    NOT NULL,
    prompt               TEXT    NOT NULL,
    cron                 TEXT    NOT NULL,
    cwd                  TEXT,
    enabled              INTEGER NOT NULL DEFAULT 1,
    paused_reason        TEXT,
    next_fire_at         INTEGER NOT NULL,
    last_fired_at        INTEGER,
    last_task_id         TEXT,
    last_status          TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_schedules_due
    ON schedules (next_fire_at)
    WHERE enabled = 1;
`;

// Idempotent. Host calls this during its own migration phase.
export function migrate(db: Database): void {
  db.exec(SCHEMA_DDL);
}

// ============================================================================
// Scheduler
// ============================================================================

export class Scheduler {
  private readonly db: Database;
  private readonly cronEval: CronEvaluator;
  private readonly enqueueAdapter: EnqueueAdapter;
  private readonly onFire: OnFire;
  private readonly maxConsecFailures: number;
  private readonly now: () => number;

  // Timer + in-flight tracking. We don't await the per-fire promises in the
  // tick (they'd serialize unrelated schedules), so we keep handles to drain
  // gracefully on stop().
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Set<Promise<void>> = new Set();
  private stopped = false;

  constructor(
    db: Database,
    cronEval: CronEvaluator,
    enqueueAdapter: EnqueueAdapter,
    onFire: OnFire,
    opts: SchedulerOptions = {},
  ) {
    this.db = db;
    this.cronEval = cronEval;
    this.enqueueAdapter = enqueueAdapter;
    this.onFire = onFire;
    this.maxConsecFailures =
      opts.defaultMaxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    this.now = opts.now ?? (() => Date.now());
  }

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  create(input: NewSchedule): Schedule {
    validatePrompt(input.prompt);
    validateCron(input.cron, this.cronEval);
    if (!input.agentId || typeof input.agentId !== "string") {
      throw new Error("agentId required");
    }

    const id = randomUUID();
    const now = this.now();
    const nextFireAt = this.cronEval(input.cron, now);

    this.db
      .prepare(
        `INSERT INTO schedules
           (id, agent_id, prompt, cron, cwd, enabled, paused_reason,
            next_fire_at, last_fired_at, last_task_id, last_status,
            consecutive_failures, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL,
                 ?, NULL, NULL, NULL,
                 0, ?, ?)`,
      )
      .run(
        id,
        input.agentId,
        input.prompt,
        input.cron,
        input.cwd ?? null,
        input.enabled === false ? 0 : 1,
        nextFireAt,
        now,
        now,
      );

    const row = this.get(id);
    if (!row) throw new Error(`create: schedule ${id} disappeared after insert`);
    return row;
  }

  update(id: string, patch: ScheduleUpdate): Schedule | null {
    const existing = this.get(id);
    if (!existing) return null;

    const fields: string[] = [];
    const params: unknown[] = [];

    if (patch.agentId !== undefined) {
      fields.push("agent_id = ?");
      params.push(patch.agentId);
    }
    if (patch.prompt !== undefined) {
      validatePrompt(patch.prompt);
      fields.push("prompt = ?");
      params.push(patch.prompt);
    }
    if (patch.cron !== undefined) {
      validateCron(patch.cron, this.cronEval);
      fields.push("cron = ?");
      params.push(patch.cron);
      // Re-derive next_fire_at relative to now() when cron changes
      fields.push("next_fire_at = ?");
      params.push(this.cronEval(patch.cron, this.now()));
    }
    if (patch.cwd !== undefined) {
      fields.push("cwd = ?");
      params.push(patch.cwd);
    }
    if (patch.enabled !== undefined) {
      fields.push("enabled = ?");
      params.push(patch.enabled ? 1 : 0);
      // Toggling enabled clears paused_reason (manual resume reset)
      fields.push("paused_reason = NULL");
      // Toggling on also resets the failure counter
      if (patch.enabled) {
        fields.push("consecutive_failures = 0");
      }
    }

    if (fields.length === 0) return existing;

    fields.push("updated_at = ?");
    params.push(this.now());
    params.push(id);

    this.db
      .prepare(`UPDATE schedules SET ${fields.join(", ")} WHERE id = ?`)
      .run(...params);

    return this.get(id);
  }

  delete(id: string): boolean {
    const r = this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    return r.changes === 1;
  }

  get(id: string): Schedule | null {
    const row = this.db
      .prepare("SELECT * FROM schedules WHERE id = ?")
      .get(id) as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : null;
  }

  list(): Schedule[] {
    const rows = this.db
      .prepare("SELECT * FROM schedules ORDER BY next_fire_at ASC")
      .all() as ScheduleRow[];
    return rows.map(rowToSchedule);
  }

  // --------------------------------------------------------------------------
  // Pause / resume
  // --------------------------------------------------------------------------

  pause(id: string, reason: PausedReason): Schedule | null {
    const now = this.now();
    // Only update if currently enabled — don't clobber a manual pause with an
    // auto-pause reason from a stale fire that hadn't been cancelled in time.
    this.db
      .prepare(
        `UPDATE schedules
            SET enabled = 0,
                paused_reason = ?,
                updated_at = ?
          WHERE id = ?
            AND enabled = 1`,
      )
      .run(reason, now, id);
    return this.get(id);
  }

  resume(id: string): Schedule | null {
    const sched = this.get(id);
    if (!sched) return null;
    const now = this.now();
    // Re-derive next_fire_at from now so we don't fire immediately on a long-
    // paused schedule whose next_fire_at is way in the past.
    const nextFireAt = this.cronEval(sched.cron, now);
    this.db
      .prepare(
        `UPDATE schedules
            SET enabled = 1,
                paused_reason = NULL,
                consecutive_failures = 0,
                next_fire_at = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(nextFireAt, now, id);
    return this.get(id);
  }

  // --------------------------------------------------------------------------
  // Fire (used by both tick and run-now)
  // --------------------------------------------------------------------------

  // Fires a schedule once, immediately, regardless of cron. Does NOT advance
  // next_fire_at. Does NOT count toward consecutive_failures (manual runs are
  // forensic, not part of the auto-pause budget). Used by run-now and by tests.
  async fireNow(id: string): Promise<FireOutcome> {
    const sched = this.get(id);
    if (!sched) {
      return { kind: "error", message: `schedule ${id} not found` };
    }
    return this.executeFire(sched, { manual: true });
  }

  // --------------------------------------------------------------------------
  // Tick lifecycle
  // --------------------------------------------------------------------------

  start(intervalMs: number = DEFAULT_TICK_INTERVAL_MS): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), intervalMs);
    // Run an immediate tick on start so schedules whose next_fire_at is past
    // (e.g., after a server restart) don't wait `intervalMs` to fire.
    this.tick();
  }

  // Best-effort drain of in-flight fires. Hosts that need a hard stop with a
  // timeout should wrap with Promise.race externally.
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.allSettled(Array.from(this.inFlight));
  }

  // The work the timer triggers. Exposed for tests that want to control the
  // clock manually instead of waiting on real wall-time.
  tick(): void {
    if (this.stopped) return;

    const now = this.now();
    const due = this.db
      .prepare(
        `SELECT * FROM schedules
          WHERE enabled = 1
            AND next_fire_at <= ?
          ORDER BY next_fire_at ASC`,
      )
      .all(now) as ScheduleRow[];

    for (const row of due) {
      const sched = rowToSchedule(row);
      const promise = this.executeFire(sched, { manual: false })
        .catch((err) => {
          // Last-ditch safety net — executeFire shouldn't throw, but if it
          // does the in-flight Set must still be cleaned.
          // eslint-disable-next-line no-console
          console.error("[scheduler] executeFire threw", err);
        })
        .then(() => {
          this.inFlight.delete(promise);
        });
      this.inFlight.add(promise);
    }
  }

  // --------------------------------------------------------------------------
  // Internal: the actual fire
  // --------------------------------------------------------------------------

  private async executeFire(
    sched: Schedule,
    opts: { manual: boolean },
  ): Promise<FireOutcome> {
    const now = this.now();
    const cwd = sched.cwd ?? "";

    // Atomic: enqueue task + advance next_fire_at (skip the advance for manual
    // fires — they don't consume the schedule slot).
    let taskId: string;
    try {
      taskId = this.db.transaction(() => {
        const tid = this.enqueueAdapter({
          description: sched.prompt,
          agentId: sched.agentId,
          metadata: {
            source: "scheduler",
            scheduleId: sched.id,
            cwd,
            manual: opts.manual,
          },
        });
        if (!opts.manual) {
          const nextFireAt = this.cronEval(sched.cron, now);
          this.db
            .prepare(
              `UPDATE schedules
                  SET next_fire_at = ?,
                      last_fired_at = ?,
                      last_task_id = ?,
                      updated_at = ?
                WHERE id = ?`,
            )
            .run(nextFireAt, now, tid, now, sched.id);
        } else {
          // Manual fires still record last_task_id + last_fired_at for
          // visibility, but don't touch next_fire_at.
          this.db
            .prepare(
              `UPDATE schedules
                  SET last_fired_at = ?,
                      last_task_id = ?,
                      updated_at = ?
                WHERE id = ?`,
            )
            .run(now, tid, now, sched.id);
        }
        return tid;
      })();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: "error", message: `enqueue failed: ${message}` };
    }

    // Fire the actual SDK call via the injected callback. This is async and
    // intentionally not awaited inside any DB transaction.
    let outcome: FireOutcome;
    try {
      outcome = await this.onFire({
        taskId,
        scheduleId: sched.id,
        agentId: sched.agentId,
        prompt: sched.prompt,
        cwd,
      });
    } catch (err) {
      // Defensive: a well-behaved onFire should return a FireOutcome rather
      // than throw, but we don't trust the host.
      const message = err instanceof Error ? err.message : String(err);
      outcome = { kind: "error", message };
    }

    if (!opts.manual) {
      this.recordOutcome(sched.id, outcome);
    }

    return outcome;
  }

  private recordOutcome(scheduleId: string, outcome: FireOutcome): void {
    const now = this.now();

    if (outcome.kind === "success") {
      this.db
        .prepare(
          `UPDATE schedules
              SET last_status = 'success',
                  consecutive_failures = 0,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(now, scheduleId);
      return;
    }

    if (outcome.kind === "oauth_dead") {
      this.db
        .prepare(
          `UPDATE schedules
              SET last_status = 'error',
                  enabled = 0,
                  paused_reason = 'oauth_unavailable',
                  updated_at = ?
            WHERE id = ?
              AND enabled = 1`,
        )
        .run(now, scheduleId);
      return;
    }

    if (outcome.kind === "budget_exhausted") {
      // Skip-and-advance — don't pause, don't increment failures. Cap is
      // monthly and rolls over.
      this.db
        .prepare(
          `UPDATE schedules
              SET last_status = 'budget_exhausted',
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(now, scheduleId);
      return;
    }

    // outcome.kind === "error" — increment failures + auto-pause on threshold.
    // Two-step transaction: increment, then read the post-increment value to
    // decide if the threshold tripped. Using `consecutive_failures + 1` in
    // the UPDATE (not a SELECT-then-UPDATE) eliminates the TOCTOU window the
    // SELECT-based version had — useful for the Clawless lift where multiple
    // DB connections may race. The `enabled = 1` guard is on BOTH branches so
    // a stale fire that resolves after a manual pause cannot bump
    // consecutive_failures or auto-pause-clobber paused_reason='manual'.
    const txn = this.db.transaction(() => {
      const updated = this.db
        .prepare(
          `UPDATE schedules
              SET last_status = 'error',
                  consecutive_failures = consecutive_failures + 1,
                  updated_at = ?
            WHERE id = ?
              AND enabled = 1
            RETURNING consecutive_failures`,
        )
        .get(now, scheduleId) as { consecutive_failures: number } | undefined;

      // Row gone (deleted) or already paused — recordOutcome no-ops cleanly.
      if (!updated) return;

      if (updated.consecutive_failures >= this.maxConsecFailures) {
        this.db
          .prepare(
            `UPDATE schedules
                SET enabled = 0,
                    paused_reason = 'too_many_failures',
                    updated_at = ?
              WHERE id = ?
                AND enabled = 1`,
          )
          .run(now, scheduleId);
      }
    });
    txn.immediate();
  }
}

// ============================================================================
// Validation
// ============================================================================

function validatePrompt(prompt: string): void {
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("prompt required (non-empty string)");
  }
  if (prompt.length > PROMPT_MAX_LEN) {
    throw new Error(`prompt exceeds ${PROMPT_MAX_LEN} chars`);
  }
}

function validateCron(cron: string, cronEval: CronEvaluator): void {
  if (typeof cron !== "string" || cron.length === 0) {
    throw new Error("cron required (non-empty string)");
  }
  if (cron.length > CRON_MAX_LEN) {
    throw new Error(`cron expression exceeds ${CRON_MAX_LEN} chars`);
  }
  try {
    cronEval(cron, Date.now());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid cron: ${message.split("\n")[0]}`);
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

type ScheduleRow = {
  id: string;
  agent_id: string;
  prompt: string;
  cron: string;
  cwd: string | null;
  enabled: number;
  paused_reason: PausedReason | null;
  next_fire_at: number;
  last_fired_at: number | null;
  last_task_id: string | null;
  last_status: LastStatus | null;
  consecutive_failures: number;
  created_at: number;
  updated_at: number;
};

function rowToSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    agentId: row.agent_id,
    prompt: row.prompt,
    cron: row.cron,
    cwd: row.cwd,
    enabled: row.enabled === 1,
    pausedReason: row.paused_reason,
    nextFireAt: row.next_fire_at,
    lastFiredAt: row.last_fired_at,
    lastTaskId: row.last_task_id,
    lastStatus: row.last_status,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Re-exported for tests.
export const __INTERNALS__ = {
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_TICK_INTERVAL_MS,
  PROMPT_MAX_LEN,
  CRON_MAX_LEN,
};
