# Building with AI Agents — Case Studies

Running log of patterns, iteration loops, and decisions worth documenting as we build Command Center. Written live during sessions, not retrospectively.

---

## Entry 01 — F1–F7 foundation in 15 minutes (2026-04-23)

### What we built
A working multi-agent command center running directly on the Claude Agent SDK: four specialist agents (Main/Comms/Content/Ops), per-agent system prompts and tool allowlists, session persistence, folder scoping, `@file` autocomplete, per-agent model switching (Opus/Sonnet/Haiku), and an auth footer that shows the model + "Max plan · subscription" on every reply.

### The claim that prompted it
A YouTuber demonstrated a similar "command center" built on OpenCode (the multi-provider open-source agent CLI) and claimed he'd been at it for 6–7 weeks. We wanted to test: how much of that is the SDK giving you for free vs. actual product work?

### The iteration loop
Linear, no backtracking: `npm init` → install SDK + tsx + express → 15-line `hello.ts` smoke test that summarizes a URL → confirmed Max OAuth works without `ANTHROPIC_API_KEY` → Express with `/api/agents` + `/api/chat` → vanilla-JS frontend → folder picker → `@file` → model selector.

The SDK's `query()` call is effectively the whole thing. Every feature was a new field on the `options` object (`allowedTools`, `systemPrompt`, `cwd`, `resume`, `model`) or a new reading of the async message stream (`session.init` for session ID capture, `assistant` for tool uses, `result` for final text).

### What the SDK gave us for free
- Agent loop (prompt → think → tool use → tool result → repeat)
- Tool implementations (Read, Glob, Grep, WebFetch, WebSearch)
- Session resume via session IDs
- Model selection via plain string
- Claude Code CLI binary bundled automatically (no separate install)
- Max plan OAuth inheritance when `ANTHROPIC_API_KEY` is unset

### What we had to build
- Express routes to stitch user input to `query()` calls
- Sidebar + chat UI (~600 LOC vanilla JS)
- Folder browser + `@file` autocomplete (server: ~30 LOC, frontend: ~120 LOC)
- Model override state (`Map<agentId, modelId>` on the server)

### The honest takeaway
The YouTuber's 6–7 weeks wasn't wasted — but most of it was building things the Claude Agent SDK now gives you for free: the agent loop, tool execution, session handling, model switching. What he uniquely built is the multi-provider abstraction (OpenAI, Groq, Ollama, etc.) and the channel integrations (Telegram, Discord, 20+ others). That stuff IS months of work, and it's the right call for a commercial product that can't be Claude-only. But for a personal Claude-centric tool, the SDK collapses the base layer to a tight afternoon.

### Gotcha for next time
`ANTHROPIC_API_KEY` silently takes precedence over OAuth. We almost mis-debugged "why isn't Max plan auth kicking in?" before realizing the env var was shadowing. Fix: `env -u ANTHROPIC_API_KEY` for one-off runs, or a `printenv ANTHROPIC_API_KEY` check as the first line of any auth-related diagnosis.

---

## Entry 02 — Sub-agent delegation via SDK `agents:` option (C01, 2026-04-23)

### The pattern
Promote one agent to a "router" by giving it `Agent` in its `allowedTools` and populating `options.agents` with `AgentDefinition` objects for the specialists. The router gains the ability to invoke any named sub-agent as a tool; the sub-agent's response gets woven into the router's reply.

### Why it's elegant
Before C01: Main would say "you should ask Comms about that." Useful triage text, but the user had to manually switch agents. After C01: Main invokes Comms directly, returns the draft. **The user doesn't context-switch; the agent does.** That's the entire "command center" pattern in one SDK option.

Zero routing code in our server. No manual string-parsing of "which agent did Main pick?" The SDK handles the tool-use round-trip internally. We only had to render the `Agent` tool use as a visible "🤝 delegated to Comms" chip in the UI so the user can see what happened.

### Code change
```ts
// agents.ts
main: {
  ...,
  allowedTools: ["Agent"],
  isRouter: true,
}

export function subAgentsFor(agentId: string) {
  if (!AGENTS[agentId]?.isRouter) return undefined;
  const subs = {};
  for (const c of AGENT_LIST) {
    if (c.id === agentId) continue;
    subs[c.id] = {
      description: c.description,
      prompt: c.systemPrompt,
      tools: c.allowedTools,
      model: c.model,
    };
  }
  return subs;
}

// server.ts — in the chat route
query({
  ...,
  ...(subAgentsFor(agent.id) ? { agents: subAgentsFor(agent.id) } : {}),
})
```

That's the whole feature. ~25 lines of code.

