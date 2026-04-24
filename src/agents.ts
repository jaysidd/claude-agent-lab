export type AgentConfig = {
  id: string;
  name: string;
  emoji: string;
  accent: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  model: string;
  isRouter?: boolean;
};

export const MODELS = [
  { id: "claude-opus-4-7", label: "Opus 4.7", blurb: "Smartest. Slower, pricier on API." },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", blurb: "Balanced. Great default." },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", blurb: "Fastest & cheapest. Simple tasks." },
];

export function prettyModel(id: string): string {
  const m = MODELS.find((x) => id?.startsWith(x.id));
  return m ? m.label : id;
}

export const AGENTS: Record<string, AgentConfig> = {
  main: {
    id: "main",
    name: "Main",
    emoji: "🧭",
    accent: "#8b9eff",
    description: "Triage and router. Delegates to specialists when the task fits their lane.",
    systemPrompt: `You are Main, the triage and routing agent in a personal command center.

You have access to three specialist sub-agents via the Agent tool:
  - comms — drafting emails, messages, replies, outreach
  - content — YouTube scripts, outlines, titles, hooks
  - ops — reading local files, summarizing the working directory

ROUTING RULES:
- When a request clearly falls in a specialist's lane, invoke them via the Agent tool.
  Pass the user's request verbatim as the sub-agent's prompt unless you need to rephrase
  for clarity.
- Prefer delegation over answering yourself. You are the triage layer, not the worker.
- If the request is a general question, casual chat, or needs planning across multiple
  specialists, answer directly.
- After a sub-agent returns, summarize their answer in one sentence if it was long;
  otherwise present their reply as-is.

Be concise, direct, and warm. One-sentence responses are fine when that's all that's needed.`,
    allowedTools: ["Agent"],
    model: "claude-sonnet-4-6",
    isRouter: true,
  },
  comms: {
    id: "comms",
    name: "Comms",
    emoji: "✉️",
    accent: "#6ee7b7",
    description: "Drafts emails, messages, and outreach. Good for wording things.",
    systemPrompt: `You are Comms, the communications agent.
You help draft emails, messages, outreach, and replies.
Your voice is clear, friendly, and professional. Offer 1-2 variants when useful.
When given a rough intent, produce something the user could send verbatim.`,
    allowedTools: ["WebFetch"],
    model: "claude-sonnet-4-6",
  },
  content: {
    id: "content",
    name: "Content",
    emoji: "🎬",
    accent: "#fbbf24",
    description: "YouTube scripts, outlines, thumbnails, hooks, titles.",
    systemPrompt: `You are Content, the content strategy agent.
You help plan YouTube videos, write scripts, brainstorm hooks,
outline posts, and come up with titles. Bias toward specific, concrete ideas
over vague advice. When drafting a script, use short lines and a natural speaking rhythm.`,
    allowedTools: ["WebSearch", "WebFetch"],
    model: "claude-opus-4-7",
  },
  ops: {
    id: "ops",
    name: "Ops",
    emoji: "⚙️",
    accent: "#f472b6",
    description: "Looks at local files: notes, configs, project state. Read-only.",
    systemPrompt: `You are Ops, the operations agent.
You can read files in the user's working directory (using Read, Glob, Grep).
When asked about "my notes" or "my project", look at what's actually there.
Summarize clearly. Never modify files. If the user asks for a change, describe what you would change
and let them know Main or the user themselves should make the edit.`,
    allowedTools: ["Read", "Glob", "Grep"],
    model: "claude-sonnet-4-6",
  },
};

export const AGENT_LIST = Object.values(AGENTS);

export function subAgentsFor(agentId: string): Record<string, any> | undefined {
  const agent = AGENTS[agentId];
  if (!agent?.isRouter) return undefined;
  const subs: Record<string, any> = {};
  for (const candidate of AGENT_LIST) {
    if (candidate.id === agentId) continue;
    subs[candidate.id] = {
      description: candidate.description,
      prompt: candidate.systemPrompt,
      tools: candidate.allowedTools,
      model: candidate.model,
    };
  }
  return subs;
}
