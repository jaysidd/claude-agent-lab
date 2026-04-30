const state = {
  agents: [],
  models: [],
  activeAgentId: null,
  conversations: {},
  cwd: "",
  home: "",
  browse: { path: "", parent: null, dirs: [] },
  filePopover: { open: false, items: [], active: 0, atIndex: -1 },
};

const agentListEl = document.getElementById("agent-list");
const messagesEl = document.getElementById("messages");
const chatTitle = document.getElementById("chat-title");
const chatSub = document.getElementById("chat-sub");
const composer = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const resetBtn = document.getElementById("reset-btn");
const cwdPill = document.getElementById("cwd-pill");
const cwdLabel = document.getElementById("cwd-label");
const cwdModal = document.getElementById("cwd-modal");
const browsePath = document.getElementById("browse-path");
const browseList = document.getElementById("browse-list");
const cwdManual = document.getElementById("cwd-manual");
const filePopover = document.getElementById("file-popover");
const modelSelect = document.getElementById("model-select");

function shortenPath(p) {
  if (!p) return "";
  if (state.home && p.startsWith(state.home)) return "~" + p.slice(state.home.length);
  return p;
}

function prettyModel(id) {
  if (!id) return "?";
  const m = state.models.find((x) => id.startsWith(x.id));
  return m ? m.label : id;
}

function formatTokens(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function formatCost(n) {
  if (n == null) return "";
  if (n === 0) return "$0";
  if (n < 0.01) return "$" + n.toFixed(4);
  return "$" + n.toFixed(2);
}

// Sum of input + output tokens (ignoring cache info — that's "free" for the user)
function totalTokens(usage) {
  if (!usage) return 0;
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

function isOAuth(apiKeySource) {
  return apiKeySource === "none" || apiKeySource === "oauth";
}

// Session-wide totals tracker, keyed by agent id
state.sessionTotals = {};

function bumpSessionTotals(agentId, msg) {
  if (!agentId) return;
  const t = state.sessionTotals[agentId] ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    costUsd: 0,
    turns: 0,
    apiKeySource: null,
  };
  if (msg.usage) {
    t.inputTokens += msg.usage.input_tokens ?? 0;
    t.outputTokens += msg.usage.output_tokens ?? 0;
    t.cacheCreationInputTokens += msg.usage.cache_creation_input_tokens ?? 0;
    t.cacheReadInputTokens += msg.usage.cache_read_input_tokens ?? 0;
  }
  if (typeof msg.totalCostUsd === "number") t.costUsd += msg.totalCostUsd;
  t.turns += 1;
  t.apiKeySource = msg.apiKeySource ?? t.apiKeySource;
  state.sessionTotals[agentId] = t;
}

function renderSessionUsage() {
  const el = document.getElementById("session-usage");
  if (!el) return;
  const t = state.sessionTotals[state.activeAgentId];
  if (!t || t.turns === 0) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  const total = t.inputTokens + t.outputTokens;
  const showCost = !isOAuth(t.apiKeySource);
  el.classList.remove("hidden");
  el.innerHTML = "";
  const tokenSpan = document.createElement("span");
  tokenSpan.textContent = `${formatTokens(total)} tk · ${t.turns} turn${t.turns === 1 ? "" : "s"}`;
  el.appendChild(tokenSpan);
  if (showCost && t.costUsd > 0) {
    const costSpan = document.createElement("span");
    costSpan.className = "usage-cost";
    costSpan.textContent = " · " + formatCost(t.costUsd);
    el.appendChild(costSpan);
  }
  // Tooltip with breakdown
  const cacheNote =
    t.cacheReadInputTokens > 0
      ? ` · ${formatTokens(t.cacheReadInputTokens)} from cache`
      : "";
  el.title = isOAuth(t.apiKeySource)
    ? `Session totals — Max plan, no per-turn cost.\n${formatTokens(t.inputTokens)} in · ${formatTokens(t.outputTokens)} out${cacheNote}\n${t.turns} agent turn${t.turns === 1 ? "" : "s"}.`
    : `Session totals — API key billing.\n${formatTokens(t.inputTokens)} in · ${formatTokens(t.outputTokens)} out${cacheNote}\n${formatCost(t.costUsd)} across ${t.turns} turn${t.turns === 1 ? "" : "s"}.`;
}

function renderMarkdown(text) {
  if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
    return null;
  }
  try {
    marked.setOptions({
      breaks: true,
      gfm: true,
      highlight: (code, lang) => {
        if (typeof hljs !== "undefined" && lang && hljs.getLanguage(lang)) {
          try {
            return hljs.highlight(code, { language: lang }).value;
          } catch {
            /* noop */
          }
        }
        return code;
      },
    });
    const html = marked.parse(text);
    return DOMPurify.sanitize(html, {
      ADD_ATTR: ["target", "rel"],
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    });
  } catch {
    return null;
  }
}

async function loadModels() {
  const res = await fetch("/api/models");
  state.models = await res.json();
}

async function loadAgents() {
  const res = await fetch("/api/agents");
  state.agents = await res.json();
  renderAgents();
  if (state.activeAgentId && state.agents.some((a) => a.id === state.activeAgentId)) {
    selectAgent(state.activeAgentId);
  } else if (state.agents[0]) {
    selectAgent(state.agents[0].id);
  }
}

async function loadCwd() {
  const res = await fetch("/api/cwd");
  const data = await res.json();
  state.cwd = data.cwd;
  state.home = data.home;
  cwdLabel.textContent = shortenPath(state.cwd);
}

function renderAgents() {
  agentListEl.innerHTML = "";
  const countEl = document.getElementById("agent-count");
  if (countEl) countEl.textContent = state.agents.length;
  for (const agent of state.agents) {
    const el = document.createElement("div");
    el.className =
      "agent-item" +
      (agent.id === state.activeAgentId ? " active" : "") +
      (agent.builtIn ? "" : " custom");
    el.dataset.id = agent.id;

    const avatar = document.createElement("div");
    avatar.className = "agent-avatar";
    avatar.style.color = agent.accent;
    avatar.textContent = agent.emoji;

    const meta = document.createElement("div");
    meta.className = "agent-meta";

    const nameRow = document.createElement("div");
    nameRow.style.display = "flex";
    nameRow.style.justifyContent = "space-between";
    nameRow.style.alignItems = "center";
    const nameEl = document.createElement("div");
    nameEl.className = "agent-name";
    nameEl.textContent = agent.name;
    nameRow.appendChild(nameEl);

    if (!agent.builtIn) {
      const actions = document.createElement("div");
      actions.className = "agent-actions";
      const editBtn = document.createElement("button");
      editBtn.className = "agent-action-btn";
      editBtn.title = "Edit this agent";
      editBtn.textContent = "✎";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openAgentEditor(agent.id);
      });
      actions.appendChild(editBtn);
      nameRow.appendChild(actions);
    }

    const descEl = document.createElement("div");
    descEl.className = "agent-desc";
    descEl.textContent = agent.description;

    const chipEl = document.createElement("div");
    chipEl.className = "agent-model-chip";
    chipEl.textContent = prettyModel(agent.model);

    meta.append(nameRow, descEl, chipEl);
    el.append(avatar, meta);

    el.addEventListener("click", () => selectAgent(agent.id));
    agentListEl.appendChild(el);
  }
}

function renderModelSelect() {
  const agent = state.agents.find((a) => a.id === state.activeAgentId);
  if (!agent) return;
  modelSelect.innerHTML = "";
  for (const m of state.models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label + (m.id === agent.defaultModel ? " · default" : "");
    if (agent.model.startsWith(m.id)) opt.selected = true;
    modelSelect.appendChild(opt);
  }
}

function selectAgent(id) {
  state.activeAgentId = id;
  const agent = state.agents.find((a) => a.id === id);
  renderAgents();
  chatTitle.textContent = `${agent.emoji}  ${agent.name}`;
  chatSub.textContent = agent.description;
  input.disabled = false;
  sendBtn.disabled = false;
  renderModelSelect();
  reflectPlanMode();
  renderMessages();
  renderSessionUsage();
  input.focus();
}

