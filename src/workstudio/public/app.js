document.documentElement.dataset.workstudio = "v1";

const statusEl = document.getElementById("systemStatus");
const summaryEl = document.getElementById("snapshotSummary");
const agentListEl = document.getElementById("agentList");
const sessionListEl = document.getElementById("sessionList");

function sessionState(session) {
  if (session.hasActiveRun || session.running === true) return "working";
  if (session.queued === true) return "queued";
  return "idle";
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

async function loadSnapshot() {
  try {
    const response = await fetch("/workstudio/api/sessions", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    const data = payload.data || {};
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];

    const byAgent = new Map();
    for (const session of sessions) {
      const agentId = session.agentId || "unknown";
      const existing = byAgent.get(agentId) || { active: 0, total: 0 };
      existing.total += 1;
      if (sessionState(session) === "working") existing.active += 1;
      byAgent.set(agentId, existing);
    }

    const agents = [...byAgent.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([agentId, stats]) => ({
        label: agentId,
        state: stats.active > 0 ? "working" : `idle · ${stats.total} session${stats.total === 1 ? "" : "s"}`,
      }));

    const recentSessions = sessions.slice(0, 12).map((session) => ({
      label: session.key || session.agentId || "session",
      state: sessionState(session),
    }));

    renderRows(agentListEl, agents, "目前 snapshot 沒有 Agent session。 ");
    renderRows(sessionListEl, recentSessions, "目前沒有 session。 ");

    statusEl.textContent = "CONNECTED";
    summaryEl.textContent = `已從 OpenClaw 讀取 ${sessions.length} 筆 session snapshot；資料來源為按需讀取，未啟用 polling。`;
  } catch (error) {
    statusEl.textContent = "ERROR";
    summaryEl.textContent = `無法讀取 OpenClaw snapshot：${error.message}`;
    renderRows(agentListEl, [], "尚未取得 Agent 資料。 ");
    renderRows(sessionListEl, [], "尚未取得 Session 資料。 ");
  }
}

loadSnapshot();