### Design decision: sub-agents inherit their own tool allowlists
When Main delegates to Ops, Ops runs with `Read/Glob/Grep` (its own `allowedTools`), not Main's empty allowlist. Sub-agents don't inherit from the router — they have their own identity. This is the right call: it prevents delegation from silently escalating tool access, and it lets the router stay small and safe.

---

## Entry 03 — Streaming with `includePartialMessages: true` (C02, 2026-04-23)

### The pattern
Set `options.includePartialMessages: true` on `query()` to get `SDKPartialAssistantMessage` events with `type: 'stream_event'` in the async stream. The `event` field contains the underlying Anthropic `BetaRawMessageStreamEvent` — `content_block_delta` events carry `delta.text` chunks you can forward to the frontend.

### Wire shape
- Server returns NDJSON (`application/x-ndjson`), one JSON object per line
- Each line has `{kind, ...}` — `init`, `text_delta`, `tool_use`, `result`, `error`, `done`
- Frontend reads `response.body.getReader()`, decodes chunks, splits on `\n`, parses each line
- Every event triggers a partial re-render; blinking cursor (`▌`) added via CSS while `streaming: true`

### Why NDJSON over SSE
`EventSource` can't POST. We could have done a POST-prepare-then-GET-stream dance, but NDJSON over a normal fetch is simpler, works with `Content-Type: application/json` request bodies, and doesn't require the browser's SSE state machine. For server-to-client-only streaming where the client POST opens the connection, NDJSON is the right primitive.

### Known perf caveat
`renderMessages()` currently rebuilds the entire chat log on every delta. For a long reply this is O(N²) DOM churn. Fine at current lengths; will need targeted updates (append to the last bubble's `textContent` instead of full re-render) once the audit agent flags it.

---

## Entry 04 — Haiku-classified task auto-routing (C03, 2026-04-23)

### The pattern
A one-shot `query()` using Haiku with a tight system prompt: "classify this task to one of {main, comms, content, ops}. Respond with exactly one word." The response gets parsed; if it's a valid agent id, we use it. If not, we substring-match against known ids. Ultimate fallback: Main.

```ts
async function classifyTask(description: string): Promise<string> {
  const systemPrompt = `You classify user tasks to exactly one of these specialists:
- main — ...
- comms — ...
- content — ...
- ops — ...
Respond with exactly ONE word: main, comms, content, or ops. ...`;

  let chosen = "main";
  for await (const msg of query({
    prompt: `Task: ${description}`,
    options: { systemPrompt, model: "claude-haiku-4-5", allowedTools: [] },
  })) {
    // parse result message, populate chosen
  }
  return chosen;
}
```

### Why Haiku
Classification is a cheap, well-bounded task: Haiku handles it in ~1–2s and costs a fraction of Sonnet. The cost delta across 100 task classifications is meaningful even for personal use; 10,000x meaningful once it's multi-user.

### The architecture win
Because Main is also a router (C01), even misclassified tasks land OK. A task misrouted to Main will get silently re-delegated to the right specialist via `Agent`. The classifier is an optimization, not a correctness requirement. That removes a whole class of "what if the classifier is wrong" anxiety.

---

## Entry 05 — Playwright split: smoke (offline) + engine (real SDK) (C06, 2026-04-23)

### The pattern
Two Playwright projects:
- `smoke` — runs with `grepInvert: /@engine/`, hits only routes that don't call the SDK (agents list, models list, cwd, browse, files). 7 tests, ~2 seconds.
- `engine` — runs with `grep: /@engine/`, hits the actual SDK via real Max-plan OAuth calls. 2 tests, ~16 seconds.

Separate `npm run test:smoke` / `test:engine` scripts so CI can run smoke on every PR and engine on a schedule (or locally before release).

### Why this matters
Real SDK calls are the only way to validate that streaming actually streams, that the classifier actually classifies, that Max plan auth actually works. But they cost real model calls and take 10x longer. Splitting them keeps the fast feedback loop fast while preserving a real-world regression gate.

### The `@file` popover test taught us about the blur-race
First cut failed intermittently. The popover was being hidden by the `blur` handler between Playwright's polls. Fix: wait for the `/api/files` network response inside a `Promise.all`, then immediately assert. The popover is guaranteed to be open in the narrow window between "request completed" and "blur hides it."

```ts
const [resp] = await Promise.all([
  page.waitForResponse((r) => r.url().includes("/api/files")),
  input.pressSequentially("Read @", { delay: 30 }),
]);
expect(resp.status()).toBe(200);
```

Lesson: when a UI event has a cleanup side-effect on timer, synchronize your test with the thing that *creates* the state, not with the state itself.
