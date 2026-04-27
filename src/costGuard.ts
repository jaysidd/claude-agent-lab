// Budget enforcement primitive (CostGuard). Standalone — no Express, no Agent
// SDK, no host-specific imports. Designed to lift cleanly into Clawless's B64.
// Signature locked rev. 2 across both projects on 2026-04-26:
//
//   check(agentId, estimatedTokens?) → { ok, reason?, capType?, remaining? }
//
// Two-tier caps:
//   - cost cap   monthly $ ceiling. OAuth records (is_oauth=1) are excluded
//                from the sum, so OAuth automatically bypasses without an
//                explicit env-var coupling.
//   - rate cap   sliding-window request count. Always enforced regardless of
//                provider — OAuth providers still hit rate limits.

import type DatabaseConstructor from "better-sqlite3";

type Database = DatabaseConstructor.Database;

// ============================================================================
// Public types
// ============================================================================

export type CapType = "cost" | "rate";

export type CheckResult = {
  ok: boolean;
  reason?: string;
  capType?: CapType;
  remaining?: number;
};

export type RecordInput = {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  isOAuth?: boolean;
  occurredAt?: number;
};

export type CapConfig = {
  costCapMonthlyUsd?: number;
  rateCapPerWindow?: number;
  rateWindowSeconds: number;
};

export type CapResolver = (agentId: string) => CapConfig;

// ============================================================================
// Migration
// ============================================================================

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_ledger (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id      TEXT    NOT NULL,
      occurred_at   INTEGER NOT NULL,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL    NOT NULL DEFAULT 0,
      is_oauth      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_agent_time ON cost_ledger(agent_id, occurred_at);
  `);
}

// ============================================================================
// CostGuard
// ============================================================================

export class CostGuard {
  private readonly db: Database;
  private readonly resolveCaps: CapResolver;
  private readonly insertStmt: ReturnType<Database["prepare"]>;
  private readonly rateCountStmt: ReturnType<Database["prepare"]>;
  private readonly monthCostStmt: ReturnType<Database["prepare"]>;

  constructor(db: Database, resolveCaps: CapResolver) {
    this.db = db;
    this.resolveCaps = resolveCaps;
    this.insertStmt = db.prepare(
      `INSERT INTO cost_ledger
        (agent_id, occurred_at, input_tokens, output_tokens, cost_usd, is_oauth)
        VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.rateCountStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM cost_ledger
        WHERE agent_id = ? AND occurred_at >= ?`,
    );
    this.monthCostStmt = db.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_ledger
        WHERE agent_id = ? AND occurred_at >= ? AND is_oauth = 0`,
    );
  }

  /**
   * Preflight check. Returns ok=true with no caps to dock if neither cap is
   * configured. estimatedTokens is accepted for forward compatibility but is
   * not consulted by v1 — it counts as one request in the rate window.
   */
  check(agentId: string, _estimatedTokens?: number): CheckResult {
    const caps = this.resolveCaps(agentId);

    // Rate cap — always enforced when set.
    if (typeof caps.rateCapPerWindow === "number" && caps.rateCapPerWindow >= 0) {
      const since = Date.now() - caps.rateWindowSeconds * 1000;
      const row = this.rateCountStmt.get(agentId, since) as { n: number };
      const used = row.n;
      const remaining = caps.rateCapPerWindow - used;
      if (remaining <= 0) {
        return {
          ok: false,
          reason: `rate cap reached: ${used}/${caps.rateCapPerWindow} requests in last ${caps.rateWindowSeconds}s`,
          capType: "rate",
          remaining: 0,
        };
      }
    }

    // Cost cap — set sums only is_oauth=0 rows, so OAuth bypasses.
    if (typeof caps.costCapMonthlyUsd === "number" && caps.costCapMonthlyUsd >= 0) {
      const monthStart = startOfMonth(Date.now());
      const row = this.monthCostStmt.get(agentId, monthStart) as { total: number };
      const used = row.total;
      const remaining = caps.costCapMonthlyUsd - used;
      if (remaining <= 0) {
        return {
          ok: false,
          reason: `cost cap reached: $${used.toFixed(4)}/$${caps.costCapMonthlyUsd.toFixed(2)} this month`,
          capType: "cost",
          remaining: 0,
        };
      }
    }

    return { ok: true };
  }

  /**
   * Append a ledger row after a call resolves. Pass isOAuth=true for Max-OAuth
   * (or any provider where cost is $0) so cost-cap accumulation skips the row.
   * Failed calls should still be recorded — they consume rate budget.
   */
  record(agentId: string, opts: RecordInput = {}): void {
    const occurredAt = opts.occurredAt ?? Date.now();
    this.insertStmt.run(
      agentId,
      occurredAt,
      opts.inputTokens ?? 0,
      opts.outputTokens ?? 0,
      opts.costUsd ?? 0,
      opts.isOAuth ? 1 : 0,
    );
  }

  /**
   * Read current usage for an agent without triggering an enforcement decision.
   * Useful for UI displays and tests.
   */
  status(agentId: string): {
    rateUsed: number;
    rateRemaining: number | null;
    costUsedThisMonth: number;
    costRemaining: number | null;
  } {
    const caps = this.resolveCaps(agentId);
    const since = Date.now() - caps.rateWindowSeconds * 1000;
    const rateUsed = (this.rateCountStmt.get(agentId, since) as { n: number }).n;
    const monthStart = startOfMonth(Date.now());
    const costUsedThisMonth = (this.monthCostStmt.get(agentId, monthStart) as {
      total: number;
    }).total;
    return {
      rateUsed,
      rateRemaining:
        typeof caps.rateCapPerWindow === "number"
          ? Math.max(0, caps.rateCapPerWindow - rateUsed)
          : null,
      costUsedThisMonth,
      costRemaining:
        typeof caps.costCapMonthlyUsd === "number"
          ? Math.max(0, caps.costCapMonthlyUsd - costUsedThisMonth)
          : null,
    };
  }
}

function startOfMonth(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}
