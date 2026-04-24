import { db } from "./memory.js";
import { randomUUID } from "node:crypto";
import type { AgentConfig } from "./agents.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS custom_agents (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    emoji         TEXT NOT NULL DEFAULT '🤖',
    accent        TEXT NOT NULL DEFAULT '#8b9eff',
    description   TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL,
    allowed_tools TEXT NOT NULL DEFAULT '[]',
    model         TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    is_router     INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
`);

export type CustomAgentInput = {
  name: string;
  emoji?: string;
  accent?: string;
  description?: string;
  systemPrompt: string;
  allowedTools?: string[];
  model?: string;
  isRouter?: boolean;
};

function rowToConfig(r: any): AgentConfig {
  let tools: string[] = [];
  try {
    tools = JSON.parse(r.allowed_tools || "[]");
  } catch (err) {
    console.warn(`customAgents: failed to parse allowed_tools for ${r.id}:`, err);
    tools = [];
  }
  return {
    id: r.id,
    name: r.name,
    emoji: r.emoji,
    accent: r.accent,
    description: r.description || "",
    systemPrompt: r.system_prompt,
    allowedTools: tools,
    model: r.model,
    isRouter: !!r.is_router,
  };
}

export function listCustomAgents(): AgentConfig[] {
  const rows = db.prepare("SELECT * FROM custom_agents ORDER BY created_at ASC").all() as any[];
  return rows.map(rowToConfig);
}

export function findCustomAgent(id: string): AgentConfig | undefined {
  const row = db.prepare("SELECT * FROM custom_agents WHERE id = ?").get(id) as any;
  return row ? rowToConfig(row) : undefined;
}

function slugId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || randomUUID().slice(0, 8);
}

export function createCustomAgent(
  input: CustomAgentInput,
  reservedIds: Set<string>,
): AgentConfig {
  const name = input.name.trim();
  const systemPrompt = (input.systemPrompt || "").trim();
  if (!name) throw new Error("name required");
  if (!systemPrompt) throw new Error("systemPrompt required");

  // Ensure the generated id doesn't collide with a built-in or another custom.
  let id = slugId(name);
  let suffix = 2;
  while (reservedIds.has(id) || findCustomAgent(id)) {
    id = `${slugId(name)}-${suffix++}`;
  }

  const now = Date.now();
  const record = {
    id,
    name,
    emoji: input.emoji?.trim() || "🤖",
    accent: input.accent?.trim() || "#8b9eff",
    description: (input.description || "").trim(),
    system_prompt: systemPrompt,
    allowed_tools: JSON.stringify(input.allowedTools ?? []),
    model: input.model || "claude-sonnet-4-6",
    is_router: input.isRouter ? 1 : 0,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO custom_agents
      (id, name, emoji, accent, description, system_prompt, allowed_tools, model, is_router, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.name,
    record.emoji,
    record.accent,
    record.description,
    record.system_prompt,
    record.allowed_tools,
    record.model,
    record.is_router,
    record.created_at,
    record.updated_at,
  );
  return findCustomAgent(id)!;
}

export function updateCustomAgent(id: string, patch: Partial<CustomAgentInput>): AgentConfig | null {
  const existing = findCustomAgent(id);
  if (!existing) return null;
  const merged = {
    name: patch.name ?? existing.name,
    emoji: patch.emoji ?? existing.emoji,
    accent: patch.accent ?? existing.accent,
    description: patch.description ?? existing.description,
    system_prompt: patch.systemPrompt ?? existing.systemPrompt,
    allowed_tools: JSON.stringify(patch.allowedTools ?? existing.allowedTools),
    model: patch.model ?? existing.model,
    is_router: patch.isRouter !== undefined ? (patch.isRouter ? 1 : 0) : existing.isRouter ? 1 : 0,
    updated_at: Date.now(),
  };
  db.prepare(
    `UPDATE custom_agents
       SET name=?, emoji=?, accent=?, description=?, system_prompt=?, allowed_tools=?, model=?, is_router=?, updated_at=?
     WHERE id=?`,
  ).run(
    merged.name,
    merged.emoji,
    merged.accent,
    merged.description,
    merged.system_prompt,
    merged.allowed_tools,
    merged.model,
    merged.is_router,
    merged.updated_at,
    id,
  );
  return findCustomAgent(id)!;
}

export function deleteCustomAgent(id: string): boolean {
  const r = db.prepare("DELETE FROM custom_agents WHERE id = ?").run(id);
  return r.changes > 0;
}
