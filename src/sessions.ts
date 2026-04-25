import { db } from "./memory.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,           -- SDK session_id
    agent_id        TEXT NOT NULL,
    title           TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    cwd             TEXT,
    message_count   INTEGER NOT NULL DEFAULT 0,
    total_input     INTEGER NOT NULL DEFAULT 0,
    total_output    INTEGER NOT NULL DEFAULT 0,
    total_cost_usd  REAL    NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS session_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    role            TEXT NOT NULL,             -- 'user' | 'agent'
    text            TEXT NOT NULL,
    tool_uses       TEXT,                      -- JSON array (agent only)
    model           TEXT,
    api_key_source  TEXT,
    usage           TEXT,                      -- JSON (agent only)
    total_cost_usd  REAL,
    created_at      INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON session_messages(session_id, id);
`);

export type SessionRow = {
  id: string;
  agentId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  cwd: string | null;
  messageCount: number;
  totalInput: number;
  totalOutput: number;
  totalCostUsd: number;
};

export type SessionMessageRow = {
  id: number;
  sessionId: string;
  role: "user" | "agent";
  text: string;
  toolUses?: any[];
  model?: string;
  apiKeySource?: string;
  usage?: any;
  totalCostUsd?: number;
  createdAt: number;
};

function rowToSession(r: any): SessionRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    cwd: r.cwd,
    messageCount: r.message_count,
    totalInput: r.total_input,
    totalOutput: r.total_output,
    totalCostUsd: r.total_cost_usd,
  };
}

function rowToMessage(r: any): SessionMessageRow {
  let toolUses: any[] | undefined;
  let usage: any;
  try {
    if (r.tool_uses) toolUses = JSON.parse(r.tool_uses);
  } catch {}
  try {
    if (r.usage) usage = JSON.parse(r.usage);
  } catch {}
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    text: r.text,
    toolUses,
    model: r.model ?? undefined,
    apiKeySource: r.api_key_source ?? undefined,
    usage,
    totalCostUsd: r.total_cost_usd ?? undefined,
    createdAt: r.created_at,
  };
}

function deriveTitle(firstUserMessage: string): string {
  const trimmed = firstUserMessage.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 60) return trimmed;
  return trimmed.slice(0, 57) + "…";
}

/**
 * Ensure a session row exists for this (sessionId, agentId). Creates a row
 * with defaults if missing; idempotent. Does NOT update the title — title is
 * derived from the first user message and stays stable.
 */
export function ensureSession(input: {
  sessionId: string;
  agentId: string;
  cwd: string;
}): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, agent_id, title, created_at, updated_at, cwd)
     VALUES (?, ?, NULL, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(input.sessionId, input.agentId, now, now, input.cwd);
}

/**
 * Append a (user, agent) turn to a session. Bumps message_count + token totals
 * and updates updated_at. Auto-titles from the first user message if needed.
 */
export function appendTurn(input: {
  sessionId: string;
  agentId: string;
  cwd: string;
  userText: string;
  agentText: string;
  toolUses?: any[];
  model?: string;
  apiKeySource?: string;
  usage?: any;
  totalCostUsd?: number;
}): void {
  ensureSession({
    sessionId: input.sessionId,
    agentId: input.agentId,
    cwd: input.cwd,
  });
  const now = Date.now();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO session_messages
         (session_id, role, text, tool_uses, model, api_key_source, usage, total_cost_usd, created_at)
       VALUES (?, 'user', ?, NULL, NULL, NULL, NULL, NULL, ?)`,
    ).run(input.sessionId, input.userText, now);

    db.prepare(
      `INSERT INTO session_messages
         (session_id, role, text, tool_uses, model, api_key_source, usage, total_cost_usd, created_at)
       VALUES (?, 'agent', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.sessionId,
      input.agentText,
      input.toolUses ? JSON.stringify(input.toolUses) : null,
      input.model ?? null,
      input.apiKeySource ?? null,
      input.usage ? JSON.stringify(input.usage) : null,
      input.totalCostUsd ?? null,
      now + 1,
    );

    const inTok = input.usage?.input_tokens ?? 0;
    const outTok = input.usage?.output_tokens ?? 0;
    const cost = input.totalCostUsd ?? 0;

    // If the session has no title yet, set it from this user message
    const existing = db.prepare("SELECT title FROM sessions WHERE id = ?").get(input.sessionId) as
      | { title: string | null }
      | undefined;
    if (existing && existing.title === null) {
      db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(
        deriveTitle(input.userText),
        input.sessionId,
      );
    }

    db.prepare(
      `UPDATE sessions
          SET updated_at    = ?,
              message_count = message_count + 2,
              total_input   = total_input  + ?,
              total_output  = total_output + ?,
              total_cost_usd = total_cost_usd + ?,
              cwd           = ?
        WHERE id = ?`,
    ).run(now, inTok, outTok, cost, input.cwd, input.sessionId);
  });
  tx();
}

export function listSessions(agentId?: string): SessionRow[] {
  const rows = (
    agentId
      ? db
          .prepare(
            "SELECT * FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 200",
          )
          .all(agentId)
      : db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 200").all()
  ) as any[];
  return rows.map(rowToSession);
}

export function getSession(id: string): SessionRow | undefined {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as any;
  return row ? rowToSession(row) : undefined;
}

export function getSessionMessages(id: string): SessionMessageRow[] {
  const rows = db
    .prepare("SELECT * FROM session_messages WHERE session_id = ? ORDER BY id ASC")
    .all(id) as any[];
  return rows.map(rowToMessage);
}

export function setSessionTitle(id: string, title: string): boolean {
  const r = db
    .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
    .run(title.slice(0, 200), Date.now(), id);
  return r.changes > 0;
}

export function deleteSession(id: string): boolean {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM session_messages WHERE session_id = ?").run(id);
    return db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  });
  const r = tx();
  return r.changes > 0;
}