function renderMessages() {
  const history = state.conversations[state.activeAgentId] ?? [];
  messagesEl.innerHTML = "";

  if (history.length === 0) {
    const agent = state.agents.find((a) => a.id === state.activeAgentId);
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.append(
      "Say hi to kick off a conversation.",
      document.createElement("br"),
      "Each agent has its own memory of this session.",
      document.createElement("br"),
      document.createElement("br"),
      "Folder: ",
    );
    const folderCode = document.createElement("code");
    folderCode.textContent = shortenPath(state.cwd);
    empty.appendChild(folderCode);
    empty.append(document.createElement("br"), "Model: ");
    const modelCode = document.createElement("code");
    modelCode.textContent = prettyModel(agent?.model);
    empty.appendChild(modelCode);
    messagesEl.appendChild(empty);
    return;
  }

  for (const m of history) {
    const row = document.createElement("div");
    row.className = `msg ${m.role}`;

    const body = document.createElement("div");
    body.className = "msg-body";
    if (m.streaming && !m.text) {
      body.classList.add("streaming-empty");
      body.textContent = "…";
    } else if (m.streaming) {
      // Live streaming: keep plain text to avoid parsing markdown per delta
      body.textContent = m.text;
      body.classList.add("streaming");
    } else if (m.role === "agent" && m.text) {
      // Completed agent reply: render markdown (sanitized)
      const html = renderMarkdown(m.text);
      if (html !== null) {
        body.innerHTML = html;
        body.classList.add("markdown");
        // Convert external links to open in new tab
        for (const a of body.querySelectorAll("a[href]")) {
          const href = a.getAttribute("href") || "";
          if (/^https?:/i.test(href)) {
            a.setAttribute("target", "_blank");
            a.setAttribute("rel", "noopener noreferrer");
          }
        }
      } else {
        body.textContent = m.text;
      }
    } else {
      body.textContent = m.text;
    }
    row.appendChild(body);

    if (m.toolUses && m.toolUses.length) {
      const chips = document.createElement("div");
      chips.className = "tool-chips";
      for (const t of m.toolUses) {
        const chip = document.createElement("span");
        if (t.name === "Agent") {
          const sub =
            (t.input && (t.input.subagent_type || t.input.agent || t.input.name)) || "specialist";
          const agent = state.agents.find((a) => a.id === sub);
          const label = agent ? `${agent.emoji} ${agent.name}` : sub;
          chip.className = "tool-chip delegation-chip";
          chip.textContent = `🤝 delegated to ${label}`;
        } else {
          chip.className = "tool-chip";
          chip.textContent = `🔧 ${t.name}`;
        }
        chips.appendChild(chip);
      }
      row.appendChild(chips);
    }

    if (m.role === "agent" && m.model) {
      const footer = document.createElement("div");
      footer.className = "msg-footer";

      const modelSpan = document.createElement("span");
      modelSpan.textContent = `🧠 ${prettyModel(m.model)}`;
      footer.appendChild(modelSpan);

      if (m.apiKeySource) {
        const authSpan = document.createElement("span");
        if (m.apiKeySource === "none" || m.apiKeySource === "oauth") {
          authSpan.className = "auth-oauth";
          authSpan.textContent = "🔐 Max plan · subscription";
        } else {
          authSpan.className = "auth-key";
          authSpan.textContent = `🔑 API key (${m.apiKeySource})`;
        }
        footer.appendChild(authSpan);
      }

      if (m.usage) {
        const usageSpan = document.createElement("span");
        usageSpan.className = "usage-chip";
        const tokens = totalTokens(m.usage);
        const tokensTxt = `📊 ${formatTokens(tokens)} tk`;
        const showCost = !isOAuth(m.apiKeySource) && typeof m.totalCostUsd === "number" && m.totalCostUsd > 0;
        if (showCost) {
          usageSpan.innerHTML =
            `${tokensTxt} · <span class="usage-cost">${formatCost(m.totalCostUsd)}</span>`;
        } else {
          usageSpan.textContent = tokensTxt;
        }
        usageSpan.title =
          `${m.usage.input_tokens ?? 0} in · ${m.usage.output_tokens ?? 0} out` +
          (m.usage.cache_read_input_tokens
            ? ` · ${m.usage.cache_read_input_tokens} from cache`
            : "");
        footer.appendChild(usageSpan);
      }

      if (m.text && !m.streaming) attachSpeakButton(footer, m.text);

      row.appendChild(footer);
    }
    if (m.role === "agent" && m.system && m.text && !m.streaming) {
      // System-origin messages (slash command output) also get a speak button
      const footer = document.createElement("div");
      footer.className = "msg-footer";
      attachSpeakButton(footer, m.text.replace(/[*_`#>]/g, ""));
      row.appendChild(footer);
    }

    messagesEl.appendChild(row);
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function sendMessage(text) {
  const agentId = state.activeAgentId;
  const history = state.conversations[agentId] ?? [];
  history.push({ role: "user", text });
  state.conversations[agentId] = history;
  state.pending = true;

  // Insert an empty agent bubble we'll fill incrementally
  const agentMsg = { role: "agent", text: "", toolUses: [], streaming: true };
  history.push(agentMsg);
  renderMessages();

  // Cache the streaming bubble's body element — mutate it directly on each delta
  // to avoid O(turns x deltas) DOM churn.
  const streamingBody = messagesEl.querySelector(".msg.agent:last-child .msg-body");

  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, message: text }),
    });
    if (!res.ok || !res.body) throw new Error("server error (status " + res.status + ")");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.kind === "init") {
          agentMsg.model = ev.model;
          agentMsg.apiKeySource = ev.apiKeySource;
        } else if (ev.kind === "usage") {
          agentMsg.usage = ev.usage;
          agentMsg.totalCostUsd = ev.totalCostUsd;
          agentMsg.numTurns = ev.numTurns;
        } else if (ev.kind === "text_delta") {
          agentMsg.text += ev.text;
          // Fast path: update the cached body element directly
          if (streamingBody) {
            if (streamingBody.classList.contains("streaming-empty")) {
              streamingBody.classList.remove("streaming-empty");
              streamingBody.classList.add("streaming");
            }
            streamingBody.textContent = agentMsg.text;
            messagesEl.scrollTop = messagesEl.scrollHeight;
            continue;
          }
          renderMessages();
        } else if (ev.kind === "tool_use") {
          agentMsg.toolUses.push({ name: ev.name, input: ev.input });
          renderMessages();
        } else if (ev.kind === "result") {
          if (!agentMsg.text) {
            agentMsg.text = ev.text;
            if (streamingBody) streamingBody.textContent = agentMsg.text;
          }
        } else if (ev.kind === "error") {
          agentMsg.text = `⚠️ ${ev.message}`;
          if (streamingBody) streamingBody.textContent = agentMsg.text;
        }
      }
    }
  } catch (err) {
    agentMsg.text = `⚠️ ${err.message}`;
  } finally {
    agentMsg.streaming = false;
    state.pending = false;
    if (agentMsg.usage) bumpSessionTotals(agentId, agentMsg);
    renderMessages();
    renderSessionUsage();
    refreshHistoryCount();
  }
}

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !state.activeAgentId || state.pending) return;
  input.value = "";
  input.style.height = "auto";
  hideFilePopover();
  hideCommandPopover();
  if (text.startsWith("/") && handleSlashCommand(text)) return;
  sendMessage(text);
});

input.addEventListener("keydown", (e) => {
  if (state.commandPopover.open) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      state.commandPopover.active = Math.min(
        state.commandPopover.active + 1,
        state.commandPopover.items.length - 1,
      );
      renderCommandPopover();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      state.commandPopover.active = Math.max(state.commandPopover.active - 1, 0);
      renderCommandPopover();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      completeSelectedCommand({ submit: false });
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      completeSelectedCommand({ submit: true });
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hideCommandPopover();
      return;
    }
  }
  if (state.filePopover.open) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      state.filePopover.active = Math.min(
        state.filePopover.active + 1,
        state.filePopover.items.length - 1,
      );
      renderFilePopover();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      state.filePopover.active = Math.max(state.filePopover.active - 1, 0);
      renderFilePopover();
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      insertSelectedFile();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hideFilePopover();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
  maybeShowCommandPopover();
  if (!input.value.startsWith("/")) maybeShowFilePopover();
});

resetBtn.addEventListener("click", async () => {
  if (!state.activeAgentId) return;
  await fetch(`/api/reset/${state.activeAgentId}`, { method: "POST" });
  state.conversations[state.activeAgentId] = [];
  delete state.sessionTotals[state.activeAgentId];
  renderMessages();
  renderSessionUsage();
});

modelSelect.addEventListener("change", async () => {
  if (!state.activeAgentId) return;
  const newModel = modelSelect.value;
  try {
    const res = await fetch(`/api/model/${state.activeAgentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: newModel }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data.model) throw new Error("server returned no model");
    // Update local agent record + clear that agent's chat (session was reset server-side)
    const agent = state.agents.find((a) => a.id === state.activeAgentId);
    if (agent) agent.model = data.model;
    state.conversations[state.activeAgentId] = [];
    renderAgents();
    renderMessages();
  } catch (err) {
    alert("Could not change model: " + err.message);
  }
});

// ----- Folder picker -----

cwdPill.addEventListener("click", () => openCwdModal(state.cwd));

document.getElementById("cwd-close").addEventListener("click", closeCwdModal);
document.getElementById("cwd-cancel").addEventListener("click", closeCwdModal);
cwdModal.addEventListener("click", (e) => {
  if (e.target === cwdModal) closeCwdModal();
});

for (const btn of document.querySelectorAll(".modal-quick button")) {
  btn.addEventListener("click", () => browseTo(btn.dataset.path));
}

document.getElementById("cwd-save").addEventListener("click", async () => {
  const manual = cwdManual.value.trim();
  const target = manual || state.browse.path;
  await saveCwd(target);
});

cwdManual.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveCwd(cwdManual.value.trim());
  }
});

async function openCwdModal(startPath) {
  cwdModal.classList.remove("hidden");
  cwdManual.value = "";
  await browseTo(startPath || state.home);
}

function closeCwdModal() {
  cwdModal.classList.add("hidden");
}

async function browseTo(p) {
  try {
    const url = "/api/browse?path=" + encodeURIComponent(p);
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.browse = data;
    renderBrowse();
  } catch (err) {
    alert("Could not open folder: " + err.message);
  }
}

function renderBrowse() {
  browsePath.textContent = shortenPath(state.browse.path);
  browseList.innerHTML = "";

  if (state.browse.parent) {
    const up = document.createElement("li");
    up.className = "parent";
    up.textContent = "↑  ..";
    up.addEventListener("click", () => browseTo(state.browse.parent));
    browseList.appendChild(up);
  }

  for (const dir of state.browse.dirs) {
    const li = document.createElement("li");
    li.textContent = "📁 " + dir;
    li.addEventListener("click", () => {
      const child = state.browse.path.replace(/\/$/, "") + "/" + dir;
      browseTo(child);
    });
    browseList.appendChild(li);
  }

  if (state.browse.dirs.length === 0 && !state.browse.parent) {
    const empty = document.createElement("li");
    empty.textContent = "(no subfolders)";
    empty.style.color = "var(--muted)";
    browseList.appendChild(empty);
  }
}

async function saveCwd(targetPath) {
  if (!targetPath) return;
  try {
    const res = await fetch("/api/cwd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: targetPath }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.cwd = data.cwd;
    cwdLabel.textContent = shortenPath(state.cwd);
    state.conversations = {};
    state.sessionTotals = {};
    closeCwdModal();
    renderMessages();
    renderSessionUsage();
  } catch (err) {
    alert("Could not set folder: " + err.message);
  }
}

// ----- @file autocomplete -----

function maybeShowFilePopover() {
  const value = input.value;
  const caret = input.selectionStart ?? value.length;
  const before = value.slice(0, caret);
  const atIdx = before.lastIndexOf("@");
  if (atIdx < 0) return hideFilePopover();
  if (atIdx > 0 && !/\s/.test(before[atIdx - 1])) return hideFilePopover();
  const q = before.slice(atIdx + 1);
  if (/\s/.test(q)) return hideFilePopover();
  fetchFiles(q, atIdx);
}

async function fetchFiles(q, atIdx) {
  try {
    const res = await fetch("/api/files?q=" + encodeURIComponent(q));
    const data = await res.json();
    if (!res.ok) return hideFilePopover();
    if (!data.files.length) return hideFilePopover();
    state.filePopover = { open: true, items: data.files, active: 0, atIndex: atIdx };
    renderFilePopover();
  } catch {
    hideFilePopover();
  }
}

function renderFilePopover() {
  filePopover.innerHTML = "";
  filePopover.classList.remove("hidden");
  state.filePopover.items.forEach((f, i) => {
    const el = document.createElement("div");
    el.className = "file-item" + (i === state.filePopover.active ? " active" : "");

    const iconSpan = document.createElement("span");
    iconSpan.className = "file-icon" + (f.isDir ? " file-dir" : "");
    iconSpan.textContent = f.isDir ? "📁" : "📄";

    const nameSpan = document.createElement("span");
    nameSpan.textContent = f.name;

    el.append(iconSpan, nameSpan);

    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      state.filePopover.active = i;
      insertSelectedFile();
    });
    filePopover.appendChild(el);
  });
}

function hideFilePopover() {
  state.filePopover.open = false;
  filePopover.classList.add("hidden");
}

function insertSelectedFile() {
  const f = state.filePopover.items[state.filePopover.active];
  if (!f) return;
  const value = input.value;
  const caret = input.selectionStart ?? value.length;
  const atIdx = state.filePopover.atIndex;
  const before = value.slice(0, atIdx);
  const after = value.slice(caret);
  const insertion = "`" + f.name + "` ";
  input.value = before + insertion + after;
  const newCaret = (before + insertion).length;
  input.setSelectionRange(newCaret, newCaret);
  hideFilePopover();
  input.focus();
}

input.addEventListener("blur", () => setTimeout(hideFilePopover, 100));

// Dismiss the command popover on any click outside the input or the popover
// itself. Robust against the Playwright / keyboard focus-churn that makes a
// blur-based dismiss flaky.
document.addEventListener("mousedown", (e) => {
  if (!state.commandPopover.open) return;
  if (e.target === input) return;
  if (e.target.closest && e.target.closest("#command-popover")) return;
  hideCommandPopover();
});

// ----- Task board -----

const tasksBtn = document.getElementById("tasks-btn");
const tasksCount = document.getElementById("tasks-count");
const tasksModal = document.getElementById("tasks-modal");
const tasksCloseBtn = document.getElementById("tasks-close");
const taskDescription = document.getElementById("task-description");
const taskPriority = document.getElementById("task-priority");
const taskAgentSelect = document.getElementById("task-agent");
const taskCreateBtn = document.getElementById("task-create-btn");

state.tasks = [];
state.memories = [];
state.planMode = {};

tasksBtn.addEventListener("click", openTasksModal);
tasksCloseBtn.addEventListener("click", () => {
  tasksModal.classList.add("hidden");
  stopApprovalPoll();
});
tasksModal.addEventListener("click", (e) => {
  if (e.target === tasksModal) {
    tasksModal.classList.add("hidden");
    stopApprovalPoll();
  }
});

async function openTasksModal() {
  populateTaskAgentSelect();
  await refreshTasks();
  tasksModal.classList.remove("hidden");
  taskDescription.focus();
  startApprovalPoll();
}

function populateTaskAgentSelect() {
  if (taskAgentSelect.options.length > 1) return;
  for (const a of state.agents) {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = `${a.emoji} ${a.name}`;
    taskAgentSelect.appendChild(opt);
  }
}

taskCreateBtn.addEventListener("click", createTask);
taskDescription.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    createTask();
  }
});

