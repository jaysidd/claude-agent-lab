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

async function loadModels() {
  const res = await fetch("/api/models");
  state.models = await res.json();
}

async function loadAgents() {
  const res = await fetch("/api/agents");
  state.agents = await res.json();
  renderAgents();
  if (state.agents[0]) selectAgent(state.agents[0].id);
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
  for (const agent of state.agents) {
    const el = document.createElement("div");
    el.className = "agent-item" + (agent.id === state.activeAgentId ? " active" : "");
    el.dataset.id = agent.id;
    el.innerHTML = `
      <div class="agent-avatar" style="color:${agent.accent}">${agent.emoji}</div>
      <div class="agent-meta">
        <div class="agent-name">${agent.name}</div>
        <div class="agent-desc">${agent.description}</div>
        <div class="agent-model-chip">${prettyModel(agent.model)}</div>
      </div>
    `;
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
  renderMessages();
  input.focus();
}

function renderMessages() {
  const history = state.conversations[state.activeAgentId] ?? [];
  messagesEl.innerHTML = "";

  if (history.length === 0) {
    const agent = state.agents.find((a) => a.id === state.activeAgentId);
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML =
      "Say hi to kick off a conversation.<br>Each agent has its own memory of this session.<br><br>" +
      `Folder: <code>${shortenPath(state.cwd)}</code><br>` +
      `Model: <code>${prettyModel(agent?.model)}</code>`;
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
    } else {
      body.textContent = m.text;
      if (m.streaming) body.classList.add("streaming");
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
      const authLabel =
        m.apiKeySource === "none" || m.apiKeySource === "oauth"
          ? `<span class="auth-oauth">🔐 Max plan · subscription</span>`
          : m.apiKeySource
            ? `<span class="auth-key">🔑 API key (${m.apiKeySource})</span>`
            : "";
      footer.innerHTML = `<span>🧠 ${prettyModel(m.model)}</span> ${authLabel}`;
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
  renderMessages();

  // Insert an empty agent bubble we'll fill incrementally
  const agentMsg = { role: "agent", text: "", toolUses: [], streaming: true };
  history.push(agentMsg);
  renderMessages();

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
        } else if (ev.kind === "text_delta") {
          agentMsg.text += ev.text;
        } else if (ev.kind === "tool_use") {
          agentMsg.toolUses.push({ name: ev.name, input: ev.input });
        } else if (ev.kind === "result") {
          if (!agentMsg.text) agentMsg.text = ev.text;
        } else if (ev.kind === "error") {
          agentMsg.text = `⚠️ ${ev.message}`;
        }
        renderMessages();
      }
    }
  } catch (err) {
    agentMsg.text = `⚠️ ${err.message}`;
  } finally {
    agentMsg.streaming = false;
    state.pending = false;
    renderMessages();
  }
}

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !state.activeAgentId || state.pending) return;
  input.value = "";
  input.style.height = "auto";
  hideFilePopover();
  sendMessage(text);
});

input.addEventListener("keydown", (e) => {
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
  maybeShowFilePopover();
});

resetBtn.addEventListener("click", async () => {
  if (!state.activeAgentId) return;
  await fetch(`/api/reset/${state.activeAgentId}`, { method: "POST" });
  state.conversations[state.activeAgentId] = [];
  renderMessages();
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
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
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
    closeCwdModal();
    renderMessages();
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
    const icon = f.isDir ? "📁" : "📄";
    el.innerHTML = `<span class="file-icon ${f.isDir ? "file-dir" : ""}">${icon}</span><span>${f.name}</span>`;
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

(async () => {
  await loadModels();
  await loadCwd();
  await loadAgents();
})();
