import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AGENTS, MODELS } from "./agents.js";
import {
  allAgents,
  findAgent,
  isBuiltInAgent,
  subAgentsFor,
  builtInIds,
} from "./agentRegistry.js";
import {
  createCustomAgent,
  updateCustomAgent,
  deleteCustomAgent,
  findCustomAgent,
} from "./customAgents.js";

// Minimal .env loader (no dep). Runs before any env usage below.
(() => {
  const envPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    ".env",
  );
  try {
    const raw = fsSync.readFileSync(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    /* no .env file; env-only is fine */
  }
})();
import {
  listMemories,
  createMemory,
  deleteMemory,
  augmentedSystemPrompt,
} from "./memory.js";
import {
  maskedSettings,
  setSetting,
  deleteSetting,
  configValue,
  SETTINGS_SCHEMA,
} from "./settings.js";
import {
  appendTurn,
  listSessions,
  getSession,
  getSessionMessages,
  setSessionTitle,
  deleteSession,
} from "./sessions.js";

type TaskPriority = "low" | "medium" | "high";
type TaskStatus = "queued" | "active" | "done" | "error";
type Task = {
  id: string;
  description: string;
  priority: TaskPriority;
  assignedAgent: string;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const sessionByAgent = new Map<string, string>();
const modelOverride = new Map<string, string>();
const planMode = new Map<string, boolean>();
const tasks = new Map<string, Task>();
let currentCwd = os.homedir();

async function classifyTask(description: string): Promise<string> {
  const systemPrompt = `You classify user tasks to exactly one of these specialists:
- main — general questions, planning, chat, cross-specialist triage
- comms — emails, messages, outreach, customer replies, social posts
- content — YouTube scripts, blog posts, titles, hooks, creative writing, thumbnails
- ops — reading local files, summarizing a project folder, file search

Respond with exactly ONE word: main, comms, content, or ops. No punctuation, no explanation.`;

  let chosen = "main";
  try {
    for await (const msg of query({
      prompt: `Task: ${description}`,
      options: {
        systemPrompt,
        model: "claude-haiku-4-5",
        allowedTools: [],
      },
    })) {
      const anyMsg = msg as any;
      if ("result" in anyMsg && typeof anyMsg.result === "string") {
        const raw = anyMsg.result.trim().toLowerCase();
        const compact = raw.replace(/[^a-z]/g, "");
        if (AGENTS[compact]) {
          chosen = compact;
        } else {
          for (const id of Object.keys(AGENTS)) {
            if (raw.includes(id)) {
              chosen = id;
              break;
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("classifier error:", err);
  }
  return chosen;
}

function expandPath(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

function effectiveModel(agentId: string): string {
  return modelOverride.get(agentId) ?? findAgent(agentId)?.model ?? "claude-sonnet-4-6";
}

app.get("/api/agents", (_req, res) => {
  res.json(
    allAgents().map(({ id, name, emoji, accent, description, model, isRouter }) => ({
      id,
      name,
      emoji,
      accent,
      description,
      model: effectiveModel(id),
      defaultModel: model,
      isRouter: !!isRouter,
      builtIn: isBuiltInAgent(id),
    })),
  );
});

app.get("/api/models", (_req, res) => {
  res.json(MODELS);
});

app.post("/api/model/:agentId", (req, res) => {
  const agentId = req.params.agentId;
  if (!findAgent(agentId)) return res.status(400).json({ error: "unknown agent" });
  const { model } = req.body ?? {};
  if (!model || typeof model !== "string") {
    modelOverride.delete(agentId);
  } else {
    modelOverride.set(agentId, model);
  }
  sessionByAgent.delete(agentId);
  res.json({ agentId, model: effectiveModel(agentId) });
});

app.get("/api/cwd", (_req, res) => {
  res.json({ cwd: currentCwd, home: os.homedir() });
});

app.post("/api/cwd", async (req, res) => {
  const raw = req.body?.path;
  if (typeof raw !== "string" || !raw.trim()) {
    return res.status(400).json({ error: "path required" });
  }
  const expanded = path.resolve(expandPath(raw.trim()));
  try {
    const stat = await fs.stat(expanded);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: "not a directory" });
    }
    currentCwd = expanded;
    sessionByAgent.clear();
    res.json({ cwd: currentCwd });
  } catch {
    res.status(400).json({ error: "path does not exist" });
  }
});

app.get("/api/browse", async (req, res) => {
  const raw = (req.query.path as string) || currentCwd;
  const target = path.resolve(expandPath(raw));
  try {
    const entries = await fs.readdir(target, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    const parent = path.dirname(target);
    res.json({
      path: target,
      parent: parent === target ? null : parent,
      dirs,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/files", async (req, res) => {
  const q = ((req.query.q as string) ?? "").toLowerCase();
  try {
    const entries = await fs.readdir(currentCwd, { withFileTypes: true });
    const files = entries
      .filter((e) => !e.name.startsWith("."))
      .filter((e) => !q || e.name.toLowerCase().includes(q))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 15)
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    res.json({ files });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/chat", async (req, res) => {
  const { agentId, message } = req.body ?? {};
  const agent = findAgent(agentId);
  if (!agent) return res.status(400).json({ error: "unknown agent" });
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "empty message" });
  }

  const resumeId = sessionByAgent.get(agent.id);
  const modelId = effectiveModel(agent.id);
  const plan = planMode.get(agent.id) === true;
  const toolUses: Array<{ name: string; input: unknown }> = [];
  let finalText = "";
  let newSessionId: string | undefined;
  let reportedModel: string | undefined;
  let apiKeySource: string | undefined;
  let usage: any = undefined;
  let totalCostUsd: number | undefined;
  let numTurns: number | undefined;

  try {
    const subAgents = subAgentsFor(agent.id);
    for await (const msg of query({
      prompt: message,
      options: {
        allowedTools: agent.allowedTools,
        systemPrompt: augmentedSystemPrompt(agent.id, agent.systemPrompt),
        resume: resumeId,
        cwd: currentCwd,
        model: modelId,
        ...(plan ? { permissionMode: "plan" as const } : {}),
        ...(subAgents ? { agents: subAgents } : {}),
      },
    })) {
      const anyMsg = msg as any;
      if (anyMsg.type === "system" && anyMsg.subtype === "init") {
        newSessionId = anyMsg.session_id ?? anyMsg.data?.session_id;
        reportedModel = anyMsg.model ?? anyMsg.data?.model;
        apiKeySource = anyMsg.apiKeySource ?? anyMsg.data?.apiKeySource;
      }
      if (anyMsg.type === "assistant" && Array.isArray(anyMsg.message?.content)) {
        for (const block of anyMsg.message.content) {
          if (block.type === "tool_use") {
            toolUses.push({ name: block.name, input: block.input });
          }
        }
      }
      if (anyMsg.type === "result") {
        if (typeof anyMsg.result === "string") finalText = anyMsg.result;
        if (anyMsg.usage) usage = anyMsg.usage;
        if (typeof anyMsg.total_cost_usd === "number") totalCostUsd = anyMsg.total_cost_usd;
        if (typeof anyMsg.num_turns === "number") numTurns = anyMsg.num_turns;
      }
    }
  } catch (err: any) {
    console.error("chat error:", err);
    return res.status(500).json({ error: err?.message ?? "agent error" });
  }

  if (newSessionId) sessionByAgent.set(agent.id, newSessionId);

  // Persist the turn so the session shows up in History
  if (newSessionId && finalText) {
    try {
      appendTurn({
        sessionId: newSessionId,
        agentId: agent.id,
        cwd: currentCwd,
        userText: message,
        agentText: finalText,
        toolUses,
        model: reportedModel ?? modelId,
        apiKeySource,
        usage,
        totalCostUsd,
      });
    } catch (err) {
      console.error("[sessions] appendTurn failed:", err);
    }
  }

  res.json({
    reply: finalText,
    toolUses,
    cwd: currentCwd,
    model: reportedModel ?? modelId,
    apiKeySource,
    planMode: plan,
    usage,
    totalCostUsd,
    numTurns,
  });
});

app.post("/api/chat/stream", async (req, res) => {
  const { agentId, message } = req.body ?? {};
  const agent = findAgent(agentId);
  if (!agent) return res.status(400).json({ error: "unknown agent" });
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "empty message" });
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  (res as any).flushHeaders?.();

  const ac = new AbortController();
  let clientClosed = false;
  res.on("close", () => {
    if (!res.writableEnded) {
      clientClosed = true;
      ac.abort();
    }
  });

  const write = (event: any) => {
    if (clientClosed || res.writableEnded) return false;
    try {
      return res.write(JSON.stringify(event) + "\n");
    } catch {
      clientClosed = true;
      return false;
    }
  };

  const resumeId = sessionByAgent.get(agent.id);
  const modelId = effectiveModel(agent.id);
  const plan = planMode.get(agent.id) === true;
  const subAgents = subAgentsFor(agent.id);

  let newSessionId: string | undefined;
  let streamReportedModel: string | undefined;
  let streamApiKeySource: string | undefined;
  let streamUsage: any;
  let streamCost: number | undefined;
  const streamToolUses: Array<{ name: string; input: unknown }> = [];
  let streamFinalText = "";

  try {
    for await (const msg of query({
      prompt: message,
      options: {
        allowedTools: agent.allowedTools,
        systemPrompt: augmentedSystemPrompt(agent.id, agent.systemPrompt),
        resume: resumeId,
        cwd: currentCwd,
        model: modelId,
        includePartialMessages: true,
        abortController: ac,
        ...(plan ? { permissionMode: "plan" as const } : {}),
        ...(subAgents ? { agents: subAgents } : {}),
      },
    })) {
      if (clientClosed) break;
      const anyMsg = msg as any;

      if (anyMsg.type === "system" && anyMsg.subtype === "init") {
        newSessionId = anyMsg.session_id ?? anyMsg.data?.session_id;
        streamReportedModel = anyMsg.model ?? anyMsg.data?.model;
        streamApiKeySource = anyMsg.apiKeySource ?? anyMsg.data?.apiKeySource;
        write({
          kind: "init",
          sessionId: newSessionId,
          model: streamReportedModel,
          apiKeySource: streamApiKeySource,
        });
        continue;
      }

      if (anyMsg.type === "stream_event") {
        const ev = anyMsg.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          write({ kind: "text_delta", text: ev.delta.text });
        }
        continue;
      }

      if (anyMsg.type === "assistant" && Array.isArray(anyMsg.message?.content)) {
        for (const block of anyMsg.message.content) {
          if (block.type === "tool_use") {
            streamToolUses.push({ name: block.name, input: block.input });
            write({ kind: "tool_use", name: block.name, input: block.input });
          }
        }
        continue;
      }

      if (anyMsg.type === "result") {
        if (typeof anyMsg.result === "string") {
          streamFinalText = anyMsg.result;
          write({ kind: "result", text: anyMsg.result });
        }
        streamUsage = anyMsg.usage;
        streamCost = anyMsg.total_cost_usd;
        write({
          kind: "usage",
          usage: anyMsg.usage,
          totalCostUsd: anyMsg.total_cost_usd,
          numTurns: anyMsg.num_turns,
        });
      }
    }
  } catch (err: any) {
    if (err?.name !== "AbortError" && !clientClosed) {
      console.error("stream error:", err);
      write({ kind: "error", message: err?.message ?? "agent error" });
    }
  }

  if (newSessionId && !clientClosed) sessionByAgent.set(agent.id, newSessionId);

  // Persist the turn for History
  if (newSessionId && streamFinalText && !clientClosed) {
    try {
      appendTurn({
        sessionId: newSessionId,
        agentId: agent.id,
        cwd: currentCwd,
        userText: message,
        agentText: streamFinalText,
        toolUses: streamToolUses,
        model: streamReportedModel ?? modelId,
        apiKeySource: streamApiKeySource,
        usage: streamUsage,
        totalCostUsd: streamCost,
      });
    } catch (err) {
      console.error("[sessions] appendTurn (stream) failed:", err);
    }
  }

  write({ kind: "done" });
  if (!res.writableEnded) res.end();
});

app.post("/api/reset/:agentId", (req, res) => {
  sessionByAgent.delete(req.params.agentId);
  res.json({ ok: true });
});

// ----- Memory -----

app.get("/api/memories", (req, res) => {
  const agentId = (req.query.agentId as string) || undefined;
  res.json(listMemories(agentId));
});

app.post("/api/memories", (req, res) => {
  try {
    const { content, agentId, category } = req.body ?? {};
    // Validate agentId against the combined registry (built-ins + custom)
    if (agentId && !findAgent(agentId)) {
      return res.status(400).json({ error: "unknown agent" });
    }
    const mem = createMemory({
      content,
      agentId: agentId || null,
      category,
    });
    res.json(mem);
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "invalid input" });
  }
});