async function createTask() {
  const description = taskDescription.value.trim();
  if (!description) return;
  taskCreateBtn.disabled = true;
  taskCreateBtn.textContent = "Routing…";
  try {
    const body = { description, priority: taskPriority.value };
    if (taskAgentSelect.value) body.agentId = taskAgentSelect.value;
    const requiresApprovalEl = document.getElementById("task-requires-approval");
    if (requiresApprovalEl?.checked) body.requiresApproval = true;
    const res = await fetch("/api/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    taskDescription.value = "";
    if (requiresApprovalEl) requiresApprovalEl.checked = false;
    await refreshTasks();
  } catch (err) {
    alert("Could not create task: " + err.message);
  } finally {
    taskCreateBtn.disabled = false;
    taskCreateBtn.textContent = "Create";
  }
}

async function refreshTasks() {
  try {
    const [tasksRes, approvalsRes] = await Promise.all([
      fetch("/api/tasks"),
      fetch("/api/approvals?status=pending"),
    ]);
    state.tasks = await tasksRes.json();
    const approvals = approvalsRes.ok ? await approvalsRes.json() : [];
    // Index by taskId so renderTaskCard can look up O(1) — multiple pending
    // approvals on the same task are possible (sequential tool calls in one
    // run; the second only created after the first decides).
    state.pendingApprovalsByTask = {};
    for (const a of approvals) {
      (state.pendingApprovalsByTask[a.taskId] ||= []).push(a);
    }
    renderTasks();
  } catch {
    /* no-op */
  }
}

// Soft 5s poll while the tasks modal is open, so a pending approval
// triggered by a long-running task surfaces without a manual refresh.
// Stopped on modal close to avoid background work.
let _approvalPollHandle = null;
function startApprovalPoll() {
  if (_approvalPollHandle) return;
  _approvalPollHandle = setInterval(refreshTasks, 5000);
}
function stopApprovalPoll() {
  if (_approvalPollHandle) {
    clearInterval(_approvalPollHandle);
    _approvalPollHandle = null;
  }
}

async function decideApproval(approvalId, decision, reason) {
  try {
    const res = await fetch(`/api/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, reason: reason || undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    delete state.approvalDrafts[approvalId];
    await refreshTasks();
  } catch (err) {
    alert(`Could not ${decision}: ${err.message}`);
  }
}

function renderTasks() {
  const byStatus = { queued: [], active: [], done: [], error: [] };
  for (const t of state.tasks) (byStatus[t.status] ?? byStatus.queued).push(t);

  document.getElementById("col-queued").textContent = byStatus.queued.length;
  document.getElementById("col-active").textContent = byStatus.active.length;
  const doneCount = byStatus.done.length + byStatus.error.length;
  document.getElementById("col-done").textContent = doneCount;

  renderColumn("col-queued-list", byStatus.queued);
  renderColumn("col-active-list", byStatus.active);
  renderColumn("col-done-list", [...byStatus.done, ...byStatus.error]);

  // Update header count + pulse on active
  const active = byStatus.active.length;
  const queued = byStatus.queued.length;
  tasksCount.textContent = queued + active;
  tasksCount.classList.toggle("has-active", active > 0);
}

function renderColumn(id, items) {
  const el = document.getElementById(id);
  el.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "col-empty";
    empty.textContent =
      id === "col-queued-list"
        ? "Add a task above"
        : id === "col-active-list"
          ? "Nothing running"
          : "No completed tasks yet";
    el.appendChild(empty);
    return;
  }
  for (const t of items) el.appendChild(renderTaskCard(t));
}

// Per-approval draft store. The 5s poll re-renders the panel; without this
// the in-flight reason input would be wiped between the user's keystroke
// and their click. Keyed by approval.id, cleared on successful decide.
state.approvalDrafts = state.approvalDrafts || {};

function renderApprovalPanel(approval) {
  const panel = document.createElement("div");
  panel.className = "approval-panel";

  const head = document.createElement("div");
  head.className = "approval-head";
  const badge = document.createElement("span");
  badge.className = "approval-badge";
  badge.textContent = "⏸ awaiting approval";
  head.appendChild(badge);
  const tool = document.createElement("span");
  tool.className = "approval-tool";
  tool.textContent = approval.toolName;
  head.appendChild(tool);
  if (approval.cwd) {
    const cwdEl = document.createElement("span");
    cwdEl.className = "approval-cwd";
    cwdEl.textContent = approval.cwd;
    cwdEl.title = "cwd at the moment the tool fired";
    head.appendChild(cwdEl);
  }
  panel.appendChild(head);

  // Pretty-printed JSON payload — what the agent is about to invoke.
  const payload = document.createElement("pre");
  payload.className = "approval-payload";
  try {
    payload.textContent = JSON.stringify(approval.toolInput, null, 2);
  } catch {
    payload.textContent = String(approval.toolInput);
  }
  panel.appendChild(payload);

  const reasonInput = document.createElement("input");
  reasonInput.type = "text";
  reasonInput.placeholder = "Optional reason (encouraged on reject)";
  reasonInput.className = "approval-reason";
  reasonInput.value = state.approvalDrafts[approval.id] ?? "";
  reasonInput.addEventListener("input", () => {
    state.approvalDrafts[approval.id] = reasonInput.value;
  });
  panel.appendChild(reasonInput);

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const approveBtn = document.createElement("button");
  approveBtn.className = "approval-approve";
  approveBtn.textContent = "Approve";
  approveBtn.addEventListener("click", () => {
    decideApproval(approval.id, "approve", reasonInput.value);
  });
  const rejectBtn = document.createElement("button");
  rejectBtn.className = "approval-reject";
  rejectBtn.textContent = "Reject";
  rejectBtn.addEventListener("click", () => {
    decideApproval(approval.id, "reject", reasonInput.value);
  });
  actions.appendChild(approveBtn);
  actions.appendChild(rejectBtn);
  panel.appendChild(actions);

  return panel;
}

function renderTaskCard(task) {
  const agent = state.agents.find((a) => a.id === task.assignedAgent);
  const pendingApprovals =
    (state.pendingApprovalsByTask && state.pendingApprovalsByTask[task.id]) || [];
  const card = document.createElement("div");
  const awaitingApproval = pendingApprovals.length > 0;
  card.className =
    `task-card status-${task.status}` +
    (awaitingApproval ? " awaiting-approval" : "") +
    (task.requiresApproval ? " marked-approval" : "");

  const head = document.createElement("div");
  head.className = "task-card-head";
  const agentInfo = document.createElement("span");
  agentInfo.className = "task-card-agent";
  agentInfo.textContent = agent ? `${agent.emoji} ${agent.name}` : task.assignedAgent;
  const prio = document.createElement("span");
  prio.className = `task-card-priority ${task.priority}`;
  prio.textContent = task.priority;
  head.appendChild(agentInfo);
  head.appendChild(prio);
  if (task.requiresApproval) {
    const ra = document.createElement("span");
    ra.className = "task-card-requires-approval";
    ra.textContent = "🛡 approval";
    ra.title = "This task pauses before each Bash/Write/Edit/WebFetch tool call";
    head.appendChild(ra);
  }
  card.appendChild(head);

  const desc = document.createElement("div");
  desc.className = "task-card-desc";
  desc.textContent = task.description;
  card.appendChild(desc);

  // Inline approval panel — one per pending approval. Each surfaces the tool
  // name + JSON payload + Approve/Reject buttons + optional reason field.
  for (const approval of pendingApprovals) {
    card.appendChild(renderApprovalPanel(approval));
  }

  if (task.status === "done" && task.result) {
    const result = document.createElement("div");
    result.className = "task-card-result";
    result.textContent = task.result;
    card.appendChild(result);
  }
  if (task.status === "error" && task.error) {
    const err = document.createElement("div");
    err.className = "task-card-error";
    err.textContent = "⚠️ " + task.error;
    card.appendChild(err);
  }

  const actions = document.createElement("div");
  actions.className = "task-card-actions";

  if (task.status === "queued") {
    const runBtn = document.createElement("button");
    runBtn.className = "run-btn";
    runBtn.textContent = "Run";
    runBtn.addEventListener("click", () => runTask(task.id));
    actions.appendChild(runBtn);
  }

  if (task.status !== "active") {
    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => deleteTask(task.id));
    actions.appendChild(delBtn);
  }

  if (actions.children.length) card.appendChild(actions);

  return card;
}

async function runTask(id) {
  // Optimistic UI: mark as active immediately
  const local = state.tasks.find((t) => t.id === id);
  if (local) local.status = "active";
  renderTasks();

  try {
    const res = await fetch(`/api/task/${id}/run`, { method: "POST" });
    const updated = await res.json();
    if (!res.ok) throw new Error(updated.error);
    const idx = state.tasks.findIndex((t) => t.id === id);
    if (idx >= 0) state.tasks[idx] = updated;
    renderTasks();
  } catch (err) {
    if (local) {
      local.status = "error";
      local.error = err.message;
    }
    renderTasks();
  }
}

async function deleteTask(id) {
  try {
    await fetch(`/api/task/${id}`, { method: "DELETE" });
    state.tasks = state.tasks.filter((t) => t.id !== id);
    renderTasks();
  } catch {
    /* no-op */
  }
}

// ----- Memory panel -----

const memoryBtn = document.getElementById("memory-btn");
const memoryCount = document.getElementById("memory-count");
const memoryModal = document.getElementById("memory-modal");
const memoryCloseBtn = document.getElementById("memory-close");
const memoryContent = document.getElementById("memory-content");
const memoryCategory = document.getElementById("memory-category");
const memoryAgentSelect = document.getElementById("memory-agent");
const memoryCreateBtn = document.getElementById("memory-create-btn");
const memoryList = document.getElementById("memory-list");

memoryBtn.addEventListener("click", openMemoryModal);
memoryCloseBtn.addEventListener("click", () => memoryModal.classList.add("hidden"));
memoryModal.addEventListener("click", (e) => {
  if (e.target === memoryModal) memoryModal.classList.add("hidden");
});

memoryCreateBtn.addEventListener("click", createMemory);
memoryContent.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    createMemory();
  }
});

function populateMemoryAgentSelect() {
  if (memoryAgentSelect.options.length > 1) return;
  for (const a of state.agents) {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = `${a.emoji} ${a.name} only`;
    memoryAgentSelect.appendChild(opt);
  }
}

async function openMemoryModal() {
  populateMemoryAgentSelect();
  await refreshMemories();
  memoryModal.classList.remove("hidden");
  memoryContent.focus();
}

async function refreshMemories() {
  try {
    const res = await fetch("/api/memories");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.memories = await res.json();
  } catch (err) {
    console.warn("refreshMemories failed:", err);
    state.memories = [];
  }
  renderMemories();
}

function renderMemories() {
  memoryCount.textContent = state.memories.length;
  memoryList.innerHTML = "";
  if (state.memories.length === 0) {
    const empty = document.createElement("li");
    empty.className = "col-empty";
    empty.textContent = "No memories yet. Add one above.";
    memoryList.appendChild(empty);
    return;
  }
  for (const m of state.memories) {
    const li = document.createElement("li");
    li.className = "memory-card";

    const meta = document.createElement("div");
    meta.className = "memory-meta";

    const badge = document.createElement("span");
    badge.className = `memory-badge ${m.category}`;
    badge.textContent = m.category;
    meta.appendChild(badge);

    const scope = document.createElement("span");
    scope.className = "memory-scope";
    if (m.agentId) {
      const agent = state.agents.find((a) => a.id === m.agentId);
      scope.textContent = agent ? `${agent.emoji} ${agent.name}` : m.agentId;
    } else {
      scope.textContent = "🌐 Global";
    }
    meta.appendChild(scope);

    const content = document.createElement("div");
    content.className = "memory-content";
    content.textContent = m.content;

    const del = document.createElement("button");
    del.className = "memory-delete";
    del.title = "Delete";
    del.textContent = "×";
    del.addEventListener("click", () => deleteMemory(m.id));

    li.append(meta, content, del);
    memoryList.appendChild(li);
  }
}

async function createMemory() {
  const content = memoryContent.value.trim();
  if (!content) return;
  memoryCreateBtn.disabled = true;
  memoryCreateBtn.textContent = "Saving…";
  try {
    const body = { content, category: memoryCategory.value };
    if (memoryAgentSelect.value) body.agentId = memoryAgentSelect.value;
    const res = await fetch("/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    memoryContent.value = "";
    await refreshMemories();
  } catch (err) {
    alert("Could not save memory: " + err.message);
  } finally {
    memoryCreateBtn.disabled = false;
    memoryCreateBtn.textContent = "Add";
  }
}

async function deleteMemory(id) {
  try {
    await fetch(`/api/memories/${id}`, { method: "DELETE" });
    state.memories = state.memories.filter((m) => m.id !== id);
    renderMemories();
  } catch {
    /* noop */
  }
}

// ----- Slash command autocomplete popover -----

const SLASH_COMMANDS = [
  { cmd: "/help", desc: "list all slash commands" },
  { cmd: "/clear", desc: "new conversation with this agent" },
  { cmd: "/agents", desc: "list all agents and what they do" },
  { cmd: "/model", desc: "show current model + options" },
  { cmd: "/model opus", desc: "switch to Opus 4.7 (careful reasoning)" },
  { cmd: "/model sonnet", desc: "switch to Sonnet 4.6 (balanced default)" },
  { cmd: "/model haiku", desc: "switch to Haiku 4.5 (fast, cheap)" },
  { cmd: "/think hard", desc: "alias for /model opus" },
  { cmd: "/think fast", desc: "alias for /model haiku" },
  { cmd: "/think default", desc: "reset this agent to its configured model" },
  { cmd: "/plan on", desc: "enable plan mode — read-only agent run" },
  { cmd: "/plan off", desc: "disable plan mode" },
  { cmd: "/export", desc: "download this conversation as Markdown" },
  { cmd: "/export md", desc: "same as /export — Markdown download" },
  { cmd: "/export json", desc: "download this conversation as JSON" },
];

const commandPopover = document.getElementById("command-popover");
state.commandPopover = { open: false, items: [], active: 0 };

function maybeShowCommandPopover() {
  const value = input.value;
  // Only trigger when the line begins with "/" — not when the user references
  // a path mid-sentence. Also hide once the user hits Enter and submits.
  if (!value.startsWith("/")) return hideCommandPopover();
  // If there's more than one space and the second token is already resolved
  // (e.g. "/model opus  "), hide so the popover doesn't shadow the rest.
  if (value.trim().split(/\s+/).length > 2) return hideCommandPopover();

  const q = value.toLowerCase();
  const matches = SLASH_COMMANDS.filter((c) => c.cmd.toLowerCase().startsWith(q));
  if (!matches.length) return hideCommandPopover();

  state.commandPopover = { open: true, items: matches, active: 0 };
  renderCommandPopover();
}

function renderCommandPopover() {
  commandPopover.innerHTML = "";
  commandPopover.classList.remove("hidden");

  const header = document.createElement("div");
  header.className = "command-popover-header";
  header.textContent = "Slash commands  ·  ↑↓ navigate  ·  Tab to complete  ·  Enter to run";
  commandPopover.appendChild(header);

  state.commandPopover.items.forEach((c, i) => {
    const el = document.createElement("div");
    el.className = "command-item" + (i === state.commandPopover.active ? " active" : "");
    const name = document.createElement("div");
    name.className = "cmd-name";
    name.textContent = c.cmd;
    const desc = document.createElement("div");
    desc.className = "cmd-desc";
    desc.textContent = c.desc;
    el.append(name, desc);
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      state.commandPopover.active = i;
      completeSelectedCommand({ submit: true });
    });
    commandPopover.appendChild(el);
  });
}

function hideCommandPopover() {
  state.commandPopover.open = false;
  commandPopover.classList.add("hidden");
}

function completeSelectedCommand({ submit } = { submit: false }) {
  const pick = state.commandPopover.items[state.commandPopover.active];
  if (!pick) return;
  input.value = pick.cmd;
  input.dispatchEvent(new Event("input"));
  if (submit) {
    hideCommandPopover();
    composer.requestSubmit();
  } else {
    // Tab-completion: insert the command, leave cursor at end,
    // keep popover open only if there are subcommands still matching
    input.setSelectionRange(input.value.length, input.value.length);
    maybeShowCommandPopover();
  }
}

// ----- Slash commands -----

function handleSlashCommand(text) {
  const match = text.match(/^\/(\w+)(?:\s+(.*))?$/);
  if (!match) return false;
  const cmd = match[1].toLowerCase();
  const arg = (match[2] || "").trim();
  const agentId = state.activeAgentId;
  const history = state.conversations[agentId] ?? [];

  const say = (markdown) => {
    history.push({
      role: "agent",
      text: markdown,
      toolUses: [],
      streaming: false,
      system: true,
    });
    state.conversations[agentId] = history;
    renderMessages();
  };

  if (cmd === "help") {
    say(
      [
        "**Slash commands**",
        "- `/clear` — start a new conversation with this agent",
        "- `/model <id>` — switch model (opus, sonnet, haiku)",
        "- `/model` — show the current model + options",
        "- `/think hard` — switch this agent to Opus (more careful thinking)",
        "- `/think fast` — switch this agent to Haiku (snappy, cheap)",
        "- `/think default` — reset to this agent's configured model",
        "- `/agents` — list all agents and their purpose",
        "- `/plan on|off` — toggle plan mode for this agent",
        "- `/export` — download this chat as Markdown (`/export json` for JSON)",
        "- `/help` — this message",
        "",
        "**Keyboard shortcuts**",
        "- `⌥V` — start / stop WhisprDesk recording (when the tab is focused). `Alt+V` on Windows/Linux.",
        "- `Enter` — send message",
        "- `Shift+Enter` — newline in the composer",
        "- `@` — file autocomplete for the current folder",
        "- `/` — slash command autocomplete",
        "- `Esc` — dismiss any open popover",
      ].join("\n"),
    );
    return true;
  }

  if (cmd === "think") {
    const agent = state.agents.find((a) => a.id === agentId);
    const mapping = {
      hard: { id: "claude-opus-4-7", label: "Opus 4.7" },
      fast: { id: "claude-haiku-4-5", label: "Haiku 4.5" },
      default: { id: agent?.defaultModel, label: null },
    };
    const key = arg.toLowerCase();
    if (!mapping[key]) {
      say("Use `/think hard` (Opus), `/think fast` (Haiku), or `/think default` (agent's configured model).");
      return true;
    }
    const target = mapping[key];
    if (!target.id) {
      say("⚠️ Couldn't resolve the default model for this agent.");
      return true;
    }
    changeAgentModel(target.id);
    const niceName = target.label ?? prettyModel(target.id);
    say(
      `**${agent?.name}** will now use \`${niceName}\` for this conversation. Use \`/think default\` to reset.`,
    );
    return true;
  }

  if (cmd === "clear") {
    fetch(`/api/reset/${agentId}`, { method: "POST" });
    state.conversations[agentId] = [];
    renderMessages();
    return true;
  }

  if (cmd === "agents") {
    say(
      [
        "**Available agents**",
        ...state.agents.map(
          (a) => `- ${a.emoji} **${a.name}** — ${a.description} _(model: ${prettyModel(a.model)})_`,
        ),
      ].join("\n"),
    );
    return true;
  }

  if (cmd === "model") {
    if (!arg) {
      const current = state.agents.find((a) => a.id === agentId);
      say(
        [
          `Current model for **${current?.name}**: \`${current?.model}\``,
          "Available: `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`.",
          "Use `/model <id>` (aliases: opus, sonnet, haiku).",
        ].join("\n\n"),
      );
      return true;
    }
    const aliases = {
      opus: "claude-opus-4-7",
      sonnet: "claude-sonnet-4-6",
      haiku: "claude-haiku-4-5",
    };
    const target = aliases[arg.toLowerCase()] || arg;
    const known = state.models.find((m) => target.startsWith(m.id));
    if (!known) {
      say(`⚠️ Unknown model \`${arg}\`. Try opus, sonnet, or haiku.`);
      return true;
    }
    changeAgentModel(target);
    say(`Model for **${state.agents.find((a) => a.id === agentId)?.name}** set to \`${known.label}\`.`);
    return true;
  }

  if (cmd === "export") {
    const fmt = (arg || "md").toLowerCase();
    if (fmt !== "md" && fmt !== "markdown" && fmt !== "json") {
      say("Use `/export` (Markdown) or `/export json`.");
      return true;
    }
    const result = downloadCurrentConversation(fmt === "json" ? "json" : "md");
    say(
      result.ok
        ? `Downloaded **${result.filename}** (${result.bytes} bytes).`
        : `⚠️ ${result.error}`,
    );
    return true;
  }

  if (cmd === "plan") {
    const on = arg.toLowerCase() === "on" || arg === "1" || arg === "true";
    const off = arg.toLowerCase() === "off" || arg === "0" || arg === "false";
    if (!on && !off) {
      say(
        `Plan mode for **${state.agents.find((a) => a.id === agentId)?.name}** is \`${state.planMode[agentId] ? "on" : "off"}\`. Use \`/plan on\` or \`/plan off\`.`,
      );
      return true;
    }
    setPlanMode(agentId, on);
    say(`Plan mode ${on ? "enabled" : "disabled"} for this agent.`);
    return true;
  }

  say(`⚠️ Unknown command \`/${cmd}\`. Try \`/help\`.`);
  return true;
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function safeFilename(s) {
  return s.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "chat";
}

function downloadCurrentConversation(fmt) {
  const agent = state.agents.find((a) => a.id === state.activeAgentId);
  if (!agent) return { ok: false, error: "no active agent" };
  const conv = state.conversations[agent.id] ?? [];
  if (conv.length === 0) return { ok: false, error: "this conversation is empty" };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const baseName = `${safeFilename(agent.name)}-${stamp}`;

  if (fmt === "json") {
    const payload = {
      exportedAt: new Date().toISOString(),
      agent: {
        id: agent.id,
        name: agent.name,
        model: agent.model,
      },
      messages: conv,
      sessionTotals: state.sessionTotals[agent.id] ?? null,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const filename = `${baseName}.json`;
    downloadBlob(filename, blob);
    return { ok: true, filename, bytes: blob.size };
  }

  // Markdown export
  const lines = [];
  lines.push(`# Chat with ${agent.emoji} ${agent.name}`);
  lines.push(`*Exported ${new Date().toLocaleString()}*`);
  const totals = state.sessionTotals[agent.id];
  if (totals && totals.turns > 0) {
    const tk = totals.inputTokens + totals.outputTokens;
    const oauth = isOAuth(totals.apiKeySource);
    lines.push(
      oauth
        ? `*${totals.turns} turn${totals.turns === 1 ? "" : "s"} · ${formatTokens(tk)} tokens · Max plan*`
        : `*${totals.turns} turn${totals.turns === 1 ? "" : "s"} · ${formatTokens(tk)} tokens · ${formatCost(totals.costUsd)}*`,
    );
  }
  lines.push("");
  lines.push("---");
  for (const m of conv) {
    lines.push("");
    if (m.role === "user") {
      lines.push("**You:**");
      lines.push("");
      lines.push(m.text);
    } else {
      const modelTag = m.model ? prettyModel(m.model) : "agent";
      const usageTag = m.usage
        ? `, ${formatTokens(totalTokens(m.usage))} tk` +
          (!isOAuth(m.apiKeySource) && typeof m.totalCostUsd === "number" && m.totalCostUsd > 0
            ? ` · ${formatCost(m.totalCostUsd)}`
            : "")
        : "";
      lines.push(`**${agent.name}** _(${modelTag}${usageTag})_:`);
      lines.push("");
      lines.push(m.text);
      if (m.toolUses && m.toolUses.length) {
        lines.push("");
        lines.push("> Tools used: " + m.toolUses.map((t) => `\`${t.name}\``).join(", "));
      }
    }
    lines.push("");
    lines.push("---");
  }
  const md = lines.join("\n");
  const blob = new Blob([md], { type: "text/markdown" });
  const filename = `${baseName}.md`;
  downloadBlob(filename, blob);
  return { ok: true, filename, bytes: blob.size };
}

async function changeAgentModel(modelId) {
  const agentId = state.activeAgentId;
  if (!agentId) return;
  const res = await fetch(`/api/model/${agentId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId }),
  });
  const data = await res.json();
  if (!res.ok) return;
  const agent = state.agents.find((a) => a.id === agentId);
  if (agent) agent.model = data.model;
  renderAgents();
  renderModelSelect();
}

// ----- Plan mode -----

const planCheckbox = document.getElementById("plan-checkbox");
const planToggle = document.getElementById("plan-toggle");

planCheckbox.addEventListener("change", async () => {
  await setPlanMode(state.activeAgentId, planCheckbox.checked);
});

async function setPlanMode(agentId, enabled) {
  if (!agentId) return;
  try {
    const res = await fetch(`/api/plan/${agentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.planMode[agentId] = !!data.enabled;
    if (agentId === state.activeAgentId) {
      planCheckbox.checked = state.planMode[agentId];
      planToggle.classList.toggle("active", state.planMode[agentId]);
    }
  } catch (err) {
    alert("Could not set plan mode: " + err.message);
  }
}

function reflectPlanMode() {
  const on = !!state.planMode[state.activeAgentId];
  planCheckbox.checked = on;
  planToggle.classList.toggle("active", on);
}

// ----- Agent editor (create + edit custom agents) -----

const agentModal = document.getElementById("agent-modal");
const agentModalTitle = document.getElementById("agent-modal-title");
const agentEmojiInput = document.getElementById("agent-emoji");
const agentNameInput = document.getElementById("agent-name");
const agentAccentInput = document.getElementById("agent-accent");
const agentDescInput = document.getElementById("agent-description");
const agentModelSelect = document.getElementById("agent-model");
const agentToolsGrid = document.getElementById("agent-tools");
const agentRouterCheckbox = document.getElementById("agent-router");
const agentSystemPromptInput = document.getElementById("agent-system-prompt");
const agentSaveBtn = document.getElementById("agent-save");
const agentCancelBtn = document.getElementById("agent-cancel");
const agentCloseBtn = document.getElementById("agent-close");
const agentDeleteBtn = document.getElementById("agent-delete");
const newAgentBtn = document.getElementById("new-agent-btn");

const AVAILABLE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Agent",
  "NotebookEdit",
  "AskUserQuestion",
  "Monitor",
];

let editingAgentId = null;

function renderToolCheckboxes(selected = []) {
  agentToolsGrid.innerHTML = "";
  const sel = new Set(selected);
  for (const tool of AVAILABLE_TOOLS) {
    const lbl = document.createElement("label");
    lbl.className = "agent-tool-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.tool = tool;
    cb.checked = sel.has(tool);
    lbl.appendChild(cb);
    const span = document.createElement("span");
    span.textContent = tool;
    lbl.appendChild(span);
    agentToolsGrid.appendChild(lbl);
  }
}

function populateAgentModelSelect(current) {
  agentModelSelect.innerHTML = "";
  for (const m of state.models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    if (current && current.startsWith(m.id)) opt.selected = true;
    agentModelSelect.appendChild(opt);
  }
}

function clearAgentForm() {
  editingAgentId = null;
  agentEmojiInput.value = "🤖";
  agentNameInput.value = "";
  agentAccentInput.value = "#8b9eff";
  agentDescInput.value = "";
  agentSystemPromptInput.value = "";
  agentRouterCheckbox.checked = false;
  populateAgentModelSelect("claude-sonnet-4-6");
  renderToolCheckboxes([]);
  agentDeleteBtn.classList.add("hidden");
  agentModalTitle.textContent = "New agent";
}

function openAgentEditor(id) {
  if (!id) {
    clearAgentForm();
    agentModal.classList.remove("hidden");
    agentNameInput.focus();
    return;
  }
  const agent = state.agents.find((a) => a.id === id);
  if (!agent) return;
  editingAgentId = id;
  agentEmojiInput.value = agent.emoji || "🤖";
  agentNameInput.value = agent.name || "";
  agentAccentInput.value = agent.accent || "#8b9eff";
  agentDescInput.value = agent.description || "";
  populateAgentModelSelect(agent.model);
  renderToolCheckboxes(agent.allowedTools || []);
  agentRouterCheckbox.checked = !!agent.isRouter;
  agentModalTitle.textContent = `Edit agent — ${agent.name}`;
  agentDeleteBtn.classList.remove("hidden");
  // Fetch the full record (including system prompt, which /api/agents list omits)
  fetch(`/api/agents/${id}`)
    .then((r) => {
      if (!r.ok) throw new Error(`failed to load agent (${r.status})`);
      return r.json();
    })
    .then((full) => {
      agentSystemPromptInput.value = full.systemPrompt || "";
    })
    .catch((err) => {
      console.warn("agent editor: could not load full record:", err);
      agentSystemPromptInput.value = "";
      agentSystemPromptInput.placeholder =
        "(failed to load saved prompt — type a new one to overwrite)";
    });
  agentModal.classList.remove("hidden");
}

newAgentBtn.addEventListener("click", () => openAgentEditor(null));
agentCloseBtn.addEventListener("click", () => agentModal.classList.add("hidden"));
agentCancelBtn.addEventListener("click", () => agentModal.classList.add("hidden"));
agentModal.addEventListener("click", (e) => {
  if (e.target === agentModal) agentModal.classList.add("hidden");
});

agentSaveBtn.addEventListener("click", async () => {
  const name = agentNameInput.value.trim();
  const systemPrompt = agentSystemPromptInput.value.trim();
  if (!name) return alert("Name required");
  if (!systemPrompt) return alert("System prompt required");
  const body = {
    name,
    emoji: agentEmojiInput.value.trim() || "🤖",
    accent: agentAccentInput.value,
    description: agentDescInput.value.trim(),
    systemPrompt,
    allowedTools: Array.from(agentToolsGrid.querySelectorAll("input:checked")).map(
      (el) => el.dataset.tool,
    ),
    model: agentModelSelect.value,
    isRouter: agentRouterCheckbox.checked,
  };
  agentSaveBtn.disabled = true;
  agentSaveBtn.textContent = "Saving…";
  try {
    let res;
    if (editingAgentId) {
      res = await fetch(`/api/agents/${editingAgentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } else {
      res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    await loadAgents();
    selectAgent(data.id);
    agentModal.classList.add("hidden");
  } catch (err) {
    alert("Could not save agent: " + err.message);
  } finally {
    agentSaveBtn.disabled = false;
    agentSaveBtn.textContent = "Save";
  }
});

agentDeleteBtn.addEventListener("click", async () => {
  if (!editingAgentId) return;
  if (!confirm(`Delete agent "${agentNameInput.value}"? This is permanent.`)) return;
  try {
    const res = await fetch(`/api/agents/${editingAgentId}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (state.activeAgentId === editingAgentId) state.activeAgentId = null;
    await loadAgents();
    agentModal.classList.add("hidden");
  } catch (err) {
    alert("Could not delete agent: " + err.message);
  }
});

// ----- Session history -----

const historyBtn = document.getElementById("history-btn");
const historyCount = document.getElementById("history-count");
const historyModal = document.getElementById("history-modal");
const historyCloseBtn = document.getElementById("history-close");
const historyListEl = document.getElementById("history-list");

historyBtn.addEventListener("click", openHistoryModal);
historyCloseBtn.addEventListener("click", () => historyModal.classList.add("hidden"));
historyModal.addEventListener("click", (e) => {
  if (e.target === historyModal) historyModal.classList.add("hidden");
});

async function refreshHistoryCount() {
  try {
    const res = await fetch("/api/sessions");
    const sessions = await res.json();
    historyCount.textContent = sessions.length;
  } catch {
    historyCount.textContent = "0";
  }
}

async function openHistoryModal() {
  await renderHistoryList();
  historyModal.classList.remove("hidden");
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

async function renderHistoryList() {
  historyListEl.innerHTML = "<div class='history-empty'>Loading…</div>";
  let sessions;
  try {
    const res = await fetch("/api/sessions");
    sessions = await res.json();
  } catch (err) {
    historyListEl.innerHTML = `<div class="history-empty">Failed to load: ${err.message}</div>`;
    return;
  }
  historyCount.textContent = sessions.length;

  if (sessions.length === 0) {
    historyListEl.innerHTML =
      "<div class='history-empty'>No conversations yet — send a message to start your first one.</div>";
    return;
  }

  // Group by agent
  const byAgent = {};
  for (const s of sessions) {
    if (!byAgent[s.agentId]) byAgent[s.agentId] = [];
    byAgent[s.agentId].push(s);
  }

  historyListEl.innerHTML = "";
  for (const agentId of Object.keys(byAgent)) {
    const agent = state.agents.find((a) => a.id === agentId);
    const group = document.createElement("div");
    group.className = "history-agent-group";

    const header = document.createElement("div");
    header.className = "history-agent-header";
    const emoji = document.createElement("span");
    emoji.className = "agent-emoji";
    emoji.textContent = agent?.emoji ?? "🤖";
    const name = document.createElement("span");
    name.className = "agent-name";
    name.textContent = agent?.name ?? agentId;
    const count = document.createElement("span");
    count.className = "session-count";
    count.textContent = byAgent[agentId].length;
    header.append(emoji, name, count);
    group.appendChild(header);

    for (const s of byAgent[agentId]) {
      group.appendChild(renderHistoryRow(s));
    }

    historyListEl.appendChild(group);
  }
}

function renderHistoryRow(s) {
  const row = document.createElement("div");
  row.className = "history-row";
  row.dataset.id = s.id;

  const main = document.createElement("div");
  main.className = "row-main";

  const title = document.createElement("div");
  title.className = "row-title";
  title.textContent = s.title || "(untitled session)";
  main.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "row-meta";
  const tokens = (s.totalInput ?? 0) + (s.totalOutput ?? 0);
  const turns = Math.max(1, Math.floor(s.messageCount / 2));
  meta.textContent = `${turns} turn${turns === 1 ? "" : "s"}  ·  ${formatTokens(tokens)} tk  ·  ${relativeTime(s.updatedAt)}`;
  main.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const renameBtn = document.createElement("button");
  renameBtn.className = "row-action-btn";
  renameBtn.title = "Rename";
  renameBtn.textContent = "✎";
  renameBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const next = prompt("New title:", s.title || "");
    if (next === null || !next.trim()) return;
    await fetch(`/api/sessions/${s.id}/title`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: next.trim() }),
    });
    await renderHistoryList();
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "row-action-btn danger";
  deleteBtn.title = "Delete";
  deleteBtn.textContent = "✕";
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${s.title || "this session"}"? This is permanent.`)) return;
    await fetch(`/api/sessions/${s.id}`, { method: "DELETE" });
    await renderHistoryList();
  });

  actions.append(renameBtn, deleteBtn);

  row.append(main, actions);
  row.addEventListener("click", () => restoreSession(s));
  return row;
}

async function restoreSession(s) {
  try {
    const res = await fetch(`/api/sessions/${s.id}/restore`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    // Switch to the right agent if needed
    if (state.activeAgentId !== s.agentId) selectAgent(s.agentId);

    // Replace the in-memory conversation with the restored messages
    const conv = data.messages.map((m) => ({
      role: m.role,
      text: m.text,
      toolUses: m.toolUses ?? [],
      model: m.model,
      apiKeySource: m.apiKeySource,
      usage: m.usage,
      totalCostUsd: m.totalCostUsd,
      streaming: false,
    }));
    state.conversations[s.agentId] = conv;

    // Rebuild session totals from the restored history
    const totals = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costUsd: 0,
      turns: 0,
      apiKeySource: null,
    };
    for (const m of conv) {
      if (m.role !== "agent" || !m.usage) continue;
      totals.inputTokens += m.usage.input_tokens ?? 0;
      totals.outputTokens += m.usage.output_tokens ?? 0;
      totals.cacheCreationInputTokens += m.usage.cache_creation_input_tokens ?? 0;
      totals.cacheReadInputTokens += m.usage.cache_read_input_tokens ?? 0;
      totals.costUsd += m.totalCostUsd ?? 0;
      totals.turns += 1;
      totals.apiKeySource = m.apiKeySource ?? totals.apiKeySource;
    }
    state.sessionTotals[s.agentId] = totals;

    historyModal.classList.add("hidden");
    renderMessages();
    renderSessionUsage();
  } catch (err) {
    alert("Could not restore session: " + err.message);
  }
}

// ----- Settings -----

const settingsBtn = document.getElementById("settings-btn");
const settingsModal = document.getElementById("settings-modal");
const settingsSectionsEl = document.getElementById("settings-sections");
const settingsCloseBtn = document.getElementById("settings-close");
const settingsCancelBtn = document.getElementById("settings-cancel");
const settingsSaveBtn = document.getElementById("settings-save");

let settingsState = { schema: [], values: [], envFallbacks: [] };

settingsBtn.addEventListener("click", openSettingsModal);
settingsCloseBtn.addEventListener("click", () => settingsModal.classList.add("hidden"));
settingsCancelBtn.addEventListener("click", () => settingsModal.classList.add("hidden"));
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) settingsModal.classList.add("hidden");
});
settingsSaveBtn.addEventListener("click", saveSettings);

