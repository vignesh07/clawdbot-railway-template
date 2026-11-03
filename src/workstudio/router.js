import childProcess from "node:child_process";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  disconnectGatewayClient,
  ensureGatewayClient,
  getGatewayClientState,
  subscribeGatewayClientState,
} from "./gateway-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

export const workstudioRouter = express.Router();
const eventClients = new Set();

function runOpenClaw(args, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(OPENCLAW_NODE, [OPENCLAW_ENTRY, ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    proc.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      finish({ code: 124, stdout, stderr: `${stderr}\nTimed out` });
    }, timeoutMs);

    proc.on("error", (error) => {
      clearTimeout(timer);
      finish({ code: 127, stdout, stderr: `${stderr}\n${String(error)}` });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      finish({ code: code ?? 0, stdout, stderr });
    });
  });
}

function writeEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastGatewayState(state) {
  for (const res of eventClients) {
    try {
      writeEvent(res, "gateway-state", state);
    } catch {
      eventClients.delete(res);
    }
  }

  if (eventClients.size === 0) disconnectGatewayClient();
}

subscribeGatewayClientState(broadcastGatewayState);

workstudioRouter.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "ai-workstudio", version: "v1" });
});

// Read-only snapshot. This endpoint deliberately does not create a Gateway connection.
workstudioRouter.get("/api/gateway", (_req, res) => {
  res.json({ ok: true, data: getGatewayClientState(), viewers: eventClients.size });
});

// Demand-driven live stream for Workstudio. The first viewer starts the Gateway
// subscription; when the last viewer disconnects, the Gateway WebSocket is closed.
workstudioRouter.get("/api/events", async (req, res) => {
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  eventClients.add(res);
  writeEvent(res, "viewer", { connected: true, viewers: eventClients.size });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(keepAlive);
    eventClients.delete(res);
    if (eventClients.size === 0) disconnectGatewayClient();
  };

  const keepAlive = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      cleanup();
    }
  }, 20_000);
  keepAlive.unref?.();

  req.on("aborted", cleanup);
  res.on("close", cleanup);

  try {
    const state = await ensureGatewayClient();
    if (!cleanedUp) writeEvent(res, "gateway-state", state);
  } catch (error) {
    if (!cleanedUp) {
      writeEvent(res, "gateway-error", {
        message: String(error?.message || error),
        state: getGatewayClientState(),
      });
      res.end();
    }
  }
});

// Manual diagnostic only. The Workstudio UI does not call this automatically.
workstudioRouter.get("/api/sessions", async (_req, res) => {
  const result = await runOpenClaw(["sessions", "--all-agents", "--json", "--limit", "60"]);

  if (result.code !== 0) {
    return res.status(502).json({
      ok: false,
      error: "Unable to read OpenClaw session snapshot",
      detail: result.stderr.trim().slice(0, 1000),
    });
  }

  try {
    const data = JSON.parse(result.stdout);
    return res.json({
      ok: true,
      source: "openclaw-sessions-on-demand",
      fetchedAt: new Date().toISOString(),
      data,
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: "OpenClaw returned non-JSON session output",
      detail: String(error),
    });
  }
});

workstudioRouter.use(express.static(publicDir, {
  index: "index.html",
  fallthrough: true,
}));

workstudioRouter.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});
