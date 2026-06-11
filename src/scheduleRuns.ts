// Scheduled-run history + result destinations (B06). The scheduler primitive
// (scheduler.ts) stays untouched — it's a well-tested, host-agnostic state
// machine that only knows a fire's outcome KIND, not its output text. The two
// B06 gaps live here as host concerns, in side tables keyed by schedule_id:
//
//   - schedule_runs:         one row per fire (status + full output + delivery)
//   - schedule_destinations: where a run's output goes (in-app / file / telegram)
//
// SECURITY (file destination): a scheduled run is UNATTENDED, and post-browser-
// automation its output can contain content the agent fetched from the web. So
// writing that output to a file is a write-side egress of attacker-influenceable
// content — NOT analogous to reading an operator-chosen pin. We therefore CONFINE
// file output to a dedicated reports dir (~/.claude-agent-lab/reports) with the
// same resolve + prefix-check floor used by skillInstall.ts / browser.ts. The
// operator picks a filename, never an arbitrary path — so a malicious page can't
// steer output into ~/.zshrc, ~/.ssh, .mcp.json, a SKILL.md, or a crontab and get
// executable content appended to a file that runs later.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "./memory.js";
import { getSetting } from "./settings.js";
import { sendMessage } from "./telegram.js";

// ============================================================================
// Schema
// ============================================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS schedule_runs (
    id              TEXT PRIMARY KEY,
    schedule_id     TEXT NOT NULL,
    task_id         TEXT,
    status          TEXT NOT NULL,            -- success | error | budget_exhausted
    output          TEXT,                     -- agent final text (success)
    error           TEXT,                     -- error message (error)
    delivery        TEXT,                     -- null | 'ok' | 'failed: <reason>'
    cost_usd        REAL,
    started_at      INTEGER NOT NULL,
    finished_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_runs_schedule ON schedule_runs(schedule_id, finished_at DESC);

  CREATE TABLE IF NOT EXISTS schedule_destinations (
    schedule_id   TEXT PRIMARY KEY,
    type          TEXT NOT NULL DEFAULT 'in-app',  -- in-app | file | telegram
    config_json   TEXT NOT NULL DEFAULT '{}',
    updated_at    INTEGER NOT NULL
  );
`);

// ============================================================================
// Constants
// ============================================================================

// Confinement root for `file` destinations. Operators name a file under here;
// they can never write outside it.
export const REPORTS_ROOT = path.join(os.homedir(), ".claude-agent-lab", "reports");

// Per-schedule run retention. A per-minute schedule would otherwise grow the
// table forever; we keep the most recent N rows per schedule.
const RUN_RETENTION = 50;

const OUTPUT_MAX = 100_000;

// ============================================================================
// Types
// ============================================================================

export type RunStatus = "success" | "error" | "budget_exhausted";

export type ScheduleRun = {
  id: string;
  scheduleId: string;
  taskId: string | null;
  status: RunStatus;
  output: string | null;
  error: string | null;
  delivery: string | null;
  costUsd: number | null;
  startedAt: number;
  finishedAt: number;
};

export type DestinationType = "in-app" | "file" | "telegram";

export type Destination = {
  type: DestinationType;
  // file
  fileName?: string; // relative name under REPORTS_ROOT
  // telegram
  chatId?: number; // a single explicit target chat
};

// ============================================================================
// File-destination path confinement
// ============================================================================

// Resolve an operator-chosen report filename to an absolute path INSIDE
// REPORTS_ROOT, or throw. Subdirectories are allowed (e.g. "news/daily.md") but
// traversal/absolute/escape is not — same floor as skillInstall.resolveSkillDir.
export function resolveReportPath(fileName: string): string {
  const name = (fileName ?? "").trim();
  if (!name) throw new Error("file name required");
  // Reject absolute paths and any traversal segment outright.
  if (path.isAbsolute(name) || name.split(/[\\/]/).some((seg) => seg === "..")) {
    throw new Error("file name must be a relative path inside the reports folder");
  }
  const resolved = path.resolve(REPORTS_ROOT, name);
  if (resolved !== path.join(REPORTS_ROOT, name) || !resolved.startsWith(REPORTS_ROOT + path.sep)) {
    throw new Error("file destination escapes the reports folder");
  }
  return resolved;
}

// ============================================================================
// Destinations
// ============================================================================

function rowToDestination(r: any): Destination {
  let cfg: any = {};
  try {
    cfg = JSON.parse(r.config_json) ?? {};
  } catch {
    /* default */
  }
  const type: DestinationType =
    r.type === "file" || r.type === "telegram" ? r.type : "in-app";
  const out: Destination = { type };
  if (type === "file" && typeof cfg.fileName === "string") out.fileName = cfg.fileName;
  if (type === "telegram" && typeof cfg.chatId === "number") out.chatId = cfg.chatId;
  return out;
}

export function getDestination(scheduleId: string): Destination {
  const r = db.prepare("SELECT * FROM schedule_destinations WHERE schedule_id = ?").get(scheduleId);
  return r ? rowToDestination(r) : { type: "in-app" };
}

// Validate + persist a destination. Throws on a bad shape so the route can 400.
export function setDestination(scheduleId: string, dest: Destination): Destination {
  const type: DestinationType =
    dest?.type === "file" || dest?.type === "telegram" ? dest.type : "in-app";
  const config: Record<string, unknown> = {};
  if (type === "file") {
    // Validate the filename confines now, so a bad path is rejected at config
    // time rather than silently failing on the first fire.
    resolveReportPath(dest.fileName ?? "");
    config.fileName = dest.fileName!.trim();
  }
  if (type === "telegram") {
    if (typeof dest.chatId !== "number" || !Number.isFinite(dest.chatId)) {
      throw new Error("telegram destination requires a numeric chatId");
    }
    config.chatId = dest.chatId;
  }
  db.prepare(
    `INSERT INTO schedule_destinations (schedule_id, type, config_json, updated_at)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(schedule_id) DO UPDATE SET
       type = excluded.type, config_json = excluded.config_json, updated_at = excluded.updated_at`,
  ).run(scheduleId, type, JSON.stringify(config), Date.now());
  return getDestination(scheduleId);
}

// ============================================================================
// Run history
// ============================================================================

function rowToRun(r: any): ScheduleRun {
  return {
    id: r.id,
    scheduleId: r.schedule_id,
    taskId: r.task_id ?? null,
    status: r.status,
    output: r.output ?? null,
    error: r.error ?? null,
    delivery: r.delivery ?? null,
    costUsd: r.cost_usd ?? null,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function recordRun(input: {
  scheduleId: string;
  taskId: string | null;
  status: RunStatus;
  output?: string | null;
  error?: string | null;
  delivery?: string | null;
  costUsd?: number | null;
  startedAt: number;
  finishedAt: number;
}): ScheduleRun {
  const run: ScheduleRun = {
    id: randomUUID(),
    scheduleId: input.scheduleId,
    taskId: input.taskId,
    status: input.status,
    output: input.output ? String(input.output).slice(0, OUTPUT_MAX) : null,
    error: input.error ?? null,
    delivery: input.delivery ?? null,
    costUsd: input.costUsd ?? null,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  };
  db.prepare(
    `INSERT INTO schedule_runs (id, schedule_id, task_id, status, output, error, delivery, cost_usd, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.id,
    run.scheduleId,
    run.taskId,
    run.status,
    run.output,
    run.error,
    run.delivery,
    run.costUsd,
    run.startedAt,
    run.finishedAt,
  );
  // Retention: keep only the most recent RUN_RETENTION rows for this schedule.
  db.prepare(
    `DELETE FROM schedule_runs
      WHERE schedule_id = ?
        AND id NOT IN (
          SELECT id FROM schedule_runs WHERE schedule_id = ?
          ORDER BY finished_at DESC LIMIT ?
        )`,
  ).run(run.scheduleId, run.scheduleId, RUN_RETENTION);
  return run;
}