async function openSettingsModal() {
  await loadSettings();
  renderSettings();
  settingsModal.classList.remove("hidden");
}

async function loadSettings() {
  try {
    const res = await fetch("/api/settings");
    settingsState = await res.json();
  } catch (err) {
    alert("Could not load settings: " + err.message);
  }
}

function renderSettings() {
  settingsSectionsEl.innerHTML = "";
  const valueByKey = {};
  for (const v of settingsState.values) valueByKey[v.key] = v;
  const envByKey = {};
  for (const e of settingsState.envFallbacks) envByKey[e.key] = e;

  for (const section of settingsState.schema) {
    const secEl = document.createElement("div");
    secEl.className = "settings-section" + (section.disabled ? " disabled" : "");
    const h = document.createElement("h3");
    h.textContent = section.section;
    if (section.disabled) {
      const badge = document.createElement("span");
      badge.className = "section-badge";
      badge.textContent = "coming soon";
      h.appendChild(badge);
    }
    secEl.appendChild(h);

    if (section.disabled && section.disabledNote) {
      const note = document.createElement("p");
      note.className = "section-disabled-note";
      note.textContent = section.disabledNote;
      secEl.appendChild(note);
    }

    for (const field of section.fields) {
      const fieldEl = document.createElement("div");
      fieldEl.className = "settings-field";

      const current = valueByKey[field.key];
      const envSet = envByKey[field.key];

      const lbl = document.createElement("label");
      lbl.textContent = field.label;
      const meta = document.createElement("span");
      meta.className = "field-meta";
      if (current?.hasValue) {
        meta.textContent = "saved in db";
      } else if (envSet?.set) {
        meta.className = "field-meta env-fallback";
        meta.textContent = "from " + envSet.envKey;
      } else {
        meta.textContent = "unset";
      }
      lbl.appendChild(meta);
      fieldEl.appendChild(lbl);

      const isTextarea = field.type === "textarea";
      const inp = document.createElement(isTextarea ? "textarea" : "input");
      if (!isTextarea) inp.type = field.isSecret ? "password" : "text";
      inp.dataset.key = field.key;
      inp.dataset.secret = field.isSecret ? "1" : "0";
      inp.placeholder = field.placeholder ?? "";
      if (section.disabled) {
        inp.disabled = true;
        inp.dataset.disabled = "1";
      }
      if (!field.isSecret && current?.hasValue) {
        inp.value = current.preview || "";
      }
      // Dirty-state cue: amber border once the user types, cleared after save.
      inp.addEventListener("input", () => {
        inp.classList.add("dirty");
        // Mark the section as dirty so per-section save / auto-save-on-test
        // can detect it in O(1) without re-scanning all inputs.
        secEl.dataset.dirty = "1";
        // Reset the "✓ Saved" affordance on the per-section button so
        // future save state is honest.
        const saveBtn = secEl.querySelector(".btn-save-section");
        if (saveBtn) {
          saveBtn.classList.remove("saved");
          saveBtn.textContent = "Save section";
        }
      });
      fieldEl.appendChild(inp);

      if (field.isSecret && current?.hasValue) {
        const preview = document.createElement("div");
        preview.className = "field-preview";
        preview.textContent = `current: ${current.preview}  (leave blank to keep)`;
        fieldEl.appendChild(preview);
      }

      if (field.help) {
        const help = document.createElement("div");
        help.className = "field-help";
        help.textContent = field.help;
        fieldEl.appendChild(help);
      }

      secEl.appendChild(fieldEl);
    }

    // Per-section action row: Save section + Test connection (where applicable).
    // Lets operators commit their edits without scrolling to the modal-bottom
    // global Save. The Test button auto-saves dirty fields first so the
    // common "type token → click Test" flow Just Works.
    if (!section.disabled) {
      const actions = document.createElement("div");
      actions.className = "section-actions";

      const saveBtn = document.createElement("button");
      saveBtn.className = "btn-save-section";
      saveBtn.type = "button";
      saveBtn.textContent = "Save section";
      saveBtn.addEventListener("click", () => saveSection(secEl));
      actions.appendChild(saveBtn);

      if (section.section.startsWith("WhisprDesk")) {
        const testBtn = document.createElement("button");
        testBtn.className = "btn-test";
        testBtn.type = "button";
        testBtn.textContent = "Test connection";
        testBtn.addEventListener("click", () => testWhisprDesk(secEl));
        actions.appendChild(testBtn);
      }
      if (section.section.startsWith("Telegram")) {
        const testBtn = document.createElement("button");
        testBtn.className = "btn-test";
        testBtn.type = "button";
        testBtn.textContent = "Test connection";
        testBtn.addEventListener("click", () => testTelegram(secEl));
        actions.appendChild(testBtn);
      }

      secEl.appendChild(actions);

      const result = document.createElement("div");
      result.dataset.role = "test-result";
      secEl.appendChild(result);

      if (section.section.startsWith("Telegram")) {
        // Surface the listener's live status on first render so the
        // operator sees ● connected / ⚠ auth_failed without having to
        // click Test.
        refreshTelegramStatusInto(result);
      }
    }

    settingsSectionsEl.appendChild(secEl);
  }
}

