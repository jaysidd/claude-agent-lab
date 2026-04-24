import { AGENTS, AGENT_LIST, type AgentConfig } from "./agents.js";
import { listCustomAgents, findCustomAgent } from "./customAgents.js";

export function allAgents(): AgentConfig[] {
  return [...AGENT_LIST, ...listCustomAgents()];
}

export function findAgent(id: string): AgentConfig | undefined {
  if (AGENTS[id]) return AGENTS[id];
  return findCustomAgent(id);
}

export function isBuiltInAgent(id: string): boolean {
  return !!AGENTS[id];
}

/**
 * For a router agent, returns a map of OTHER agents shaped as SDK
 * AgentDefinitions. Built-ins and custom agents both participate.
 */
export function subAgentsFor(agentId: string): Record<string, any> | undefined {
  const agent = findAgent(agentId);
  if (!agent?.isRouter) return undefined;
  const subs: Record<string, any> = {};
  for (const candidate of allAgents()) {
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

export function builtInIds(): Set<string> {
  return new Set(Object.keys(AGENTS));
}
