export type AgentConfig = {
  id: string;
  name: string;
  emoji: string;
  accent: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  model: string;
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
    description: "Triage and default agent. Routes requests and handles general questions.",
    systemPrompt: `You are Main, the triage agent in a personal command center.
Your job is to handle general questions and help the user think through what they want to do.
Be concise, direct, and warm. When asked something clearly in another agent's lane
(comms, content, ops), suggest which agent they should talk to instead of answering yourself.`,
    allowedTools: [],
    model: "claude-sonnet-4-6",
  },
  comms: {
    id: "comms",
    name: "Comms",
    emoji: "✉️",
    accent: "#6ee7b7",
    description: "Drafts emails, messages, and outreach. Good for wording things.",
    systemPrompt: `You are Comms, the communications agent.
You help the user draft emails, messages, outreach, and replies.
Your voice is clear, friendly, and professional. Offer 1-2 variants when useful.
When the user gives you a rough intent, produce something they could send verbatim.`,
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
You help the user plan YouTube videos, write scripts, brainstorm hooks,
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
