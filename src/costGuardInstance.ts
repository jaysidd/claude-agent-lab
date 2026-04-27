// Bootstrap singleton for CostGuard. Wires the standalone primitive
// (src/costGuard.ts) to the Command Center's existing better-sqlite3 handle and
// the settings-table-backed cap resolver. Mirrors taskQueueInstance.ts.

import { db } from "./memory.js";
import { configValue } from "./settings.js";
import { migrate, CostGuard, type CapConfig } from "./costGuard.js";

migrate(db);

const DEFAULT_RATE_WINDOW_SECONDS = 3600;

function readCap(key: string): number | undefined {
  // Caps are unset OR a positive number. `0` collapses to "unset" — matches
  // the schema help text ("leave blank for no cap") and avoids the footgun
  // where a user typing 0 silently bricks the agent.
  const raw = configValue(key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function readPositive(key: string): number | undefined {
  // For non-cap numeric settings (rate window). 0 is invalid — falls back
  // to the caller's default.
  const raw = configValue(key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function resolveCaps(agentId: string): CapConfig {
  // Per-agent override falls back to global. Unset/0/invalid = no enforcement.
  const costCapMonthlyUsd =
    readCap(`costguard.cost_cap_monthly_usd.${agentId}`) ??
    readCap("costguard.cost_cap_monthly_usd");
  const rateCapPerWindow =
    readCap(`costguard.rate_cap_per_window.${agentId}`) ??
    readCap("costguard.rate_cap_per_window");
  const rateWindowSeconds =
    readPositive("costguard.rate_window_seconds") ?? DEFAULT_RATE_WINDOW_SECONDS;
  return { costCapMonthlyUsd, rateCapPerWindow, rateWindowSeconds };
}

export const costGuard = new CostGuard(db, resolveCaps);
