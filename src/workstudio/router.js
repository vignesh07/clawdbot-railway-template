import childProcess from "node:child_process";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

export const workstudioRouter = express.Router();

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

workstudioRouter.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "ai-workstudio", version: "v1" });
});

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