// Collect editable settings entries from a scope (whole modal or a single
// section). Returns the array of {key, value, isSecret} entries that should
// be POSTed. Secret fields with empty values are skipped (preserves existing
// secret); non-secret fields with empty values clear the DB row if one
// existed previously.
function collectSettingsEntriesFrom(scopeEl) {
  const entries = [];
  for (const inp of scopeEl.querySelectorAll("[data-key]")) {
    if (inp.dataset.disabled === "1") continue;
    const key = inp.dataset.key;
    const isSecret = inp.dataset.secret === "1";
    const value = inp.value;
    if (isSecret) {
      if (value.trim()) entries.push({ key, value: value.trim(), isSecret: true });
    } else {
      const prev = settingsState.values.find((v) => v.key === key);
      if (value.trim()) {
        entries.push({ key, value: value.trim(), isSecret: false });
      } else if (prev?.hasValue) {
        entries.push({ key, value: null });
      }
    }
  }
  return entries;
}

// Submit a batch of entries, handle the response, and re-probe statuses.
// Returns true on success. Reports errors via alert.
async function postSettingsEntries(entries) {
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return true;
  } catch (err) {
    alert("Could not save settings: " + err.message);
    return false;
  }
}

// Whole-modal save (the Save changes button at the modal bottom). Same
// behavior as before — collects every editable input, POSTs, re-renders.
async function saveSettings() {
  const entries = collectSettingsEntriesFrom(settingsSectionsEl);
  settingsSaveBtn.disabled = true;
  settingsSaveBtn.textContent = "Saving…";
  try {
    const ok = await postSettingsEntries(entries);
    if (!ok) return;
    await loadSettings();
    renderSettings();
    await refreshWhisprDeskStatus();
  } finally {
    settingsSaveBtn.disabled = false;
    settingsSaveBtn.textContent = "Save changes";
  }
}

