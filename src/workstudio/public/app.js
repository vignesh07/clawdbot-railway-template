document.documentElement.dataset.workstudio = "v1";

const statusEl = document.getElementById("systemStatus");
const summaryEl = document.getElementById("snapshotSummary");
const agentListEl = document.getElementById("agentList");
const sessionListEl = document.getElementById("sessionList");

let eventSource = null;

function sessionState(session) {
  if (session.hasActiveRun || session.running === true) return "working";
  if (session.queued === true) return "queued";
  const state = String(session.status || session.state || "").toLowerCase();
  if (["error", "failed", "failure"].includes(state)) return "error";
  return "idle";
}

function formatTime(value) {
  if (!value) return "尚無活動";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function renderRows(container, rows, emptyText) {
  container.replaceChildren();

  if (!rows.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = emptyText;
    container.appendChild(p);
    return;
  }

  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "agent-row";

    const label = document.createElement("span");
    label.textContent = row.label;

    const state = document.createElement("strong");
    state.textContent = row.state;

    item.append(label, state);
    container.appendChild(item);
  }
}

function renderAgents(agents) {
  agentListEl.replaceChildren();

  if (!agents.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Gateway 沒有回傳 Agent roster。";
    agentListEl.appendChild(p);
    return;
  }

  for (const agent of agents) {
    const item = document.createElement("div");
    item.className = `agent-overview agent-${agent.status || "idle"}`;

    const main = document.createElement("div");
    main.className = "agent-main";

    const identity = document.createElement("div");
    identity.className = "agent-identity";

    const title = document.createElement("strong");
    title.className = "agent-name";
    title.textContent = agent.name || agent.agentId || "unknown";

    const id = document.createElement("span");
    id.className = "agent-id";
    id.textContent = agent.agentId || "unknown";

    identity.append(title, id);

    const status = document.createElement("span");
    status.className = `agent-status status-${agent.status || "idle"}`;
    status.textContent = String(agent.status || "idle").toUpperCase();

    main.append(identity, status);

    const meta = document.createElement("div");
    meta.className = "agent-meta";

    const metaItems = [
      ["Model", agent.model || "未提供"],
      ["Runtime", agent.runtime || "未提供"],
      ["Team", agent.team || "未設定"],
      ["Last activity", formatTime(agent.lastActivityAt)],
      ["Session", agent.activeSession || (agent.sessionCount ? `${agent.sessionCount} recorded` : "none")],
    ];

    for (const [label, value] of metaItems) {
      const cell = document.createElement("div");
      cell.className = "agent-meta-item";

      const key = document.createElement("span");
      key.className = "agent-meta-label";
      key.textContent = label;

      const text = document.createElement("span");
      text.className = "agent-meta-value";
      text.textContent = String(value);

      cell.append(key, text);
      meta.appendChild(cell);
    }

    item.append(main, meta);
    agentListEl.appendChild(item);
  }
}

function renderGatewayState(data) {
  const agents = Array.isArray(data.agents) ? data.agents : [];
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];

  const recentSessions = sessions.slice(0, 12).map((session) => ({
    label: session.key || session.id || session.agentId || session.owner || "session",
    state: sessionState(session),
  }));

  renderAgents(agents);
  renderRows(sessionListEl, recentSessions, "目前沒有 session。");

  statusEl.textContent = data.connected && data.subscribed ? "CONNECTED" : "CONNECTING";
  summaryEl.textContent = `Gateway ${data.serverVersion || "unknown"} · protocol ${data.protocol ?? "-"} · subscription ${data.subscribed ? "active" : "inactive"} · Agent roster ${agents.length} · sessions ${sessions.length}。資料由 Gateway 即時推送；頁面關閉後 subscription 會跟著釋放。`;
}

function renderError(message) {
  statusEl.textContent = "ERROR";
  summaryEl.textContent = `無法讀取 Gateway subscription：${message || "unknown error"}`;
  renderAgents([]);
  renderRows(sessionListEl, [], "尚未取得 Session 資料。");
}

function connectEventStream() {
  if (eventSource) eventSource.close();

  statusEl.textContent = "CONNECTING";
  summaryEl.textContent = "正在建立 Workstudio 即時連線…";

  const source = new EventSource("/workstudio/api/events");
  eventSource = source;

  source.addEventListener("gateway-state", (event) => {
    try {
      renderGatewayState(JSON.parse(event.data || "{}"));
    } catch (error) {
      renderError(String(error));
    }
  });

  source.addEventListener("gateway-error", (event) => {
    try {
      const payload = JSON.parse(event.data || "{}");
      renderError(payload.message || "Gateway connection failed");
    } catch (error) {
      renderError(String(error));
    }
  });

  source.onerror = () => {
    if (document.visibilityState === "hidden") return;
    statusEl.textContent = "RECONNECTING";
    summaryEl.textContent = "即時連線中斷，瀏覽器正在重新連線…";
  };
}

function disconnectEventStream() {
  if (!eventSource) return;
  eventSource.close();
  eventSource = null;
}

window.addEventListener("pagehide", disconnectEventStream);
window.addEventListener("beforeunload", disconnectEventStream);

connectEventStream();
