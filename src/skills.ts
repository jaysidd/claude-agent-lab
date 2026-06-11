// Skills panel — surface the Agent Skills discovered in the current working
// directory (`{cwd}/.claude/skills/*/SKILL.md`) and the user home
// (`~/.claude/skills/*/SKILL.md`), and let the operator enable them per agent.
//
// The SDK loads skills only when `settingSources` includes 'project'/'user',
// and the `skills` option filters WHICH discovered skills load into the system
// prompt. So an agent with enabled skills runs with:
//     settingSources: ['project', 'user'], skills: [enabled names]
// An agent with none keeps the current behavior (no settingSources, no skills).
//
// Discovery is a filesystem scan (no query() burn). We parse the name +
// description from each SKILL.md frontmatter with a light regex (no YAML dep).
//
// Imports `db` from memory.ts (one-directional).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "./memory.js";

// ============================================================================
// Schema — which skills are enabled per agent (presence of a row = enabled)
// ============================================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id    TEXT NOT NULL,
    skill_name  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (agent_id, skill_name)
  );
`);

// ============================================================================
// Types
// ============================================================================

export type DiscoveredSkill = {
  name: string;
  description: string;
  source: "project" | "user";
  path: string;
};

// ============================================================================
// Discovery
// ============================================================================

// Pull `name:` and `description:` out of a SKILL.md YAML frontmatter block
// without a YAML dependency. Falls back to the directory name if `name:` is
// absent.
function parseFrontmatter(
  filePath: string,
  dirName: string,
): { name: string; description: string } {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8").slice(0, 4000);
  } catch {
    return { name: dirName, description: "" };
  }
  const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
  const body = fm ? fm[1] : text;
  const nameM = body.match(/^\s*name\s*:\s*(.+?)\s*$/m);
  const descM = body.match(/^\s*description\s*:\s*(.+?)\s*$/m);
  const strip = (s: string) => s.replace(/^["']|["']$/g, "").trim();
  return {
    name: nameM ? strip(nameM[1]) : dirName,
    description: descM ? strip(descM[1]) : "",
  };
}

function scanSkillsDir(baseDir: string, source: "project" | "user"): DiscoveredSkill[] {
  const skillsRoot = path.join(baseDir, ".claude", "skills");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return []; // no skills dir — fine
  }
  const out: DiscoveredSkill[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillMd = path.join(skillsRoot, e.name, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;
    const { name, description } = parseFrontmatter(skillMd, e.name);
    out.push({ name, description, source, path: skillMd });
  }
  return out;
}

// Discover skills visible from a given cwd. Project skills (cwd/.claude/skills)
// shadow user skills (~/.claude/skills) on name collision, matching how the
// SDK resolves them.
export function discoverSkills(cwd: string): DiscoveredSkill[] {
  const project = scanSkillsDir(cwd, "project");
  const user = scanSkillsDir(os.homedir(), "user");
  const seen = new Set(project.map((s) => s.name));
  const merged = [...project];
  for (const u of user) {
    if (!seen.has(u.name)) {
      merged.push(u);
      seen.add(u.name);
    }
  }
  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================================
// Per-agent enabled set
// ============================================================================

export function enabledSkillsFor(agentId: string): string[] {
  const rows = db
    .prepare("SELECT skill_name FROM agent_skills WHERE agent_id = ? ORDER BY skill_name")
    .all(agentId) as { skill_name: string }[];
  return rows.map((r) => r.skill_name);
}

export function setSkillEnabled(agentId: string, skillName: string, enabled: boolean): void {
  if (enabled) {
    db.prepare(
      "INSERT OR IGNORE INTO agent_skills (agent_id, skill_name, created_at) VALUES (?, ?, ?)",
    ).run(agentId, skillName, Date.now());
  } else {
    db.prepare("DELETE FROM agent_skills WHERE agent_id = ? AND skill_name = ?").run(
      agentId,
      skillName,
    );
  }
}

// Remove a skill's enabled rows across ALL agents — called when the skill is
// deleted from disk so a stale row can't keep flipping settingSources on for a
// skill that no longer exists (the R1 blast-radius note above). Returns the
// number of rows cleared.
export function clearSkillEverywhere(skillName: string): number {
  const r = db.prepare("DELETE FROM agent_skills WHERE skill_name = ?").run(skillName);
  return r.changes;
}

// ============================================================================
// Runtime composition — spread into query() options
// ============================================================================

// When the agent has ≥1 enabled skill, returns the settingSources needed for
// discovery plus the skill name filter. Otherwise returns {} (no behavior
// change — skills stay off for agents that haven't opted in).
//
// ⚠️ BLAST RADIUS (Reviewer R1): `settingSources: ['project','user']` does more
// than load skills — it makes the SDK also load project/user `CLAUDE.md`,
// `.mcp.json`, and hooks for this query. That's wider than "turn on a skill,"
// and the `.mcp.json` load can overlap with Feature 2's per-agent MCP config.
// It's strictly opt-in (only fires when the operator enables a skill on this
// agent), which we accept under the personal-use model. A stale agent_skills
// row (skill deleted from disk) would still flip settingSources on for zero
// benefit — tracked as a backlog watch-list item; intersect against
// discoverSkills(cwd) if that becomes a problem.
export function skillsOptionsFor(
  agentId: string,
): { settingSources?: ("project" | "user")[]; skills?: string[] } {
  const enabled = enabledSkillsFor(agentId);
  if (enabled.length === 0) return {};
  return {
    settingSources: ["project", "user"],
    skills: enabled,
  };
}