// Per-section save — wired to the inline "Save section" button. Saves only
// fields within secEl. After success, clears dirty cues on the section's
// inputs and flashes the button "✓ Saved" briefly. Re-renders ONLY this
// section's metadata (envFallback indicators, "saved in db" labels) by
// re-fetching settings — full-modal re-render would lose focus / cursor
// position on whichever input the user was about to interact with next.
async function saveSection(secEl) {
  const entries = collectSettingsEntriesFrom(secEl);
  const saveBtn = secEl.querySelector(".btn-save-section");
  if (!saveBtn) return false;
  if (entries.length === 0) {
    // Nothing to save — flash a quick "Up to date" hint instead of "Saved".
    saveBtn.classList.add("saved");
    saveBtn.textContent = "✓ Up to date";
    setTimeout(() => {
      saveBtn.classList.remove("saved");
      saveBtn.textContent = "Save section";
    }, 1500);
    return true;
  }
  saveBtn.disabled = true;
  const originalText = saveBtn.textContent;
  saveBtn.textContent = "Saving…";
  try {
    const ok = await postSettingsEntries(entries);
    if (!ok) {
      saveBtn.textContent = originalText;
      return false;
    }
    // Reload settings into state so the next-render meta labels are correct,
    // then clear dirty cues on this section's inputs without rebuilding the
    // whole modal.
    await loadSettings();
    secEl.dataset.dirty = "0";
    secEl.querySelectorAll("[data-key]").forEach((inp) => {
      inp.classList.remove("dirty");
      // Secret inputs auto-clear after save (matching old whole-modal behavior).
      if (inp.dataset.secret === "1") inp.value = "";
    });
    saveBtn.classList.add("saved");
    saveBtn.textContent = "✓ Saved";
    setTimeout(() => {
      // Only revert the label if no new dirty edits arrived in the meantime.
      if (secEl.dataset.dirty !== "1") {
        saveBtn.classList.remove("saved");
        saveBtn.textContent = "Save section";
      }
    }, 2000);
    // Probe integration statuses if relevant (telegram restart fires
    // server-side; surface the new status inline).
    const result = secEl.querySelector("[data-role='test-result']");
    if (result && secEl.querySelector(".btn-save-section")) {
      const heading = secEl.querySelector("h3, h4, .section-title")?.textContent ?? "";
      if (/Telegram/i.test(heading) || /WhisprDesk/i.test(heading)) {
        // Tiny delay so the server-side restartTelegram() has time to do
        // its first getMe() probe before we read /api/telegram/status.
        setTimeout(() => {
          if (/Telegram/i.test(heading)) refreshTelegramStatusInto(result);
        }, 500);
      }
    }
    return true;
  } finally {
    saveBtn.disabled = false;
  }
}

// Used by Test connection buttons: if the section has dirty fields, save
// them first so the test runs against the latest values. Returns true if
// the section is clean / save succeeded; false if the save failed and the
// caller should bail out of the test.
async function ensureSectionSavedBeforeTest(secEl) {
  if (secEl.dataset.dirty !== "1") return true;
  return await saveSection(secEl);
}

async function testTelegram(secEl) {
  const result = secEl.querySelector("[data-role='test-result']");
  // Save dirty fields first so a fresh token/allowlist is what gets tested.
  // The user's mental model is "I typed a token, then clicked Test" — they
  // shouldn't have to also remember to save first.
  result.className = "settings-test-result";
  result.textContent = "Saving…";
  const saved = await ensureSectionSavedBeforeTest(secEl);
  if (!saved) {
    result.classList.add("err");
    result.textContent = "Could not save before testing — fix the error above and retry.";
    return;
  }
  result.textContent = "Testing…";
  try {
    const res = await fetch("/api/telegram/test", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      result.classList.add("ok");
      result.textContent = `✓ Bot @${data.botUsername}`;
    } else {
      result.classList.add("err");
      result.textContent = `Test failed: ${data.error}`;
    }
  } catch (err) {
    result.classList.add("err");
    result.textContent = "Test failed: " + err.message;
  }
}

// Show the listener's live status (not a probe — reads what the long-poll
// loop currently knows). Called when the Telegram settings section renders.
async function refreshTelegramStatusInto(resultEl) {
  try {
    const res = await fetch("/api/telegram/status");
    const data = await res.json();
    resultEl.className = "settings-test-result";
    if (data.kind === "stopped") {
      resultEl.textContent = "Listener not running — save a token to start.";
      return;
    }
    if (data.kind === "starting") {
      resultEl.textContent = "Starting…";
      return;
    }
    if (data.kind === "listening") {
      resultEl.classList.add("ok");
      resultEl.textContent = `● connected as @${data.botUsername}`;
      return;
    }
    if (data.kind === "auth_failed") {
      resultEl.classList.add("err");
      resultEl.textContent = `Auth failed: ${data.error}`;
      return;
    }
    if (data.kind === "conflict") {
      resultEl.classList.add("err");
      resultEl.textContent = `Conflict: ${data.error} (another instance is polling this token)`;
      return;
    }
    resultEl.classList.add("err");
    resultEl.textContent = `Error: ${data.error ?? "unknown"}`;
  } catch {
    /* leave blank — status is best-effort */
  }
}

async function testWhisprDesk(secEl) {
  const result = secEl.querySelector("[data-role='test-result']");
  result.className = "settings-test-result";
  result.textContent = "Saving…";
  const saved = await ensureSectionSavedBeforeTest(secEl);
  if (!saved) {
    result.classList.add("err");
    result.textContent = "Could not save before testing — fix the error above and retry.";
    return;
  }
  result.textContent = "Testing…";
  try {
    const res = await fetch("/api/whisprdesk/status");
    const data = await res.json();
    if (!data.configured) {
      result.classList.add("err");
      result.textContent = "Not configured — save a token first.";
      return;
    }
    if (data.reachable) {
      result.classList.add("ok");
      result.textContent = "✓ Reachable. " + JSON.stringify(data.upstream ?? {});
    } else {
      result.classList.add("err");
      result.textContent = "Configured but unreachable: " + (data.error ?? "unknown");
    }
  } catch (err) {
    result.classList.add("err");
    result.textContent = "Test failed: " + err.message;
  }
}

// ----- WhisprDesk voice integration -----

const micBtn = document.getElementById("mic-btn");
const whisprdeskLabel = document.getElementById("whisprdesk-label");
const whisprdeskDot = document.getElementById("whisprdesk-dot");

let mediaRecorder = null;
let recordedChunks = [];
let whisprdeskConfigured = false;
let recordingTimerInterval = null;

const micIcon = document.getElementById("mic-icon");
const recordingIndicator = document.getElementById("recording-indicator");
const recordingTimer = recordingIndicator?.querySelector(".rec-timer");

function showRecordingUI(show) {
  if (!recordingIndicator) return;
  if (show) {
    recordingIndicator.classList.remove("hidden");
    micIcon.textContent = "⏹";
    const startedAt = Date.now();
    recordingTimer.textContent = "0:00";
    recordingTimerInterval = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      recordingTimer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 500);
  } else {
    recordingIndicator.classList.add("hidden");
    micIcon.textContent = "🎤";
    if (recordingTimerInterval) {
      clearInterval(recordingTimerInterval);
      recordingTimerInterval = null;
    }
  }
}