app.delete("/api/memories/:id", (req, res) => {
  const ok = deleteMemory(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

// ----- Plan mode -----

app.post("/api/plan/:agentId", (req, res) => {
  const agentId = req.params.agentId;
  if (!findAgent(agentId)) return res.status(400).json({ error: "unknown agent" });
  const enabled = !!req.body?.enabled;
  if (enabled) planMode.set(agentId, true);
  else planMode.delete(agentId);
  // Plan mode changes context semantics; start fresh so prior session
  // doesn't expect tools that are now disabled.
  sessionByAgent.delete(agentId);
  res.json({ agentId, enabled });
});

app.get("/api/tasks", (_req, res) => {
  res.json(Array.from(tasks.values()).sort((a, b) => b.createdAt - a.createdAt));
});

app.post("/api/task", async (req, res) => {
  const rawDesc = req.body?.description;
  if (typeof rawDesc !== "string") {
    return res.status(400).json({ error: "description must be a string" });
  }
  const description = rawDesc.trim();
  const priority = (req.body?.priority ?? "medium") as TaskPriority;
  const agentOverride = req.body?.agentId as string | undefined;
  if (!description) return res.status(400).json({ error: "description required" });
  if (!["low", "medium", "high"].includes(priority)) {
    return res.status(400).json({ error: "invalid priority" });
  }

  const assignedAgent =
    agentOverride && findAgent(agentOverride) ? agentOverride : await classifyTask(description);

  const task: Task = {
    id: randomUUID(),
    description,
    priority,
    assignedAgent,
    status: "queued",
    createdAt: Date.now(),
  };
  tasks.set(task.id, task);
  pruneCompletedTasks();
  res.json(task);
});

function pruneCompletedTasks(cap = 50) {
  const completed = Array.from(tasks.values())
    .filter((t) => t.status === "done" || t.status === "error")
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
  const excess = completed.length - cap;
  for (let i = 0; i < excess; i++) tasks.delete(completed[i].id);
}

app.post("/api/task/:id/run", async (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: "task not found" });
  if (task.status !== "queued") {
    return res.status(400).json({ error: "task already " + task.status });
  }

  const agent = findAgent(task.assignedAgent);
  if (!agent) {
    task.status = "error";
    task.error = "assigned agent no longer exists";
    return res.json(task);
  }

  task.status = "active";
  task.startedAt = Date.now();

  let finalText = "";
  const subAgents = subAgentsFor(agent.id);
  const plan = planMode.get(agent.id) === true;
  try {
    for await (const msg of query({
      prompt: task.description,
      options: {
        allowedTools: agent.allowedTools,
        systemPrompt: augmentedSystemPrompt(agent.id, agent.systemPrompt),
        cwd: currentCwd,
        model: effectiveModel(agent.id),
        ...(plan ? { permissionMode: "plan" as const } : {}),
        ...(subAgents ? { agents: subAgents } : {}),
      },
    })) {
      const anyMsg = msg as any;
      if ("result" in anyMsg && typeof anyMsg.result === "string") {
        finalText = anyMsg.result;
      }
    }
    task.status = "done";
    task.completedAt = Date.now();
    task.result = finalText;
  } catch (err: any) {
    task.status = "error";
    task.error = err?.message ?? "agent failed";
    task.completedAt = Date.now();
  }

  res.json(task);
});

app.delete("/api/task/:id", (req, res) => {
  tasks.delete(req.params.id);
  res.json({ ok: true });
});

// ----- WhisprDesk proxy (config via SQLite settings, env fallback) -----

function whisprdeskConfig() {
  const url = (configValue("whisprdesk.url", "WHISPRDESK_URL") ?? "http://127.0.0.1:9879").replace(
    /\/+$/,
    "",
  );
  const token = configValue("whisprdesk.token", "WHISPRDESK_TOKEN") ?? "";
  return { url, token };
}

app.get("/api/whisprdesk/status", async (_req, res) => {
  const { url, token } = whisprdeskConfig();
  if (!token) {
    return res.json({ configured: false });
  }
  try {
    const r = await fetch(`${url}/v1/status`);
    const body = await r.json().catch(() => ({}));
    res.json({ configured: true, reachable: r.ok, upstream: body });
  } catch (err: any) {
    res.json({ configured: true, reachable: false, error: err?.message ?? "fetch failed" });
  }
});

app.post(
  "/api/whisprdesk/transcribe",
  express.raw({ type: "*/*", limit: "30mb" }),
  async (req, res) => {
    const { url, token } = whisprdeskConfig();
    if (!token) return res.status(400).json({ error: "WhisprDesk token not set" });
    const audio = req.body as Buffer;
    if (!audio || !audio.length) return res.status(400).json({ error: "empty body" });

    const contentType = (req.headers["content-type"] as string) ?? "audio/webm";
    console.log(
      `[whisprdesk] transcribe: ${audio.length} bytes, content-type=${contentType}`,
    );

    try {
      const upstream = await fetch(`${url}/v1/transcribe`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": contentType,
        },
        body: new Uint8Array(audio),
      });
      const upstreamCT = upstream.headers.get("content-type") ?? "application/json";
      const text = await upstream.text();

      if (!upstream.ok) {
        console.error(
          `[whisprdesk] upstream ${upstream.status} (${upstreamCT}): ${text.slice(0, 500)}`,
        );
        // Surface the real upstream error to the browser so alerts are useful
        let upstreamError: any;
        try {
          upstreamError = JSON.parse(text);
        } catch {
          upstreamError = { raw: text.slice(0, 500) };
        }
        return res.status(502).json({
          error: `WhisprDesk rejected the audio (HTTP ${upstream.status})`,
          upstream: upstreamError,
          sentBytes: audio.length,
          sentContentType: contentType,
        });
      }

      console.log(`[whisprdesk] transcribe OK (${audio.length} bytes)`);
      res.status(upstream.status).type(upstreamCT).send(text);
    } catch (err: any) {
      console.error("[whisprdesk] proxy fetch failed:", err);
      res.status(502).json({ error: err?.message ?? "upstream failed" });
    }
  },
);

