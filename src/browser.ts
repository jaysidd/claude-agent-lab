// Browser automation — per-agent toggle that gives an agent a real browser
// (via the official Playwright MCP server) behind an allow-list permission gate.
//
// A browsing agent is the single highest-risk surface in any agent app: a
// visited page is untrusted input that can carry prompt-injection, and an
// unguarded browser is an SSRF cannon into localhost + the LAN + cloud
// metadata. Containment here is ALLOW-LIST ONLY (there is no "open" mode):
//
//   1. Allow-list (authoritative) — an agent may only navigate to domains the
//      operator explicitly added. The PreToolUse hook on `browser_navigate`
//      runs isUrlAllowed(), which (a) enforces a hard floor — http/https only,
//      no localhost / RFC1918 / link-local / cloud-metadata, with real IPv4 +
//      IPv4-mapped-IPv6 parsing so obfuscated forms (decimal, hex, ::ffff:...)
//      are caught — and (b) requires a domain match.
//   2. Playwright layer (defense-in-depth) — the server runs `--isolated`
//      (fresh profile, no access to your real browser cookies),
//      `--block-service-workers`, `--allowed-origins` (the operator's domains),
//      and `--blocked-origins` (the floor literals).
//
// HONEST RESIDUAL (security audit S1): Playwright's origin flags are explicitly
// NOT a hard security boundary and do not gate in-page link-CLICKS or HTTP
// REDIRECTS. The PreToolUse hook only fires on explicit `browser_navigate`. So
// a malicious or compromised ALLOW-LISTED page that redirects/links to a
// private address is not individually re-gated. The mitigation is the model:
// only allow-list domains you trust. Fully closing this needs a connect-time
// IP-filtering egress proxy — a future enhancement, tracked in the backlog.

import { randomUUID } from "node:crypto";
import { db } from "./memory.js";

// ============================================================================
// Schema
// ============================================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS browser_agents (
    agent_id            TEXT PRIMARY KEY,
    enabled             INTEGER NOT NULL DEFAULT 0,
    mode                TEXT NOT NULL DEFAULT 'allowlist',  -- 'allowlist' | 'open'
    headless            INTEGER NOT NULL DEFAULT 1,
    allowed_domains_json TEXT NOT NULL DEFAULT '[]',
    updated_at          INTEGER NOT NULL
  );