async function refreshWhisprDeskStatus() {
  try {
    const res = await fetch("/api/whisprdesk/status");
    const data = await res.json();
    if (!data.configured) {
      whisprdeskDot.className = "status-dot status-dot-off";
      whisprdeskLabel.textContent = "WhisprDesk · off";
      micBtn.disabled = true;
      micBtn.title = "WhisprDesk not configured. Set WHISPRDESK_TOKEN in .env and restart.";
      return;
    }
    whisprdeskConfigured = true;
    if (data.reachable) {
      whisprdeskDot.className = "status-dot";
      whisprdeskLabel.textContent = "WhisprDesk · ready";
      micBtn.disabled = false;
      micBtn.title = "Click (or ⌥V) to record — click again to stop, then Enter to send";
      subscribeToWhisprDeskEvents();
    } else {
      whisprdeskDot.className = "status-dot status-dot-warn";
      whisprdeskLabel.textContent = "WhisprDesk · unreachable";
      micBtn.disabled = true;
      micBtn.title = "WhisprDesk configured but not reachable. Is the app running?";
    }
  } catch {
    whisprdeskDot.className = "status-dot status-dot-off";
    whisprdeskLabel.textContent = "WhisprDesk · error";
    micBtn.disabled = true;
  }
}

// Global keyboard shortcut: Option+V (macOS) or Alt+V (other) toggles recording.
// Avoids ⌘⇧M which collides with Chrome's user-switcher menu on macOS; avoids
// ⌘M entirely (system-level "minimize window"). Option+V is unclaimed on all
// major browsers + both desktop OSes.
document.addEventListener("keydown", (e) => {
  const isOptionV = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyV";
  if (!isOptionV) return;
  if (micBtn.disabled) return;
  // Don't trigger if a modal is open — user is probably configuring
  const anyModalOpen = document.querySelector(".modal-overlay:not(.hidden)");
  if (anyModalOpen) return;
  // Don't trigger inside unrelated text inputs (settings fields, agent editor,
  // memory panel, etc.) so users can still type the letter V. The chat
  // composer textarea is explicitly OK because that's where the transcript
  // lands anyway.
  const ae = document.activeElement;
  if (
    ae &&
    ae !== input &&
    (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA") &&
    !ae.readOnly
  ) {
    return;
  }
  e.preventDefault();
  micBtn.click();
});

micBtn.addEventListener("click", async () => {
  if (micBtn.disabled) return;
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType =
      MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
    recordedChunks = [];
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    mediaRecorder.addEventListener("dataavailable", (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    });
    mediaRecorder.addEventListener("stop", async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recordedChunks, { type: mimeType || "audio/webm" });
      micBtn.classList.remove("recording");
      showRecordingUI(false);
      await transcribeBlob(blob);
    });
    mediaRecorder.start();
    micBtn.classList.add("recording");
    micBtn.title = "Click to stop and transcribe";
    showRecordingUI(true);
  } catch (err) {
    alert("Microphone access denied or unavailable: " + err.message);
  }
});

async function transcribeBlob(blob) {
  if (!blob.size) return;
  micBtn.classList.add("processing");
  console.log(`[mic] captured: ${blob.size} bytes, type=${blob.type || "audio/webm"}`);

  // Convert MediaRecorder output (WebM/Opus on Chrome) to mono 16-bit PCM WAV
  // in the browser before sending. Browsers reliably decode their own
  // MediaRecorder output; server-side ffmpeg sometimes chokes on the streaming
  // EBML header Chrome emits. WAV is trivial to decode anywhere.
  let wavBlob;
  try {
    wavBlob = await webmBlobToWav(blob);
  } catch (err) {
    console.error("[mic] WAV conversion failed:", err);
    alert(
      `Couldn't prepare the audio:\n\n${err.message}\n\n` +
        "Try recording again. If this keeps happening, check the browser console.",
    );
    micBtn.classList.remove("processing");
    return;
  }
  console.log(`[mic] converted to WAV: ${wavBlob.size} bytes`);

  try {
    const res = await fetch("/api/whisprdesk/transcribe", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wavBlob,
    });
    const data = await res.json();
    if (!res.ok) {
      console.error("[mic] transcribe failed:", data);
      const detail =
        data.upstream?.error ??
        data.upstream?.message ??
        (data.upstream?.raw ? data.upstream.raw : JSON.stringify(data.upstream ?? {}));
      throw new Error(`${data.error || "failed"}\n\n${detail}`);
    }
    if (data.text) insertTextIntoComposer(data.text);
    else console.warn("[mic] empty transcript:", data);
  } catch (err) {
    alert(
      `Transcription failed:\n\n${err.message}\n\nCheck the browser console + server log for details.`,
    );
  } finally {
    micBtn.classList.remove("processing");
  }
}

// Browser-side WAV encoder. Decodes the MediaRecorder output with the same
// codec the browser used to record it, then writes a PCM RIFF/WAVE file.
// Mono, 16-bit, source sample rate (usually 48 kHz on Chrome).
async function webmBlobToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error("Web Audio API not available in this browser");
  const audioCtx = new AudioCtx();
  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    // Free resources even on error
    if (typeof audioCtx.close === "function") audioCtx.close();
  }
  return audioBufferToWavBlob(audioBuffer);
}

