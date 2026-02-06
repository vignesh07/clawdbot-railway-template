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
  // external authentication (GitHub OAuth). This avoids the "gateway token
  // mismatch" error that occurs because the Control UI SPA authenticates at
  // the WebSocket application-protocol level, which the proxy cannot inject.
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

// ---------- Helpers ----------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SESSION_CONFIG = {
  secret: SESSION_SECRET,
  name: "openclaw.sid",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || Boolean(process.env.RAILWAY_ENVIRONMENT),
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
};

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
app.use(session(SESSION_CONFIG));

// ---------- Auth routes ----------

function loginPageHTML(error) {
  const errorBlock = error
    ? `<div class="alert alert-error">${escapeHtml(error)}</div>`
    : "";
  const notConfigured = !isAuthConfigured()
    ? `<div class="alert alert-warn">
        <strong>GitHub OAuth not configured.</strong><br/>
        Set <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> in your Railway variables.<br/>
        Optionally set <code>GITHUB_ALLOWED_USERS</code> to restrict access.
      </div>`
    : "";
  const btnDisabled = !isAuthConfigured() ? "disabled" : "";
  const btnCls = !isAuthConfigured() ? "btn-github disabled" : "btn-github";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in - OpenClaw</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #09090b; color: #fafafa; min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
    }
    .login-wrapper { width: 100%; max-width: 380px; padding: 1.5rem; }
    .logo-mark {
      width: 48px; height: 48px; border-radius: 14px;
      background: linear-gradient(135deg, #18181b 0%, #27272a 100%);
      border: 1px solid #3f3f46;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 1.5rem;
    }
    .logo-mark svg { width: 24px; height: 24px; color: #fafafa; }
    h1 { font-size: 1.25rem; font-weight: 600; text-align: center; letter-spacing: -0.01em; }
    .subtitle { color: #71717a; font-size: 0.875rem; text-align: center; margin-top: 0.375rem; margin-bottom: 2rem; }
    .alert {
      padding: 0.75rem 1rem; border-radius: 10px; font-size: 0.8125rem;
      margin-bottom: 1.25rem; line-height: 1.5;
    }
    .alert-error { background: #1c0a0a; border: 1px solid #7f1d1d; color: #fca5a5; }
    .alert-warn { background: #1a1500; border: 1px solid #854d0e; color: #fde68a; }
    .alert code { background: #27272a; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.75rem; color: #e4e4e7; }
    .btn-github {
      display: flex; align-items: center; justify-content: center; gap: 0.625rem;
      width: 100%; padding: 0.75rem 1rem; border-radius: 10px; border: 1px solid #27272a;
      background: #fafafa; color: #09090b; font-size: 0.875rem; font-weight: 600;
      cursor: pointer; transition: background 0.15s, transform 0.1s;
      text-decoration: none;
    }
    .btn-github:hover { background: #e4e4e7; }
    .btn-github:active { transform: scale(0.985); }
    .btn-github.disabled { opacity: 0.4; cursor: not-allowed; pointer-events: none; }
    .btn-github svg { width: 18px; height: 18px; flex-shrink: 0; }
    .footer-text { text-align: center; margin-top: 2rem; font-size: 0.75rem; color: #52525b; }
    .footer-text a { color: #71717a; text-decoration: none; }
    .footer-text a:hover { color: #a1a1aa; }
  </style>
</head>
<body>
  <div class="login-wrapper">
    <div class="logo-mark">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
    </div>
    <h1>Welcome to OpenClaw</h1>
    <p class="subtitle">Sign in to manage your instance</p>
    ${errorBlock}
    ${notConfigured}
    <a href="/auth/github" class="${btnCls}" ${btnDisabled}>
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
      Continue with GitHub
    </a>
    <p class="footer-text">Secured by GitHub OAuth</p>
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

app.get("/setup", (req, res) => {
  const user = req.session?.user;
  const avatarHtml = user
    ? `<img src="${escapeHtml(user.avatar)}" alt="" class="avatar" /><span class="user-name">${escapeHtml(user.name || user.login)}</span>`
    : "";
  const signOutHtml = user ? `<a href="/auth/logout" class="nav-link">Sign out</a>` : "";

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Setup</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #09090b;
      --surface: #18181b;
      --surface-2: #27272a;
      --border: #27272a;
      --border-hover: #3f3f46;
      --text: #fafafa;
      --text-muted: #a1a1aa;
      --text-dim: #71717a;
      --accent: #3b82f6;
      --accent-muted: rgba(59, 130, 246, 0.15);
      --success: #22c55e;
      --success-muted: rgba(34, 197, 94, 0.12);
      --danger: #ef4444;
      --danger-muted: rgba(239, 68, 68, 0.1);
      --radius: 12px;
      --radius-sm: 8px;
      --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    }

    body { font-family: var(--font); background: var(--bg); color: var(--text); line-height: 1.5; min-height: 100vh; }

    /* ---- Top nav ---- */
    .topbar {
      position: sticky; top: 0; z-index: 50;
      background: rgba(9,9,11,0.85); backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      padding: 0 1.5rem; height: 56px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .topbar-left { display: flex; align-items: center; gap: 0.75rem; }
    .topbar-brand { font-weight: 600; font-size: 0.9375rem; letter-spacing: -0.01em; color: var(--text); text-decoration: none; }
    .avatar { width: 24px; height: 24px; border-radius: 50%; }
    .user-name { font-size: 0.8125rem; color: var(--text-muted); }
    .topbar-right { display: flex; align-items: center; gap: 1rem; }
    .nav-link { font-size: 0.8125rem; color: var(--text-dim); text-decoration: none; transition: color 0.15s; }
    .nav-link:hover { color: var(--text-muted); }
    .open-ui-btn {
      display: inline-flex; align-items: center; gap: 0.375rem;
      font-size: 0.8125rem; font-weight: 500; color: var(--accent);
      text-decoration: none; padding: 0.375rem 0.75rem;
      border: 1px solid rgba(59,130,246,0.25); border-radius: var(--radius-sm);
      transition: background 0.15s, border-color 0.15s;
    }
    .open-ui-btn:hover { background: var(--accent-muted); border-color: rgba(59,130,246,0.4); }
    .open-ui-btn svg { width: 14px; height: 14px; }

    /* ---- Layout ---- */
    .shell { max-width: 640px; margin: 0 auto; padding: 2rem 1.5rem 4rem; }

    /* ---- Status banner ---- */
    .status-banner {
      display: flex; align-items: center; gap: 0.75rem;
      padding: 0.875rem 1rem; border-radius: var(--radius);
      border: 1px solid var(--border); background: var(--surface);
      margin-bottom: 2rem;
    }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #52525b; flex-shrink: 0; }
    .status-dot.ok { background: var(--success); box-shadow: 0 0 8px rgba(34,197,94,0.4); }
    .status-dot.err { background: var(--danger); box-shadow: 0 0 8px rgba(239,68,68,0.3); }
    .status-text { flex: 1; font-size: 0.8125rem; color: var(--text-muted); }

    /* ---- Tabs ---- */
    .tabs {
      display: flex; gap: 0; border-bottom: 1px solid var(--border);
      margin-bottom: 1.5rem; overflow-x: auto;
    }
    .tab {
      padding: 0.625rem 1rem; font-size: 0.8125rem; font-weight: 500;
      color: var(--text-dim); cursor: pointer; border: 0; background: 0;
      border-bottom: 2px solid transparent; transition: color 0.15s, border-color 0.15s;
      white-space: nowrap; font-family: var(--font);
    }
    .tab:hover { color: var(--text-muted); }
    .tab.active { color: var(--text); border-bottom-color: var(--text); }

    .tab-panel { display: none; }
    .tab-panel.active { display: block; }

    /* ---- Cards ---- */
    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 1.25rem; margin-bottom: 1rem;
      transition: border-color 0.15s;
    }
    .card:hover { border-color: var(--border-hover); }
    .card-header { margin-bottom: 1rem; }
    .card-title { font-size: 0.9375rem; font-weight: 600; letter-spacing: -0.01em; }
    .card-desc { font-size: 0.8125rem; color: var(--text-dim); margin-top: 0.25rem; }

    /* ---- Forms ---- */
    .field { margin-bottom: 1rem; }
    .field-label { display: block; font-size: 0.8125rem; font-weight: 500; color: var(--text-muted); margin-bottom: 0.375rem; }
    .field-hint { font-size: 0.75rem; color: var(--text-dim); margin-top: 0.25rem; line-height: 1.4; }
    input, select, textarea {
      width: 100%; padding: 0.5rem 0.75rem;
      border: 1px solid var(--border); border-radius: var(--radius-sm);
      font-size: 0.875rem; background: var(--bg); color: var(--text);
      outline: none; transition: border-color 0.15s, box-shadow 0.15s;
      font-family: var(--font);
    }
    input:focus, select:focus, textarea:focus {
      border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-muted);
    }
    input[type="password"] { font-family: var(--font-mono); letter-spacing: 0.05em; }
    select { cursor: pointer; }

    /* ---- Buttons ---- */
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 0.375rem;
      padding: 0.5rem 1rem; border-radius: var(--radius-sm); border: 1px solid transparent;
      font-size: 0.8125rem; font-weight: 600; cursor: pointer;
      transition: background 0.15s, transform 0.1s, opacity 0.15s;
      font-family: var(--font);
    }
    .btn:active { transform: scale(0.98); }
    .btn-primary { background: var(--text); color: var(--bg); border-color: var(--text); }
    .btn-primary:hover { opacity: 0.9; }
    .btn-secondary { background: var(--surface-2); color: var(--text-muted); border-color: var(--border); }
    .btn-secondary:hover { background: #3f3f46; color: var(--text); }
    .btn-danger { background: var(--danger-muted); color: #fca5a5; border-color: #7f1d1d; }
    .btn-danger:hover { background: rgba(239,68,68,0.18); }
    .btn-ghost { background: transparent; color: var(--text-dim); }
    .btn-ghost:hover { color: var(--text-muted); background: var(--surface); }
    .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }

    /* ---- Channel cards ---- */
    .channel-grid { display: flex; flex-direction: column; gap: 0.75rem; }
    .channel-card {
      border: 1px solid var(--border); border-radius: var(--radius);
      overflow: hidden; transition: border-color 0.15s;
    }
    .channel-card:hover { border-color: var(--border-hover); }
    .channel-header {
      display: flex; align-items: center; gap: 0.625rem;
      padding: 0.75rem 1rem; background: var(--surface); cursor: pointer;
      border: 0; width: 100%; text-align: left; color: var(--text);
      font-family: var(--font); font-size: 0.8125rem; font-weight: 500;
    }
    .channel-header:hover { background: rgba(39,39,42,0.8); }
    .channel-icon { width: 20px; height: 20px; flex-shrink: 0; color: var(--text-dim); }
    .channel-name { flex: 1; }
    .channel-toggle { font-size: 0.75rem; color: var(--text-dim); transition: transform 0.2s; }
    .channel-body { padding: 0 1rem 1rem; display: none; background: var(--surface); }
    .channel-card.open .channel-body { display: block; }
    .channel-card.open .channel-toggle { transform: rotate(180deg); }

    /* ---- Console ---- */
    .console-bar { display: flex; gap: 0.5rem; align-items: center; }
    .console-bar select { flex: 2; }
    .console-bar input { flex: 1; }

    /* ---- Output log ---- */
    pre {
      white-space: pre-wrap; word-break: break-word;
      background: var(--bg); border: 1px solid var(--border);
      border-radius: var(--radius-sm); padding: 0.75rem;
      font-family: var(--font-mono); font-size: 0.75rem;
      margin-top: 0.75rem; max-height: 280px; overflow-y: auto;
      display: none; color: var(--text-muted); line-height: 1.6;
    }
    pre.visible { display: block; }

    code {
      background: var(--surface-2); padding: 0.1rem 0.3rem;
      border-radius: 3px; font-size: 0.8em; color: #e4e4e7;
      font-family: var(--font-mono);
    }

    .separator { border: 0; border-top: 1px solid var(--border); margin: 1rem 0; }

    /* ---- Responsive ---- */
    @media (max-width: 480px) {
      .shell { padding: 1.25rem 1rem 3rem; }
      .topbar { padding: 0 1rem; }
      .tab { padding: 0.5rem 0.75rem; font-size: 0.75rem; }
    }
  </style>
</head>
<body>

  <nav class="topbar" role="navigation">
    <div class="topbar-left">
      <a href="/setup" class="topbar-brand">OpenClaw</a>
      <span style="color:var(--text-dim);font-size:0.75rem;">Setup</span>
    </div>
    <div class="topbar-right">
      ${avatarHtml}
      <a href="/openclaw" target="_blank" class="open-ui-btn" id="openUiLink">
        Open UI
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </a>
      ${signOutHtml}
    </div>
  </nav>

  <main class="shell">

    <!-- Status -->
    <div class="status-banner">
      <span class="status-dot" id="statusDot"></span>
      <span class="status-text" id="status">Checking status...</span>
    </div>

    <!-- Tabs -->
    <div class="tabs" role="tablist">
      <button class="tab active" role="tab" data-tab="setup" aria-selected="true">Setup</button>
      <button class="tab" role="tab" data-tab="channels">Channels</button>
      <button class="tab" role="tab" data-tab="tools">Tools</button>
    </div>

    <!-- ========== TAB: Setup ========== -->
    <div class="tab-panel active" id="panel-setup">

      <div class="card">
        <div class="card-header">
          <div class="card-title">AI Provider</div>
          <div class="card-desc">Select your provider and enter credentials to get started.</div>
        </div>

        <div class="field">
          <label class="field-label" for="authChoice">Provider</label>
          <select id="authChoice">
            <option value="openrouter-api-key">OpenRouter</option>
            <option value="openai-api-key">OpenAI</option>
            <option value="apiKey">Anthropic</option>
            <option value="gemini-api-key">Google Gemini</option>
            <option value="ai-gateway-api-key">Vercel AI Gateway</option>
            <option value="moonshot-api-key">Moonshot AI</option>
            <option value="minimax-api">MiniMax</option>
            <option value="claude-cli">Anthropic (Claude CLI)</option>
            <option value="codex-cli">OpenAI (Codex CLI OAuth)</option>
          </select>
        </div>

        <div class="field">
          <label class="field-label" for="authSecret">API Key</label>
          <input id="authSecret" type="password" placeholder="Paste your key here" autocomplete="off" />
        </div>

        <div class="field" id="modelField">
          <label class="field-label" for="model" id="modelLabel">Model</label>
          <input id="model" type="text" placeholder="anthropic/claude-sonnet-4" autocomplete="off" />
          <div class="field-hint" id="modelHint">
            OpenRouter format: <code>provider/model-name</code>
          </div>
        </div>

        <input type="hidden" id="flow" value="quickstart" />
      </div>

      <div class="actions" style="margin-bottom:1rem;">
        <button class="btn btn-primary" id="run">Deploy Configuration</button>
        <button class="btn btn-ghost" id="reset">Reset</button>
      </div>

      <pre id="log"></pre>
    </div>

    <!-- ========== TAB: Channels ========== -->
    <div class="tab-panel" id="panel-channels">

      <div class="card">
        <div class="card-header">
          <div class="card-title">Chat Platforms</div>
          <div class="card-desc">Connect messaging platforms to your OpenClaw instance. These are optional and can be configured later.</div>
        </div>

        <div class="channel-grid">

          <!-- Telegram -->
          <div class="channel-card" id="channelTelegram">
            <button class="channel-header" onclick="this.parentElement.classList.toggle('open')">
              <svg class="channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0h-.056zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
              <span class="channel-name">Telegram</span>
              <span class="channel-toggle">&#9662;</span>
            </button>
            <div class="channel-body">
              <div class="field" style="margin-top:0.75rem;">
                <label class="field-label" for="telegramToken">Bot token</label>
                <input id="telegramToken" type="password" placeholder="123456:ABC..." autocomplete="off" />
                <div class="field-hint">Get this from <code>@BotFather</code> on Telegram.</div>
              </div>
            </div>
          </div>

          <!-- Discord -->
          <div class="channel-card" id="channelDiscord">
            <button class="channel-header" onclick="this.parentElement.classList.toggle('open')">
              <svg class="channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
              <span class="channel-name">Discord</span>
              <span class="channel-toggle">&#9662;</span>
            </button>
            <div class="channel-body">
              <div class="field" style="margin-top:0.75rem;">
                <label class="field-label" for="discordToken">Bot token</label>
                <input id="discordToken" type="password" placeholder="Bot token" autocomplete="off" />
                <div class="field-hint">From the Discord Developer Portal. Enable MESSAGE CONTENT INTENT.</div>
              </div>
            </div>
          </div>

          <!-- Slack -->
          <div class="channel-card" id="channelSlack">
            <button class="channel-header" onclick="this.parentElement.classList.toggle('open')">
              <svg class="channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M5.042 15.165a2.528 2.528 0 01-2.52 2.523A2.528 2.528 0 010 15.165a2.527 2.527 0 012.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 012.521-2.52 2.527 2.527 0 012.521 2.52v6.313A2.528 2.528 0 018.834 24a2.528 2.528 0 01-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 01-2.521-2.52A2.528 2.528 0 018.834 0a2.528 2.528 0 012.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 012.521 2.521 2.528 2.528 0 01-2.521 2.521H2.522A2.528 2.528 0 010 8.834a2.528 2.528 0 012.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 012.522-2.521A2.528 2.528 0 0124 8.834a2.528 2.528 0 01-2.522 2.521h-2.522V8.834zm-1.27 0a2.528 2.528 0 01-2.523 2.521 2.527 2.527 0 01-2.52-2.521V2.522A2.527 2.527 0 0115.163 0a2.528 2.528 0 012.523 2.522v6.312zM15.163 18.956a2.528 2.528 0 012.523 2.522A2.528 2.528 0 0115.163 24a2.527 2.527 0 01-2.52-2.522v-2.522h2.52zm0-1.27a2.527 2.527 0 01-2.52-2.523 2.526 2.526 0 012.52-2.52h6.315A2.528 2.528 0 0124 15.163a2.528 2.528 0 01-2.522 2.523h-6.315z"/></svg>
              <span class="channel-name">Slack</span>
              <span class="channel-toggle">&#9662;</span>
            </button>
            <div class="channel-body">
              <div class="field" style="margin-top:0.75rem;">
                <label class="field-label" for="slackBotToken">Bot token</label>
                <input id="slackBotToken" type="password" placeholder="xoxb-..." autocomplete="off" />
              </div>
              <div class="field">
                <label class="field-label" for="slackAppToken">App token</label>
                <input id="slackAppToken" type="password" placeholder="xapp-..." autocomplete="off" />
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>

    <!-- ========== TAB: Tools ========== -->
    <div class="tab-panel" id="panel-tools">

      <!-- Debug Console -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">Console</div>
          <div class="card-desc">Run diagnostic commands against your instance.</div>
        </div>
        <div class="console-bar">
          <select id="consoleCmd">
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
          <input id="consoleArg" placeholder="arg" />
          <button class="btn btn-secondary" id="consoleRun">Run</button>
        </div>
        <pre id="consoleOut"></pre>
      </div>

      <!-- Config Editor -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">Configuration</div>
          <div class="card-desc" id="configPath">Edit the raw config file directly.</div>
        </div>
        <textarea id="configText" style="height:200px;font-family:var(--font-mono);font-size:0.75rem;resize:vertical;"></textarea>
        <div class="actions" style="margin-top:0.75rem;">
          <button class="btn btn-secondary" id="configReload">Reload</button>
          <button class="btn btn-primary" id="configSave">Save & Restart</button>
        </div>
        <pre id="configOut"></pre>
      </div>

      <!-- Backup -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">Backup & Restore</div>
          <div class="card-desc">Export or import your instance data.</div>
        </div>
        <div class="actions">
          <a href="/setup/export" class="btn btn-secondary" target="_blank">Download backup</a>
        </div>
        <hr class="separator" />
        <div class="field">
          <label class="field-label" for="importFile">Import backup (.tar.gz)</label>
          <input id="importFile" type="file" accept=".tar.gz,application/gzip" />
        </div>
        <div class="actions">
          <button class="btn btn-danger" id="importRun">Import & Overwrite</button>
        </div>
        <pre id="importOut"></pre>
      </div>

      <!-- Pairing -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">Device Pairing</div>
          <div class="card-desc">Approve DM access when dmPolicy is set to pairing.</div>
        </div>
        <div class="actions">
          <button class="btn btn-secondary" id="pairingApprove">Approve pairing code</button>
        </div>
      </div>

    </div>

  </main>

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
  const timeoutMs = opts.timeoutMs ?? 60_000; // default 60s
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
    let settled = false;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 0, output: out });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      out += `\n[timeout] command killed after ${timeoutMs / 1000}s\n`;
      try { proc.kill("SIGKILL"); } catch {}
      finish(124); // exit code 124 = timeout (matches GNU timeout convention)
    }, timeoutMs);

    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      finish(127);
    });

    proc.on("close", (code) => finish(code));
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
    // errors. The wrapper's GitHub OAuth session protects all routes externally.
    const cfgOpts = { timeoutMs: 10_000 };
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "none"]), cfgOpts);
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]), cfgOpts);
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]), cfgOpts);

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

    // Start gateway in the background -- don't block the HTTP response.
    // Railway's proxy has a ~30s timeout and the full setup chain above
    // can exceed that if we also wait for the gateway to become ready.
    restartGateway().catch((err) => {
      console.error("[/setup/api/run] background gateway start failed:", err);
    });
    extra += "\n[gateway] starting in background...\n";
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
      session(SESSION_CONFIG)(req, fakeRes, () => {
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