`);

// ============================================================================
// Types
// ============================================================================

export type BrowserMode = "allowlist" | "open";

export type BrowserConfig = {
  agentId: string;
  enabled: boolean;
  mode: BrowserMode;
  headless: boolean;
  allowedDomains: string[];
  updatedAt: number;
};

// ============================================================================
// Hard deny-list (the floor — enforced in BOTH modes, cannot be allow-listed)
// ============================================================================

// Hostnames / protocols that are never reachable, regardless of allow-list.
// These protect against SSRF into the local machine + LAN and against
// non-web schemes.
const DENY_PROTOCOLS = new Set([
  "file:",
  "chrome:",
  "chrome-extension:",
  "about:",
  "data:",
  "view-source:",
  "ftp:",
  "ws:",
  "wss:",
]);

const DENY_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "::1",
  "[::1]",
  "metadata.google.internal", // cloud metadata endpoints
]);

// ============================================================================
// URL gate
// ============================================================================

// Parse a possibly-obfuscated IPv4 hostname into its dotted form, or null if
// it isn't an IPv4 literal. Handles dotted decimal, single-integer decimal
// (e.g. 2130706433 == 127.0.0.1), and hex (0x7f000001).
function toIPv4(hostname: string): string | null {
  const h = hostname.trim().toLowerCase();
  // dotted quad
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const parts = h.split(".").map(Number);
    if (parts.every((p) => p >= 0 && p <= 255)) return parts.join(".");
    return null;
  }
  // single decimal integer
  if (/^\d{1,10}$/.test(h)) {
    const n = Number(h);
    if (Number.isInteger(n) && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
    }
    return null;
  }
  // hex (0x...)
  if (/^0x[0-9a-f]+$/.test(h)) {
    const n = parseInt(h, 16);
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
    }
    return null;
  }
  return null;
}

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 0) return true; // "this" network
  return false;
}

// Does a hostname fall under an allowed domain? Exact match or subdomain.
// "github.com" allows "github.com" and "api.github.com" but NOT "notgithub.com".
function hostMatchesDomain(hostname: string, domain: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  const d = domain.toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!d) return false;
  return h === d || h.endsWith("." + d);
}

export type GateResult = { allowed: boolean; reason: string };

// The authoritative gate. Used by the PreToolUse hook on browser_navigate.
export function isUrlAllowed(agentId: string, rawUrl: string): GateResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: `unparseable URL: ${String(rawUrl).slice(0, 120)}` };
  }

  // Protocol floor — only http/https reach the network; everything else denied.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, reason: `blocked protocol: ${url.protocol}` };
  }
  if (DENY_PROTOCOLS.has(url.protocol)) {
    return { allowed: false, reason: `blocked protocol: ${url.protocol}` };
  }

  // Normalize: strip IPv6 brackets AND a single trailing dot ("localhost." and
  // "127.0.0.1." both resolve to the bare host but dodge naive string checks).
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

  // Hostname floor (localhost, IPv6 loopback/unspecified, cloud metadata host).
  if (DENY_HOSTNAMES.has(hostname)) {
    return { allowed: false, reason: `blocked host: ${hostname}` };
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { allowed: false, reason: "blocked host: localhost" };
  }
  if (hostname === "::" || hostname === "::1") {
    return { allowed: false, reason: `blocked IPv6 loopback/unspecified: ${hostname}` };
  }

  // Private/loopback IPv4 floor (handles dotted, decimal, and hex obfuscation).
  const ipv4 = toIPv4(hostname);
  if (ipv4 && isPrivateIPv4(ipv4)) {
    return { allowed: false, reason: `blocked private address: ${hostname} (${ipv4})` };
  }

  // IPv6 floor. Unique-local (fc00::/7), link-local (fe80::/10), AND
  // IPv4-mapped / NAT64 forms whose embedded IPv4 is private — the latter is
  // the class that bypassed an earlier version (Node emits `::ffff:7f00:1`
  // for `::ffff:127.0.0.1`, and `::ffff:a9fe:a9fe` is the 169.254.169.254
  // cloud-metadata address). Security audit S2/S3.
  if (hostname.includes(":")) {
    if (/^f[cd]/i.test(hostname) || /^fe[89ab]/i.test(hostname)) {
      return { allowed: false, reason: `blocked private IPv6: ${hostname}` };
    }
    const embedded = ipv6EmbeddedIPv4(hostname);
    if (embedded && isPrivateIPv4(embedded)) {
      return { allowed: false, reason: `blocked IPv4-mapped IPv6: ${hostname} (${embedded})` };
    }
  }

  // Allow-list gate. (There is no "open"/allow-everything mode: a browser that
  // can follow links to arbitrary hosts is an SSRF risk that Playwright's
  // origin flags do NOT fully contain — they are explicitly not a security
  // boundary and do not gate redirects/clicks. So an agent may only navigate
  // to domains the operator explicitly allow-listed. See the module header.)
  const config = getBrowserConfig(agentId);
  for (const domain of config.allowedDomains) {
    if (hostMatchesDomain(hostname, domain)) {
      return { allowed: true, reason: `allow-listed: ${domain}` };
    }
  }
  return {
    allowed: false,
    reason: `${hostname} is not in this agent's browser allow-list. Add it in the Browser panel.`,
  };
}

// Extract an embedded IPv4 from an IPv4-mapped (::ffff:...) or NAT64
// (64:ff9b::...) IPv6 host, in either dotted (::ffff:127.0.0.1) or the
// compressed-hex form Node actually emits (::ffff:7f00:1). Returns null when
// the host is not one of those mapped forms, so genuine public IPv6 literals
// are not misread.
function ipv6EmbeddedIPv4(host: string): string | null {
  const h = host.toLowerCase();
  const isMapped = h.startsWith("::ffff:") || h.startsWith("64:ff9b:") || h.includes("::ffff:");
  if (!isMapped) return null;
  // trailing dotted quad: ::ffff:127.0.0.1
  const dotted = h.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const p = dotted.slice(1).map(Number);
    if (p.every((x) => x >= 0 && x <= 255)) return p.join(".");
  }
  // trailing two hex groups: ::ffff:7f00:1
  const hex = h.match(/:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const h1 = parseInt(hex[1], 16);
    const h2 = parseInt(hex[2], 16);
    return [(h1 >> 8) & 255, h1 & 255, (h2 >> 8) & 255, h2 & 255].join(".");
  }
  return null;
}

// ============================================================================
// CRUD
// ============================================================================

function rowToConfig(r: any): BrowserConfig {
  let domains: string[] = [];
  try {
    const v = JSON.parse(r.allowed_domains_json);
    if (Array.isArray(v)) domains = v.map(String);
  } catch {
    /* default [] */
  }
  return {
    agentId: r.agent_id,
    enabled: r.enabled === 1,
    mode: r.mode === "open" ? "open" : "allowlist",
    headless: r.headless === 1,
    allowedDomains: domains,
    updatedAt: r.updated_at,
  };
}

export function getBrowserConfig(agentId: string): BrowserConfig {
  const r = db.prepare("SELECT * FROM browser_agents WHERE agent_id = ?").get(agentId);
  if (r) return rowToConfig(r);
  // Default (disabled) config for an agent with no row yet.
  return {
    agentId,
    enabled: false,
    mode: "allowlist",
    headless: true,
    allowedDomains: [],
    updatedAt: 0,
  };
}