// Update the delivery column after a best-effort delivery attempt.
export function setRunDelivery(runId: string, delivery: string): void {
  db.prepare("UPDATE schedule_runs SET delivery = ? WHERE id = ?").run(delivery, runId);
}

export function listRuns(scheduleId: string, limit = 25): ScheduleRun[] {
  return (
    db
      .prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY finished_at DESC LIMIT ?")
      .all(scheduleId, limit) as any[]
  ).map(rowToRun);
}

// Clear all side-table rows for a schedule — called when the schedule is
// deleted, so its run history + destination don't orphan (the #3 stale-row
// lesson: the scheduler primitive doesn't know about these tables).
export function clearScheduleData(scheduleId: string): void {
  db.prepare("DELETE FROM schedule_runs WHERE schedule_id = ?").run(scheduleId);
  db.prepare("DELETE FROM schedule_destinations WHERE schedule_id = ?").run(scheduleId);
}

// ============================================================================
// Delivery — best-effort, NEVER throws (so a delivery failure can't fail the
// run). Returns a delivery status string for the run row.
// ============================================================================

export async function deliverResult(
  scheduleId: string,
  payload: { status: RunStatus; output: string | null; error: string | null; finishedAt: number },
): Promise<string> {
  const dest = getDestination(scheduleId);
  if (dest.type === "in-app") return "in-app"; // recorded in history; nothing to send

  // Only successful runs with output are worth delivering externally.
  if (payload.status !== "success" || !payload.output) {
    return "skipped (no output)";
  }
  const body = payload.output.slice(0, OUTPUT_MAX);

  try {
    if (dest.type === "file") {
      const abs = resolveReportPath(dest.fileName ?? "");
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const header = `\n\n----- scheduled run @ ${new Date(payload.finishedAt).toISOString()} -----\n`;
      fs.appendFileSync(abs, header + body + "\n", "utf8");
      return "ok";
    }
    if (dest.type === "telegram") {
      const token = getSetting("telegram.bot_token");
      if (!token) return "failed: telegram not configured";
      if (typeof dest.chatId !== "number") return "failed: no chatId";
      await sendMessage(token, dest.chatId, body.slice(0, 4000));
      return "ok";
    }
  } catch (err: any) {
    return "failed: " + (err?.message ?? String(err));
  }
  return "in-app";
}
