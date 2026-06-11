// Skill install + scan — the "Skills Studio" backend. Companion to skills.ts
// (which only DISCOVERS + toggles skills already on disk). This module lets the
// operator CREATE skills from the UI: author one in the Skill Builder, install
// one from the bundled starter pack, or paste an external SKILL.md.
//
// Deliberate scope (see .notes/clawless-port-analysis.md §3b): we do NOT port
// Clawless's ClawHub registry — its skills use OpenClaw's tool vocabulary
// (`fs_write_file`/`cmd_bash`/`browser_open`) that doesn't exist in the Claude
// Agent SDK, so a fetch-and-install would produce broken skills. What ports
// cleanly is the *install-review UX* and a *static security scan*. There is NO
// VirusTotal layer: it's useless on instruction text (AV engines match malware
// binaries, not harmful instructions) and uploading a SKILL.md off-device would
// violate the LOCKED_PRIVACY guarantee personality.ts enshrines.
//
// SECURITY FLOOR: every path that writes or deletes resolves the target and
// verifies it stays inside the user skills root (~/.claude/skills) — the same
// resolve + prefix-check pattern browser.ts uses for SSRF. A slug is confined
// to [a-z0-9-]; anything else (../, absolute, encoded, empty) is rejected.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// Roots
// ============================================================================

// Skills install to the USER root, not cwd/.claude/skills. The user root is
// stable across projects ("skills I installed" stay visible no matter which
// folder an agent is pointed at); cwd-scoped skills would vanish when you
// switch projects. discoverSkills() in skills.ts already reads this location.
const USER_SKILLS_ROOT = path.join(os.homedir(), ".claude", "skills");

// Bundled starter pack — SDK-native skills shipped in the repo for genuine
// one-click install. Resolved relative to this module so it works regardless of
// cwd. (this file: src/skillInstall.ts → ../assets/starter-skills)
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const STARTER_ROOT = path.resolve(MODULE_DIR, "..", "assets", "starter-skills");

const NAME_MAX = 64;
const DESC_MAX = 1024;
const BODY_MAX = 64_000;

// ============================================================================
// Types
// ============================================================================

export type Severity = "high" | "medium" | "low";

export type ScanFinding = {
  severity: Severity;
  rule: string; // human-readable rule name
  line: number; // 1-based line number in the scanned text
  snippet: string; // the offending line, trimmed + length-capped
};

export type ScanResult = {
  findings: ScanFinding[];
  maxSeverity: Severity | null; // null = clean
  scanned: true; // always true — signals the scan actually ran (vs skipped)
};

export type InstallInput = {
  name: string;
  description: string;
  allowedTools?: string[];
  body: string;
};

export type InstalledSkill = {
  slug: string;
  name: string;
  description: string;
  path: string;
};

export type StarterSkill = {
  id: string; // directory name under assets/starter-skills
  name: string;
  description: string;
  allowedTools: string[];
  body: string;
  installed: boolean; // already present in the user skills root?
};

// ============================================================================
// Slug + path confinement — the security floor
// ============================================================================

// Reduce a display name to a filesystem-safe slug. Lowercase, non-alnum → '-',
// collapse repeats, trim leading/trailing '-'. Returns "" if nothing survives
// (e.g. a name that's all punctuation) so callers can reject it.
export function slugify(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NAME_MAX);
}

// Resolve a slug to its skill directory and PROVE the result stays inside the
// user skills root. Throws on any escape attempt. This is the single gate every
// write/delete goes through. We re-slugify and require the input to already BE
// its own slug, so "../x", "/etc", "%2e%2e", ".", ".." all fail before we even
// touch the filesystem.
export function resolveSkillDir(slug: string): string {
  const clean = slugify(slug);
  if (!clean || clean !== slug) {
    throw new Error("invalid skill id");
  }
  const dir = path.resolve(USER_SKILLS_ROOT, clean);
  // Prefix-check against the root WITH a trailing separator so a sibling like
  // "<root>-evil" can't masquerade as inside the root.
  if (dir !== path.join(USER_SKILLS_ROOT, clean) || !dir.startsWith(USER_SKILLS_ROOT + path.sep)) {
    throw new Error("skill path escapes skills root");
  }
  return dir;
}

// Is this SKILL.md path one we installed (i.e. under the user skills root)?
// Used to decide whether the UI may delete it. Path-based rather than relying
// on the discovery "source" label, because when cwd == homedir the project and
// user skill roots collide and discovery labels everything "project".
export function isUserInstalledSkillPath(skillMdPath: string): boolean {
  const resolved = path.resolve(skillMdPath);
  return resolved.startsWith(USER_SKILLS_ROOT + path.sep);
}

