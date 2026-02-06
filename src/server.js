import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import session from "express-session";
import httpProxy from "http-proxy";
import * as tar from "tar";

// Railway deployments sometimes inject PORT=3000 by default. We want the wrapper to
// reliably listen on 8080 unless explicitly overridden.
//
// Prefer OPENCLAW_PUBLIC_PORT (set in the Dockerfile / template) over PORT.
// Keep CLAWDBOT_PUBLIC_PORT as a backward-compat alias for older templates.
const PORT = Number.parseInt(
  process.env.OPENCLAW_PUBLIC_PORT ?? process.env.CLAWDBOT_PUBLIC_PORT ?? process.env.PORT ?? "8080",
  10,
);

// State/workspace
// OpenClaw defaults to ~/.openclaw. Keep CLAWDBOT_* as backward-compat aliases.
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  process.env.CLAWDBOT_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");

const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  process.env.CLAWDBOT_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

// GitHub OAuth configuration.
// Required env vars: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
// Optional: GITHUB_ALLOWED_USERS (comma-separated list of GitHub usernames)
// If GITHUB_ALLOWED_USERS is not set, any GitHub user can log in.
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID?.trim() || "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET?.trim() || "";
const GITHUB_ALLOWED_USERS = (process.env.GITHUB_ALLOWED_USERS || "")
  .split(",")
  .map((u) => u.trim().toLowerCase())
  .filter(Boolean);

// Session secret: reuse a persisted value for stability across restarts.
function resolveSessionSecret() {
  const envSecret = process.env.SESSION_SECRET?.trim();
  if (envSecret) return envSecret;

  const secretPath = path.join(STATE_DIR, "session.secret");
  try {
    const existing = fs.readFileSync(secretPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // First run
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(secretPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort
  }
  return generated;
}

const SESSION_SECRET = resolveSessionSecret();

// Gateway admin token (protects OpenClaw gateway + Control UI).
// Must be stable across restarts. If not provided via env, persist it in the state dir.
function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || process.env.CLAWDBOT_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // ignore
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;
// Backward-compat: some older flows expect CLAWDBOT_GATEWAY_TOKEN.
process.env.CLAWDBOT_GATEWAY_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN || OPENCLAW_GATEWAY_TOKEN;

// Where the gateway will listen internally (we proxy to it).
const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

// Always run the built-from-source CLI entry directly to avoid PATH/global-install mismatches.
const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    process.env.CLAWDBOT_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

let gatewayProc = null;
let gatewayStarting = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Try the default Control UI base path, then fall back to legacy or root.
      const paths = ["/openclaw", "/clawdbot", "/"]; 
      for (const p of paths) {
        try {
          const res = await fetch(`${GATEWAY_TARGET}${p}`, { method: "GET" });
          // Any HTTP response means the port is open.
          if (res) return true;
        } catch {
          // try next
        }
      }
    } catch {
      // not ready
    }
    await sleep(250);
  }
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  // The internal gateway is bound to loopback and only reachable via the
  // wrapper proxy, so we disable auth on it entirely. The wrapper handles
  // external authentication (Basic auth on /setup). This avoids the "gateway
  // token mismatch" error that occurs because the Control UI SPA authenticates
  // at the WebSocket application-protocol level, which the proxy cannot inject.
  try {
    const cfgFile = configPath();
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    let dirty = false;

    if (!cfg.gateway) cfg.gateway = {};
    if (!cfg.gateway.auth) cfg.gateway.auth = {};

    // Disable gateway auth -- the wrapper proxy is the only client.
    if (cfg.gateway.auth.mode !== "none") {
      cfg.gateway.auth.mode = "none";
      delete cfg.gateway.auth.token;
      dirty = true;
    }

    if (dirty) {
      fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), "utf8");
      console.log("[wrapper] patched gateway config: auth set to none (loopback only)");
    }
  } catch (err) {
    console.warn(`[wrapper] could not patch gateway config: ${err.message}`);
  }

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "none",
  ];

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      // Backward-compat aliases
      CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR || STATE_DIR,
      CLAWDBOT_WORKSPACE_DIR: process.env.CLAWDBOT_WORKSPACE_DIR || WORKSPACE_DIR,
    },
  });

  gatewayProc.on("error", (err) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    console.error(`[gateway] exited code=${code} signal=${signal}`);
    gatewayProc = null;
  });
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      await startGateway();
      const ready = await waitForGatewayReady({ timeoutMs: 20_000 });
      if (!ready) {
        throw new Error("Gateway did not become ready in time");
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

async function restartGateway() {
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Give it a moment to exit and release the port.
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

// ---------- GitHub OAuth helpers ----------

async function githubFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      accept: "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text}`);
  }
  return res.json();
}