export function setBrowserConfig(
  agentId: string,
  patch: Partial<Pick<BrowserConfig, "enabled" | "mode" | "headless" | "allowedDomains">>,
): BrowserConfig {
  const current = getBrowserConfig(agentId);
  const next: BrowserConfig = {
    ...current,
    ...patch,
    agentId,
    updatedAt: Date.now(),
  };
  // Mode is always "allowlist" — the "open" (allow-everything-but-the-floor)
  // mode was removed after the security audit (S1): a browser that can follow
  // links/redirects to arbitrary hosts is an SSRF risk Playwright's flags don't
  // contain. The column is kept for forward-compat but coerced here.
  next.mode = "allowlist";
  // Normalize domains: trim, lowercase, strip scheme/path, dedupe, drop empties.
  next.allowedDomains = Array.from(
    new Set(
      (next.allowedDomains ?? [])
        .map((d) => normalizeDomain(d))
        .filter(Boolean),
    ),
  );
  db.prepare(
    `INSERT INTO browser_agents (agent_id, enabled, mode, headless, allowed_domains_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       enabled = excluded.enabled,
       mode = excluded.mode,
       headless = excluded.headless,
       allowed_domains_json = excluded.allowed_domains_json,
       updated_at = excluded.updated_at`,
  ).run(
    agentId,
    next.enabled ? 1 : 0,
    next.mode,
    next.headless ? 1 : 0,
    JSON.stringify(next.allowedDomains),
    next.updatedAt,
  );
  return next;
}

// Strip a user-entered domain down to a bare host: "https://GitHub.com/foo" -> "github.com".
export function normalizeDomain(input: string): string {
  let s = (input ?? "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z]+:\/\//, ""); // scheme
  s = s.split("/")[0]; // path
  s = s.split("@").pop() ?? s; // userinfo
  s = s.split(":")[0]; // port
  s = s.replace(/^\.+|\.+$/g, ""); // leading/trailing dots
  return s;
}

// ============================================================================
// Runtime composition — spread into query() options when browser is enabled
// ============================================================================

const PLAYWRIGHT_PKG = "@playwright/mcp@latest";

// Best-effort origin floor passed to Playwright (defense-in-depth for
// link-click navigation; the hook is the authoritative private-IP check).
const BLOCKED_ORIGIN_FLOOR = [
  "http://localhost",
  "https://localhost",
  "http://127.0.0.1",
  "https://127.0.0.1",
  "http://0.0.0.0",
  // Common LAN gateway/admin + cloud metadata literals (origins support no
  // CIDR, so this is best-effort; the allow-list is the real containment).
  "http://169.254.169.254",
  "http://192.168.0.1",
  "http://192.168.1.1",
  "http://10.0.0.1",
].join(";");

function playwrightServerConfig(config: BrowserConfig): {
  type: "stdio";
  command: string;
  args: string[];
} {
  const args = ["-y", PLAYWRIGHT_PKG, "--isolated", "--block-service-workers"];
  if (config.headless) args.push("--headless");
  // Defense-in-depth floor. Playwright's docs are explicit that origin lists
  // are NOT a hard security boundary and do not gate redirects, so this is a
  // helper layer, not the authoritative control — the allow-list + the
  // PreToolUse hook are. Origins support no CIDR, so we list common private
  // gateways + the metadata IP literally; the real containment is the
  // allow-list (--allowed-origins below) restricting the browser to the
  // operator's chosen domains.
  args.push("--blocked-origins", BLOCKED_ORIGIN_FLOOR);
  // Allow-list always applies (no open mode). Restrict the browser to exactly
  // the operator's domains (http + https). If zero domains, pass a sentinel
  // that matches nothing so the agent has browser tools but no destinations
  // until the operator adds one.
  const origins = config.allowedDomains.flatMap((d) => [`https://${d}`, `http://${d}`]);
  args.push("--allowed-origins", origins.length ? origins.join(";") : "https://invalid.invalid");
  return { type: "stdio", command: "npx", args };
}

// Returns the Playwright MCP server + allow-token to spread into query()
// options when the agent has browser enabled, else null.
export function browserOptionsFor(
  agentId: string,
): { servers: Record<string, ReturnType<typeof playwrightServerConfig>>; allowTokens: string[] } | null {
  const config = getBrowserConfig(agentId);
  if (!config.enabled) return null;
  return {
    servers: { browser: playwrightServerConfig(config) },
    allowTokens: ["mcp__browser"],
  };
}

// The tool name the guard hook matches (explicit navigation).
export const BROWSER_NAV_TOOL = "mcp__browser__browser_navigate";

// Re-exported for tests.
export const __INTERNALS__ = { toIPv4, isPrivateIPv4, hostMatchesDomain, BLOCKED_ORIGIN_FLOOR };
