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
  if (text.startsWith("/") && handleSlashCommand(text)) return;
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
tasksCloseBtn.addEventListener("click", () => tasksModal.classList.add("hidden"));
tasksModal.addEventListener("click", (e) => {
  if (e.target === tasksModal) tasksModal.classList.add("hidden");
});

async function openTasksModal() {
  populateTaskAgentSelect();
  await refreshTasks();
  tasksModal.classList.remove("hidden");
  taskDescription.focus();
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
    const res = await fetch("/api/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    taskDescription.value = "";
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
    const res = await fetch("/api/tasks");
    state.tasks = await res.json();
    renderTasks();
  } catch {
    /* no-op */
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

function renderTaskCard(task) {
  const agent = state.agents.find((a) => a.id === task.assignedAgent);
  const card = document.createElement("div");
  card.className = `task-card status-${task.status}`;

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
  card.appendChild(head);

  const desc = document.createElement("div");
  desc.className = "task-card-desc";
  desc.textContent = task.description;
  card.appendChild(desc);

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
  const res = await fetch("/api/memories");
  state.memories = await res.json();
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
        "- `/agents` — list all agents and their purpose",
        "- `/plan on|off` — toggle plan mode for this agent",
        "- `/help` — this message",
      ].join("\n"),
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
    .then((r) => r.json())
    .then((full) => {
      agentSystemPromptInput.value = full.systemPrompt || "";
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
    secEl.className = "settings-section";
    const h = document.createElement("h3");
    h.textContent = section.section;
    secEl.appendChild(h);

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
      if (!field.isSecret && current?.hasValue) {
        inp.value = current.preview || "";
      }
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

    // Per-section Test Connection button
    if (section.section.startsWith("WhisprDesk")) {
      const testBtn = document.createElement("button");
      testBtn.className = "btn-test";
      testBtn.type = "button";
      testBtn.textContent = "Test connection";
      testBtn.addEventListener("click", () => testWhisprDesk(secEl));
      secEl.appendChild(testBtn);
      const result = document.createElement("div");
      result.dataset.role = "test-result";
      secEl.appendChild(result);
    }

    settingsSectionsEl.appendChild(secEl);
  }
}

async function saveSettings() {
  const entries = [];
  for (const inp of settingsSectionsEl.querySelectorAll("[data-key]")) {
    const key = inp.dataset.key;
    const isSecret = inp.dataset.secret === "1";
    const value = inp.value;
    if (isSecret) {
      // Only send if user typed something new
      if (value.trim()) entries.push({ key, value: value.trim(), isSecret: true });
    } else {
      // Non-secret fields always sent (even empty = reset to env fallback)
      const prev = settingsState.values.find((v) => v.key === key);
      if (value.trim()) {
        entries.push({ key, value: value.trim(), isSecret: false });
      } else if (prev?.hasValue) {
        entries.push({ key, value: null }); // clear
      }
    }
  }
  settingsSaveBtn.disabled = true;
  settingsSaveBtn.textContent = "Saving…";
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    await loadSettings();
    renderSettings();
    // Re-probe WhisprDesk after save, since token may now be set
    await refreshWhisprDeskStatus();
  } catch (err) {
    alert("Could not save settings: " + err.message);
  } finally {
    settingsSaveBtn.disabled = false;
    settingsSaveBtn.textContent = "Save changes";
  }
}

async function testWhisprDesk(secEl) {
  const result = secEl.querySelector("[data-role='test-result']");
  result.className = "settings-test-result";
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
      micBtn.title = "Click to record — release to transcribe with WhisprDesk";
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
      await transcribeBlob(blob);
    });
    mediaRecorder.start();
    micBtn.classList.add("recording");
    micBtn.title = "Click to stop and transcribe";
  } catch (err) {
    alert("Microphone access denied or unavailable: " + err.message);
  }
});

async function transcribeBlob(blob) {
  if (!blob.size) return;
  micBtn.classList.add("processing");
  try {
    const res = await fetch("/api/whisprdesk/transcribe", {
      method: "POST",
      headers: { "Content-Type": blob.type || "audio/webm" },
      body: blob,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "transcription failed");
    if (data.text) insertTextIntoComposer(data.text);
  } catch (err) {
    alert("Transcription failed: " + err.message);
  } finally {
    micBtn.classList.remove("processing");
  }
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

(async () => {
  await loadModels();
  await loadCwd();
  await loadAgents();
  await refreshTasks();
  await refreshMemories();
  await refreshWhisprDeskStatus();
})();