// ============================================================================
// Static security scan — a heuristic lint, NOT a sandbox
// ============================================================================

// Each rule is a regex + severity. Matched line-by-line so we can report a line
// number. These catch the obvious dangerous patterns in skill instructions;
// they are advisory (a skill is just text until an agent acts on it), so the UI
// frames findings as "review these", not "this is malware".
const SCAN_RULES: { severity: Severity; rule: string; re: RegExp }[] = [
  // HIGH — remote-code-execution and exfiltration shapes
  { severity: "high", rule: "Pipe remote download into a shell", re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/i },
  { severity: "high", rule: "Decode base64 into a shell", re: /base64\s+(-d|--decode)[^\n|]*\|\s*(ba)?sh\b/i },
  { severity: "high", rule: "Reverse shell via /dev/tcp", re: /\/dev\/(tcp|udp)\//i },
  { severity: "high", rule: "Netcat with command execution", re: /\bnc\b[^\n]*\s-[a-z]*e\b/i },
  { severity: "high", rule: "Recursive force-delete", re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i },
  { severity: "high", rule: "Write to SSH authorized_keys", re: /\.ssh\/authorized_keys/i },
  { severity: "high", rule: "Dynamic eval of a string", re: /\beval\s*\(|\beval\s+["'$]/i },
  // MEDIUM — privilege, persistence, credential reads
  { severity: "medium", rule: "Elevated privileges (sudo)", re: /\bsudo\b/i },
  { severity: "medium", rule: "Edit shell startup file", re: />>?\s*~?\/?\.?(bashrc|zshrc|profile|bash_profile)\b/i },
  { severity: "medium", rule: "Modify crontab", re: /\bcrontab\b/i },
  { severity: "medium", rule: "Read cloud / credential files", re: /\.aws\/credentials|\.config\/gcloud|\.npmrc|(^|\/)\.env\b/i },
  { severity: "medium", rule: "Network call to a raw IP address", re: /\b(curl|wget|fetch)\b[^\n]*https?:\/\/\d{1,3}(\.\d{1,3}){3}/i },
  { severity: "medium", rule: "macOS AppleScript execution", re: /\bosascript\b/i },
  // LOW — worth a glance
  { severity: "low", rule: "Unencrypted http:// URL", re: /\bhttp:\/\//i },
  { severity: "low", rule: "Shell-out keyword", re: /\bchild_process\b|\bexecSync\b|\bspawnSync\b/i },
];

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

export function scanSkillContent(text: string): ScanResult {
  const findings: ScanFinding[] = [];
  const lines = (text ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of SCAN_RULES) {
      if (rule.re.test(line)) {
        findings.push({
          severity: rule.severity,
          rule: rule.rule,
          line: i + 1,
          snippet: line.trim().slice(0, 200),
        });
      }
    }
  }
  let maxSeverity: Severity | null = null;
  for (const f of findings) {
    if (!maxSeverity || SEVERITY_RANK[f.severity] > SEVERITY_RANK[maxSeverity]) {
      maxSeverity = f.severity;
    }
  }
  return { findings, maxSeverity, scanned: true };
}

// ============================================================================
// Frontmatter assembly
// ============================================================================

// Build a valid SDK-native SKILL.md. Frontmatter VALUES are flattened to a
// single line and quoted so a newline or stray `---` in name/description can't
// inject extra frontmatter or break the fence. The body is written verbatim
// below the fence — it's instructions, not config, so it isn't sanitized (just
// length-capped). allowed-tools is emitted only when present.
function buildSkillMd(input: InstallInput): string {
  const name = oneLine(input.name).slice(0, NAME_MAX);
  const description = oneLine(input.description).slice(0, DESC_MAX);
  const tools = (input.allowedTools ?? [])
    .map((t) => oneLine(t))
    .filter((t) => /^[A-Za-z0-9_:.*-]+$/.test(t)); // token-shaped only
  const body = (input.body ?? "").slice(0, BODY_MAX);

  const fm: string[] = ["---", `name: ${yamlString(name)}`, `description: ${yamlString(description)}`];
  if (tools.length) fm.push(`allowed-tools: ${tools.join(", ")}`);
  fm.push("---");
  return `${fm.join("\n")}\n\n${body.trim()}\n`;
}

function oneLine(s: string): string {
  return (s ?? "").replace(/[\r\n]+/g, " ").trim();
}

// Double-quote a YAML scalar, escaping backslashes and quotes. Safe for the
// single-line values we emit (no control chars survive oneLine()).
function yamlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ============================================================================
// Install / delete
// ============================================================================

export function installSkill(input: InstallInput, opts: { force?: boolean } = {}): InstalledSkill {
  const name = oneLine(input.name);
  if (!name) throw new Error("name required");
  const slug = slugify(name);
  if (!slug) throw new Error("name must contain at least one letter or number");
  const description = oneLine(input.description);
  if (!description) throw new Error("description required");
  if (!oneLine(input.body)) throw new Error("instructions (body) required");

  const dir = resolveSkillDir(slug);
  const skillMd = path.join(dir, "SKILL.md");
  if (fs.existsSync(skillMd) && !opts.force) {
    throw new Error(`a skill named "${slug}" already exists`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(skillMd, buildSkillMd({ ...input, name, description }), "utf8");
  return { slug, name, description, path: skillMd };
}

// Remove an installed skill directory. Confined to the user skills root by
// resolveSkillDir; refuses if the target isn't a directory we'd recognize as a
// skill (must contain SKILL.md) so a bad slug can't nuke an unrelated folder.
// Returns the skill's frontmatter `name` (so the caller can clear per-agent
// enabled rows keyed on that name), or null if nothing was removed.
export function deleteSkill(slug: string): { removed: boolean; name: string | null } {
  const dir = resolveSkillDir(slug);
  if (!fs.existsSync(dir)) return { removed: false, name: null };
  const skillMd = path.join(dir, "SKILL.md");
  const stat = fs.statSync(dir);
  if (!stat.isDirectory() || !fs.existsSync(skillMd)) {
    throw new Error("target is not an installed skill");
  }
  let name: string | null = null;
  try {
    name = parseSkillMd(fs.readFileSync(skillMd, "utf8")).name || null;
  } catch {
    /* best-effort — deletion still proceeds */
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { removed: true, name };
}

// ============================================================================
// Starter pack
// ============================================================================

// Parse name/description/allowed-tools out of a SKILL.md, plus return the body.
// Mirrors the light regex parse in skills.ts (no YAML dep) and adds tools+body.
export function parseSkillMd(text: string): {
  name: string;
  description: string;
  allowedTools: string[];
  body: string;
} {
  const fm = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const head = fm ? fm[1] : "";
  const body = fm ? fm[2] : text;
  const strip = (s: string) => s.replace(/^["']|["']$/g, "").trim();
  const nameM = head.match(/^\s*name\s*:\s*(.+?)\s*$/m);
  const descM = head.match(/^\s*description\s*:\s*(.+?)\s*$/m);
  const toolsM = head.match(/^\s*allowed-tools\s*:\s*(.+?)\s*$/m);
  return {
    name: nameM ? strip(nameM[1]) : "",
    description: descM ? strip(descM[1]) : "",
    allowedTools: toolsM
      ? strip(toolsM[1])
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [],
    body: body.trim(),
  };
}

export function listStarterSkills(): StarterSkill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(STARTER_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: StarterSkill[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillMd = path.join(STARTER_ROOT, e.name, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;
    let text = "";
    try {
      text = fs.readFileSync(skillMd, "utf8");
    } catch {
      continue;
    }
    const parsed = parseSkillMd(text);
    const installedDir = path.resolve(USER_SKILLS_ROOT, slugify(parsed.name || e.name));
    out.push({
      id: e.name,
      name: parsed.name || e.name,
      description: parsed.description,
      allowedTools: parsed.allowedTools,
      body: parsed.body,
      installed: fs.existsSync(path.join(installedDir, "SKILL.md")),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Install a starter by its directory id. Reads the bundled SKILL.md and writes
// it into the user root via installSkill (so it goes through the same scan-able
// content + path floor). The starter id is confined the same way as a slug.
export function installStarterSkill(id: string, opts: { force?: boolean } = {}): InstalledSkill {
  const cleanId = slugify(id);
  if (!cleanId || cleanId !== id) throw new Error("invalid starter id");
  const skillMd = path.join(STARTER_ROOT, cleanId, "SKILL.md");
  if (!fs.existsSync(skillMd)) throw new Error("unknown starter skill");
  const parsed = parseSkillMd(fs.readFileSync(skillMd, "utf8"));
  return installSkill(
    {
      name: parsed.name || cleanId,
      description: parsed.description,
      allowedTools: parsed.allowedTools,
      body: parsed.body,
    },
    opts,
  );
}

// Re-exported for tests.
export const __INTERNALS__ = {
  USER_SKILLS_ROOT,
  STARTER_ROOT,
  buildSkillMd,
  parseSkillMd,
  SCAN_RULES,
};
