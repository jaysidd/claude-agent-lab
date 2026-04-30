import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
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
import { db } from "./memory.js";
import { taskQueue, WORKER_ID } from "./taskQueueInstance.js";
import type { Task as QueueTask } from "./taskQueue.js";
import { costGuard } from "./costGuardInstance.js";
import {
  initScheduler,
  cronEval,
  cronPreview,
} from "./schedulerInstance.js";
import type {
  EnqueueAdapter,
  FireContext,
  FireOutcome,
  OnFire,
  Schedule,
} from "./scheduler.js";
import { approvals } from "./approvalsInstance.js";
import type { Approval } from "./approvals.js";
import type {
  HookCallback,
  HookCallbackMatcher,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import {
  configureTelegram,
  startTelegram,
  restartTelegram,
  telegramStatus,
  testTelegramToken,
} from "./telegramInstance.js";
import {
  sendMessage as telegramSendMessage,
  sendChatAction as telegramSendChatAction,
  chunkReply as telegramChunkReply,
  type IncomingMessageContext as TelegramCtx,
} from "./telegram.js";

type TaskPriority = "low" | "medium" | "high";
type ApiTaskStatus = "queued" | "active" | "done" | "error";

// Wire-format task shape returned to the frontend. Stable contract — UI
// classnames and conditional rendering depend on these field names and
// status strings.
type ApiTask = {
  id: string;
  description: string;
  priority: TaskPriority;
  assignedAgent: string;
  status: ApiTaskStatus;
  createdAt: number;
  result?: string;
  error?: string;
  requiresApproval?: boolean; // C16d — surfaced from metadata for UI badge
};

const PRIORITY_TO_NUM: Record<TaskPriority, number> = {
  low: 0,
  medium: 5,
  high: 10,
};

function priorityFromNum(n: number): TaskPriority {
  if (n >= 10) return "high";
  if (n >= 5) return "medium";
  return "low";
}

function statusFromQueue(s: QueueTask["status"]): ApiTaskStatus {
  switch (s) {
    case "queued":
      return "queued";
    case "checked_out":
      return "active";
    case "done":
      return "done";
    case "failed":
    case "cancelled":
      return "error";
    default: {
      // exhaustiveness guard — any new TaskStatus added to the queue must
      // be mapped here explicitly, otherwise this won't compile.
      const _exhaustive: never = s;
      void _exhaustive;
      return "error";
    }
  }
}

function toApiTask(t: QueueTask): ApiTask {
  const errMsg =
    t.error && typeof t.error === "object" && "message" in t.error
      ? String(t.error.message)
      : undefined;
  const requiresApproval = t.metadata?.requiresApproval === true ? true : undefined;
  return {
    id: t.id,
    description: t.description,
    priority: priorityFromNum(t.priority),
    assignedAgent: t.agentId,
    status: statusFromQueue(t.status),
    createdAt: t.createdAt,
    result: typeof t.result === "string" ? t.result : undefined,
    error: errMsg,
    ...(requiresApproval ? { requiresApproval } : {}),
  };
}

const TASK_RETENTION_CAP = 50;

const countTerminalStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM tasks WHERE status IN ('done', 'failed', 'cancelled')`,
);

const pruneTerminalStmt = db.prepare(
  `DELETE FROM tasks
     WHERE status IN ('done', 'failed', 'cancelled')
       AND id NOT IN (
         SELECT id FROM tasks
          WHERE status IN ('done', 'failed', 'cancelled')
          ORDER BY updated_at DESC
          LIMIT ?
       )`,
);

function pruneCompletedTasks(cap = TASK_RETENTION_CAP) {
  // Skip the heavier DELETE-with-NOT-IN-subquery when the table is under
  // the cap. The COUNT is a single index probe; the DELETE walks a TEMP
  // B-TREE for the inner ORDER BY, which is wasted work the 99% of the
  // time the cap is unmet. (Perf audit P2.)
  const { n } = countTerminalStmt.get() as { n: number };
  if (n <= cap) return;
  pruneTerminalStmt.run(cap);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const sessionByAgent = new Map<string, string>();
const modelOverride = new Map<string, string>();
const planMode = new Map<string, boolean>();
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

  const guard = costGuard.check(agent.id);
  if (!guard.ok) {
    return res.status(429).json({
      error: guard.reason ?? "budget cap reached",
      capType: guard.capType,
      remaining: guard.remaining,
    });
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
    // Failed calls still consume rate budget — record with zero cost.
    costGuard.record(agent.id, {
      isOAuth: apiKeySource === "none",
    });
    return res.status(500).json({ error: err?.message ?? "agent error" });
  }

  costGuard.record(agent.id, {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    costUsd: totalCostUsd ?? 0,
    isOAuth: apiKeySource === "none",
  });

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

  const guard = costGuard.check(agent.id);
  if (!guard.ok) {
    return res.status(429).json({
      error: guard.reason ?? "budget cap reached",
      capType: guard.capType,
      remaining: guard.remaining,
    });
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

  // Record usage even on partial/aborted streams — they still consume rate
  // budget. costUsd defaults to 0 when no result message arrived.
  costGuard.record(agent.id, {
    inputTokens: streamUsage?.input_tokens ?? 0,
    outputTokens: streamUsage?.output_tokens ?? 0,
    costUsd: streamCost ?? 0,
    isOAuth: streamApiKeySource === "none",
  });

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

// ----- CostGuard -----

app.get("/api/costguard/status", (req, res) => {
  const agentId = (req.query.agentId as string) || "";
  if (!findAgent(agentId)) return res.status(400).json({ error: "unknown agent" });
  res.json(costGuard.status(agentId));
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
  // Kanban wants newest-first; the queue's natural priority-first order is
  // for next-in-queue displays (B54). Pass orderBy through so the SQL sort
  // is the only sort. (Perf audit P1.)
  const all = taskQueue.list({ orderBy: "createdAt DESC" });
  res.json(all.map(toApiTask));
});

app.post("/api/task", async (req, res) => {
  const rawDesc = req.body?.description;
  if (typeof rawDesc !== "string") {
    return res.status(400).json({ error: "description must be a string" });
  }
  const description = rawDesc.trim();
  const priority = (req.body?.priority ?? "medium") as TaskPriority;
  const agentOverride = req.body?.agentId as string | undefined;
  const requiresApproval = req.body?.requiresApproval === true;
  if (!description) return res.status(400).json({ error: "description required" });
  if (!["low", "medium", "high"].includes(priority)) {
    return res.status(400).json({ error: "invalid priority" });
  }

  const assignedAgent =
    agentOverride && findAgent(agentOverride) ? agentOverride : await classifyTask(description);

  const task = taskQueue.enqueue({
    description,
    agentId: assignedAgent,
    priority: PRIORITY_TO_NUM[priority],
    metadata: requiresApproval ? { requiresApproval: true } : undefined,
  });
  pruneCompletedTasks();
  res.json(toApiTask(task));
});

app.post("/api/task/:id/run", async (req, res) => {
  const taskId = req.params.id;
  const existing = taskQueue.get(taskId);
  if (!existing) return res.status(404).json({ error: "task not found" });
  if (existing.status !== "queued") {
    return res.status(400).json({ error: "task already " + statusFromQueue(existing.status) });
  }

  const agent = findAgent(existing.agentId);
  if (!agent) {
    taskQueue.cancel(taskId, "assigned agent no longer exists");
    const cancelled = taskQueue.get(taskId);
    return res.json(cancelled ? toApiTask(cancelled) : null);
  }

  const guard = costGuard.check(agent.id);
  if (!guard.ok) {
    return res.status(429).json({
      error: guard.reason ?? "budget cap reached",
      capType: guard.capType,
      remaining: guard.remaining,
    });
  }

  const checked = taskQueue.checkoutById(taskId, WORKER_ID);
  if (!checked) {
    // Lost the race to another caller; reflect current state to the client.
    const fresh = taskQueue.get(taskId);
    return res.status(409).json(fresh ? toApiTask(fresh) : { error: "task not available" });
  }

  let finalText = "";
  let agentError: string | null = null;
  let taskUsage: any;
  let taskCostUsd: number | undefined;
  let taskApiKeySource: string | undefined;
  const subAgents = subAgentsFor(agent.id);
  const plan = planMode.get(agent.id) === true;
  const gate = shouldGateRun({ cwd: currentCwd, taskMetadata: checked.metadata });
  const approvalHook = gate.gated
    ? buildApprovalHook({
        taskId: taskId,
        cwd: currentCwd,
        productionMarked: gate.productionMarked,
      })
    : undefined;
  try {
    for await (const msg of query({
      prompt: checked.description,
      options: {
        allowedTools: agent.allowedTools,
        systemPrompt: augmentedSystemPrompt(agent.id, agent.systemPrompt),
        cwd: currentCwd,
        model: effectiveModel(agent.id),
        ...(plan ? { permissionMode: "plan" as const } : {}),
        ...(subAgents ? { agents: subAgents } : {}),
        ...(approvalHook ? { hooks: approvalHook } : {}),
      },
    })) {
      const anyMsg = msg as any;
      if (anyMsg.type === "system" && anyMsg.subtype === "init") {
        taskApiKeySource = anyMsg.apiKeySource ?? anyMsg.data?.apiKeySource;
      }
      if (anyMsg.type === "result") {
        if (typeof anyMsg.result === "string") finalText = anyMsg.result;
        if (anyMsg.usage) taskUsage = anyMsg.usage;
        if (typeof anyMsg.total_cost_usd === "number") taskCostUsd = anyMsg.total_cost_usd;
      }
    }
  } catch (err: any) {
    agentError = err?.message ?? "agent failed";
  }

  costGuard.record(agent.id, {
    inputTokens: taskUsage?.input_tokens ?? 0,
    outputTokens: taskUsage?.output_tokens ?? 0,
    costUsd: taskCostUsd ?? 0,
    isOAuth: taskApiKeySource === "none",
  });

  // Wrap queue terminal updates so a row that was reaped (lease expired
  // mid-query, reaper requeued) or hard-deleted out from under us doesn't
  // crash the request handler. Both paths land on UPDATE-matches-zero,
  // which the queue surfaces as a throw.
  try {
    if (agentError !== null) {
      taskQueue.fail(taskId, WORKER_ID, { message: agentError });
    } else {
      taskQueue.complete(taskId, WORKER_ID, finalText);
    }
  } catch (err: any) {
    console.warn(
      `[task ${taskId}] terminal update failed (likely reaped or deleted mid-run): ${err?.message ?? err}`,
    );
  }

  const final = taskQueue.get(taskId);
  res.json(final ? toApiTask(final) : null);
});

app.delete("/api/task/:id", (req, res) => {
  // Hard-delete is constrained to terminal states. Deleting a checked_out
  // row would orphan a worker mid-execution and crash its terminal update.
  // For non-terminal rows, callers should cancel via the queue instead
  // (currently no UI surface — UI already disables Delete on active tasks).
  const result = db
    .prepare(
      `DELETE FROM tasks
        WHERE id = ?
          AND status IN ('done', 'failed', 'cancelled')`,
    )
    .run(req.params.id);
  if (result.changes === 0) {
    const current = taskQueue.get(req.params.id);
    if (!current) return res.json({ ok: true }); // already gone — idempotent
    return res
      .status(409)
      .json({ error: "task is not in a terminal state", task: toApiTask(current) });
  }
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

  // CostGuard supports per-agent override keys for ONLY these two base keys.
  // `rate_window_seconds` is intentionally global-only (resolver never reads
  // a per-agent variant). The trailing segment must be a known agent id.
  const COST_GUARD_OVERRIDE_BASES = [
    "costguard.cost_cap_monthly_usd",
    "costguard.rate_cap_per_window",
  ];
  const isCostGuardOverride = (key: string): boolean => {
    for (const base of COST_GUARD_OVERRIDE_BASES) {
      const prefix = base + ".";
      if (!key.startsWith(prefix)) continue;
      const agentId = key.slice(prefix.length);
      if (!agentId || agentId.includes(".")) return false;
      return !!findAgent(agentId);
    }
    return false;
  };

  let changed = 0;
  let telegramTouched = false;
  for (const entry of entries) {
    const { key, value, isSecret } = entry ?? {};
    if (typeof key !== "string") continue;
    if (!knownKeys.has(key) && !isCostGuardOverride(key)) continue;
    if (key.startsWith("telegram.")) telegramTouched = true;
    if (value === null || value === undefined) {
      deleteSetting(key);
      changed++;
    } else if (typeof value === "string" && value.length > 0) {
      setSetting(key, value, !!isSecret);
      changed++;
    }
    // empty string = no-op (preserves existing secret when user leaves field blank)
  }

  // Telegram listener picks up its config from the settings table at start
  // time, so changing the token or chat-ID allowlist requires restarting
  // the long-poll loop. Fire-and-forget — the response shouldn't block on
  // a getMe roundtrip; the operator can refresh /api/telegram/status if
  // they want the live state.
  if (telegramTouched) {
    restartTelegram().catch((err) => {
      console.warn(`[telegram] restart after settings save failed: ${err?.message ?? err}`);
    });
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

// ============================================================================
// C16d Approvals — production-cwd marker + hook factory
// ============================================================================
//
// The approvals primitive (src/approvals.ts) exposes create/decide/expire +
// an in-memory awaiter Map. This block wires it into the SDK call paths via
// a PreToolUse hook factory + a settings-backed production-cwd allowlist.
//
// Defense-in-depth: the per-task `requiresApproval` toggle and the production-
// cwd allowlist are independent. EITHER triggers the hook. The cwd allowlist
// is the safety net for unattended scheduled fires whose creator forgot to
// flip the toggle.

const DEFAULT_DANGEROUS_TOOLS = ["Bash", "Write", "Edit", "WebFetch"] as const;
const APPROVAL_HOOK_TIMEOUT_SECONDS = 60 * 60; // 1 hour, see C16d design Q2

function productionMarkedCwds(): string[] {
  const raw = configValue("approvals.production_cwds");
  if (!raw) return [];
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function cwdIsProductionMarked(cwd: string): boolean {
  if (!cwd) return false;
  const resolved = path.resolve(cwd);
  for (const marked of productionMarkedCwds()) {
    const resolvedMarked = path.resolve(marked);
    // Exact-prefix match. A marked path of /Users/me/prod matches that path
    // and any descendant; does NOT match /Users/me/prod-2.
    if (resolved === resolvedMarked || resolved.startsWith(resolvedMarked + path.sep)) {
      return true;
    }
  }
  return false;
}

// Builds the PreToolUse hook configuration the SDK accepts. Returns
// `undefined` when there's nothing to gate, so the caller can spread it
// conditionally into `query()` options without a flag.
function buildApprovalHook(opts: {
  taskId: string;
  cwd: string;
  productionMarked: boolean;
}): Partial<Record<"PreToolUse", HookCallbackMatcher[]>> | undefined {
  // Anchor the dangerous-tools matcher (Reviewer R2 follow-up). Without `^...$`,
  // `Bash|Write|Edit|WebFetch` would match any tool whose name contains one of
  // those substrings — `BashHelper`, `MyEdit`, etc. Anchoring forces an exact
  // match against the SDK's tool name. The production-marked branch keeps `.*`
  // by design (gate everything).
  const matcher = opts.productionMarked
    ? ".*"
    : `^(?:${DEFAULT_DANGEROUS_TOOLS.join("|")})$`;

  const callback: HookCallback = async (input, _toolUseId, { signal }) => {
    const pre = input as PreToolUseHookInput;

    // approvals.create() can throw — most importantly when tool_input exceeds
    // the 64 KB inspection cap. A throw from a hook callback is treated by
    // the SDK as a non-blocking error (NOT a deny), which would let the
    // dangerous tool through unattended. Reviewer R11. Catch the throw here
    // and return an explicit deny so a malformed/oversized tool_input fails
    // closed instead of fails open.
    let handle;
    try {
      handle = approvals.create({
        taskId: opts.taskId,
        toolName: pre.tool_name,
        toolUseId: pre.tool_use_id,
        toolInput: pre.tool_input,
        cwd: opts.cwd,
        workerId: WORKER_ID,
      });
    } catch (err: any) {
      const message = err?.message ?? "approval creation failed";
      console.warn(
        `[approvals] hook callback denied tool ${pre.tool_name} on task ${opts.taskId}: ${message}`,
      );
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `approval gate could not record this call: ${message}`,
        },
      };
    }

    // If the SDK aborts (client disconnect, server shutdown handler, etc.),
    // mark the approval expired so the kanban row doesn't dangle and the
    // awaiter Promise resolves cleanly.
    const onAbort = () => approvals.expire(handle.id, "sdk_aborted");
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const decision = await handle.awaitDecision();
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision.status === "approved" ? "allow" : "deny",
          permissionDecisionReason:
            decision.reason ?? `approval ${decision.status} by operator`,
        },
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };

  return {
    PreToolUse: [
      {
        matcher,
        timeout: APPROVAL_HOOK_TIMEOUT_SECONDS,
        hooks: [callback],
      },
    ],
  };
}

// Convenience: should this run attach the approval hook? Centralized so the
// per-task toggle and production-cwd allowlist stay aligned across both run
// paths (manual /api/task/:id/run + scheduler onFire).
function shouldGateRun(opts: {
  cwd: string;
  taskMetadata: Record<string, unknown> | null;
}): { gated: boolean; productionMarked: boolean } {
  const productionMarked = cwdIsProductionMarked(opts.cwd);
  const taskFlag = opts.taskMetadata?.requiresApproval === true;
  return {
    gated: productionMarked || taskFlag,
    productionMarked,
  };
}

// ============================================================================
// C16a Scheduler — wiring + routes
// ============================================================================
//
// The Scheduler primitive (src/scheduler.ts) is host-agnostic. We wire it here
// with two callbacks:
//   - enqueueAdapter: drops fires into the durable task queue (so they show up
//     on the kanban and respect the same lease/retry semantics as manual tasks)
//   - onFire: runs the actual SDK call, detects OAuth-dead errors, records the
//     CostGuard ledger row, and updates the queue task's terminal state
//
// We intentionally don't extract this into a shared "agent runtime" module —
// the chat / streaming / task-run paths each have their own quirks (sessions,
// streaming cursor, plan mode toggling) and a premature abstraction would
// bury those differences. Scheduler fires are fresh-context, no-resume,
// fire-and-forget; that's distinct enough to keep here.

const enqueueScheduledTask: EnqueueAdapter = (input) => {
  const task = taskQueue.enqueue({
    description: input.description,
    agentId: input.agentId,
    priority: PRIORITY_TO_NUM.medium,
    metadata: input.metadata,
  });
  pruneCompletedTasks();
  return task.id;
};

// Heuristic for distinguishing "OAuth session is dead" from "tool call failed
// with an authorization-flavored error message." Two-layer defense:
//
//   1. Domain match: the error must mention an auth-system noun (oauth,
//      claude login, credentials, anthropic api key) AND a failure verb
//      (expired, invalid, failed, required, missing). Single-token matches
//      like "expired" or "unauthorized" alone are too easy to trigger from
//      benign tool errors ("file lease expired", "unauthorized scope").
//   2. Position guard: the error must arrive BEFORE the first assistant
//      message in the stream. Tool errors surface inside the agent loop,
//      which cannot start without a working SDK transport, so an auth-
//      flavored error from a tool can only surface after ≥ 1 assistant
//      frame has been emitted.
//
// Both must hold to classify as oauth_dead. Anything else falls through to
// the generic "error" outcome (which still increments consecutive_failures
// and trips 3-strike auto-pause, just under a different paused_reason).
//
// The second top-level alternation matches the canonical CLI exhortation
// "please run [`]claude login[`]" without requiring a separate failure-verb,
// because the phrase itself is unambiguous enough to classify as auth-dead.
// Captured during the C16a security audit (2026-04-28): the original single-
// alternation regex missed three real-world phrasings ("Please run claude
// login", "Please run `claude login`", "Please run `claude login` to refresh
// credentials") because they had no failure-verb token *after* the domain
// phrase. Without this, a legitimate OAuth-dead error would mis-classify as
// generic and only auto-pause after 3 strikes — annoying, not a security gap,
// but worth fixing while the regex is in scope. Strictly additive: all prior
// true/false cases retained.
const OAUTH_DEAD_PATTERN =
  /(?:(?:oauth|claude\s*(?:code\s*)?login|anthropic\s*api[ -]?key|credentials).*(?:expired|invalid|failed|required|missing|not authenticated|please run)|please\s+run\s+`?claude\s*(?:code\s*)?login`?)/i;

const fireScheduledTask: OnFire = async (
  ctx: FireContext,
): Promise<FireOutcome> => {
  const agent = findAgent(ctx.agentId);
  if (!agent) {
    return { kind: "error", message: `agent ${ctx.agentId} not found` };
  }

  // Defense-in-depth — Scheduler.executeFire already enqueued before this
  // callback fires, so we re-check CostGuard here in case the agent's cap
  // was lowered between enqueue and fire.
  const guard = costGuard.check(agent.id);
  if (!guard.ok) {
    // Roll the queued task forward to a clean cancelled terminal so the
    // kanban shows the budget block. Use cancel() (not checkoutById+fail)
    // because cancel is idempotent against terminal states and doesn't burn
    // an attempt — this fire never reached the SDK.
    taskQueue.cancel(ctx.taskId, guard.reason ?? "budget cap reached");
    return {
      kind: "budget_exhausted",
      reason: guard.reason ?? "budget cap reached",
    };
  }

  const checked = taskQueue.checkoutById(ctx.taskId, WORKER_ID);
  if (!checked) {
    return {
      kind: "error",
      message: `task ${ctx.taskId} no longer available for checkout`,
    };
  }

  let finalText = "";
  let usage: any;
  let costUsd: number | undefined;
  let apiKeySource: string | undefined;
  let assistantMessageArrived = false;
  let agentError: any | null = null;

  const subAgents = subAgentsFor(agent.id);
  const plan = planMode.get(agent.id) === true;
  const fireCwd = ctx.cwd || currentCwd;

  // Scheduled fires don't expose a per-task `requiresApproval` flag (yet —
  // future enhancement on the schedule row itself). Production-cwd allowlist
  // is the only gate path here. The hook fires for every tool call when the
  // cwd matches.
  const scheduledGate = cwdIsProductionMarked(fireCwd);
  const scheduledHook = scheduledGate
    ? buildApprovalHook({
        taskId: ctx.taskId,
        cwd: fireCwd,
        productionMarked: true,
      })
    : undefined;

  try {
    for await (const msg of query({
      prompt: ctx.prompt,
      options: {
        allowedTools: agent.allowedTools,
        systemPrompt: augmentedSystemPrompt(agent.id, agent.systemPrompt),
        cwd: fireCwd,
        model: effectiveModel(agent.id),
        ...(plan ? { permissionMode: "plan" as const } : {}),
        ...(subAgents ? { agents: subAgents } : {}),
        ...(scheduledHook ? { hooks: scheduledHook } : {}),
      },
    })) {
      const anyMsg = msg as any;
      if (anyMsg.type === "system" && anyMsg.subtype === "init") {
        apiKeySource = anyMsg.apiKeySource ?? anyMsg.data?.apiKeySource;
      }
      if (anyMsg.type === "assistant") {
        assistantMessageArrived = true;
      }
      if (anyMsg.type === "result") {
        if (typeof anyMsg.result === "string") finalText = anyMsg.result;
        if (anyMsg.usage) usage = anyMsg.usage;
        if (typeof anyMsg.total_cost_usd === "number") costUsd = anyMsg.total_cost_usd;
      }
    }
  } catch (err: any) {
    agentError = err;
  }

  // Always record — failed fires still consume rate budget per CostGuard's
  // documented contract.
  costGuard.record(agent.id, {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    costUsd: costUsd ?? 0,
    isOAuth: apiKeySource === "none",
  });

  // Update queue terminal state. Defensive try/catch because the task row may
  // have been reaped (long fire + lease expired) or hard-deleted out from
  // under us. Both paths land on UPDATE-matches-zero which the queue surfaces
  // as a throw — we just log and move on.
  try {
    if (agentError) {
      taskQueue.fail(ctx.taskId, WORKER_ID, {
        message: agentError?.message ?? String(agentError),
      });
    } else {
      taskQueue.complete(ctx.taskId, WORKER_ID, finalText);
    }
  } catch (err: any) {
    console.warn(
      `[scheduler ${ctx.scheduleId}] queue terminal update failed: ${err?.message ?? err}`,
    );
  }

  if (agentError) {
    const message = agentError?.message ?? String(agentError);
    if (!assistantMessageArrived && OAUTH_DEAD_PATTERN.test(message)) {
      return { kind: "oauth_dead", message };
    }
    return { kind: "error", message };
  }

  return { kind: "success" };
};

const scheduler = initScheduler(enqueueScheduledTask, fireScheduledTask);
scheduler.start();

// --- Routes ---

function toApiSchedule(s: Schedule) {
  return s; // wire shape == internal shape for v1; UI computes relative times
}

app.get("/api/schedules", (_req, res) => {
  res.json(scheduler.list().map(toApiSchedule));
});

app.post("/api/schedules", (req, res) => {
  const { agentId, prompt, cron, cwd, enabled } = req.body ?? {};
  if (!findAgent(agentId)) {
    return res.status(400).json({ error: "unknown agent" });
  }
  try {
    const s = scheduler.create({
      agentId,
      prompt,
      cron,
      cwd: cwd === undefined ? null : cwd,
      enabled,
    });
    res.json(toApiSchedule(s));
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "invalid schedule" });
  }
});

app.get("/api/schedules/:id", (req, res) => {
  const s = scheduler.get(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json(toApiSchedule(s));
});

app.patch("/api/schedules/:id", (req, res) => {
  const patch = req.body ?? {};
  if (patch.agentId !== undefined && !findAgent(patch.agentId)) {
    return res.status(400).json({ error: "unknown agent" });
  }
  try {
    const s = scheduler.update(req.params.id, patch);
    if (!s) return res.status(404).json({ error: "not found" });
    res.json(toApiSchedule(s));
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "invalid update" });
  }
});

app.delete("/api/schedules/:id", (req, res) => {
  const ok = scheduler.delete(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

app.post("/api/schedules/:id/run-now", async (req, res) => {
  const sched = scheduler.get(req.params.id);
  if (!sched) return res.status(404).json({ error: "not found" });
  // Don't await the fire — the SDK call streams a full reply and we don't
  // want to hold the HTTP request open for that. fireNow's synchronous prefix
  // (enqueue + last_task_id record) runs to completion before the first
  // await inside executeFire, so the post-yield `scheduler.get()` below sees
  // the populated lastTaskId. Catch the void'd promise so a rejected
  // executeFire (e.g., enqueue throw) doesn't surface as an unhandled
  // rejection — operational errors are already logged inside executeFire's
  // own try/catch on the SDK call.
  scheduler.fireNow(req.params.id).catch((err) => {
    console.warn(
      `[scheduler ${req.params.id}] fireNow rejected: ${err?.message ?? err}`,
    );
  });
  // Yield once so the synchronous enqueue/UPDATE inside fireNow runs before
  // we read the schedule back. better-sqlite3 is sync, so a single macrotask
  // tick is enough to drain the microtask queue.
  await new Promise((r) => setTimeout(r, 0));
  const fresh = scheduler.get(req.params.id);
  res.json({
    ok: true,
    taskId: fresh?.lastTaskId ?? null,
    schedule: fresh ? toApiSchedule(fresh) : null,
  });
});

app.post("/api/schedules/:id/pause", (req, res) => {
  const before = scheduler.get(req.params.id);
  if (!before) return res.status(404).json({ error: "not found" });
  if (!before.enabled) {
    return res.json(toApiSchedule(before));
  }
  const after = scheduler.pause(req.params.id, "manual");
  res.json(after ? toApiSchedule(after) : null);
});

app.post("/api/schedules/:id/resume", (req, res) => {
  const after = scheduler.resume(req.params.id);
  if (!after) return res.status(404).json({ error: "not found" });
  res.json(toApiSchedule(after));
});

app.post("/api/cron/preview", (req, res) => {
  const cron = req.body?.cron;
  if (typeof cron !== "string" || !cron.trim()) {
    return res.status(400).json({ valid: false, error: "cron required" });
  }
  if (cron.length > 100) {
    return res.status(400).json({ valid: false, error: "cron too long" });
  }
  try {
    const next = cronPreview(cron, Date.now(), 3);
    res.json({ valid: true, next });
  } catch (err: any) {
    res.status(400).json({
      valid: false,
      error: (err?.message ?? "invalid cron").split("\n")[0],
    });
  }
});

// ============================================================================
// C16d Approvals — operator-facing routes
// ============================================================================

function toApiApproval(a: Approval) {
  return a; // wire shape == internal shape; UI handles tool_input rendering
}

app.get("/api/approvals", (req, res) => {
  const status = (req.query.status as string | undefined) ?? "pending";
  const knownStatuses = ["pending", "approved", "rejected", "expired"] as const;
  if (!knownStatuses.includes(status as (typeof knownStatuses)[number])) {
    return res.status(400).json({ error: "invalid status filter" });
  }
  res.json(
    approvals
      .list({ status: status as (typeof knownStatuses)[number] })
      .map(toApiApproval),
  );
});

app.get("/api/approvals/:id", (req, res) => {
  const a = approvals.get(req.params.id);
  if (!a) return res.status(404).json({ error: "not found" });
  res.json(toApiApproval(a));
});

app.post("/api/approvals/:id/decide", (req, res) => {
  const decision = req.body?.decision;
  if (decision !== "approve" && decision !== "reject") {
    return res.status(400).json({
      error: "decision required: 'approve' | 'reject'",
    });
  }
  const reason =
    typeof req.body?.reason === "string" && req.body.reason.trim()
      ? req.body.reason.trim().slice(0, 1000)
      : null;
  const status = decision === "approve" ? "approved" : "rejected";
  const updated = approvals.decide(req.params.id, status, reason);
  if (!updated) {
    // Either the approval doesn't exist or it's already in a terminal state.
    const existing = approvals.get(req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });
    return res.status(409).json({
      error: `approval already ${existing.status}`,
      approval: toApiApproval(existing),
    });
  }
  res.json(toApiApproval(updated));
});

// ============================================================================
// C05 Telegram bridge — onMessage handler + routes + listener bootstrap
// ============================================================================
//
// Wires incoming Telegram messages to the same agent invocation path the
// web UI uses. Parses an optional /<agent_id> command prefix, resolves the
// agent via agentRegistry, runs CostGuard preflight, fires query() with the
// shared sessionByAgent state, and sends the reply (chunked at 4000 chars).

const TELEGRAM_DEFAULT_AGENT_ID = "main";

function parseTelegramCommand(
  text: string,
): { agentId: string | null; body: string; isHelp: boolean; isAgentList: boolean } {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return { agentId: null, body: trimmed, isHelp: false, isAgentList: false };
  }
  const spaceIdx = trimmed.indexOf(" ");
  const cmd = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx))
    .toLowerCase()
    .replace(/@.*$/, ""); // /main@my_bot → /main (Telegram appends @botname in groups)
  const body = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  if (cmd === "help" || cmd === "h" || cmd === "start") {
    return { agentId: null, body: "", isHelp: true, isAgentList: false };
  }
  if (cmd === "agents" || cmd === "list") {
    return { agentId: null, body: "", isHelp: false, isAgentList: true };
  }
  return { agentId: cmd, body, isHelp: false, isAgentList: false };
}

function buildTelegramHelp(): string {
  const agentLines = allAgents()
    .map((a) => `• /${a.id} — ${a.name} (${a.description})`)
    .join("\n");
  return [
    "*Command Center bot*",
    "",
    "Send a plain message to chat with Main (the router).",
    "Or use a slash command to target a specific agent:",
    "",
    agentLines,
    "",
    "/help — show this message",
    "/agents — list current agents",
  ].join("\n");
}

function buildTelegramAgentList(): string {
  return allAgents()
    .map((a) => `• ${a.emoji} *${a.name}* — \`/${a.id}\` (${a.model})`)
    .join("\n");
}