function isAuthConfigured() {
  return Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
}

function requireAuth(req, res, next) {
  // Auth routes and healthcheck are always public
  if (
    req.path === "/auth/github" ||
    req.path === "/auth/github/callback" ||
    req.path === "/auth/login" ||
    req.path === "/setup/healthz"
  ) {
    return next();
  }

  // If GitHub OAuth is not configured, fall through (allow access).
  // This lets users still complete initial setup before configuring OAuth.
  if (!isAuthConfigured()) {
    return next();
  }

  if (req.session?.user) {
    return next();
  }

  // For API calls, return 401
  if (req.path.startsWith("/setup/api/") || req.headers.accept?.includes("application/json")) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  // For page requests, redirect to login
  return res.redirect("/auth/login");
}

// ---------- Express app ----------

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // trust Railway's reverse proxy for secure cookies
app.use(express.json({ limit: "1mb" }));

// Session middleware
app.use(
  session({
    secret: SESSION_SECRET,
    name: "openclaw.sid",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  }),
);

// ---------- Auth routes ----------

function loginPageHTML(error) {
  const errorBlock = error
    ? `<div style="background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;padding:0.75rem 1rem;border-radius:8px;margin-bottom:1rem;font-size:0.9rem;">${error}</div>`
    : "";
  const notConfigured = !isAuthConfigured()
    ? `<div style="background:#fefce8;border:1px solid #fde68a;color:#92400e;padding:0.75rem 1rem;border-radius:8px;margin-bottom:1rem;font-size:0.85rem;">
        <strong>GitHub OAuth not configured.</strong><br/>
        Set <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> in your Railway variables.<br/>
        Optionally set <code>GITHUB_ALLOWED_USERS</code> to restrict access (comma-separated usernames).
      </div>`
    : "";
  const btnDisabled = !isAuthConfigured() ? "disabled" : "";
  const btnStyle = !isAuthConfigured()
    ? "opacity:0.5;cursor:not-allowed;"
    : "cursor:pointer;";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in - OpenClaw</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: #0a0a0a; color: #fafafa; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #141414; border: 1px solid #262626; border-radius: 16px; padding: 2.5rem 2rem; max-width: 400px; width: 100%; margin: 1rem; }
    h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.25rem; text-align: center; }
    .subtitle { color: #a3a3a3; font-size: 0.9rem; text-align: center; margin-bottom: 1.5rem; }
    .btn-github { display: flex; align-items: center; justify-content: center; gap: 0.75rem; width: 100%; padding: 0.75rem 1.25rem; border-radius: 10px; border: 1px solid #333; background: #fafafa; color: #0a0a0a; font-size: 0.95rem; font-weight: 600; transition: all 0.15s; text-decoration: none; ${btnStyle} }
    .btn-github:hover:not([disabled]) { background: #e5e5e5; }
    .btn-github svg { width: 20px; height: 20px; }
    code { background: #262626; padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.8rem; color: #e5e5e5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>OpenClaw</h1>
    <p class="subtitle">Sign in to access your instance</p>
    ${errorBlock}
    ${notConfigured}
    <a href="/auth/github" class="btn-github" ${btnDisabled}>
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
      Sign in with GitHub
    </a>
  </div>
</body>
</html>`;
}

app.get("/auth/login", (req, res) => {
  // If already logged in, redirect to home
  if (req.session?.user) {
    return res.redirect("/");
  }
  const error = req.query.error || "";
  res.type("html").send(loginPageHTML(error));
});

app.get("/auth/github", (req, res) => {
  if (!isAuthConfigured()) {
    return res.redirect("/auth/login?error=" + encodeURIComponent("GitHub OAuth not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET."));
  }

  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${getBaseUrl(req)}/auth/github/callback`,
    scope: "read:user",
    state,
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get("/auth/github/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code || !state || state !== req.session.oauthState) {
      return res.redirect("/auth/login?error=" + encodeURIComponent("Invalid OAuth state. Please try again."));
    }
    delete req.session.oauthState;

    // Exchange code for access token
    const tokenData = await githubFetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    if (!tokenData.access_token) {
      return res.redirect("/auth/login?error=" + encodeURIComponent("Failed to get access token from GitHub."));
    }

    // Get user info
    const user = await githubFetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${tokenData.access_token}` },
    });

    const username = (user.login || "").toLowerCase();

    // Check allowlist
    if (GITHUB_ALLOWED_USERS.length > 0 && !GITHUB_ALLOWED_USERS.includes(username)) {
      return res.redirect(
        "/auth/login?error=" +
          encodeURIComponent(`Access denied. User "${user.login}" is not in the allowed users list.`),
      );
    }

    // Save to session
    req.session.user = {
      id: user.id,
      login: user.login,
      avatar: user.avatar_url,
      name: user.name || user.login,
    };

    req.session.save(() => {
      res.redirect("/setup");
    });
  } catch (err) {
    console.error("[auth] GitHub OAuth error:", err);
    res.redirect("/auth/login?error=" + encodeURIComponent("Authentication failed. Please try again."));
  }
});

app.get("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/auth/login");
  });
});

app.get("/auth/me", (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  res.json({ user: req.session.user });
});

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

// Apply auth to all routes below
app.use(requireAuth);

// Minimal health endpoint for Railway.
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

app.get("/setup/app.js", (_req, res) => {
  // Serve JS for /setup (kept external to avoid inline encoding/template issues)
  res.type("application/javascript");
  res.send(fs.readFileSync(path.join(process.cwd(), "src", "setup-app.js"), "utf8"));
});

app.get("/setup", (_req, res) => {
  const user = req.session?.user;
  const userBar = user
    ? `<div class="user-bar">
        <div style="display:flex;align-items:center;gap:0.5rem;">
          <img src="${user.avatar}" alt="" style="width:24px;height:24px;border-radius:50%;" />
          <span style="font-size:0.85rem;color:#a3a3a3;">${user.name || user.login}</span>
        </div>
        <a href="/auth/logout" style="font-size:0.85rem;color:#a3a3a3;text-decoration:none;">Sign out</a>
      </div>`
    : "";

  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Setup</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: #0a0a0a; color: #fafafa; line-height: 1.5; }
    .wrap { max-width: 620px; margin: 0 auto; padding: 2rem 1.25rem; }
    .user-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; padding: 0.5rem 0; border-bottom: 1px solid #262626; }
    h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.25rem; }
    .subtitle { color: #a3a3a3; font-size: 0.9rem; margin-bottom: 1.5rem; }
    .status-bar { background: #141414; border: 1px solid #262626; border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1.5rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
    .status-dot { width: 10px; height: 10px; border-radius: 50%; background: #525252; flex-shrink: 0; }
    .status-dot.ok { background: #22c55e; }
    .status-dot.err { background: #ef4444; }
    .status-text { flex: 1; font-size: 0.9rem; }
    .status-links a { font-size: 0.85rem; color: #60a5fa; text-decoration: none; }
    .status-links a:hover { text-decoration: underline; }
    .card { background: #141414; border: 1px solid #262626; border-radius: 10px; padding: 1.25rem; margin-bottom: 1rem; }
    .card h2 { font-size: 1.05rem; font-weight: 600; margin-bottom: 0.5rem; }
    .hint { color: #a3a3a3; font-size: 0.85rem; margin-bottom: 0.75rem; }
    label { display: block; margin-top: 0.75rem; font-size: 0.85rem; font-weight: 600; color: #d4d4d4; }
    input, select, textarea { width: 100%; padding: 0.55rem 0.75rem; margin-top: 0.3rem; border: 1px solid #333; border-radius: 8px; font-size: 0.9rem; background: #1a1a1a; color: #fafafa; outline: none; }
    input:focus, select:focus, textarea:focus { border-color: #60a5fa; box-shadow: 0 0 0 2px rgba(96,165,250,0.2); }
    .model-hint { color: #737373; font-size: 0.8rem; margin-top: 0.25rem; }
    .btn { display: inline-flex; align-items: center; justify-content: center; padding: 0.6rem 1.25rem; border-radius: 8px; border: 0; font-size: 0.9rem; font-weight: 600; cursor: pointer; transition: opacity 0.15s; }
    .btn:hover { opacity: 0.85; }
    .btn-primary { background: #fafafa; color: #0a0a0a; }
    .btn-secondary { background: #262626; color: #d4d4d4; }
    .btn-danger { background: #1c0a0a; color: #f87171; border: 1px solid #7f1d1d; }
    .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 1rem; }
    pre { white-space: pre-wrap; word-break: break-word; background: #1a1a1a; border: 1px solid #262626; border-radius: 8px; padding: 0.75rem; font-size: 0.8rem; margin-top: 0.75rem; max-height: 300px; overflow-y: auto; display: none; color: #d4d4d4; }
    pre.visible { display: block; }
    .toggle { font-size: 0.85rem; color: #60a5fa; cursor: pointer; border: 0; background: 0; padding: 0; margin-top: 1rem; }
    .toggle:hover { text-decoration: underline; }
    .advanced { display: none; }
    .advanced.open { display: block; }
    .divider { border: 0; border-top: 1px solid #262626; margin: 1rem 0; }
    code { background: #262626; padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.85rem; color: #e5e5e5; }
  </style>
</head>
<body>
  <div class="wrap">
    ${userBar}
    <h1>OpenClaw Setup</h1>
    <p class="subtitle">Configure your OpenClaw instance in a few steps.</p>

    <div class="status-bar">
      <span class="status-dot" id="statusDot"></span>
      <span class="status-text" id="status">Loading...</span>
      <span class="status-links">
        <a href="/openclaw" target="_blank">Open UI</a>
      </span>
    </div>

    <div class="card">
      <h2>Provider</h2>
      <p class="hint">Pick the AI provider and paste your API key.</p>

      <label>Provider</label>
      <select id="authChoice">
        <option value="openrouter-api-key">OpenRouter</option>
        <option value="openai-api-key">OpenAI</option>
        <option value="apiKey">Anthropic</option>
        <option value="gemini-api-key">Google Gemini</option>
        <option value="ai-gateway-api-key">Vercel AI Gateway</option>
        <option value="moonshot-api-key">Moonshot AI</option>
        <option value="minimax-api">MiniMax</option>
        <option value="claude-cli">Anthropic (Claude CLI token)</option>
        <option value="codex-cli">OpenAI (Codex CLI OAuth)</option>
      </select>

      <label>API Key</label>
      <input id="authSecret" type="password" placeholder="sk-or-v1-... / sk-..." autocomplete="off" />

      <label id="modelLabel">Model</label>
      <input id="model" type="text" placeholder="anthropic/claude-sonnet-4" autocomplete="off" />
      <div class="model-hint" id="modelHint">
        OpenRouter format: <code>provider/model-name</code>. Examples: <code>anthropic/claude-sonnet-4</code>, <code>openai/gpt-4o</code>, <code>google/gemini-2.5-pro</code>
      </div>

      <input type="hidden" id="flow" value="quickstart" />
    </div>

    <div class="card">
      <h2>Channels (optional)</h2>
      <p class="hint">Connect a chat platform now, or do it later from the OpenClaw UI.</p>

      <label>Telegram bot token</label>
      <input id="telegramToken" type="password" placeholder="123456:ABC..." autocomplete="off" />
      <div class="model-hint">From <code>@BotFather</code> on Telegram.</div>

      <label>Discord bot token</label>
      <input id="discordToken" type="password" placeholder="Bot token" autocomplete="off" />
      <div class="model-hint">From the Discord Developer Portal. Enable MESSAGE CONTENT INTENT.</div>

      <button class="toggle" id="toggleSlack">+ Slack</button>
      <div class="advanced" id="slackSection">
        <label>Slack bot token</label>
        <input id="slackBotToken" type="password" placeholder="xoxb-..." autocomplete="off" />
        <label>Slack app token</label>
        <input id="slackAppToken" type="password" placeholder="xapp-..." autocomplete="off" />
      </div>
    </div>

    <div class="card">
      <div class="actions">
        <button class="btn btn-primary" id="run">Run Setup</button>
        <button class="btn btn-danger" id="reset">Reset</button>
      </div>
      <pre id="log"></pre>
    </div>

    <button class="toggle" id="toggleAdvanced">Advanced tools</button>
    <div class="advanced" id="advancedSection">
      <div class="card" style="margin-top: 0.75rem">
        <h2>Debug console</h2>
        <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap">
          <select id="consoleCmd" style="flex:2">
            <option value="gateway.restart">gateway.restart</option>
            <option value="gateway.stop">gateway.stop</option>
            <option value="gateway.start">gateway.start</option>
            <option value="openclaw.status">openclaw status</option>
            <option value="openclaw.health">openclaw health</option>
            <option value="openclaw.doctor">openclaw doctor</option>
            <option value="openclaw.logs.tail">openclaw logs --tail N</option>
            <option value="openclaw.config.get">openclaw config get (path)</option>
            <option value="openclaw.version">openclaw --version</option>
          </select>
          <input id="consoleArg" placeholder="arg" style="flex:1" />
          <button class="btn btn-secondary" id="consoleRun">Run</button>
        </div>
        <pre id="consoleOut"></pre>
      </div>

      <div class="card">
        <h2>Config editor</h2>
        <div class="hint" id="configPath"></div>
        <textarea id="configText" style="height:200px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:0.8rem"></textarea>
        <div class="actions">
          <button class="btn btn-secondary" id="configReload">Reload</button>
          <button class="btn btn-primary" id="configSave">Save & Restart</button>
        </div>
        <pre id="configOut"></pre>
      </div>

      <div class="card">
        <h2>Backup</h2>
        <div class="actions">
          <a href="/setup/export" class="btn btn-secondary" target="_blank">Download backup</a>
        </div>
        <hr class="divider" />
        <label>Import backup (.tar.gz)</label>
        <input id="importFile" type="file" accept=".tar.gz,application/gzip" />
        <div class="actions">
          <button class="btn btn-danger" id="importRun">Import</button>
        </div>
        <pre id="importOut"></pre>
      </div>

      <div class="card">
        <h2>Pairing</h2>
        <p class="hint">Approve DM access when dmPolicy=pairing.</p>
        <div class="actions">
          <button class="btn btn-secondary" id="pairingApprove">Approve pairing code</button>
        </div>
      </div>
    </div>
  </div>

  <script src="/setup/app.js"></script>
</body>
</html>`);
});

app.get("/setup/api/status", async (_req, res) => {
  const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));

  res.json({
    configured: isConfigured(),
    openclawVersion: version.output.trim(),
  });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    // The wrapper owns public networking; keep the gateway internal.
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart"
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    // Map secret to correct flag for common choices.
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      "apiKey": "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key"
    };
    const flag = map[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token" && secret) {
      // This is the Anthropics setup-token flow.
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  // Model is applied after onboarding via `config set` (see /setup/api/run handler).
  // The `onboard` command does not accept --model in newer OpenClaw builds.

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        // Backward-compat aliases
        CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR || STATE_DIR,
        CLAWDBOT_WORKSPACE_DIR: process.env.CLAWDBOT_WORKSPACE_DIR || WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

app.post("/setup/api/run", async (req, res) => {
  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return res.json({ ok: true, output: "Already configured.\nUse Reset setup if you want to rerun onboarding.\n" });
    }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const payload = req.body || {};
  const onboardArgs = buildOnboardArgs(payload);
  const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

  let extra = "";

  const ok = onboard.code === 0 && isConfigured();

  // Optional channel setup (only after successful onboarding, and only if the installed CLI supports it).
  if (ok) {
    // The internal gateway is bound to loopback and only reachable through
    // the wrapper proxy, so we disable auth entirely to avoid "token mismatch"
    // errors. The wrapper's SETUP_PASSWORD protects /setup externally.
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "none"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));

    // Ensure model is written into config (important for OpenRouter where the CLI may not
    // recognise --model during non-interactive onboarding).
    const modelVal = (payload.model || "").trim();
    if (modelVal) {
      const setModel = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "model", modelVal]));
      extra += `\n[model] set to ${modelVal} (exit=${setModel.code})\n`;
    }

    const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
    const helpText = channelsHelp.output || "";

    const supports = (name) => helpText.includes(name);

    if (payload.telegramToken?.trim()) {
      if (!supports("telegram")) {
        extra += "\n[telegram] skipped (this openclaw build does not list telegram in `channels add --help`)\n";
      } else {
        // Avoid `channels add` here (it has proven flaky across builds); write config directly.
        const token = payload.telegramToken.trim();
        const cfgObj = {
          enabled: true,
          dmPolicy: "pairing",
          botToken: token,
          groupPolicy: "allowlist",
          streamMode: "partial",
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));
        extra += `\n[telegram config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[telegram verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    if (payload.discordToken?.trim()) {
      if (!supports("discord")) {
        extra += "\n[discord] skipped (this openclaw build does not list discord in `channels add --help`)\n";
      } else {
        const token = payload.discordToken.trim();
        const cfgObj = {
          enabled: true,
          token,
          groupPolicy: "allowlist",
          dm: {
            policy: "pairing",
          },
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));
        extra += `\n[discord config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[discord verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
      if (!supports("slack")) {
        extra += "\n[slack] skipped (this openclaw build does not list slack in `channels add --help`)\n";
      } else {
        const cfgObj = {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.slack"]));
        extra += `\n[slack config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[slack verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    // Apply changes immediately.
    await restartGateway();
  }

  return res.status(ok ? 200 : 500).json({
    ok,
    output: `${onboard.output}${extra}`,
  });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return res.status(500).json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || process.env.CLAWDBOT_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(path.join(STATE_DIR, "gateway.token")),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

// --- Debug console (Option A: allowlisted commands + config editor) ---

function redactSecrets(text) {
  if (!text) return text;
  // Very small best-effort redaction. (Config paths/values may still contain secrets.)
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(gho_[A-Za-z0-9_]{10,})/g, "[REDACTED]")
    .replace(/(xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]")
    .replace(/(AA[A-Za-z0-9_-]{10,}:\S{10,})/g, "[REDACTED]");
}

const ALLOWED_CONSOLE_COMMANDS = new Set([
  // Wrapper-managed lifecycle
  "gateway.restart",
  "gateway.stop",
  "gateway.start",

  // OpenClaw CLI helpers
  "openclaw.version",
  "openclaw.status",
  "openclaw.health",
  "openclaw.doctor",
  "openclaw.logs.tail",
  "openclaw.config.get",
]);

app.post("/setup/api/console/run", async (req, res) => {
  const payload = req.body || {};
  const cmd = String(payload.cmd || "").trim();
  const arg = String(payload.arg || "").trim();

  if (!ALLOWED_CONSOLE_COMMANDS.has(cmd)) {
    return res.status(400).json({ ok: false, error: "Command not allowed" });
  }

  try {
    if (cmd === "gateway.restart") {
      await restartGateway();
      return res.json({ ok: true, output: "Gateway restarted (wrapper-managed).\n" });
    }
    if (cmd === "gateway.stop") {
      if (gatewayProc) {
        try { gatewayProc.kill("SIGTERM"); } catch {}
        await sleep(750);
        gatewayProc = null;
      }
      return res.json({ ok: true, output: "Gateway stopped (wrapper-managed).\n" });
    }
    if (cmd === "gateway.start") {
      const r = await ensureGatewayRunning();
      return res.json({ ok: Boolean(r.ok), output: r.ok ? "Gateway started.\n" : `Gateway not started: ${r.reason}\n` });
    }

    if (cmd === "openclaw.version") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.status") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["status"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.health") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["health"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.doctor") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.logs.tail") {
      const lines = Math.max(50, Math.min(1000, Number.parseInt(arg || "200", 10) || 200));
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["logs", "--tail", String(lines)]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.config.get") {
      if (!arg) return res.status(400).json({ ok: false, error: "Missing config path" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", arg]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    return res.status(400).json({ ok: false, error: "Unhandled command" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/setup/api/config/raw", async (_req, res) => {
  try {
    const p = configPath();
    const exists = fs.existsSync(p);
    const content = exists ? fs.readFileSync(p, "utf8") : "";
    res.json({ ok: true, path: p, exists, content });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/config/raw", async (req, res) => {
  try {
    const content = String((req.body && req.body.content) || "");
    if (content.length > 500_000) {
      return res.status(413).json({ ok: false, error: "Config too large" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });

    const p = configPath();
    // Backup
    if (fs.existsSync(p)) {
      const backupPath = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(p, backupPath);
    }

    fs.writeFileSync(p, content, { encoding: "utf8", mode: 0o600 });

    // Apply immediately.
    if (isConfigured()) {
      await restartGateway();
    }

    res.json({ ok: true, path: p });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/pairing/approve", async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res.status(400).json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", String(channel), String(code)]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: r.output });
});

app.post("/setup/api/reset", async (_req, res) => {
  // Minimal reset: delete the config file so /setup can rerun.
  // Keep credentials/sessions/workspace by default.
  try {
    fs.rmSync(configPath(), { force: true });
    res.type("text/plain").send("OK - deleted config file. You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.get("/setup/export", async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  // Prefer exporting from a common /data root so archives are easy to inspect and restore.
  // This preserves dotfiles like /data/.openclaw/openclaw.json.
  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);

  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    // We export relative to /data so the archive contains: .openclaw/... and workspace/...
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const stream = tar.c(
    {
      gzip: true,
      portable: true,
      noMtime: true,
      cwd,
      onwarn: () => {},
    },
    paths,
  );

  stream.on("error", (err) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

function isUnderDir(p, root) {
  const abs = path.resolve(p);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

function looksSafeTarPath(p) {
  if (!p) return false;
  // tar paths always use / separators
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  // windows drive letters
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  // path traversal
  if (p.split("/").includes("..")) return false;
  return true;
}

async function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Import a backup created by /setup/export.
// This is intentionally limited to restoring into /data to avoid overwriting arbitrary host paths.
app.post("/setup/import", async (req, res) => {
  try {
    const dataRoot = "/data";
    if (!isUnderDir(STATE_DIR, dataRoot) || !isUnderDir(WORKSPACE_DIR, dataRoot)) {
      return res
        .status(400)
        .type("text/plain")
        .send("Import is only supported when OPENCLAW_STATE_DIR and OPENCLAW_WORKSPACE_DIR are under /data (Railway volume).\n");
    }

    // Stop gateway before restore so we don't overwrite live files.
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }

    const buf = await readBodyBuffer(req, 250 * 1024 * 1024); // 250MB max
    if (!buf.length) return res.status(400).type("text/plain").send("Empty body\n");

    // Extract into /data.
    // We only allow safe relative paths, and we intentionally do NOT delete existing files.
    // (Users can reset/redeploy or manually clean the volume if desired.)
    const tmpPath = path.join(os.tmpdir(), `openclaw-import-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpPath, buf);

    await tar.x({
      file: tmpPath,
      cwd: dataRoot,
      gzip: true,
      strict: true,
      onwarn: () => {},
      filter: (p) => {
        // Allow only paths that look safe.
        return looksSafeTarPath(p);
      },
    });

    try { fs.rmSync(tmpPath, { force: true }); } catch {}

    // Restart gateway after restore.
    if (isConfigured()) {
      await restartGateway();
    }

    res.type("text/plain").send("OK - imported backup into /data and restarted gateway.\n");
  } catch (err) {
    console.error("[import]", err);
    res.status(500).type("text/plain").send(String(err));
  }
});

// Proxy everything else to the gateway.
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
});

