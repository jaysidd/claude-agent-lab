import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { AGENTS } from "./agents.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, "..", "data");
const DB_PATH = process.env.LAB_DB_PATH ?? path.join(DB_DIR, "lab.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id          TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    agent_id    TEXT,              -- NULL = global (applies to all agents)
    category    TEXT DEFAULT 'fact', -- fact | preference | context
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, created_at DESC);
`);

export type MemoryCategory = "fact" | "preference" | "context";

export type Memory = {
  id: string;
  content: string;
  agentId: string | null;
  category: MemoryCategory;
  createdAt: number;
};

const ALLOWED_CATEGORIES: MemoryCategory[] = ["fact", "preference", "context"];

function row(m: any): Memory {
  return {
    id: m.id,
    content: m.content,
    agentId: m.agent_id,
    category: m.category,
    createdAt: m.created_at,
  };
}

export function listMemories(agentId?: string | null): Memory[] {
  const stmt = agentId
    ? db.prepare(
        "SELECT * FROM memories WHERE agent_id IS NULL OR agent_id = ? ORDER BY created_at DESC",
      )
    : db.prepare("SELECT * FROM memories ORDER BY created_at DESC");
  const rows = agentId ? stmt.all(agentId) : stmt.all();
  return rows.map(row);
}

export function createMemory(input: {
  content: string;
  agentId?: string | null;
  category?: MemoryCategory;
}): Memory {
  const content = input.content.trim();
  if (!content) throw new Error("content required");
  if (input.agentId && !AGENTS[input.agentId] && input.agentId !== null) {
    throw new Error("unknown agent");
  }
  const category: MemoryCategory = ALLOWED_CATEGORIES.includes(
    input.category as MemoryCategory,
  )
    ? (input.category as MemoryCategory)
    : "fact";
  const mem: Memory = {
    id: randomUUID(),
    content,
    agentId: input.agentId ?? null,
    category,
    createdAt: Date.now(),
  };
  db.prepare(
    "INSERT INTO memories (id, content, agent_id, category, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(mem.id, mem.content, mem.agentId, mem.category, mem.createdAt);
  return mem;
}

export function deleteMemory(id: string): boolean {
  const r = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  return r.changes > 0;
}

export function clearMemories(): number {
  const r = db.prepare("DELETE FROM memories").run();
  return r.changes;
}

const MAX_INJECTED = 20;
const MAX_CHARS = 2000;

export function memoryBlockFor(agentId: string): string | null {
  const memories = listMemories(agentId).slice(0, MAX_INJECTED);
  if (memories.length === 0) return null;

  const byCategory: Record<MemoryCategory, string[]> = {
    fact: [],
    preference: [],
    context: [],
  };
  let totalChars = 0;
  for (const m of memories) {
    const line = `- ${m.content}`;
    if (totalChars + line.length > MAX_CHARS) break;
    byCategory[m.category].push(line);
    totalChars += line.length;
  }

  const sections: string[] = [];
  if (byCategory.preference.length)
    sections.push("Preferences:\n" + byCategory.preference.join("\n"));
  if (byCategory.fact.length) sections.push("Facts:\n" + byCategory.fact.join("\n"));
  if (byCategory.context.length) sections.push("Context:\n" + byCategory.context.join("\n"));
  if (sections.length === 0) return null;

  return [
    "<persistent-memory>",
    "These are user-provided notes that apply to your reply. Treat them as background knowledge.",
    ...sections,
    "</persistent-memory>",
  ].join("\n");
}

export function augmentedSystemPrompt(agentId: string, basePrompt: string): string {
  const block = memoryBlockFor(agentId);
  if (!block) return basePrompt;
  return `${basePrompt}\n\n${block}`;
}