const onTelegramMessage = async (ctx: TelegramCtx): Promise<void> => {
  // Re-read the token on each message — Settings save can rotate it.
  const token = configValue("telegram.bot_token", "TELEGRAM_BOT_TOKEN");
  if (!token) return; // Listener was started but token cleared mid-poll; bail.

  const parsed = parseTelegramCommand(ctx.text);

  // Built-in commands handled inline, no agent fire.
  if (parsed.isHelp) {
    await telegramSendMessage(token, ctx.chatId, buildTelegramHelp(), {
      parse_mode: "Markdown",
    });
    return;
  }
  if (parsed.isAgentList) {
    await telegramSendMessage(token, ctx.chatId, buildTelegramAgentList(), {
      parse_mode: "Markdown",
    });
    return;
  }

  // Resolve the target agent. Bare text → default; /<id> → that id.
  const targetId = parsed.agentId ?? TELEGRAM_DEFAULT_AGENT_ID;
  const agent = findAgent(targetId);
  if (!agent) {
    await telegramSendMessage(
      token,
      ctx.chatId,
      `⚠️ Unknown agent: \`${targetId}\`. Try /agents.`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  // Use parsed.body, NOT ctx.text — for bare text both are equal (trimmed),
  // but for `/main` with no body, parsed.body is "" while ctx.text is the
  // literal "/main". Reviewer R9: the prior fallback would send "/main" as
  // the agent's prompt, burning tokens on the command string itself.
  const prompt = parsed.body;
  if (!prompt.trim()) {
    await telegramSendMessage(
      token,
      ctx.chatId,
      `What would you like ${agent.name} to do?`,
    );
    return;
  }

  // CostGuard preflight — fail fast without burning tokens if exhausted.
  const guard = costGuard.check(agent.id);
  if (!guard.ok) {
    await telegramSendMessage(
      token,
      ctx.chatId,
      `⚠️ ${guard.reason ?? "budget cap reached"}`,
    );
    return;
  }

  // Maintain a typing... indicator throughout the SDK call. Telegram
  // clears the indicator after ~5s, so we re-send every 4s. Stops in
  // the finally block. The sleep is wake-able so the SDK reply lands
  // immediately instead of waiting up to 4 s for the next loop tick.
  // C05 perf audit P1.
  let typingActive = true;
  let wakeTypingLoop: () => void = () => {};
  const typingLoop = (async () => {
    while (typingActive) {
      try {
        await telegramSendChatAction(token, ctx.chatId, "typing");
      } catch {
        /* swallow — surfacing typing errors to the operator is noisier than useful */
      }
      if (!typingActive) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 4000);
        wakeTypingLoop = () => { clearTimeout(t); resolve(); };
      });
    }
  })();

  let finalText = "";
  let usage: any;
  let costUsd: number | undefined;
  let apiKeySource: string | undefined;
  let newSessionId: string | undefined;
  let agentError: string | null = null;

  const subAgents = subAgentsFor(agent.id);
  const plan = planMode.get(agent.id) === true;
  const resumeId = sessionByAgent.get(agent.id);

  try {
    for await (const msg of query({
      prompt,
      options: {
        allowedTools: agent.allowedTools,
        systemPrompt: augmentedSystemPrompt(agent.id, agent.systemPrompt),
        cwd: currentCwd,
        model: effectiveModel(agent.id),
        ...(resumeId ? { resume: resumeId } : {}),
        ...(plan ? { permissionMode: "plan" as const } : {}),
        ...(subAgents ? { agents: subAgents } : {}),
      },
    })) {
      const anyMsg = msg as any;
      if (anyMsg.type === "system" && anyMsg.subtype === "init") {
        apiKeySource = anyMsg.apiKeySource ?? anyMsg.data?.apiKeySource;
        if (typeof anyMsg.session_id === "string") newSessionId = anyMsg.session_id;
      }
      if (anyMsg.type === "result") {
        if (typeof anyMsg.result === "string") finalText = anyMsg.result;
        if (anyMsg.usage) usage = anyMsg.usage;
        if (typeof anyMsg.total_cost_usd === "number") costUsd = anyMsg.total_cost_usd;
      }
    }
  } catch (err: any) {
    agentError = err?.message ?? "agent failed";
  } finally {
    typingActive = false;
    wakeTypingLoop();
    await typingLoop;
  }

  // Persist the new session id to the shared map (web UI sees the same).
  if (newSessionId) sessionByAgent.set(agent.id, newSessionId);

  costGuard.record(agent.id, {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    costUsd: costUsd ?? 0,
    isOAuth: apiKeySource === "none",
  });

  if (agentError) {
    await telegramSendMessage(
      token,
      ctx.chatId,
      `⚠️ Agent error: ${agentError}`,
    );
    return;
  }

  const replyText = finalText || "_(no reply)_";
  const chunks = telegramChunkReply(replyText);
  for (const chunk of chunks) {
    try {
      await telegramSendMessage(token, ctx.chatId, chunk, {
        parse_mode: "Markdown",
      });
    } catch (err: any) {
      // Markdown parse errors fall through to plain text — the agent might
      // have emitted invalid markdown the operator still wants to see.
      const isParseError = /can't parse entities/i.test(err?.message ?? "");
      if (isParseError) {
        await telegramSendMessage(token, ctx.chatId, chunk).catch(() => {});
      } else {
        console.warn(`[telegram] sendMessage failed: ${err?.message ?? err}`);
      }
    }
  }
};

configureTelegram(onTelegramMessage);
startTelegram().then((status) => {
  if (status.kind === "listening") {
    console.log(`[telegram] listening as @${status.botUsername}`);
  } else if (status.kind !== "stopped") {
    console.warn(`[telegram] start status: ${status.kind} (${"error" in status ? status.error : ""})`);
  }
  // status.kind === "stopped" means no token — silent, this is the default.
});

// --- Telegram routes ---

app.get("/api/telegram/status", (_req, res) => {
  res.json(telegramStatus());
});

app.post("/api/telegram/test", async (_req, res) => {
  const result = await testTelegramToken();
  res.json(result);
});

// ============================================================================

const PORT = Number(process.env.PORT ?? 3333);
const HOST = process.env.HOST ?? "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`Command Center running at http://${HOST}:${PORT}`);
  console.log(`  cwd: ${currentCwd}`);
});
