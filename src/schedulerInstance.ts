// Bootstrap singleton for Scheduler. Wires the standalone primitive
// (src/scheduler.ts) to:
//   - the existing better-sqlite3 handle (data/lab.db via memory.ts)
//   - cron-parser v5 for next-fire-time evaluation
//   - host-supplied enqueue + onFire callbacks (passed via initScheduler)
//
// Pattern matches taskQueueInstance.ts / costGuardInstance.ts. Singleton is
// created lazily because onFire needs server.ts state (findAgent, currentCwd,
// effectiveModel, etc.) that isn't safe to import here without circular deps.

import { CronExpressionParser } from "cron-parser";
import { db } from "./memory.js";
import {
  migrate,
  Scheduler,
  type EnqueueAdapter,
  type OnFire,
} from "./scheduler.js";

migrate(db);

// Inject as the Scheduler's CronEvaluator. cron-parser v5 throws on invalid
// expressions; the Scheduler's validateCron() catches and rewraps the message.
export function cronEval(cron: string, from: number): number {
  const it = CronExpressionParser.parse(cron, {
    currentDate: new Date(from),
  });
  return it.next().toDate().getTime();
}

// Returns up to N upcoming fires. Powers the `/api/cron/preview` route the
// new-schedule UI uses for the "next 3 fires" panel.
export function cronPreview(cron: string, from: number, count: number): number[] {
  const it = CronExpressionParser.parse(cron, {
    currentDate: new Date(from),
  });
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(it.next().toDate().getTime());
  }
  return out;
}

let _scheduler: Scheduler | null = null;

export function initScheduler(
  enqueueAdapter: EnqueueAdapter,
  onFire: OnFire,
): Scheduler {
  if (_scheduler) return _scheduler;
  _scheduler = new Scheduler(db, cronEval, enqueueAdapter, onFire);
  return _scheduler;
}

export function getScheduler(): Scheduler {
  if (!_scheduler) {
    throw new Error("scheduler not initialized; call initScheduler() first");
  }
  return _scheduler;
}
