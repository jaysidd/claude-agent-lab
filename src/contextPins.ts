// Context pins — per-agent content auto-injected into the system prompt on
// every turn. Two kinds:
//   - "snippet": static text stored in the DB (e.g. a tone guide, a glossary)
//   - "file": an absolute path re-read from disk on EACH turn, so edits to the
//     file flow through live without re-saving the pin (e.g. a writing-style
//     doc, a project spec, a running TODO list)
//
// This module imports `db` + `memoryBlockFor` from memory.ts and owns the
// composition function `augmentedSystemPrompt` (moved here from memory.ts to
// avoid a circular import — memory.ts must not import this module). Every
// query() call in server.ts funnels its systemPrompt through here, so memory
// AND pins land on chat, streaming, task-run, scheduler, and Telegram paths.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, memoryBlockFor } from "./memory.js";
import { buildPersonalityPrompt } from "./personality.js";

// ============================================================================
// Schema
// ============================================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS context_pins (
    id          TEXT PRIMARY KEY,
    agent_id    TEXT NOT NULL,           -- pins are always per-agent (no global)
    label       TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('snippet', 'file')),
    content     TEXT NOT NULL,           -- snippet text, or absolute file path
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pins_agent ON context_pins(agent_id, created_at DESC);
`);

// ============================================================================
// Types
// ============================================================================

export type PinKind = "snippet" | "file";

export type ContextPin = {
  id: string;
  agentId: string;
  label: string;
  kind: PinKind;
  content: string;
  createdAt: number;
};

// Per-file and total injection caps. A pinned file larger than the per-file
// cap is truncated with a marker; total across all of an agent's pins is
// bounded so a careless pin can't blow the context budget.
const PER_FILE_MAX_CHARS = 16_000;
const TOTAL_MAX_CHARS = 32_000;
const LABEL_MAX = 200;

// ============================================================================
// Helpers
// ============================================================================

function row(p: any): ContextPin {
  return {
    id: p.id,
    agentId: p.agent_id,
    label: p.label,
    kind: p.kind,
    content: p.content,
    createdAt: p.created_at,
  };
}

// Expand a leading ~ to the user's home dir, then resolve to absolute. Used
// for file pins so "~/notes/style.md" works. The personal-use threat model
// already lets the operator point cwd anywhere, so reading an operator-chosen
// file is in-scope (see security-audit baseline).
export function expandFilePath(p: string): string {
  const trimmed = p.trim();
  const expanded = trimmed.startsWith("~")
    ? path.join(os.homedir(), trimmed.slice(1))
    : trimmed;
  return path.resolve(expanded);
}

// ============================================================================
// CRUD
// ============================================================================

export function listPins(agentId: string): ContextPin[] {
  const rows = db
    .prepare(
      "SELECT * FROM context_pins WHERE agent_id = ? ORDER BY created_at DESC",
    )
    .all(agentId);
  return rows.map(row);
}

export function createPin(input: {
  agentId: string;
  label: string;
  kind: PinKind;
  content: string;
}): ContextPin {
  const agentId = (input.agentId ?? "").trim();
  if (!agentId) throw new Error("agentId required");
  const kind: PinKind = input.kind === "file" ? "file" : "snippet";
  const content = (input.content ?? "").trim();
  if (!content) throw new Error(kind === "file" ? "file path required" : "snippet text required");
  // For file pins, store the expanded absolute path so re-reads are stable
  // even if the server's cwd changes later.
  const storedContent = kind === "file" ? expandFilePath(content) : content;
  const label = ((input.label ?? "").trim() || defaultLabel(kind, storedContent)).slice(0, LABEL_MAX);

  const pin: ContextPin = {
    id: randomUUID(),
    agentId,
    label,
    kind,
    content: storedContent,
    createdAt: Date.now(),
  };
  db.prepare(
    "INSERT INTO context_pins (id, agent_id, label, kind, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(pin.id, pin.agentId, pin.label, pin.kind, pin.content, pin.createdAt);
  return pin;
}

export function deletePin(id: string): boolean {
  const r = db.prepare("DELETE FROM context_pins WHERE id = ?").run(id);
  return r.changes > 0;
}

function defaultLabel(kind: PinKind, content: string): string {
  if (kind === "file") return path.basename(content);
  const firstLine = content.split("\n")[0] ?? "";
  return firstLine.slice(0, 60) || "snippet";
}

// ============================================================================
// Injection
// ============================================================================

// Resolves a pin to the text that should be injected. File pins are re-read
// from disk every call; a missing/unreadable file becomes an inline marker so
// the agent knows the reference exists but is currently unavailable (rather
// than silently dropping it).
function resolvePinText(pin: ContextPin): string {
  if (pin.kind === "snippet") {
    return pin.content.slice(0, PER_FILE_MAX_CHARS);
  }
  try {
    const stat = fs.statSync(pin.content);
    if (!stat.isFile()) {
      return `[pinned path is not a file: ${pin.content}]`;
    }
    let text = fs.readFileSync(pin.content, "utf8");
    if (text.length > PER_FILE_MAX_CHARS) {
      text = text.slice(0, PER_FILE_MAX_CHARS) + "\n…[truncated]";
    }
    return text;
  } catch {
    return `[pinned file unavailable: ${pin.content}]`;
  }
}

export function pinnedBlockFor(agentId: string): string | null {
  const pins = listPins(agentId);
  if (pins.length === 0) return null;

  const blocks: string[] = [];
  let totalChars = 0;
  for (const pin of pins) {
    const text = resolvePinText(pin);
    const header =
      pin.kind === "file"
        ? `### ${pin.label} (live file: ${pin.content})`
        : `### ${pin.label}`;
    const block = `${header}\n${text}`;
    if (totalChars + block.length > TOTAL_MAX_CHARS) break;
    blocks.push(block);
    totalChars += block.length;
  }
  if (blocks.length === 0) return null;

  return [
    "<pinned-context>",
    "The operator has pinned the following references. Treat them as authoritative background for this agent.",
    ...blocks,
    "</pinned-context>",
  ].join("\n\n");
}

// ============================================================================
// Composition — the single system-prompt augmentation point
// ============================================================================

// Appends the personality block (personality.ts), the persistent-memory block
// (memory.ts), and the pinned-context block (this module) to an agent's base
// system prompt. All query() callers in server.ts use this. Order:
// base → personality → memory → pins. Personality (incl. its locked privacy +
// boundary sections) sits right after the base prompt as foundational
// behavior; memory and pins are context that sits closest to the user turn.
export function augmentedSystemPrompt(agentId: string, basePrompt: string): string {
  const parts = [basePrompt];
  const personality = buildPersonalityPrompt(agentId);
  if (personality) parts.push(personality);
  const mem = memoryBlockFor(agentId);
  if (mem) parts.push(mem);
  const pins = pinnedBlockFor(agentId);
  if (pins) parts.push(pins);
  return parts.join("\n\n");
}