app.get("/api/whisprdesk/events", async (req, res) => {
  const { url, token } = whisprdeskConfig();
  if (!token) return res.status(400).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  (res as any).flushHeaders?.();

  const ac = new AbortController();
  const cleanup = () => {
    try {
      ac.abort();
    } catch {
      /* noop */
    }
  };
  res.on("close", () => {
    if (!res.writableEnded) cleanup();
  });

  try {
    const upstream = await fetch(`${url}/v1/events`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    if (!upstream.ok || !upstream.body) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ status: upstream.status })}\n\n`,
      );
      return res.end();
    }
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err: any) {
    if (err?.name !== "AbortError") {
      res.write(`event: error\ndata: ${JSON.stringify({ error: err?.message ?? "upstream failed" })}\n\n`);
    }
    if (!res.writableEnded) res.end();
  }
});

// ----- Settings -----

app.get("/api/settings", (_req, res) => {
  res.json({
    schema: SETTINGS_SCHEMA,
    values: maskedSettings(),
    envFallbacks: SETTINGS_SCHEMA.flatMap((s) => s.fields)
      .filter((f) => f.envFallback && process.env[f.envFallback])
      .map((f) => ({ key: f.key, envKey: f.envFallback, set: true })),
  });
});

app.post("/api/settings", (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : null;
  if (!entries) return res.status(400).json({ error: "entries[] required" });

  const knownKeys = new Set(
    SETTINGS_SCHEMA.flatMap((s) => s.fields).map((f) => f.key),
  );

  let changed = 0;
  for (const entry of entries) {
    const { key, value, isSecret } = entry ?? {};
    if (typeof key !== "string" || !knownKeys.has(key)) continue;
    if (value === null || value === undefined) {
      deleteSetting(key);
      changed++;
    } else if (typeof value === "string" && value.length > 0) {
      setSetting(key, value, !!isSecret);
      changed++;
    }
    // empty string = no-op (preserves existing secret when user leaves field blank)
  }
  res.json({ ok: true, changed });
});


// ----- Session history -----

app.get("/api/sessions", (req, res) => {
  const agentId = (req.query.agentId as string) || undefined;
  res.json(listSessions(agentId));
});

app.get("/api/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "not found" });
  const messages = getSessionMessages(req.params.id);
  res.json({ session, messages });
});

app.post("/api/sessions/:id/restore", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "not found" });
  if (!findAgent(session.agentId)) {
    return res.status(400).json({ error: "agent for this session no longer exists" });
  }
  // Hand the SDK-side session id back to the agent so future messages
  // resume this conversation in place.
  sessionByAgent.set(session.agentId, session.id);
  const messages = getSessionMessages(req.params.id);
  res.json({ session, messages });
});

app.post("/api/sessions/:id/title", (req, res) => {
  const title = (req.body?.title ?? "").toString().trim();
  if (!title) return res.status(400).json({ error: "title required" });
  const ok = setSessionTitle(req.params.id, title);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

app.delete("/api/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "not found" });
  // If this is the active session for the agent, drop the resume pointer too
  if (sessionByAgent.get(session.agentId) === session.id) {
    sessionByAgent.delete(session.agentId);
  }
  deleteSession(req.params.id);
  res.json({ ok: true });
});

// ----- Custom agents CRUD -----

app.get("/api/agents/:id", (req, res) => {
  const agent = findAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "not found" });
  res.json({ ...agent, builtIn: isBuiltInAgent(req.params.id) });
});

app.post("/api/agents", (req, res) => {
  try {
    const created = createCustomAgent(req.body ?? {}, builtInIds());
    res.json({ ...created, builtIn: false });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "invalid input" });
  }
});

app.patch("/api/agents/:id", (req, res) => {
  const id = req.params.id;
  if (isBuiltInAgent(id)) {
    return res.status(400).json({ error: "built-in agents are read-only" });
  }
  const updated = updateCustomAgent(id, req.body ?? {});
  if (!updated) return res.status(404).json({ error: "not found" });
  // Changing system prompt or tools changes context semantics; clear session.
  sessionByAgent.delete(id);
  res.json({ ...updated, builtIn: false });
});

app.delete("/api/agents/:id", (req, res) => {
  const id = req.params.id;
  if (isBuiltInAgent(id)) {
    return res.status(400).json({ error: "built-in agents cannot be deleted" });
  }
  const ok = deleteCustomAgent(id);
  if (!ok) return res.status(404).json({ error: "not found" });
  sessionByAgent.delete(id);
  modelOverride.delete(id);
  planMode.delete(id);
  res.json({ ok: true });
});

const PORT = Number(process.env.PORT ?? 3333);
const HOST = process.env.HOST ?? "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`Command Center running at http://${HOST}:${PORT}`);
  console.log(`  cwd: ${currentCwd}`);
});
