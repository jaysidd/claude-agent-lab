import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AGENTS, AGENT_LIST, MODELS, subAgentsFor } from "./agents.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const sessionByAgent = new Map<string, string>();
const modelOverride = new Map<string, string>();
let currentCwd = os.homedir();

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

app.post("/api/reset/:agentId", (req, res) => {
  sessionByAgent.delete(req.params.agentId);
  res.json({ ok: true });
});

const PORT = Number(process.env.PORT ?? 3333);
app.listen(PORT, () => {
  console.log(`Command Center running at http://localhost:${PORT}`);
  console.log(`  cwd: ${currentCwd}`);
});
