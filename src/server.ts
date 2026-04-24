import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AGENTS, AGENT_LIST, MODELS, subAgentsFor } from "./agents.js";

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
  return modelOverride.get(agentId) ?? AGENTS[agentId].model;
}

app.get("/api/agents", (_req, res) => {
  res.json(
    AGENT_LIST.map(({ id, name, emoji, accent, description }) => ({
      id,
      name,
      emoji,
      accent,
      description,
      model: effectiveModel(id),
      defaultModel: AGENTS[id].model,
    })),
  );
});

app.get("/api/models", (_req, res) => {
  res.json(MODELS);
});

app.post("/api/model/:agentId", (req, res) => {
  const agentId = req.params.agentId;
  if (!AGENTS[agentId]) return res.status(400).json({ error: "unknown agent" });
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
  const agent = AGENTS[agentId];
  if (!agent) return res.status(400).json({ error: "unknown agent" });
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "empty message" });
  }

  const resumeId = sessionByAgent.get(agent.id);
  const modelId = effectiveModel(agent.id);
  const toolUses: Array<{ name: string; input: unknown }> = [];
  let finalText = "";
  let newSessionId: string | undefined;
  let reportedModel: string | undefined;
  let apiKeySource: string | undefined;

  try {
    const subAgents = subAgentsFor(agent.id);
    for await (const msg of query({
      prompt: message,
      options: {
        allowedTools: agent.allowedTools,
        systemPrompt: agent.systemPrompt,
        resume: resumeId,
        cwd: currentCwd,
        model: modelId,
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
      if ("result" in anyMsg && typeof anyMsg.result === "string") {
        finalText = anyMsg.result;
      }
    }
  } catch (err: any) {
    console.error("chat error:", err);
    return res.status(500).json({ error: err?.message ?? "agent error" });
  }

  if (newSessionId) sessionByAgent.set(agent.id, newSessionId);

  res.json({
    reply: finalText,
    toolUses,
    cwd: currentCwd,
    model: reportedModel ?? modelId,
    apiKeySource,
  });
});

app.post("/api/chat/stream", async (req, res) => {
  const { agentId, message } = req.body ?? {};
  const agent = AGENTS[agentId];
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
  const subAgents = subAgentsFor(agent.id);

  let newSessionId: string | undefined;

  try {
    for await (const msg of query({
      prompt: message,
      options: {
        allowedTools: agent.allowedTools,
        systemPrompt: agent.systemPrompt,
        resume: resumeId,
        cwd: currentCwd,
        model: modelId,
        includePartialMessages: true,
        abortController: ac,
        ...(subAgents ? { agents: subAgents } : {}),
      },
    })) {
      if (clientClosed) break;
      const anyMsg = msg as any;

      if (anyMsg.type === "system" && anyMsg.subtype === "init") {
        newSessionId = anyMsg.session_id ?? anyMsg.data?.session_id;
        write({
          kind: "init",
          sessionId: newSessionId,
          model: anyMsg.model ?? anyMsg.data?.model,
          apiKeySource: anyMsg.apiKeySource ?? anyMsg.data?.apiKeySource,
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
            write({ kind: "tool_use", name: block.name, input: block.input });
          }
        }
        continue;
      }

      if ("result" in anyMsg && typeof anyMsg.result === "string") {
        write({ kind: "result", text: anyMsg.result });
      }
    }
  } catch (err: any) {
    if (err?.name !== "AbortError" && !clientClosed) {
      console.error("stream error:", err);
      write({ kind: "error", message: err?.message ?? "agent error" });
    }
  }

  if (newSessionId && !clientClosed) sessionByAgent.set(agent.id, newSessionId);
  write({ kind: "done" });
  if (!res.writableEnded) res.end();
});

app.post("/api/reset/:agentId", (req, res) => {
  sessionByAgent.delete(req.params.agentId);
  res.json({ ok: true });
});

app.get("/api/tasks", (_req, res) => {
  res.json(Array.from(tasks.values()).sort((a, b) => b.createdAt - a.createdAt));
});

app.post("/api/task", async (req, res) => {
  const description = (req.body?.description ?? "").toString().trim();
  const priority = (req.body?.priority ?? "medium") as TaskPriority;
  const agentOverride = req.body?.agentId as string | undefined;
  if (!description) return res.status(400).json({ error: "description required" });
  if (!["low", "medium", "high"].includes(priority)) {
    return res.status(400).json({ error: "invalid priority" });
  }

  const assignedAgent =
    agentOverride && AGENTS[agentOverride] ? agentOverride : await classifyTask(description);

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

  const agent = AGENTS[task.assignedAgent];
  if (!agent) {
    task.status = "error";
    task.error = "assigned agent no longer exists";
    return res.json(task);
  }

  task.status = "active";
  task.startedAt = Date.now();

  let finalText = "";
  const subAgents = subAgentsFor(agent.id);
  try {
    for await (const msg of query({
      prompt: task.description,
      options: {
        allowedTools: agent.allowedTools,
        systemPrompt: agent.systemPrompt,
        cwd: currentCwd,
        model: effectiveModel(agent.id),
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

const PORT = Number(process.env.PORT ?? 3333);
const HOST = process.env.HOST ?? "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`Command Center running at http://${HOST}:${PORT}`);
  console.log(`  cwd: ${currentCwd}`);
});
