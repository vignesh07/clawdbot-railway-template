import crypto from "node:crypto";

const GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const GATEWAY_URL = `ws://${GATEWAY_HOST}:${GATEWAY_PORT}`;
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || "";

let socket = null;
let connecting = null;
let connected = false;
let hello = null;
let subscribed = false;
let sessions = [];
let lastEventAt = null;
let lastError = null;
let lastFrame = null;
let requestSeq = 0;
let shouldStayConnected = false;
const pending = new Map();
const stateListeners = new Set();

function nextId(prefix = "workstudio") {
  requestSeq += 1;
  return `${prefix}-${Date.now()}-${requestSeq}-${crypto.randomBytes(3).toString("hex")}`;
}

function parseFrame(data) {
  if (typeof data === "string") return JSON.parse(data);
  if (data instanceof ArrayBuffer) return JSON.parse(Buffer.from(data).toString("utf8"));
  if (ArrayBuffer.isView(data)) return JSON.parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8"));
  if (data && typeof data.text === "function") return data.text().then((text) => JSON.parse(text));
  return JSON.parse(String(data));
}

function notifyStateListeners() {
  const state = getGatewayClientState();
  for (const listener of stateListeners) {
    try { listener(state); } catch {}
  }
}

function sendRequest(method, params = {}, timeoutMs = 10_000) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Gateway socket is not open"));
  }

  const id = nextId(method.replace(/[^A-Za-z0-9_-]/g, "-"));
  const frame = { type: "req", id, method, params };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);

    pending.set(id, {
      method,
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });

    socket.send(JSON.stringify(frame));
  });
}

function mergeSessionChanged(payload) {
  const row = payload?.session;
  if (!row?.key) return;

  const index = sessions.findIndex((item) => item.key === row.key);
  if (payload?.reason === "delete" || payload?.deleted === true) {
    if (index >= 0) sessions.splice(index, 1);
    return;
  }

  if (index >= 0) sessions[index] = { ...sessions[index], ...row };
  else sessions.unshift(row);
}

async function handleFrame(frame) {
  lastFrame = frame;

  if (frame?.type === "event") {
    lastEventAt = new Date().toISOString();

    if (frame.event === "connect.challenge") {
      const params = {
        minProtocol: 4,
        maxProtocol: 4,
        client: {
          id: "gateway-client",
          version: "workstudio-v1",
          platform: "linux",
          mode: "backend",
        },
        role: "operator",
        scopes: ["operator.read"],
        caps: [],
        commands: [],
        permissions: {},
        auth: { token: GATEWAY_TOKEN },
        locale: "zh-TW",
        userAgent: "ai-workstudio/v1",
      };

      const response = await sendRequest("connect", params);
      hello = response?.payload || response || null;
      connected = Boolean(hello?.type === "hello-ok" || response?.ok === true);

      const subscription = await sendRequest("sessions.subscribe", {
        limit: 60,
        ownerFirst: true,
      });

      const payload = subscription?.payload || subscription || {};
      const list = payload?.list || {};
      sessions = Array.isArray(list.sessions) ? list.sessions : Array.isArray(list.items) ? list.items : [];
      subscribed = payload?.subscribed === true;

      if (!subscribed) {
        throw new Error(`sessions.subscribe returned without subscribed=true: ${JSON.stringify(payload).slice(0, 800)}`);
      }

      notifyStateListeners();
      return;
    }

    if (frame.event === "sessions.changed") {
      mergeSessionChanged(frame.payload || {});
      notifyStateListeners();
      return;
    }

    if (frame.event === "shutdown") {
      connected = false;
      subscribed = false;
      notifyStateListeners();
    }
    return;
  }

  if (frame?.type === "res" && frame.id) {
    const waiter = pending.get(frame.id);
    if (!waiter) return;
    pending.delete(frame.id);

    if (frame.ok === false) {
      const message = frame.error?.message || frame.error?.code || "Gateway request failed";
      waiter.reject(new Error(`${waiter.method}: ${message}`));
    } else {
      waiter.resolve(frame);
    }
  }
}

function resetSocketState() {
  connected = false;
  subscribed = false;
  hello = null;
  for (const [, waiter] of pending) waiter.reject(new Error("Gateway socket closed"));
  pending.clear();
  socket = null;
  notifyStateListeners();
}

export async function ensureGatewayClient() {
  shouldStayConnected = true;

  if (connected && subscribed && socket?.readyState === WebSocket.OPEN) return getGatewayClientState();
  if (connecting) return connecting;

  if (!GATEWAY_TOKEN) {
    lastError = "OPENCLAW_GATEWAY_TOKEN is missing";
    throw new Error(lastError);
  }

  connecting = new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY_URL);
    socket = ws;

    const fail = (error) => {
      const message = String(error?.message || error || "Gateway connection failed");
      lastError = message;
      try { ws.close(); } catch {}
      reject(new Error(message));
    };

    const connectTimer = setTimeout(() => {
      fail(lastError || "Gateway handshake timed out");
    }, 15_000);

    ws.addEventListener("message", async (event) => {
      try {
        const frame = await parseFrame(event.data);
        await handleFrame(frame);
        if (connected && subscribed) {
          clearTimeout(connectTimer);
          lastError = null;

          if (!shouldStayConnected) {
            try { ws.close(1000, "No Workstudio viewers"); } catch {}
            reject(new Error("Gateway client no longer needed"));
            return;
          }

          resolve(getGatewayClientState());
        }
      } catch (error) {
        clearTimeout(connectTimer);
        fail(error);
      }
    });

    ws.addEventListener("error", () => {
      if (!lastError) lastError = "Gateway WebSocket error";
    });

    ws.addEventListener("close", () => {
      clearTimeout(connectTimer);
      const wasReady = connected && subscribed;
      const errorBeforeClose = lastError;
      resetSocketState();
      if (!wasReady && errorBeforeClose) reject(new Error(errorBeforeClose));
    });
  }).finally(() => {
    connecting = null;
  });

  return connecting;
}

export function disconnectGatewayClient() {
  shouldStayConnected = false;
  const ws = socket;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    try { ws.close(1000, "No Workstudio viewers"); } catch {}
  }
}

export function subscribeGatewayClientState(listener) {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

export function getGatewayClientState() {
  return {
    url: GATEWAY_URL,
    connected,
    subscribed,
    protocol: hello?.protocol ?? null,
    serverVersion: hello?.server?.version ?? null,
    sessionCount: sessions.length,
    sessions,
    lastEventAt,
    lastError,
    lastFrame,
  };
}