function audioBufferToWavBlob(audioBuffer) {
  const numChannels = 1; // mix to mono — Whisper doesn't need stereo and it halves the size
  const sampleRate = audioBuffer.sampleRate;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  // Mix all channels to mono by averaging
  const sourceLength = audioBuffer.length;
  const monoSamples = new Float32Array(sourceLength);
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < sourceLength; i++) monoSamples[i] += data[i];
  }
  if (audioBuffer.numberOfChannels > 1) {
    for (let i = 0; i < sourceLength; i++) monoSamples[i] /= audioBuffer.numberOfChannels;
  }

  const dataSize = sourceLength * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  // RIFF header
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  // fmt chunk
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  // data chunk
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  // PCM samples: float32 [-1, 1] → int16 LE
  let offset = 44;
  for (let i = 0; i < sourceLength; i++) {
    const clamped = Math.max(-1, Math.min(1, monoSamples[i]));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function insertTextIntoComposer(text) {
  if (!text) return;
  const existing = input.value.trim();
  input.value = existing ? `${existing} ${text}` : text;
  input.dispatchEvent(new Event("input"));
  input.focus();
}

// Passive SSE listener: if the user dictates anywhere in WhisprDesk while
// the Command Center tab is focused, append the text to the composer.
let whisprdeskEvents = null;
function subscribeToWhisprDeskEvents() {
  if (whisprdeskEvents) return;
  try {
    whisprdeskEvents = new EventSource("/api/whisprdesk/events");
    const handler = (e) => {
      if (!document.hasFocus()) return; // only when user is on this tab
      if (!state.activeAgentId) return;
      try {
        const data = JSON.parse(e.data);
        const text = data.text ?? data.transcript ?? data.transcription;
        if (text && typeof text === "string") insertTextIntoComposer(text);
      } catch {
        /* not JSON; ignore */
      }
    };
    whisprdeskEvents.addEventListener("transcription", handler);
    whisprdeskEvents.addEventListener("message", handler);
    whisprdeskEvents.addEventListener("error", () => {
      whisprdeskEvents?.close();
      whisprdeskEvents = null;
      // Quietly retry after a few seconds
      setTimeout(refreshWhisprDeskStatus, 5000);
    });
  } catch {
    whisprdeskEvents = null;
  }
}

// ----- TTS (browser-native) speak button on agent messages -----

let activeUtterance = null;

function attachSpeakButton(footerEl, text) {
  if (typeof speechSynthesis === "undefined") return;
  const btn = document.createElement("button");
  btn.className = "msg-speak-btn";
  btn.type = "button";
  btn.title = "Read aloud";
  btn.textContent = "🔊";
  btn.addEventListener("click", () => {
    if (activeUtterance && speechSynthesis.speaking) {
      speechSynthesis.cancel();
      document
        .querySelectorAll(".msg-speak-btn.speaking")
        .forEach((el) => el.classList.remove("speaking"));
      activeUtterance = null;
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.pitch = 1.0;
    u.onend = () => btn.classList.remove("speaking");
    u.onerror = () => btn.classList.remove("speaking");
    btn.classList.add("speaking");
    activeUtterance = u;
    speechSynthesis.speak(u);
  });
  footerEl.appendChild(btn);
}

// ----- Schedules (C16a) -----

const schedulesBtn = document.getElementById("schedules-btn");
const schedulesCount = document.getElementById("schedules-count");
const schedulesModal = document.getElementById("schedules-modal");
const schedulesCloseBtn = document.getElementById("schedules-close");
const scheduleAgentSelect = document.getElementById("schedule-agent");
const schedulePromptInput = document.getElementById("schedule-prompt");
const scheduleCronInput = document.getElementById("schedule-cron");
const scheduleCreateBtn = document.getElementById("schedule-create-btn");
const schedulePreview = document.getElementById("schedule-preview");
const schedulesList = document.getElementById("schedules-list");

state.schedules = [];

schedulesBtn.addEventListener("click", openSchedulesModal);
schedulesCloseBtn.addEventListener("click", () =>
  schedulesModal.classList.add("hidden"),
);
schedulesModal.addEventListener("click", (e) => {
  if (e.target === schedulesModal) schedulesModal.classList.add("hidden");
});

document.querySelectorAll(".schedule-presets button").forEach((btn) => {
  btn.addEventListener("click", () => {
    scheduleCronInput.value = btn.dataset.cron;
    refreshCronPreview();
  });
});

scheduleCronInput.addEventListener("input", debounce(refreshCronPreview, 200));
scheduleCreateBtn.addEventListener("click", createSchedule);

async function openSchedulesModal() {
  populateScheduleAgentSelect();
  await refreshSchedules();
  refreshCronPreview();
  schedulesModal.classList.remove("hidden");
  schedulePromptInput.focus();
}

function populateScheduleAgentSelect() {
  if (scheduleAgentSelect.options.length > 0) return;
  for (const a of state.agents) {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = `${a.emoji} ${a.name}`;
    scheduleAgentSelect.appendChild(opt);
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function refreshCronPreview() {
  const cron = scheduleCronInput.value.trim();
  schedulePreview.innerHTML = "";
  if (!cron) return;
  try {
    const res = await fetch("/api/cron/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cron }),
    });
    const data = await res.json();
    if (!data.valid) {
      const err = document.createElement("div");
      err.className = "schedule-preview-error";
      err.textContent = `⚠️ ${data.error}`;
      schedulePreview.appendChild(err);
      return;
    }
    const heading = document.createElement("div");
    heading.className = "schedule-preview-heading";
    heading.textContent = "Next 3 fires:";
    schedulePreview.appendChild(heading);
    for (const ms of data.next) {
      const row = document.createElement("div");
      row.className = "schedule-preview-row";
      row.textContent = formatFireTime(ms);
      schedulePreview.appendChild(row);
    }
  } catch {
    /* network glitch — silent */
  }
}

function formatFireTime(ms) {
  const d = new Date(ms);
  const local = d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${local}  ·  in ${formatRelative(ms - Date.now())}`;
}

function formatRelative(ms) {
  const sign = ms < 0 ? "-" : "";
  const a = Math.abs(ms);
  const sec = Math.floor(a / 1000);
  if (sec < 60) return `${sign}${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${sign}${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${sign}${hr}h ${min % 60}m`;
  const day = Math.floor(hr / 24);
  return `${sign}${day}d ${hr % 24}h`;
}

async function createSchedule() {
  const agentId = scheduleAgentSelect.value;
  const prompt = schedulePromptInput.value.trim();
  const cron = scheduleCronInput.value.trim();
  if (!agentId || !prompt || !cron) {
    alert("Pick an agent, write a prompt, and enter a cron expression.");
    return;
  }
  scheduleCreateBtn.disabled = true;
  scheduleCreateBtn.textContent = "Saving…";
  try {
    const res = await fetch("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, prompt, cron }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    schedulePromptInput.value = "";
    scheduleCronInput.value = "";
    schedulePreview.innerHTML = "";
    await refreshSchedules();
  } catch (err) {
    alert("Could not create schedule: " + err.message);
  } finally {
    scheduleCreateBtn.disabled = false;
    scheduleCreateBtn.textContent = "Add schedule";
  }
}

async function refreshSchedules() {
  try {
    const res = await fetch("/api/schedules");
    state.schedules = await res.json();
    renderSchedules();
  } catch {
    /* no-op */
  }
}

function renderSchedules() {
  schedulesList.innerHTML = "";
  schedulesCount.textContent = state.schedules.length;
  schedulesCount.classList.toggle(
    "has-active",
    state.schedules.some((s) => s.enabled),
  );

  if (state.schedules.length === 0) {
    const empty = document.createElement("div");
    empty.className = "col-empty";
    empty.textContent = "No schedules yet. Add one above.";
    schedulesList.appendChild(empty);
    return;
  }

  for (const s of state.schedules) {
    schedulesList.appendChild(renderScheduleCard(s));
  }
}

function renderScheduleCard(sched) {
  const agent = state.agents.find((a) => a.id === sched.agentId);
  const card = document.createElement("div");
  card.className = `schedule-card ${sched.enabled ? "enabled" : "paused"}`;

  const head = document.createElement("div");
  head.className = "schedule-card-head";
  const agentInfo = document.createElement("span");
  agentInfo.className = "schedule-card-agent";
  agentInfo.textContent = agent ? `${agent.emoji} ${agent.name}` : sched.agentId;
  head.appendChild(agentInfo);

  const status = document.createElement("span");
  status.className = `schedule-card-status ${sched.enabled ? "enabled" : "paused"}`;
  status.textContent = sched.enabled
    ? "● enabled"
    : `⏸ paused: ${sched.pausedReason ?? "unknown"}`;
  head.appendChild(status);
  card.appendChild(head);

  const prompt = document.createElement("div");
  prompt.className = "schedule-card-prompt";
  prompt.textContent = sched.prompt;
  card.appendChild(prompt);

  const meta = document.createElement("div");
  meta.className = "schedule-card-meta";
  const cronEl = document.createElement("span");
  cronEl.className = "schedule-card-cron";
  cronEl.textContent = sched.cron;
  meta.appendChild(cronEl);

  const nextEl = document.createElement("span");
  nextEl.className = "schedule-card-next";
  if (sched.enabled) {
    nextEl.textContent = `next in ${formatRelative(sched.nextFireAt - Date.now())}`;
  } else {
    nextEl.textContent = "—";
  }
  meta.appendChild(nextEl);

  if (sched.lastFiredAt) {
    const lastEl = document.createElement("span");
    lastEl.className = `schedule-card-last status-${sched.lastStatus ?? "unknown"}`;
    const ago = formatRelative(Date.now() - sched.lastFiredAt);
    const statusLabel = sched.lastStatus
      ? sched.lastStatus.replace("_", " ")
      : "fired";
    lastEl.textContent = `last: ${statusLabel} ${ago} ago`;
    meta.appendChild(lastEl);
  }

  if (sched.consecutiveFailures > 0 && sched.enabled) {
    const failEl = document.createElement("span");
    failEl.className = "schedule-card-failures";
    failEl.textContent = `⚠️ ${sched.consecutiveFailures} consecutive failure${sched.consecutiveFailures > 1 ? "s" : ""}`;
    meta.appendChild(failEl);
  }

  card.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "schedule-card-actions";

  const runNowBtn = document.createElement("button");
  runNowBtn.className = "run-btn";
  runNowBtn.textContent = "Run now";
  runNowBtn.title = "Fire this schedule once, ignoring cron";
  runNowBtn.addEventListener("click", () => runScheduleNow(sched.id));
  actions.appendChild(runNowBtn);

  const toggleBtn = document.createElement("button");
  toggleBtn.textContent = sched.enabled ? "Pause" : "Resume";
  toggleBtn.addEventListener("click", () => toggleSchedule(sched.id, sched.enabled));
  actions.appendChild(toggleBtn);

  const delBtn = document.createElement("button");
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", () => deleteSchedule(sched.id));
  actions.appendChild(delBtn);

  card.appendChild(actions);
  return card;
}

async function runScheduleNow(id) {
  try {
    const res = await fetch(`/api/schedules/${id}/run-now`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    await refreshSchedules();
    if (typeof refreshTasks === "function") await refreshTasks();
  } catch (err) {
    alert("Run-now failed: " + err.message);
  }
}

async function toggleSchedule(id, currentlyEnabled) {
  try {
    const path = currentlyEnabled
      ? `/api/schedules/${id}/pause`
      : `/api/schedules/${id}/resume`;
    const res = await fetch(path, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    await refreshSchedules();
  } catch (err) {
    alert("Toggle failed: " + err.message);
  }
}

async function deleteSchedule(id) {
  if (!confirm("Delete this schedule?")) return;
  try {
    await fetch(`/api/schedules/${id}`, { method: "DELETE" });
    await refreshSchedules();
  } catch {
    /* no-op */
  }
}

// ----- Keyboard shortcuts + ⌘K command palette -----
//
// One global keydown handler covers two surfaces:
//   1. Direct shortcuts (⌘; ⌘⇧T ⌘⇧H ⌘⇧M ⌘⇧S) — mapped to the existing
//      header buttons. Cmd+T / Cmd+S / Cmd+H are reserved by the browser
//      or macOS, so we use ⌘⇧ for those. ⌘; is unclaimed everywhere.
//   2. ⌘K command palette — opens a fuzzy-filter list of every modal,
//      every action, and every agent. Type to narrow, ↑↓ to navigate,
//      Enter to fire, Esc to close.
//
// Esc also closes whichever modal is on top — palette wins because its
// listener runs first via capture phase. Plain Esc when nothing's open
// blurs the active input as a no-op.

const paletteModal = document.getElementById("palette-modal");
const paletteInput = document.getElementById("palette-input");
const paletteList = document.getElementById("palette-list");
const paletteCloseBtn = document.getElementById("palette-close");

let _paletteSelected = 0;
let _paletteVisibleEntries = [];

function buildPaletteEntries() {
  // Static actions: every header button + sidebar's "+ New agent" + "New chat".
  const actions = [
    { label: "Open Tasks", hint: "⌘⇧T", icon: "📋", run: () => document.getElementById("tasks-btn").click() },
    { label: "Open Schedules", hint: "⌘⇧S", icon: "🕒", run: () => document.getElementById("schedules-btn").click() },
    { label: "Open Memory", hint: "⌘⇧M", icon: "🧠", run: () => document.getElementById("memory-btn").click() },
    { label: "Open History", hint: "⌘⇧H", icon: "📜", run: () => document.getElementById("history-btn").click() },
    { label: "Open Settings", hint: "⌘;",  icon: "⚙️", run: () => document.getElementById("settings-btn").click() },
    { label: "New chat with current agent", hint: "", icon: "🆕", run: () => document.getElementById("reset-btn").click() },
    { label: "New custom agent", hint: "", icon: "✨", run: () => document.getElementById("new-agent-btn")?.click() },
  ];
  // Dynamic: switch to any agent.
  const agentEntries = (state.agents || []).map((a) => ({
    label: `Switch to ${a.name}`,
    hint: "",
    icon: a.emoji,
    run: () => {
      const el = document.querySelector(`.agent-item[data-id="${a.id}"]`);
      if (el) el.click();
    },
  }));
  return [...actions, ...agentEntries];
}

function fuzzyMatch(needle, hay) {
  if (!needle) return true;
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  // Substring check first (cheap), then a per-char threaded match for typos.
  if (h.includes(n)) return true;
  let i = 0;
  for (const c of h) {
    if (c === n[i]) i++;
    if (i === n.length) return true;
  }
  return false;
}

function renderPalette() {
  const filter = paletteInput.value.trim();
  const entries = buildPaletteEntries().filter((e) => fuzzyMatch(filter, e.label));
  _paletteVisibleEntries = entries;
  if (_paletteSelected >= entries.length) _paletteSelected = Math.max(0, entries.length - 1);
  paletteList.innerHTML = "";
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "palette-empty";
    empty.textContent = "No matches";
    paletteList.appendChild(empty);
    return;
  }
  entries.forEach((entry, idx) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "palette-row" + (idx === _paletteSelected ? " selected" : "");
    row.setAttribute("aria-label", entry.label);
    const icon = document.createElement("span");
    icon.className = "palette-row-icon";
    icon.textContent = entry.icon;
    const label = document.createElement("span");
    label.className = "palette-row-label";
    label.textContent = entry.label;
    row.appendChild(icon);
    row.appendChild(label);
    if (entry.hint) {
      const hint = document.createElement("span");
      hint.className = "palette-row-hint";
      hint.textContent = entry.hint;
      row.appendChild(hint);
    }
    row.addEventListener("click", () => firePaletteEntry(entry));
    row.addEventListener("mouseenter", () => {
      _paletteSelected = idx;
      // Re-style without re-rendering — cheaper than rebuilding the list.
      paletteList.querySelectorAll(".palette-row").forEach((el, i) => {
        el.classList.toggle("selected", i === idx);
      });
    });
    paletteList.appendChild(row);
  });
}

function openPalette() {
  paletteModal.classList.remove("hidden");
  paletteInput.value = "";
  _paletteSelected = 0;
  renderPalette();
  // Focus on next tick so the keydown that opened the palette doesn't race
  // the input's own keydown handler.
  setTimeout(() => paletteInput.focus(), 0);
}

function closePalette() {
  paletteModal.classList.add("hidden");
  paletteInput.value = "";
}

function firePaletteEntry(entry) {
  closePalette();
  // Defer the action one tick so the palette closes BEFORE the action fires.
  // Otherwise the new modal's open-modal listener can race the palette's
  // close transition.
  setTimeout(() => {
    try {
      entry.run();
    } catch (err) {
      console.warn("[palette] action threw:", err);
    }
  }, 0);
}

paletteInput.addEventListener("input", renderPalette);
paletteCloseBtn.addEventListener("click", closePalette);
paletteModal.addEventListener("click", (e) => {
  if (e.target === paletteModal) closePalette();
});
paletteInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (_paletteVisibleEntries.length > 0) {
      _paletteSelected = (_paletteSelected + 1) % _paletteVisibleEntries.length;
      renderPalette();
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (_paletteVisibleEntries.length > 0) {
      _paletteSelected =
        (_paletteSelected - 1 + _paletteVisibleEntries.length) % _paletteVisibleEntries.length;
      renderPalette();
    }
  } else if (e.key === "Enter") {
    e.preventDefault();
    const chosen = _paletteVisibleEntries[_paletteSelected];
    if (chosen) firePaletteEntry(chosen);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closePalette();
  }
});

// Global capture-phase keydown for ⌘K + secondary shortcuts. Capture phase
// so ⌘K still opens the palette even if focus is in a textarea (otherwise
// the input swallows it). Esc to close any open modal — palette first since
// it's the most ephemeral surface.
document.addEventListener(
  "keydown",
  (e) => {
    const meta = e.metaKey || e.ctrlKey;

    // ⌘K — toggle palette regardless of focus
    if (meta && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      if (paletteModal.classList.contains("hidden")) {
        openPalette();
      } else {
        closePalette();
      }
      return;
    }

    // Direct shortcuts only fire when no input/textarea is focused — we
    // don't want ⌘⇧M to grab focus while the user is typing a memory.
    const t = e.target;
    const inEditable =
      t instanceof HTMLElement &&
      (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

    if (meta && !e.shiftKey && e.key === ";") {
      e.preventDefault();
      document.getElementById("settings-btn").click();
      return;
    }
    if (meta && e.shiftKey && (e.key === "T" || e.key === "t")) {
      e.preventDefault();
      document.getElementById("tasks-btn").click();
      return;
    }
    if (meta && e.shiftKey && (e.key === "S" || e.key === "s")) {
      e.preventDefault();
      document.getElementById("schedules-btn").click();
      return;
    }
    if (meta && e.shiftKey && (e.key === "H" || e.key === "h")) {
      e.preventDefault();
      document.getElementById("history-btn").click();
      return;
    }
    if (meta && e.shiftKey && (e.key === "M" || e.key === "m")) {
      e.preventDefault();
      document.getElementById("memory-btn").click();
      return;
    }

    // Esc — close the topmost open modal. Palette is handled by its own
    // listener above; this catches the rest. We close one at a time so
    // chained Esc presses peel back layered modals.
    if (e.key === "Escape" && !inEditable) {
      const stackOrder = [
        "tasks-modal",
        "schedules-modal",
        "history-modal",
        "memory-modal",
        "settings-modal",
        "agent-modal",
      ];
      for (const id of stackOrder) {
        const el = document.getElementById(id);
        if (el && !el.classList.contains("hidden")) {
          el.classList.add("hidden");
          // Stop polls if applicable (tasks modal owns the approval poll)
          if (id === "tasks-modal" && typeof stopApprovalPoll === "function") {
            stopApprovalPoll();
          }
          e.preventDefault();
          return;
        }
      }
    }
  },
  true,
);

(async () => {
  await loadModels();
  await loadCwd();
  await loadAgents();
  await refreshTasks();
  await refreshMemories();
  await refreshWhisprDeskStatus();
  await refreshHistoryCount();
  await refreshSchedules();
})();