proxy.on("error", (err, _req, _res) => {
  console.error("[proxy]", err);
});

app.use(async (req, res) => {
  // If not configured, force users to /setup for any non-setup routes.
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    try {
      await ensureGatewayRunning();
    } catch (err) {
      return res.status(503).type("text/plain").send(`Gateway not ready: ${String(err)}`);
    }
  }

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[wrapper] listening on :${PORT}`);
  console.log(`[wrapper] state dir: ${STATE_DIR}`);
  console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);
  console.log(`[wrapper] gateway token: ${OPENCLAW_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
  console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);
  if (isAuthConfigured()) {
    console.log(`[wrapper] auth: GitHub OAuth (client_id=${GITHUB_CLIENT_ID.slice(0, 8)}...)`);
    if (GITHUB_ALLOWED_USERS.length > 0) {
      console.log(`[wrapper] allowed users: ${GITHUB_ALLOWED_USERS.join(", ")}`);
    } else {
      console.log(`[wrapper] allowed users: (any GitHub user)`);
    }
  } else {
    console.log(`[wrapper] ================================================`);
    console.log(`[wrapper] WARNING: GitHub OAuth not configured!`);
    console.log(`[wrapper] Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET`);
    console.log(`[wrapper] in your Railway variables to protect this instance.`);
    console.log(`[wrapper] ================================================`);
  }
  // Don't start gateway unless configured; proxy will ensure it starts.
});

server.on("upgrade", async (req, socket, head) => {
  if (!isConfigured()) {
    socket.destroy();
    return;
  }

  // For WebSocket upgrades, parse the session cookie to verify auth.
  // The session middleware doesn't run on raw upgrade events, so we
  // create a minimal fake response to invoke the session parser.
  if (isAuthConfigured()) {
    const authenticated = await new Promise((resolve) => {
      const fakeRes = { end() {}, setHeader() {}, getHeader() { return undefined; } };
      session({
        secret: SESSION_SECRET,
        name: "openclaw.sid",
        resave: false,
        saveUninitialized: false,
      })(req, fakeRes, () => {
        resolve(Boolean(req.session?.user));
      });
    });
    if (!authenticated) {
      socket.destroy();
      return;
    }
  }

  try {
    await ensureGatewayRunning();
  } catch {
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

process.on("SIGTERM", () => {
  // Best-effort shutdown
  try {
    if (gatewayProc) gatewayProc.kill("SIGTERM");
  } catch {
    // ignore
  }
  process.exit(0);
});
