import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import session from "express-session";
import httpProxy from "http-proxy";
import * as tar from "tar";

/** @type {Set<string>} */
const warnedDeprecatedEnv = new Set();

/**
 * Prefer `primaryKey`, fall back to `deprecatedKey` with a one-time warning.
 * @param {string} primaryKey
 * @param {string} deprecatedKey
 */
function getEnvWithShim(primaryKey, deprecatedKey) {
  const primary = process.env[primaryKey]?.trim();
  if (primary) return primary;

  const deprecated = process.env[deprecatedKey]?.trim();
  if (!deprecated) return undefined;

  if (!warnedDeprecatedEnv.has(deprecatedKey)) {
    console.warn(
      `[deprecation] ${deprecatedKey} is deprecated. Use ${primaryKey} instead.`,
    );
    warnedDeprecatedEnv.add(deprecatedKey);
  }

  return deprecated;
}

// Railway deployments sometimes inject PORT=3000 by default. We want the wrapper to
// reliably listen on 8080 unless explicitly overridden.
//
// Prefer OPENCLAW_PUBLIC_PORT (set in the Dockerfile / template) over PORT.
const PORT = Number.parseInt(
  getEnvWithShim("OPENCLAW_PUBLIC_PORT", "CLAWDBOT_PUBLIC_PORT") ??
    process.env.PORT ??
    "8080",
  10,
);

// State/workspace
// OpenClaw defaults to ~/.openclaw.
const STATE_DIR =
  getEnvWithShim("OPENCLAW_STATE_DIR", "CLAWDBOT_STATE_DIR") ||
  path.join(os.homedir(), ".openclaw");

const WORKSPACE_DIR =
  getEnvWithShim("OPENCLAW_WORKSPACE_DIR", "CLAWDBOT_WORKSPACE_DIR") ||
  path.join(STATE_DIR, "workspace");

// Username/Password authentication configuration.
// AUTH_USERNAME: username for login (default: "admin")
// AUTH_PASSWORD: password for login (falls back to SETUP_PASSWORD for backward compatibility)
const AUTH_USERNAME = process.env.AUTH_USERNAME?.trim() || "admin";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD?.trim() || process.env.SETUP_PASSWORD?.trim() || "";

// SETUP_PASSWORD configuration.
// Returns the env var, a previously-saved password, or null (first run).
const PASSWORD_PATH = path.join(STATE_DIR, "setup.password");
const PASSWORD_RESET_TOKENS_PATH = path.join(STATE_DIR, "reset-tokens.json");

// Load existing reset tokens from file
function loadResetTokens() {
  try {
    const data = fs.readFileSync(PASSWORD_RESET_TOKENS_PATH, "utf8");
    return JSON.parse(data) || {};
  } catch {
    return {};
  }
}

// Save reset tokens to file
function saveResetTokens(tokens) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(PASSWORD_RESET_TOKENS_PATH, JSON.stringify(tokens, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (err) {
    console.error("[reset] Failed to save reset tokens:", err);
  }
}

let resetTokens = loadResetTokens();

function resolveSetupPassword() {
  const envPassword = process.env.SETUP_PASSWORD?.trim();
  if (envPassword) return envPassword;

  try {
    const existing = fs.readFileSync(PASSWORD_PATH, "utf8").trim();
    if (existing) return existing;
  } catch {
    // First run - no password yet
  }

  return null; // Signal that user must create a password via the UI
}

// Configure password reset via external webhook or console logging
function setupEmailTransporter() {
  const webhookUrl = process.env.PASSWORD_RESET_WEBHOOK_URL?.trim();
  const consoleMode = process.env.PASSWORD_RESET_CONSOLE_MODE === "true";

  if (webhookUrl) {
    console.log("[reset] Using webhook URL for password resets:", webhookUrl);
  } else if (consoleMode) {
    console.log("[reset] Console mode enabled - reset links will be logged");
  } else {
    console.log("[reset] No email configured. Users can only reset via admin-provided tokens.");
  }

  return { webhookUrl, consoleMode };
}

let emailConfig = setupEmailTransporter();


let SETUP_PASSWORD = resolveSetupPassword();

function isPasswordConfigured() {
  return SETUP_PASSWORD !== null;
}

function savePassword(password) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(PASSWORD_PATH, password, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.error("[setup] Failed to save password:", err);
    throw err;
  }
  SETUP_PASSWORD = password;
}

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
  const envTok = getEnvWithShim(
    "OPENCLAW_GATEWAY_TOKEN",
    "CLAWDBOT_GATEWAY_TOKEN",
  );
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
    getEnvWithShim("OPENCLAW_CONFIG_PATH", "CLAWDBOT_CONFIG_PATH") ||
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
let gatewayRestartAttempts = 0;
let gatewayRestartTimer = null;
const MAX_RESTART_ATTEMPTS = 3;

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
      const headers = OPENCLAW_GATEWAY_TOKEN
        ? { "Authorization": `Bearer ${OPENCLAW_GATEWAY_TOKEN}` }
        : {};
      for (const p of paths) {
        try {
          const res = await fetch(`${GATEWAY_TARGET}${p}`, { method: "GET", headers });
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
  // wrapper proxy. We keep auth as "token" with our known token so the
  // wrapper can authenticate to the gateway. OpenClaw 2026.2.4+ rejects
  // "none" as a valid gateway.auth.mode value.
  try {
    const cfgFile = configPath();
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    let dirty = false;

    if (!cfg.gateway) cfg.gateway = {};

    // Ensure gateway auth uses token mode with the wrapper's known token.
    if (cfg.gateway.authMode !== "token") {
      cfg.gateway.authMode = "token";
      dirty = true;
    }

    // Also patch the nested auth object if present (older config format).
    if (cfg.gateway.auth) {
      if (cfg.gateway.auth.mode && cfg.gateway.auth.mode !== "token") {
        cfg.gateway.auth.mode = "token";
        dirty = true;
      }
    }

    // Ensure bind and port are correct.
    if (cfg.gateway.bind !== "loopback") {
      cfg.gateway.bind = "loopback";
      dirty = true;
    }
    if (cfg.gateway.port !== INTERNAL_GATEWAY_PORT) {
      cfg.gateway.port = INTERNAL_GATEWAY_PORT;
      dirty = true;
    }

    if (dirty) {
      fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), "utf8");
      console.log("[wrapper] patched gateway config: auth=token, bind=loopback, port=" + INTERNAL_GATEWAY_PORT);
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
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
  ];

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  gatewayProc.on("error", (err) => {
    console.error(`[gateway] spawn error: ${err.message}`);
    if (err.code === "ENOENT") {
      console.error(`[gateway] Binary not found. Check OPENCLAW_NODE and OPENCLAW_ENTRY paths.`);
    } else if (err.code === "EACCES") {
      console.error(`[gateway] Permission denied. Check file permissions.`);
    }
    gatewayProc = null;
    scheduleGatewayRestart();
  });

  gatewayProc.on("exit", (code, signal) => {
    console.error(`[gateway] exited code=${code} signal=${signal}`);
    gatewayProc = null;
    
    // Don't auto-restart if we're shutting down
    if (!isShuttingDown) {
      scheduleGatewayRestart();
    }
  });
}

function scheduleGatewayRestart() {
  // Clear any existing restart timer
  if (gatewayRestartTimer) {
    clearTimeout(gatewayRestartTimer);
    gatewayRestartTimer = null;
  }

  // Check if we've exceeded max restart attempts
  if (gatewayRestartAttempts >= MAX_RESTART_ATTEMPTS) {
    console.error(`[gateway] Max restart attempts (${MAX_RESTART_ATTEMPTS}) exceeded. Manual intervention required.`);
    return;
  }

  // Calculate exponential backoff delay: 1s, 2s, 4s
  const delay = Math.pow(2, gatewayRestartAttempts) * 1000;
  gatewayRestartAttempts++;

  console.log(`[gateway] Scheduling restart attempt ${gatewayRestartAttempts}/${MAX_RESTART_ATTEMPTS} in ${delay}ms`);

  gatewayRestartTimer = setTimeout(async () => {
    try {
      console.log(`[gateway] Auto-restart attempt ${gatewayRestartAttempts}/${MAX_RESTART_ATTEMPTS}`);
      await startGateway();
      
      // Wait to verify it started successfully
      const ready = await waitForGatewayReady({ timeoutMs: 10_000 });
      if (ready) {
        console.log("[gateway] Successfully restarted");
        gatewayRestartAttempts = 0; // Reset counter on success
      } else {
        console.error("[gateway] Restart failed - not ready");
        scheduleGatewayRestart(); // Try again
      }
    } catch (err) {
      console.error("[gateway] Auto-restart failed:", err);
      scheduleGatewayRestart(); // Try again
    }
  }, delay);
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  // Quick check: if the process is alive, verify it's actually responding.
  if (gatewayProc) {
    // Fast readiness probe (1s) -- if already running it should respond quickly.
    const alive = await waitForGatewayReady({ timeoutMs: 2_000 });
    if (alive) return { ok: true };
    // Process object exists but not responding -- kill and restart.
    console.warn("[wrapper] gateway process exists but not responding, restarting...");
    try { gatewayProc.kill("SIGTERM"); } catch { /* ignore */ }
    await sleep(500);
    gatewayProc = null;
  }
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      await startGateway();
      // Railway cold starts can be slow; give it up to 45s.
      const ready = await waitForGatewayReady({ timeoutMs: 45_000 });
      if (!ready) {
        // Kill the zombie process if it didn't become ready.
        if (gatewayProc) {
          try { gatewayProc.kill("SIGTERM"); } catch { /* ignore */ }
          gatewayProc = null;
        }
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

// ---------- Error Handling Helpers ----------

function errorPageHTML(statusCode, title, message, details = null) {
  const showDetails = details && process.env.NODE_ENV !== "production";
  const detailsBlock = showDetails
    ? `<details class="error-details">
        <summary>Show Technical Details</summary>
        <pre>${escapeHtml(details)}</pre>
      </details>`
    : "";

  const retryButton = (statusCode === 502 || statusCode === 503)
    ? `<button class="btn-retry" onclick="location.reload()">Retry</button>
       <script>
         setTimeout(() => location.reload(), 5000);
       </script>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${statusCode} - ${escapeHtml(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #09090b; color: #fafafa; min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      padding: 1.5rem;
    }
    .error-container {
      max-width: 480px; width: 100%; text-align: center;
    }
    .status-code {
      font-size: 6rem; font-weight: 700; color: #ef4444;
      line-height: 1; margin-bottom: 1rem;
      text-shadow: 0 0 40px rgba(239, 68, 68, 0.3);
    }
    h1 {
      font-size: 1.5rem; font-weight: 600; margin-bottom: 0.75rem;
      color: #fafafa; letter-spacing: -0.02em;
    }
    p {
      font-size: 0.9375rem; color: #a1a1aa; line-height: 1.6;
      margin-bottom: 2rem;
    }
    .btn-retry {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 0.75rem 1.5rem; border-radius: 10px;
      border: none; background: #3b82f6; color: #fafafa;
      font-size: 0.875rem; font-weight: 600; cursor: pointer;
      transition: all 0.15s; text-decoration: none;
    }
    .btn-retry:hover { background: #2563eb; }
    .error-details {
      margin-top: 2rem; text-align: left;
      background: #131316; border: 1px solid #232329;
      border-radius: 8px; padding: 1rem;
    }
    .error-details summary {
      cursor: pointer; font-size: 0.8125rem;
      color: #71717a; font-weight: 500;
    }
    .error-details pre {
      margin-top: 0.75rem; font-size: 0.75rem;
      color: #d4d4d8; overflow-x: auto;
      font-family: ui-monospace, monospace;
    }
  </style>
</head>
<body>
  <div class="error-container">
    <div class="status-code">${statusCode}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    ${retryButton}
    ${detailsBlock}
  </div>
</body>
</html>`;
}

// ---------- Username/Password Auth helpers ----------

function isAuthConfigured() {
  return Boolean(AUTH_PASSWORD);
}

// ---------- SETUP_PASSWORD authentication ----------

function requireSetupPassword(req, res, next) {
  // Exclude public routes - paths are relative when middleware is mounted on /setup
  if (
    req.path === "/password-prompt" ||
    req.path === "/verify-password" ||
    req.path === "/create-password" ||
    req.path === "/save-password" ||
    req.path === "/forgot-password" ||
    req.path === "/request-reset" ||
    req.path === "/reset-password" ||
    req.path === "/confirm-reset" ||
    req.path === "/healthz"
  ) {
    return next();
  }

  // If no password has been configured yet, redirect to password creation
  if (!isPasswordConfigured()) {
    if (req.path.startsWith("/api/") || req.headers.accept?.includes("application/json")) {
      return res.status(401).json({ error: "Setup password not yet configured. Visit /setup to create one." });
    }
    return res.redirect("/setup/create-password");
  }

  // Check if password has been verified in session
  if (req.session?.setupPasswordVerified) {
    return next();
  }

  // For API calls, return 401
  if (req.path.startsWith("/api/") || req.headers.accept?.includes("application/json")) {
    return res.status(401).json({ error: "Setup password required" });
  }

  // For page requests, redirect to password prompt
  return res.redirect("/setup/password-prompt");
}

function requireAuth(req, res, next) {
  // Login route and healthcheck are always public
  if (
    req.path === "/auth/login" ||
    req.path === "/setup/healthz"
  ) {
    return next();
  }

  // If auth is not configured, fall through (allow access).
  // This lets users complete initial setup without authentication.
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
app.use(express.urlencoded({ extended: false })); // Parse form data for login

// Session middleware
app.use(session(SESSION_CONFIG));

// Rate limiting for login attempts (in-memory store)
const loginAttempts = new Map(); // IP -> { count, resetAt }

function rateLimitLogin(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const window = 15 * 60 * 1000; // 15 minutes
  const maxAttempts = 10;

  const record = loginAttempts.get(ip);
  
  if (record && now < record.resetAt) {
    if (record.count >= maxAttempts) {
      const retryAfter = Math.ceil((record.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ 
        error: "Too many login attempts. Please try again later.",
        retryAfter 
      });
    }
  } else if (!record || now >= record.resetAt) {
    // Reset or initialize
    loginAttempts.set(ip, { count: 0, resetAt: now + window });
  }

  next();
}

function incrementLoginAttempts(req) {
  const ip = req.ip || req.connection.remoteAddress;
  const record = loginAttempts.get(ip);
  if (record) {
    record.count++;
  }
}

// ---------- Auth routes ----------

function loginPageHTML(error) {
  const errorBlock = error
    ? `<div class="alert alert-error">${escapeHtml(error)}</div>`
    : "";
  const notConfigured = !isAuthConfigured()
    ? `<div class="alert alert-warn">
        <strong>Open Access Mode</strong><br/>
        Authentication not configured. Anyone with access to this URL can manage your instance.<br/>
        Set <code>AUTH_PASSWORD</code> in your environment variables to secure access.
      </div>`
    : "";

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
      overflow: hidden;
    }

    /* Subtle radial glow */
    body::before {
      content: ''; position: fixed; top: -40%; left: 50%; transform: translateX(-50%);
      width: 800px; height: 600px; border-radius: 50%;
      background: radial-gradient(ellipse, rgba(59,130,246,0.06) 0%, transparent 70%);
      pointer-events: none; z-index: 0;
    }

    @keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes scaleIn { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }

    .login-wrapper {
      width: 100%; max-width: 360px; padding: 1.5rem;
      position: relative; z-index: 1;
    }
    .logo-mark {
      width: 44px; height: 44px; border-radius: 12px;
      background: #131316; border: 1px solid #232329;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 1.5rem;
      animation: scaleIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both;
      box-shadow: 0 0 0 4px rgba(59,130,246,0.06), 0 4px 24px rgba(0,0,0,0.4);
    }
    .logo-mark svg { width: 22px; height: 22px; color: #3b82f6; }
    h1 {
      font-size: 1.125rem; font-weight: 600; text-align: center;
      letter-spacing: -0.02em; line-height: 1.3;
      animation: fadeUp 0.45s cubic-bezier(0.4,0,0.2,1) 0.1s both;
    }
    .subtitle {
      color: #71717a; font-size: 0.8125rem; text-align: center;
      margin-top: 0.375rem; margin-bottom: 2rem;
      animation: fadeUp 0.45s cubic-bezier(0.4,0,0.2,1) 0.15s both;
    }
    .alert {
      padding: 0.75rem 1rem; border-radius: 10px; font-size: 0.8125rem;
      margin-bottom: 1.25rem; line-height: 1.5;
      animation: fadeUp 0.4s cubic-bezier(0.4,0,0.2,1) 0.2s both;
    }
    .alert-error { background: rgba(239,68,68,0.08); border: 1px solid rgba(127,29,29,0.5); color: #fca5a5; }
    .alert-warn { background: rgba(234,179,8,0.06); border: 1px solid rgba(133,77,14,0.5); color: #fde68a; }
    .alert code {
      background: #1c1c21; padding: 0.1rem 0.3rem; border-radius: 3px;
      font-size: 0.75rem; color: #d4d4d8;
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    }
    .form-group {
      margin-bottom: 1rem;
      animation: fadeUp 0.45s cubic-bezier(0.4,0,0.2,1) 0.2s both;
    }
    .form-group label {
      display: block;
      font-size: 0.8125rem;
      font-weight: 500;
      margin-bottom: 0.375rem;
      color: #d4d4d8;
    }
    .form-group input {
      width: 100%;
      padding: 0.625rem 0.875rem;
      border-radius: 8px;
      border: 1px solid #232329;
      background: #131316;
      color: #fafafa;
      font-size: 0.875rem;
      transition: all 0.15s cubic-bezier(0.4,0,0.2,1);
    }
    .form-group input:focus {
      outline: none;
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59,130,246,0.1);
    }
    .btn-submit {
      display: flex; align-items: center; justify-content: center;
      width: 100%; padding: 0.6875rem 1rem; border-radius: 10px;
      border: none; background: #3b82f6; color: #fafafa;
      font-size: 0.875rem; font-weight: 600; cursor: pointer;
      transition: all 0.15s cubic-bezier(0.4,0,0.2,1);
      animation: fadeUp 0.5s cubic-bezier(0.4,0,0.2,1) 0.3s both;
      margin-top: 1.5rem;
    }
    .btn-submit:hover { background: #2563eb; box-shadow: 0 2px 12px rgba(59,130,246,0.3); }
    .btn-submit:active { transform: scale(0.98); }
    .footer-text {
      text-align: center; margin-top: 2rem; font-size: 0.6875rem; color: #3f3f46;
      display: flex; align-items: center; justify-content: center; gap: 0.375rem;
      animation: fadeUp 0.5s cubic-bezier(0.4,0,0.2,1) 0.4s both;
    }
    .footer-text svg { width: 12px; height: 12px; }
  </style>
</head>
<body>
  <div class="login-wrapper">
    <div class="logo-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
    </div>
    <h1>Welcome to OpenClaw</h1>
    <p class="subtitle">Sign in to manage your instance</p>
    ${errorBlock}
    ${notConfigured}
    <form method="POST" action="/auth/login">
      <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" required autocomplete="username" />
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autocomplete="current-password" />
      </div>
      <button type="submit" class="btn-submit">Sign In</button>
    </form>
    <p class="footer-text">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
      Secured by username & password
    </p>
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

app.post("/auth/login", rateLimitLogin, (req, res) => {
  const { username, password } = req.body;

  // Validate form data
  if (!username || !password) {
    incrementLoginAttempts(req);
    return res.redirect("/auth/login?error=" + encodeURIComponent("Username and password are required"));
  }

  // If auth is not configured, grant "Open Access" session
  if (!isAuthConfigured()) {
    req.session.user = {
      id: "open-access",
      login: username,
      name: "Open Access User",
    };
    return req.session.save(() => {
      res.redirect("/setup");
    });
  }

  // Check credentials using constant-time comparison to prevent timing attacks
  // Pad strings to the same length for timingSafeEqual
  const maxLen = Math.max(username.length, AUTH_USERNAME.length, password.length, AUTH_PASSWORD.length);
  const usernameBuf = Buffer.alloc(maxLen);
  const authUsernameBuf = Buffer.alloc(maxLen);
  const passwordBuf = Buffer.alloc(maxLen);
  const authPasswordBuf = Buffer.alloc(maxLen);
  
  usernameBuf.write(username);
  authUsernameBuf.write(AUTH_USERNAME);
  passwordBuf.write(password);
  authPasswordBuf.write(AUTH_PASSWORD);
  
  let usernameMatch, passwordMatch;
  try {
    usernameMatch = crypto.timingSafeEqual(usernameBuf, authUsernameBuf) && username.length === AUTH_USERNAME.length;
    passwordMatch = crypto.timingSafeEqual(passwordBuf, authPasswordBuf) && password.length === AUTH_PASSWORD.length;
  } catch (err) {
    // If comparison fails, treat as mismatch
    usernameMatch = false;
    passwordMatch = false;
  }

  if (usernameMatch && passwordMatch) {
    // Successful login
    req.session.user = {
      id: crypto.randomBytes(8).toString("hex"),
      login: username,
      name: username,
    };
    return req.session.save(() => {
      res.redirect("/setup");
    });
  }

  // Failed login
  incrementLoginAttempts(req);
  return res.redirect("/auth/login?error=" + encodeURIComponent("Invalid username or password"));
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

// ---------- SETUP_PASSWORD routes ----------

// --- First-run: Create Password ---
app.get("/setup/create-password", (req, res) => {
  // If password already exists, go to normal login
  if (isPasswordConfigured()) {
    return res.redirect("/setup/password-prompt");
  }

  const error = req.query.error || "";
  const errorBlock = error
    ? `<div class="alert alert-error">${escapeHtml(error)}</div>`
    : "";

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Create Setup Password</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #09090b;
      --surface: #131316;
      --surface-2: #1c1c21;
      --border: #232329;
      --text: #f4f4f5;
      --text-dim: #a1a1aa;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --error: #ef4444;
      --success: #22c55e;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .container {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2.5rem 2rem;
      max-width: 480px;
      width: 100%;
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
      text-align: center;
    }
    .subtitle {
      color: var(--text-dim);
      text-align: center;
      margin-bottom: 2rem;
      font-size: 0.95rem;
      line-height: 1.5;
    }
    .alert {
      padding: 0.875rem;
      border-radius: 8px;
      margin-bottom: 1.5rem;
      font-size: 0.9rem;
    }
    .alert-error {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5;
    }
    .info-box {
      background: rgba(59, 130, 246, 0.08);
      border: 1px solid rgba(59, 130, 246, 0.2);
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 1.5rem;
      font-size: 0.85rem;
      color: var(--text-dim);
      line-height: 1.5;
    }
    .field { margin-bottom: 1.25rem; }
    label {
      display: block;
      margin-bottom: 0.5rem;
      font-weight: 500;
      font-size: 0.9rem;
    }
    input[type="password"] {
      width: 100%;
      padding: 0.875rem;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 1rem;
      font-family: inherit;
      transition: border-color 0.2s;
    }
    input[type="password"]:focus {
      outline: none;
      border-color: var(--primary);
    }
    .hint {
      font-size: 0.8rem;
      color: var(--text-dim);
      margin-top: 0.35rem;
    }
    button {
      width: 100%;
      padding: 0.875rem;
      background: var(--primary);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
      font-family: inherit;
      margin-top: 0.5rem;
    }
    button:hover { background: var(--primary-hover); }
    button:active { transform: scale(0.98); }
  </style>
</head>
<body>
  <div class="container">
    <h1>Create Setup Password</h1>
    <p class="subtitle">Welcome! Create a password to protect the setup panel.<br/>You will use this password each time you access /setup.</p>
    ${errorBlock}
    <div class="info-box">
      This password is saved to the server. You can also set it via the <code>SETUP_PASSWORD</code> environment variable to skip this step.
    </div>
    <form method="POST" action="/setup/save-password">
      <div class="field">
        <label for="password">New Password</label>
        <input
          type="password"
          id="password"
          name="password"
          autocomplete="new-password"
          required
          autofocus
          minlength="8"
        />
        <p class="hint">Minimum 8 characters</p>
      </div>
      <div class="field">
        <label for="confirm">Confirm Password</label>
        <input
          type="password"
          id="confirm"
          name="confirm"
          autocomplete="new-password"
          required
          minlength="8"
        />
      </div>
      <button type="submit">Create Password & Continue</button>
    </form>
  </div>
</body>
</html>`);
});

app.post("/setup/save-password", express.urlencoded({ extended: false }), (req, res) => {
  // Prevent overwriting an existing password via this route
  if (isPasswordConfigured()) {
    return res.redirect("/setup/password-prompt");
  }

  const password = req.body.password || "";
  const confirm = req.body.confirm || "";

  if (password.length < 8) {
    return res.redirect("/setup/create-password?error=" + encodeURIComponent("Password must be at least 8 characters"));
  }
  if (password !== confirm) {
    return res.redirect("/setup/create-password?error=" + encodeURIComponent("Passwords do not match"));
  }

  try {
    savePassword(password);
  } catch {
    return res.redirect("/setup/create-password?error=" + encodeURIComponent("Failed to save password. Check server logs."));
  }

  // Automatically mark session as verified so user doesn't have to re-enter
  req.session.setupPasswordVerified = true;
  req.session.save(() => {
    res.redirect("/setup");
  });
});

// --- Normal password login ---
app.get("/setup/password-prompt", (req, res) => {
  const error = req.query.error || "";
  const errorBlock = error
    ? `<div class="alert alert-error">${escapeHtml(error)}</div>`
    : "";

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Setup Password Required</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #09090b;
      --surface: #131316;
      --surface-2: #1c1c21;
      --border: #232329;
      --text: #f4f4f5;
      --text-dim: #a1a1aa;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --error: #ef4444;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .container {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2.5rem 2rem;
      max-width: 420px;
      width: 100%;
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
      text-align: center;
    }
    .subtitle {
      color: var(--text-dim);
      text-align: center;
      margin-bottom: 2rem;
      font-size: 0.95rem;
    }
    .alert {
      padding: 0.875rem;
      border-radius: 8px;
      margin-bottom: 1.5rem;
      font-size: 0.9rem;
    }
    .alert-error {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5;
    }
    label {
      display: block;
      margin-bottom: 0.5rem;
      font-weight: 500;
      font-size: 0.9rem;
    }
    input[type="password"] {
      width: 100%;
      padding: 0.875rem;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 1rem;
      font-family: inherit;
      margin-bottom: 1.5rem;
      transition: border-color 0.2s;
    }
    input[type="password"]:focus {
      outline: none;
      border-color: var(--primary);
    }
    button {
      width: 100%;
      padding: 0.875rem;
      background: var(--primary);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
      font-family: inherit;
    }
    button:hover {
      background: var(--primary-hover);
    }
    button:active {
      transform: scale(0.98);
    }
    .link {
      color: var(--primary);
      text-decoration: none;
      font-size: 0.875rem;
    }
    .link:hover {
      text-decoration: underline;
    }
    .link-container {
      text-align: center;
      margin-top: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔐 Setup Password</h1>
    <p class="subtitle">Enter the password to access the setup panel</p>
    ${errorBlock}
    <form method="POST" action="/setup/verify-password">
      <label for="password">Password</label>
      <input 
        type="password" 
        id="password" 
        name="password" 
        autocomplete="current-password"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        required 
        autofocus 
      />
      <button type="submit">Continue</button>
    </form>
    <div class="link-container">
      <a href="/setup/forgot-password" class="link">Forgot password?</a>
    </div>
  </div>
</body>
</html>`);
});

// Simple rate limiter for password verification (prevent brute force)
const passwordAttempts = new Map();
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW = 15 * 60 * 1000; // 15 minutes

function rateLimitPassword(req, res, next) {
  const clientId = req.ip || req.connection.remoteAddress || "unknown";
  const now = Date.now();
  
  if (!passwordAttempts.has(clientId)) {
    passwordAttempts.set(clientId, []);
  }
  
  const attempts = passwordAttempts.get(clientId);
  // Remove old attempts outside the window
  const recentAttempts = attempts.filter(time => now - time < ATTEMPT_WINDOW);
  passwordAttempts.set(clientId, recentAttempts);
  
  if (recentAttempts.length >= MAX_ATTEMPTS) {
    return res.redirect("/setup/password-prompt?error=" + encodeURIComponent("Too many attempts. Please try again later."));
  }
  
  // Record this attempt
  recentAttempts.push(now);
  next();
}

app.post("/setup/verify-password", rateLimitPassword, express.urlencoded({ extended: false }), (req, res) => {
  const submittedPassword = req.body.password || "";
  
  // Use timing-safe comparison to prevent timing attacks
  const passwordBuffer = Buffer.from(submittedPassword);
  const expectedBuffer = Buffer.from(SETUP_PASSWORD);
  
  // Ensure buffers are the same length before comparison
  if (passwordBuffer.length !== expectedBuffer.length) {
    return res.redirect("/setup/password-prompt?error=" + encodeURIComponent("Incorrect password"));
  }
  
  try {
    if (crypto.timingSafeEqual(passwordBuffer, expectedBuffer)) {
      req.session.setupPasswordVerified = true;
      req.session.save(() => {
        res.redirect("/setup");
      });
    } else {
      res.redirect("/setup/password-prompt?error=" + encodeURIComponent("Incorrect password"));
    }
  } catch (err) {
    console.error("[setup] Password verification error:", err);
    res.redirect("/setup/password-prompt?error=" + encodeURIComponent("Incorrect password"));
  }
});

// --- Password reset endpoints ---
app.get("/setup/forgot-password", (req, res) => {
  const message = req.query.message || "";
  const error = req.query.error || "";
  const messageBlock = message
    ? `<div class="alert alert-success">${escapeHtml(message)}</div>`
    : "";
  const errorBlock = error
    ? `<div class="alert alert-error">${escapeHtml(error)}</div>`
    : "";

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Forgot Password</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #09090b;
      --surface: #131316;
      --border: #232329;
      --text: #f4f4f5;
      --primary: #3b82f6;
      --error: #ef4444;
      --success: #22c55e;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .container {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2.5rem 2rem;
      max-width: 420px;
      width: 100%;
    }
    h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.5rem; text-align: center; }
    .subtitle { color: #a1a1aa; font-size: 0.95rem; text-align: center; margin-bottom: 1.5rem; line-height: 1.5; }
    form { display: flex; flex-direction: column; gap: 1rem; }
    label { font-size: 0.875rem; font-weight: 500; display: block; margin-bottom: 0.375rem; }
    input { background: #1c1c21; border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem; color: var(--text); font-size: 1rem; }
    input:focus { outline: none; border-color: var(--primary); }
    button { background: var(--primary); border: none; border-radius: 8px; padding: 0.75rem; color: white; font-weight: 600; cursor: pointer; font-size: 1rem; }
    button:hover { background: #2563eb; }
    button:active { transform: scale(0.98); }
    .alert { padding: 1rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.875rem; }
    .alert-error { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); color: #fca5a5; }
    .alert-success { background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3); color: #86efac; }
    .link { color: var(--primary); text-decoration: none; }
    .link:hover { text-decoration: underline; }
    .back-link { text-align: center; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Forgot Password</h1>
    <p class="subtitle">Enter your email address to receive a password reset link.</p>
    ${messageBlock}
    ${errorBlock}
    <form method="POST" action="/setup/request-reset">
      <label for="email">Email Address</label>
      <input type="email" id="email" name="email" placeholder="your@email.com" required>
      <button type="submit">Send Reset Link</button>
    </form>
    <div class="back-link">
      <a href="/setup/password-prompt" class="link">Back to Login</a>
    </div>
  </div>
</body>
</html>`);
});

app.post("/setup/request-reset", express.urlencoded({ extended: false }), (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();

  if (!email) {
    return res.redirect("/setup/forgot-password?error=" + encodeURIComponent("Email is required"));
  }

  // Generate a reset token
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 3600000; // 1 hour

  // Store the token
  resetTokens[token] = { email, expiresAt };
  saveResetTokens(resetTokens);

  // Generate reset URL
  const resetUrl = `${getBaseUrl(req)}/setup/reset-password?token=${encodeURIComponent(token)}`;
  const resetMessage = `Password reset link: ${resetUrl}`;

  // Send via webhook if configured
  if (emailConfig.webhookUrl) {
    fetch(emailConfig.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: email,
        subject: "Password Reset Request - OpenClaw Setup",
        html: `<h2>Password Reset Request</h2><p>Click to reset: <a href="${escapeHtml(resetUrl)}">Reset Password</a></p><p>This link expires in 1 hour.</p>`,
        resetUrl,
        expiresAt,
      }),
    }).catch((err) => {
      console.error("[reset] Webhook send error:", err.message);
    });

    return res.redirect("/setup/forgot-password?message=" + encodeURIComponent("Reset link sent. Check your email."));
  }

  // Console mode: log the reset link
  if (emailConfig.consoleMode) {
    console.log(`\n[reset] PASSWORD RESET LINK FOR ${email}:\n${resetUrl}\n`);
    return res.redirect("/setup/forgot-password?message=" + encodeURIComponent("Reset link logged to console. Contact your administrator."));
  }

  // No email service configured
  res.redirect("/setup/forgot-password?error=" + encodeURIComponent("Email service not configured. Contact your administrator."));
});

app.get("/setup/reset-password", (req, res) => {
  const token = (req.query.token || "").trim();
  const error = req.query.error || "";

  if (!token) {
    return res.redirect("/setup/forgot-password?error=" + encodeURIComponent("Invalid or missing reset token"));
  }

  const resetData = resetTokens[token];
  if (!resetData || resetData.expiresAt < Date.now()) {
    // Clean up expired token
    if (resetData) delete resetTokens[token];
    saveResetTokens(resetTokens);
    return res.redirect("/setup/forgot-password?error=" + encodeURIComponent("Reset link has expired. Please request a new one."));
  }

  const errorBlock = error
    ? `<div class="alert alert-error">${escapeHtml(error)}</div>`
    : "";

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Reset Password</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #09090b;
      --surface: #131316;
      --border: #232329;
      --text: #f4f4f5;
      --primary: #3b82f6;
      --error: #ef4444;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .container {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2.5rem 2rem;
      max-width: 420px;
      width: 100%;
    }
    h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.5rem; text-align: center; }
    .subtitle { color: #a1a1aa; font-size: 0.95rem; text-align: center; margin-bottom: 1.5rem; line-height: 1.5; }
    form { display: flex; flex-direction: column; gap: 1rem; }
    label { font-size: 0.875rem; font-weight: 500; display: block; margin-bottom: 0.375rem; }
    input { background: #1c1c21; border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem; color: var(--text); font-size: 1rem; font-family: monospace; }
    input:focus { outline: none; border-color: var(--primary); }
    button { background: var(--primary); border: none; border-radius: 8px; padding: 0.75rem; color: white; font-weight: 600; cursor: pointer; font-size: 1rem; }
    button:hover { background: #2563eb; }
    button:active { transform: scale(0.98); }
    .alert { padding: 1rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.875rem; }
    .alert-error { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); color: #fca5a5; }
    .link { color: var(--primary); text-decoration: none; }
    .link:hover { text-decoration: underline; }
    .back-link { text-align: center; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Reset Password</h1>
    <p class="subtitle">Enter a new password for your OpenClaw setup.</p>
    ${errorBlock}
    <form method="POST" action="/setup/confirm-reset">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <label for="password">New Password</label>
      <input type="password" id="password" name="password" placeholder="At least 8 characters" required>
      <label for="confirm">Confirm Password</label>
      <input type="password" id="confirm" name="confirm" placeholder="Repeat password" required>
      <button type="submit">Reset Password</button>
    </form>
    <div class="back-link">
      <a href="/setup/password-prompt" class="link">Back to Login</a>
    </div>
  </div>
</body>
</html>`);
});

app.post("/setup/confirm-reset", express.urlencoded({ extended: false }), (req, res) => {
  const token = (req.body.token || "").trim();
  const password = req.body.password || "";
  const confirm = req.body.confirm || "";

  const resetData = resetTokens[token];
  if (!resetData || resetData.expiresAt < Date.now()) {
    return res.redirect("/setup/forgot-password?error=" + encodeURIComponent("Reset link has expired"));
  }

  if (password.length < 8) {
    return res.redirect("/setup/reset-password?token=" + encodeURIComponent(token) + "&error=" + encodeURIComponent("Password must be at least 8 characters"));
  }

  if (password !== confirm) {
    return res.redirect("/setup/reset-password?token=" + encodeURIComponent(token) + "&error=" + encodeURIComponent("Passwords do not match"));
  }

  try {
    savePassword(password);
    // Clean up the token after use
    delete resetTokens[token];
    saveResetTokens(resetTokens);

    res.redirect("/setup/password-prompt?message=" + encodeURIComponent("Password reset successfully. Please log in with your new password."));
  } catch (err) {
    console.error("[reset] Error saving password:", err);
    res.redirect("/setup/reset-password?token=" + encodeURIComponent(token) + "&error=" + encodeURIComponent("Failed to reset password. Please try again."));
  }
});

// Minimal health endpoint for Railway - must be public
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

// Apply SETUP_PASSWORD auth to /setup routes (before username/password auth)
app.use("/setup", requireSetupPassword);

// Apply username/password auth to all routes below
app.use(requireAuth);

app.get("/setup/app.js", (_req, res) => {
  // Serve JS for /setup (kept external to avoid inline encoding/template issues)
  res.type("application/javascript");
  res.send(fs.readFileSync(path.join(process.cwd(), "src", "setup-app.js"), "utf8"));
});

app.get("/setup", (req, res) => {
  const user = req.session?.user;
  const avatarHtml = user
    ? user.avatar 
      ? `<img src="${escapeHtml(user.avatar)}" alt="" class="avatar" /><span class="user-name">${escapeHtml(user.name || user.login)}</span>`
      : `<div class="avatar-placeholder"></div><span class="user-name">${escapeHtml(user.name || user.login)}</span>`
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
      --surface: #131316;
      --surface-2: #1c1c21;
      --surface-3: #27272a;
      --border: #232329;
      --border-hover: #3f3f46;
      --border-focus: #3b82f6;
      --text: #fafafa;
      --text-muted: #a1a1aa;
      --text-dim: #71717a;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --accent-muted: rgba(59,130,246,0.12);
      --success: #22c55e;
      --success-muted: rgba(34,197,94,0.1);
      --warn: #eab308;
      --warn-muted: rgba(234,179,8,0.1);
      --danger: #ef4444;
      --danger-muted: rgba(239,68,68,0.08);
      --radius: 12px;
      --radius-sm: 8px;
      --radius-xs: 6px;
      --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
      --ease: cubic-bezier(0.4, 0, 0.2, 1);
      --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    body { font-family: var(--font); background: var(--bg); color: var(--text); line-height: 1.5; min-height: 100vh; }

    /* ---- Animations ---- */
    @keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes slideDown { from { opacity: 0; max-height: 0; } to { opacity: 1; max-height: 400px; } }
    @keyframes toastIn { from { opacity: 0; transform: translateY(12px) scale(0.95); } to { opacity: 1; transform: translateY(0) scale(1); } }
    @keyframes toastOut { from { opacity: 1; transform: translateY(0) scale(1); } to { opacity: 0; transform: translateY(-8px) scale(0.95); } }
    .animate-in { animation: fadeUp 0.4s var(--ease) both; }
    .animate-in-delay-1 { animation-delay: 0.05s; }
    .animate-in-delay-2 { animation-delay: 0.1s; }
    .animate-in-delay-3 { animation-delay: 0.15s; }

    /* ---- Toast system ---- */
    #toastContainer {
      position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 9999;
      display: flex; flex-direction: column-reverse; gap: 0.5rem;
      pointer-events: none;
    }
    .toast {
      pointer-events: auto;
      padding: 0.625rem 1rem; border-radius: var(--radius-sm);
      font-size: 0.8125rem; font-weight: 500;
      backdrop-filter: blur(12px); border: 1px solid var(--border);
      animation: toastIn 0.3s var(--ease-spring) both;
      display: flex; align-items: center; gap: 0.5rem;
      max-width: 360px; line-height: 1.4;
    }
    .toast.removing { animation: toastOut 0.25s var(--ease) both; }
    .toast-success { background: rgba(34,197,94,0.12); color: #86efac; border-color: rgba(34,197,94,0.2); }
    .toast-error { background: rgba(239,68,68,0.12); color: #fca5a5; border-color: rgba(239,68,68,0.2); }
    .toast-info { background: rgba(59,130,246,0.12); color: #93c5fd; border-color: rgba(59,130,246,0.2); }
    .toast-icon { flex-shrink: 0; width: 16px; height: 16px; }

    /* ---- Top nav ---- */
    .topbar {
      position: sticky; top: 0; z-index: 50;
      background: rgba(9,9,11,0.8); backdrop-filter: blur(16px) saturate(1.2);
      border-bottom: 1px solid var(--border);
      padding: 0 1.5rem; height: 52px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .topbar-left { display: flex; align-items: center; gap: 0.5rem; }
    .topbar-brand {
      display: flex; align-items: center; gap: 0.5rem;
      font-weight: 600; font-size: 0.875rem; letter-spacing: -0.02em;
      color: var(--text); text-decoration: none;
    }
    .topbar-brand svg { width: 20px; height: 20px; color: var(--accent); }
    .topbar-sep { width: 1px; height: 16px; background: var(--border); margin: 0 0.25rem; }
    .topbar-page { font-size: 0.8125rem; color: var(--text-dim); font-weight: 400; }
    .avatar { width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--border); }
    .avatar-placeholder { 
      width: 22px; height: 22px; border-radius: 50%; 
      background: var(--surface-2); border: 1px solid var(--border);
      display: inline-block;
    }
    .user-name { font-size: 0.75rem; color: var(--text-dim); }
    .topbar-right { display: flex; align-items: center; gap: 0.75rem; }
    .nav-link { font-size: 0.75rem; color: var(--text-dim); text-decoration: none; transition: color 0.15s; }
    .nav-link:hover { color: var(--text-muted); }
    .open-ui-btn {
      display: inline-flex; align-items: center; gap: 0.375rem;
      font-size: 0.75rem; font-weight: 500; color: var(--accent);
      text-decoration: none; padding: 0.3125rem 0.625rem;
      border: 1px solid rgba(59,130,246,0.2); border-radius: var(--radius-xs);
      transition: all 0.15s var(--ease); background: transparent;
    }
    .open-ui-btn:hover { background: var(--accent-muted); border-color: rgba(59,130,246,0.35); }
    .open-ui-btn svg { width: 12px; height: 12px; }

    /* ---- Layout ---- */
    .shell { max-width: 620px; margin: 0 auto; padding: 1.75rem 1.5rem 4rem; }

    /* ---- Status banner ---- */
    .status-banner {
      display: flex; align-items: center; gap: 0.625rem;
      padding: 0.75rem 1rem; border-radius: var(--radius);
      border: 1px solid var(--border); background: var(--surface);
      margin-bottom: 1.75rem; animation: fadeUp 0.35s var(--ease) both;
    }
    .status-dot {
      width: 7px; height: 7px; border-radius: 50%; background: #52525b; flex-shrink: 0;
      transition: background 0.3s, box-shadow 0.3s;
    }
    .status-dot.ok { background: var(--success); box-shadow: 0 0 0 3px var(--success-muted), 0 0 12px rgba(34,197,94,0.25); }
    .status-dot.err { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-muted), 0 0 12px rgba(239,68,68,0.2); }
    .status-dot.loading { animation: pulse 1.5s ease-in-out infinite; }
    .status-text { flex: 1; font-size: 0.8125rem; color: var(--text-muted); }
    .status-version { font-size: 0.6875rem; color: var(--text-dim); font-family: var(--font-mono); }

    /* ---- Tabs ---- */
    .tabs {
      display: flex; gap: 0.125rem; padding: 3px;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius); margin-bottom: 1.75rem;
      animation: fadeUp 0.4s var(--ease) 0.05s both;
    }
    .tab {
      flex: 1; padding: 0.5rem 0.75rem; font-size: 0.8125rem; font-weight: 500;
      color: var(--text-dim); cursor: pointer; border: 0; background: 0;
      border-radius: calc(var(--radius) - 3px);
      transition: all 0.2s var(--ease); white-space: nowrap; font-family: var(--font);
      position: relative;
    }
    .tab:hover { color: var(--text-muted); }
    .tab.active {
      color: var(--text); background: var(--surface-2);
      box-shadow: 0 1px 3px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.03);
    }
    .tab .kbd {
      display: inline-block; font-size: 0.625rem; font-family: var(--font-mono);
      color: var(--text-dim); margin-left: 0.375rem;
      padding: 0.0625rem 0.3125rem; border-radius: 3px;
      border: 1px solid var(--border); background: var(--bg);
      vertical-align: 1px; line-height: 1.2;
    }

    .tab-panel { display: none; }
    .tab-panel.active { display: block; animation: fadeUp 0.3s var(--ease) both; }

    /* ---- Cards ---- */
    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 1.25rem; margin-bottom: 0.875rem;
      transition: border-color 0.2s var(--ease);
    }
    .card:hover { border-color: var(--border-hover); }
    .card-header { margin-bottom: 1rem; }
    .card-title {
      font-size: 0.875rem; font-weight: 600; letter-spacing: -0.01em;
      display: flex; align-items: center; gap: 0.5rem;
    }
    .card-title-icon { width: 16px; height: 16px; color: var(--text-dim); flex-shrink: 0; }
    .card-desc { font-size: 0.8125rem; color: var(--text-dim); margin-top: 0.25rem; line-height: 1.5; }

    /* ---- Forms ---- */
    .field { margin-bottom: 1rem; }
    .field:last-child { margin-bottom: 0; }
    .field-label {
      display: flex; align-items: center; gap: 0.375rem;
      font-size: 0.8125rem; font-weight: 500; color: var(--text-muted); margin-bottom: 0.375rem;
    }
    .field-required { color: var(--danger); font-size: 0.75rem; }
    .field-hint { font-size: 0.75rem; color: var(--text-dim); margin-top: 0.3125rem; line-height: 1.5; }
    input, select, textarea {
      width: 100%; padding: 0.5rem 0.75rem;
      border: 1px solid var(--border); border-radius: var(--radius-sm);
      font-size: 0.8125rem; background: var(--bg); color: var(--text);
      outline: none; transition: border-color 0.15s, box-shadow 0.15s;
      font-family: var(--font);
    }
    input:hover, select:hover, textarea:hover { border-color: var(--border-hover); }
    input:focus, select:focus, textarea:focus {
      border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--accent-muted);
    }
    input[type="password"] { font-family: var(--font-mono); letter-spacing: 0.04em; font-size: 0.8125rem; }
    select {
      cursor: pointer;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 0.75rem center;
      padding-right: 2rem; appearance: none;
    }

    /* ---- Buttons ---- */
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 0.375rem;
      padding: 0.4375rem 0.875rem; border-radius: var(--radius-sm); border: 1px solid transparent;
      font-size: 0.8125rem; font-weight: 600; cursor: pointer;
      transition: all 0.15s var(--ease); font-family: var(--font);
      position: relative; overflow: hidden;
    }
    .btn:active:not(:disabled) { transform: scale(0.97); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: var(--text); color: var(--bg); border-color: var(--text); }
    .btn-primary:hover:not(:disabled) { background: #e4e4e7; }
    .btn-secondary { background: var(--surface-2); color: var(--text-muted); border-color: var(--border); }
    .btn-secondary:hover:not(:disabled) { background: var(--surface-3); color: var(--text); border-color: var(--border-hover); }
    .btn-danger { background: var(--danger-muted); color: #fca5a5; border-color: rgba(127,29,29,0.5); }
    .btn-danger:hover:not(:disabled) { background: rgba(239,68,68,0.15); }
    .btn-ghost { background: transparent; color: var(--text-dim); border-color: transparent; }
    .btn-ghost:hover:not(:disabled) { color: var(--text-muted); background: var(--surface); }
    .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }

    /* Button spinner */
    .btn .spinner {
      width: 14px; height: 14px; border: 2px solid transparent;
      border-top-color: currentColor; border-radius: 50%;
      animation: spin 0.6s linear infinite; display: none;
    }
    .btn.loading .spinner { display: inline-block; }
    .btn.loading .btn-label { opacity: 0.7; }

    /* ---- Channel cards ---- */
    .channel-grid { display: flex; flex-direction: column; gap: 0.5rem; }
    .channel-card {
      border: 1px solid var(--border); border-radius: var(--radius);
      overflow: hidden; transition: all 0.2s var(--ease);
    }
    .channel-card:hover { border-color: var(--border-hover); }
    .channel-header {
      display: flex; align-items: center; gap: 0.625rem;
      padding: 0.6875rem 1rem; background: var(--surface); cursor: pointer;
      border: 0; width: 100%; text-align: left; color: var(--text);
      font-family: var(--font); font-size: 0.8125rem; font-weight: 500;
      transition: background 0.15s;
    }
    .channel-header:hover { background: var(--surface-2); }
    .channel-icon { width: 18px; height: 18px; flex-shrink: 0; color: var(--text-dim); }
    .channel-name { flex: 1; }
    .channel-badge {
      font-size: 0.625rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
      padding: 0.125rem 0.375rem; border-radius: var(--radius-xs);
      background: var(--success-muted); color: var(--success);
      display: none;
    }
    .channel-card.has-token .channel-badge { display: inline-block; }
    .channel-chevron {
      width: 16px; height: 16px; color: var(--text-dim);
      transition: transform 0.25s var(--ease);
    }
    .channel-body {
      max-height: 0; overflow: hidden; background: var(--surface);
      transition: max-height 0.3s var(--ease), padding 0.3s var(--ease);
      padding: 0 1rem;
    }
    .channel-card.open .channel-body { max-height: 300px; padding: 0.75rem 1rem 1rem; }
    .channel-card.open .channel-chevron { transform: rotate(180deg); }

    /* ---- Console ---- */
    .console-bar { display: flex; gap: 0.5rem; align-items: center; }
    .console-bar select { flex: 2; }
    .console-bar input { flex: 1; }

    /* ---- Output log ---- */
    pre {
      white-space: pre-wrap; word-break: break-word;
      background: var(--bg); border: 1px solid var(--border);
      border-radius: var(--radius-sm); padding: 0.75rem;
      font-family: var(--font-mono); font-size: 0.6875rem;
      margin-top: 0.75rem; max-height: 260px; overflow-y: auto;
      display: none; color: var(--text-dim); line-height: 1.7;
      scrollbar-width: thin; scrollbar-color: var(--surface-3) transparent;
    }
    pre.visible { display: block; animation: fadeIn 0.2s var(--ease); }

    code {
      background: var(--surface-2); padding: 0.125rem 0.3125rem;
      border-radius: 4px; font-size: 0.8em; color: #d4d4d8;
      font-family: var(--font-mono);
    }

    .separator { border: 0; border-top: 1px solid var(--border); margin: 1rem 0; }


    /* ---- Setup stages ---- */
    .stage-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 1rem; margin-bottom: 0.875rem;
    }
    .stage-title { font-size: 0.75rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 0.625rem; }
    .stage-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem; }
    .stage-item {
      display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.625rem;
      border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg);
      font-size: 0.75rem; color: var(--text-dim);
    }
    .stage-dot { width: 8px; height: 8px; border-radius: 50%; background: #52525b; flex-shrink: 0; }
    .stage-item.current { border-color: var(--border-focus); color: var(--text); }
    .stage-item.current .stage-dot { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-muted); }
    .stage-item.done .stage-dot { background: var(--success); box-shadow: 0 0 0 3px var(--success-muted); }
    .stage-item.error .stage-dot { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-muted); }
    .preflight-box {
      display: none; margin-bottom: 0.875rem; padding: 0.75rem 0.875rem;
      border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2);
      font-size: 0.75rem;
    }
    .preflight-box.visible { display: block; }
    .preflight-box h4 { margin: 0 0 0.5rem; font-size: 0.75rem; color: var(--text-muted); }
    .preflight-list { margin: 0; padding-left: 1rem; color: var(--text-dim); }
    .preflight-list li { margin-bottom: 0.375rem; }
    .preflight-list .warn { color: #facc15; }
    .preflight-list .err { color: #f87171; }
    /* ---- Empty state ---- */
    .empty-hint {
      text-align: center; padding: 2rem 1rem; color: var(--text-dim); font-size: 0.8125rem;
    }
    .empty-hint svg { width: 32px; height: 32px; margin: 0 auto 0.75rem; color: var(--surface-3); }

    /* ---- Kbd (keyboard shortcut) ---- */
    kbd {
      display: inline-block; font-size: 0.625rem; font-family: var(--font-mono);
      color: var(--text-dim); padding: 0.0625rem 0.3125rem; border-radius: 3px;
      border: 1px solid var(--border); background: var(--bg);
      line-height: 1.4; vertical-align: 1px;
    }

    /* ---- Responsive ---- */
    @media (max-width: 480px) {
      .shell { padding: 1.25rem 1rem 3rem; }
      .topbar { padding: 0 1rem; height: 48px; }
      .tab .kbd { display: none; }
      .topbar-page { display: none; }
      .topbar-sep { display: none; }
      #toastContainer { left: 1rem; right: 1rem; bottom: 1rem; }
      .toast { max-width: 100%; }
    }
  </style>
</head>
<body>

  <!-- Toast container -->
  <div id="toastContainer" aria-live="polite"></div>

  <nav class="topbar" role="navigation">
    <div class="topbar-left">
      <a href="/setup" class="topbar-brand" aria-label="OpenClaw Home">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        OpenClaw
      </a>
      <div class="topbar-sep"></div>
      <span class="topbar-page">Setup</span>
    </div>
    <div class="topbar-right">
      ${avatarHtml}
      <a href="/openclaw" target="_blank" class="open-ui-btn" id="openUiLink" aria-label="Open OpenClaw UI">
        Open UI
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </a>
      ${signOutHtml}
    </div>
  </nav>

  <main class="shell">

    <!-- Status -->
    <div class="status-banner">
      <span class="status-dot loading" id="statusDot"></span>
      <span class="status-text" id="status">Connecting...</span>
      <span class="status-version" id="statusVersion"></span>
    </div>

    <!-- Tabs (pill style with keyboard shortcuts) -->
    <div class="tabs" role="tablist" aria-label="Setup sections">
      <button class="tab active" role="tab" data-tab="setup" aria-selected="true" tabindex="0">
        Setup <span class="kbd">1</span>
      </button>
      <button class="tab" role="tab" data-tab="channels" aria-selected="false" tabindex="-1">
        Channels <span class="kbd">2</span>
      </button>
      <button class="tab" role="tab" data-tab="tools" aria-selected="false" tabindex="-1">
        Tools <span class="kbd">3</span>
      </button>
    </div>

    <!-- ========== TAB: Setup ========== -->
    <div class="tab-panel active" id="panel-setup" role="tabpanel">

      <div class="card animate-in">
        <div class="card-header">
          <div class="card-title">
            <svg class="card-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>
            AI Provider
          </div>
          <div class="card-desc">Choose your provider and paste credentials.</div>
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
          <label class="field-label" for="authSecret">API Key <span class="field-required">*</span></label>
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

      <div class="stage-card animate-in animate-in-delay-1">
        <div class="stage-title">Setup progress</div>
        <div class="stage-grid" id="stageGrid">
          <div class="stage-item current" id="stage-validate"><span class="stage-dot"></span><span>Validate</span></div>
          <div class="stage-item" id="stage-configure"><span class="stage-dot"></span><span>Configure</span></div>
          <div class="stage-item" id="stage-deploy"><span class="stage-dot"></span><span>Deploy</span></div>
          <div class="stage-item" id="stage-verify"><span class="stage-dot"></span><span>Verify</span></div>
        </div>
      </div>

      <div class="preflight-box" id="preflightBox">
        <h4>Preflight checks</h4>
        <ul class="preflight-list" id="preflightList"></ul>
      </div>

      <div class="actions animate-in animate-in-delay-1" style="margin-bottom:0.875rem;">
        <button class="btn btn-primary" id="run">
          <span class="spinner"></span>
          <span class="btn-label">Deploy Configuration</span>
        </button>
        <button class="btn btn-secondary" id="preflightRun">Run Preflight</button>
        <button class="btn btn-ghost" id="reset">Reset</button>
      </div>

      <pre id="log"></pre>
    </div>

    <!-- ========== TAB: Channels ========== -->
    <div class="tab-panel" id="panel-channels" role="tabpanel">

      <div class="card">
        <div class="card-header">
          <div class="card-title">
            <svg class="card-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
            Chat Platforms
          </div>
          <div class="card-desc">Connect messaging platforms. All optional -- configure now or later from the UI.</div>
        </div>

        <div class="channel-grid">

          <!-- Telegram -->
          <div class="channel-card" id="channelTelegram">
            <button class="channel-header" aria-expanded="false" aria-controls="telegramBody">
              <svg class="channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0h-.056zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
              <span class="channel-name">Telegram</span>
              <span class="channel-badge">Connected</span>
              <svg class="channel-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <div class="channel-body" id="telegramBody">
              <div class="field">
                <label class="field-label" for="telegramToken">Bot token</label>
                <input id="telegramToken" type="password" placeholder="123456:ABC..." autocomplete="off" />
                <div class="field-hint">Get this from <code>@BotFather</code> on Telegram.</div>
              </div>
            </div>
          </div>

          <!-- Discord -->
          <div class="channel-card" id="channelDiscord">
            <button class="channel-header" aria-expanded="false" aria-controls="discordBody">
              <svg class="channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
              <span class="channel-name">Discord</span>
              <span class="channel-badge">Connected</span>
              <svg class="channel-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <div class="channel-body" id="discordBody">
              <div class="field">
                <label class="field-label" for="discordToken">Bot token</label>
                <input id="discordToken" type="password" placeholder="Bot token" autocomplete="off" />
                <div class="field-hint">From Discord Developer Portal. Enable MESSAGE CONTENT INTENT.</div>
              </div>
            </div>
          </div>

          <!-- Slack -->
          <div class="channel-card" id="channelSlack">
            <button class="channel-header" aria-expanded="false" aria-controls="slackBody">
              <svg class="channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M5.042 15.165a2.528 2.528 0 01-2.52 2.523A2.528 2.528 0 010 15.165a2.527 2.527 0 012.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 012.521-2.52 2.527 2.527 0 012.521 2.52v6.313A2.528 2.528 0 018.834 24a2.528 2.528 0 01-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 01-2.521-2.52A2.528 2.528 0 018.834 0a2.528 2.528 0 012.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 012.521 2.521 2.528 2.528 0 01-2.521 2.521H2.522A2.528 2.528 0 010 8.834a2.528 2.528 0 012.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 012.522-2.521A2.528 2.528 0 0124 8.834a2.528 2.528 0 01-2.522 2.521h-2.522V8.834zm-1.27 0a2.528 2.528 0 01-2.523 2.521 2.527 2.527 0 01-2.52-2.521V2.522A2.527 2.527 0 0115.163 0a2.528 2.528 0 012.523 2.522v6.312zM15.163 18.956a2.528 2.528 0 012.523 2.522A2.528 2.528 0 0115.163 24a2.527 2.527 0 01-2.52-2.522v-2.522h2.52zm0-1.27a2.527 2.527 0 01-2.52-2.523 2.526 2.526 0 012.52-2.52h6.315A2.528 2.528 0 0124 15.163a2.528 2.528 0 01-2.522 2.523h-6.315z"/></svg>
              <span class="channel-name">Slack</span>
              <span class="channel-badge">Connected</span>
              <svg class="channel-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <div class="channel-body" id="slackBody">
              <div class="field">
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
    <div class="tab-panel" id="panel-tools" role="tabpanel">

      <!-- Debug Console -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">
            <svg class="card-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
            Console
          </div>
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
          <button class="btn btn-secondary" id="consoleRun">
            <span class="spinner"></span>
            <span class="btn-label">Run</span>
          </button>
        </div>
        <pre id="consoleOut"></pre>
      </div>

      <!-- Config Editor -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">
            <svg class="card-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>
            Configuration
          </div>
          <div class="card-desc" id="configPath">Edit the raw config file.</div>
        </div>
        <textarea id="configText" style="height:180px;font-family:var(--font-mono);font-size:0.6875rem;resize:vertical;line-height:1.6;tab-size:2;"></textarea>
        <div class="actions" style="margin-top:0.75rem;">
          <button class="btn btn-secondary" id="configReload">Reload</button>
          <button class="btn btn-primary" id="configSave">
            <span class="spinner"></span>
            <span class="btn-label">Save & Restart</span>
          </button>
        </div>
        <pre id="configOut"></pre>
      </div>

      <!-- Backup -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">
            <svg class="card-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Backup & Restore
          </div>
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
          <button class="btn btn-danger" id="importRun">
            <span class="spinner"></span>
            <span class="btn-label">Import & Overwrite</span>
          </button>
        </div>
        <pre id="importOut"></pre>
      </div>

      <!-- Pairing -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">
            <svg class="card-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 3v4"/><path d="M8 3v4"/></svg>
            Device Pairing
          </div>
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
  try {
    const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));

    res.json({
      configured: isConfigured(),
      openclawVersion: version.output.trim(),
    });
  } catch (err) {
    console.error("[/setup/api/status] error:", err);
    res.status(500).json({ 
      ok: false, 
      error: "Failed to get status",
      configured: isConfigured() 
    });
  }
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

function getProviderKeyHint(authChoice = "") {
  if (authChoice === "openai-api-key") return "OpenAI keys usually start with sk-.";
  if (authChoice === "openrouter-api-key") return "OpenRouter keys usually start with sk-or-v1-.";
  if (authChoice === "apiKey") return "Anthropic keys usually start with sk-ant-.";
  if (authChoice === "gemini-api-key") return "Gemini keys are long API key strings from Google AI Studio.";
  return "Verify the provider key and try again.";
}


function sendSetupError(res, status, code, message, action, details) {
  return res.status(status).json({
    ok: false,
    error: {
      code,
      message,
      action,
      details: details || null,
    },
  });
}

function classifyOnboardFailure(output = "") {
  const text = String(output || "").toLowerCase();

  if (text.includes("invalid") && text.includes("api key")) {
    return {
      code: "PROVIDER_AUTH_FAILED",
      message: "Provider authentication failed during onboarding.",
      action: "Verify provider selection and API key, then run Preflight again.",
    };
  }

  if (text.includes("permission denied") || text.includes("eacces") || text.includes("readonly")) {
    return {
      code: "STORAGE_PERMISSION_ERROR",
      message: "OpenClaw could not write required files.",
      action: "Check OPENCLAW_STATE_DIR/OPENCLAW_WORKSPACE_DIR and volume mount permissions.",
    };
  }

  if (text.includes("timeout") || text.includes("timed out")) {
    return {
      code: "ONBOARD_TIMEOUT",
      message: "Onboarding timed out before completion.",
      action: "Retry once; if it repeats, check network/provider connectivity and logs.",
    };
  }

  return {
    code: "ONBOARD_FAILED",
    message: "OpenClaw onboarding did not complete successfully.",
    action: "Review setup output log, fix highlighted issues, and retry deployment.",
  };
}

app.post("/setup/api/preflight", async (req, res) => {
  const payload = req.body || {};
  const checks = [];
  const errors = [];
  const warnings = [];

  const addCheck = (name, ok, message, action, severity = "error") => {
    checks.push({ name, ok, message, action, severity });
    if (ok) return;
    if (severity === "warning") warnings.push({ name, message, action });
    else errors.push({ name, message, action });
  };

  const authChoice = (payload.authChoice || "").trim();
  const authSecret = (payload.authSecret || "").trim();
  const model = (payload.model || "").trim();

  const needsSecret = authChoice !== "claude-cli" && authChoice !== "codex-cli";
  addCheck(
    "providerKey",
    !needsSecret || Boolean(authSecret),
    "Provider credential is required for this auth mode.",
    "Paste a valid API key in the Auth Secret field before deploying.",
  );

  const providerPatterns = {
    "openai-api-key": /^sk-/,
    "openrouter-api-key": /^sk-or-v1-/,
    apiKey: /^sk-ant-/,
  };
  if (needsSecret && providerPatterns[authChoice]) {
    addCheck(
      "providerKeyFormat",
      providerPatterns[authChoice].test(authSecret),
      "Provider key format looks invalid.",
      getProviderKeyHint(authChoice),
      "warning",
    );
  }

  const providerNeedsModel = new Set([
    "openrouter-api-key",
    "openai-api-key",
    "gemini-api-key",
    "ai-gateway-api-key",
    "apiKey",
  ]);
  if (providerNeedsModel.has(authChoice)) {
    addCheck(
      "model",
      Boolean(model),
      "Model is recommended for this provider.",
      "Set a model value (for example gpt-4o or anthropic/claude-sonnet-4).",
      "warning",
    );
  }

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    addCheck("stateDir", true, `State directory ready: ${STATE_DIR}`, "");
  } catch (err) {
    addCheck(
      "stateDir",
      false,
      `Cannot create state directory: ${STATE_DIR}`,
      "Ensure OPENCLAW_STATE_DIR points to a writable volume path.",
    );
  }

  try {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    addCheck("workspaceDir", true, `Workspace directory ready: ${WORKSPACE_DIR}`, "");
  } catch (err) {
    addCheck(
      "workspaceDir",
      false,
      `Cannot create workspace directory: ${WORKSPACE_DIR}`,
      "Ensure OPENCLAW_WORKSPACE_DIR points to a writable volume path.",
    );
  }

  if (STATE_DIR.startsWith("/data") || WORKSPACE_DIR.startsWith("/data")) {
    addCheck(
      "dataMount",
      fs.existsSync("/data"),
      "Expected Railway volume mount at /data was not found.",
      "Attach a Railway Volume mounted at /data and redeploy.",
    );
  } else {
    addCheck(
      "dataMount",
      false,
      "State/workspace are not under /data; persistence may be lost on redeploy.",
      "Set OPENCLAW_STATE_DIR=/data/.openclaw and OPENCLAW_WORKSPACE_DIR=/data/workspace.",
      "warning",
    );
  }

  return res.json({ ok: errors.length === 0, errors, warnings, checks });
});

app.post("/setup/api/run", async (req, res) => {
  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return res.json({ ok: true, output: "Already configured.\nUse Reset setup if you want to rerun onboarding.\n" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};

    const preflightBlockingErrors = [];
    if ((payload.authChoice || "") !== "claude-cli" && (payload.authChoice || "") !== "codex-cli" && !(payload.authSecret || "").trim()) {
      preflightBlockingErrors.push("Provider credential is required for this auth mode.");
    }
    if (preflightBlockingErrors.length) {
      return sendSetupError(
        res,
        400,
        "PRECONDITION_FAILED",
        "Cannot start onboarding due to missing required setup input.",
        "Run Preflight, fix blockers, and retry deployment.",
        { blockers: preflightBlockingErrors },
      );
    }

    const onboardArgs = buildOnboardArgs(payload);
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

    let extra = "";
    const ok = onboard.code === 0 && isConfigured();

    if (!ok) {
      const classified = classifyOnboardFailure(onboard.output);
      return sendSetupError(
        res,
        500,
        classified.code,
        classified.message,
        classified.action,
        {
          commandExitCode: onboard.code,
          outputPreview: (onboard.output || "").slice(0, 3000),
        },
      );
    }

    // Optional channel setup (only after successful onboarding, and only if the installed CLI supports it).
    // The internal gateway uses token auth with the wrapper's known token.
    // OpenClaw 2026.2.4+ rejects "none" as a gateway.auth.mode value.
    const cfgOpts = { timeoutMs: 10_000 };
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.authMode", "token"]), cfgOpts);
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]), cfgOpts);
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]), cfgOpts);    const modelVal = (payload.model || "").trim();
    if (modelVal) {
      const setModel = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "model", modelVal]));
      extra += `
[model] set to ${modelVal} (exit=${setModel.code})
`;
    }

    const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
    const helpText = channelsHelp.output || "";
    const supports = (name) => helpText.includes(name);

    if (payload.telegramToken?.trim()) {
      if (!supports("telegram")) {
        extra += "\n[telegram] skipped (this openclaw build does not list telegram in `channels add --help`)\n";
      } else {
        const token = payload.telegramToken.trim();
        const cfgObj = {
          enabled: true,
          dmPolicy: "pairing",
          botToken: token,
          groupPolicy: "allowlist",
          streamMode: "partial",
        };
        const set = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]));
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));
        extra += `
[telegram config] exit=${set.code} (output ${set.output.length} chars)
${set.output || "(no output)"}`;
        extra += `
[telegram verify] exit=${get.code} (output ${get.output.length} chars)
${get.output || "(no output)"}`;
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
          dm: { policy: "pairing" },
        };
        const set = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(cfgObj)]));
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));
        extra += `
[discord config] exit=${set.code} (output ${set.output.length} chars)
${set.output || "(no output)"}`;
        extra += `
[discord verify] exit=${get.code} (output ${get.output.length} chars)
${get.output || "(no output)"}`;
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
        const set = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)]));
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.slack"]));
        extra += `
[slack config] exit=${set.code} (output ${set.output.length} chars)
${set.output || "(no output)"}`;
        extra += `
[slack verify] exit=${get.code} (output ${get.output.length} chars)
${get.output || "(no output)"}`;
      }
    }

    restartGateway().catch((err) => {
      console.error("[/setup/api/run] background gateway start failed:", err);
    });
    extra += "\n[gateway] starting in background...\n";

    return res.status(200).json({
      ok: true,
      output: `${onboard.output}${extra}`,
    });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return sendSetupError(
      res,
      500,
      "SETUP_INTERNAL_ERROR",
      "Unexpected internal error while running setup.",
      "Retry setup once. If it fails again, check server logs and run diagnostics from the Tools tab.",
      { reason: String(err) },
    );
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
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
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
  try {
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
  } catch (err) {
    console.error("[/setup/export] error:", err);
    if (!res.headersSent) {
      res.status(500).type("text/plain").send(`Export failed: ${err.message}`);
    }
  }
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
  proxyTimeout: 30000, // 30 second timeout
});

// Inject the gateway token into every proxied request so the gateway
// accepts it (auth is now "token" mode instead of the invalid "none").
proxy.on("proxyReq", (proxyReq) => {
  if (OPENCLAW_GATEWAY_TOKEN) {
    proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  }
});

proxy.on("error", (err, req, res) => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [proxy] Error proxying ${req.method} ${req.url} to ${GATEWAY_TARGET}:`, err.message);

  // If response is already sent, can't do anything
  if (res.headersSent) {
    return res.end();
  }

  // Determine error type and status code
  let statusCode = 502;
  let title = "Bad Gateway";
  let message = "The gateway is not responding. Please try again.";

  if (err.code === "ECONNREFUSED") {
    statusCode = 503;
    title = "Service Unavailable";
    message = "The gateway service is currently unavailable. It may be starting up.";
  } else if (err.code === "ECONNRESET") {
    statusCode = 502;
    title = "Connection Reset";
    message = "The connection to the gateway was reset. Please try again.";
  } else if (err.code === "ETIMEDOUT") {
    statusCode = 504;
    title = "Gateway Timeout";
    message = "The gateway took too long to respond. Please try again.";
  }

  // Return appropriate response
  if (req.path.startsWith("/setup/api/") || req.headers.accept?.includes("application/json")) {
    return res.status(statusCode).json({
      ok: false,
      error: message,
      code: err.code,
    });
  }

  res.status(statusCode).type("html").send(errorPageHTML(statusCode, title, message, err.code));
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
      const errMsg = escapeHtml(String(err));
      return res.status(503).type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Gateway Starting - OpenClaw</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#09090b;color:#fafafa;min-height:100vh;display:flex;align-items:center;justify-content:center}
.c{max-width:420px;width:100%;padding:1.5rem;text-align:center}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.spinner{width:32px;height:32px;border:3px solid #27272a;border-top-color:#3b82f6;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 1.5rem}
h1{font-size:1rem;font-weight:600;margin-bottom:0.375rem;animation:fadeUp 0.4s ease both}
.desc{color:#71717a;font-size:0.8125rem;margin-bottom:1.5rem;line-height:1.5;animation:fadeUp 0.4s ease 0.05s both}
.err{background:rgba(239,68,68,0.08);border:1px solid rgba(127,29,29,0.4);border-radius:8px;padding:0.625rem 0.875rem;font-size:0.75rem;color:#fca5a5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin-bottom:1.5rem;text-align:left;word-break:break-word;animation:fadeUp 0.4s ease 0.1s both}
.actions{display:flex;gap:0.5rem;justify-content:center;animation:fadeUp 0.4s ease 0.15s both}
.btn{display:inline-flex;align-items:center;gap:0.375rem;padding:0.4375rem 0.875rem;border-radius:8px;font-size:0.8125rem;font-weight:600;cursor:pointer;border:1px solid transparent;text-decoration:none;transition:all 0.15s}
.btn-primary{background:#fafafa;color:#09090b;border-color:#fafafa}
.btn-primary:hover{background:#e4e4e7}
.btn-secondary{background:#1c1c21;color:#a1a1aa;border-color:#27272a}
.btn-secondary:hover{background:#27272a;color:#fafafa}
.auto{color:#52525b;font-size:0.6875rem;margin-top:1.25rem;animation:fadeUp 0.4s ease 0.2s both}
</style>
</head><body>
<div class="c">
<div class="spinner" role="status" aria-label="Loading"></div>
<h1>Gateway is starting up</h1>
<p class="desc">The OpenClaw gateway is taking longer than expected. This can happen on cold starts.</p>
<div class="err">${errMsg}</div>
<div class="actions">
<button class="btn btn-primary" onclick="location.reload()">Retry</button>
<a href="/setup" class="btn btn-secondary">Go to Setup</a>
</div>
<p class="auto">This page will auto-retry in <span id="cd">10</span>s</p>
</div>
<script>let t=10;const el=document.getElementById("cd");setInterval(()=>{t--;if(t<=0)location.reload();else el.textContent=t},1000);</script>
</body></html>`);
    }
  }

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

// ---------- Global Error Handler ----------

app.use((err, req, res, next) => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] Error on ${req.method} ${req.url}:`, err);
  console.error(err.stack);

  // Determine if this is an API route
  const isApiRoute = req.path.startsWith("/setup/api/");

  // Determine status code
  let statusCode = err.statusCode || err.status || 500;
  if (statusCode < 400) statusCode = 500;

  // For API routes, return JSON
  if (isApiRoute || req.headers.accept?.includes("application/json")) {
    return res.status(statusCode).json({
      ok: false,
      error: err.message || "Internal server error",
      ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
    });
  }

  // For browser routes, return styled HTML error page
  const title = statusCode < 500 ? "Request Error" : "Server Error";
  const message = statusCode < 500
    ? err.message || "The request could not be completed."
    : "An unexpected error occurred. Please try again later.";

  res.status(statusCode).type("html").send(
    errorPageHTML(statusCode, title, message, process.env.NODE_ENV !== "production" ? err.stack : null)
  );
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[wrapper] listening on :${PORT}`);
  console.log(`[wrapper] state dir: ${STATE_DIR}`);
  console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);
  console.log(`[wrapper] gateway token: ${OPENCLAW_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
  console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);
  if (isAuthConfigured()) {
    console.log(`[wrapper] auth: Username/Password (username=${AUTH_USERNAME})`);
    console.log(`[wrapper] auth: Password is configured`);
  } else {
    console.log(`[wrapper] ================================================`);
    console.log(`[wrapper] WARNING: Authentication not configured!`);
    console.log(`[wrapper] Set AUTH_PASSWORD (and optionally AUTH_USERNAME)`);
    console.log(`[wrapper] in your environment variables to protect this instance.`);
    console.log(`[wrapper] Open Access mode: Anyone can access /setup`);
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
  // Inject gateway token for WebSocket upgrades.
  if (OPENCLAW_GATEWAY_TOKEN) {
    req.headers["authorization"] = `Bearer ${OPENCLAW_GATEWAY_TOKEN}`;
  }
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

// ---------- Process-Level Error Handling and Graceful Shutdown ----------

let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[wrapper] Received ${signal}, starting graceful shutdown...`);

  // Set a timeout to force exit after 10 seconds
  const forceExitTimer = setTimeout(() => {
    console.error("[wrapper] Graceful shutdown timeout - forcing exit");
    process.exit(1);
  }, 10000);

  try {
    // Close HTTP server (stop accepting new connections)
    await new Promise((resolve) => {
      server.close((err) => {
        if (err) console.error("[wrapper] Error closing server:", err);
        else console.log("[wrapper] HTTP server closed");
        resolve();
      });
    });

    // Kill gateway process
    if (gatewayProc) {
      console.log("[wrapper] Terminating gateway process...");
      gatewayProc.kill("SIGTERM");
      
      // Wait up to 3 seconds for graceful termination
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (gatewayProc && !gatewayProc.killed) {
            console.log("[wrapper] Gateway didn't exit gracefully, sending SIGKILL");
            gatewayProc.kill("SIGKILL");
          }
          resolve();
        }, 3000);

        if (gatewayProc) {
          gatewayProc.once("exit", () => {
            clearTimeout(timeout);
            console.log("[wrapper] Gateway process terminated");
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
    }

    clearTimeout(forceExitTimer);
    console.log("[wrapper] Graceful shutdown complete");
    process.exit(0);
  } catch (err) {
    console.error("[wrapper] Error during shutdown:", err);
    clearTimeout(forceExitTimer);
    process.exit(1);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  console.error("[wrapper] FATAL: Uncaught exception - application in undefined state");
  console.error(err);
  console.error(err.stack);
  
  // Attempt minimal cleanup but exit immediately regardless
  // The application is in an undefined state and cannot continue safely
  try {
    if (gatewayProc && !gatewayProc.killed) {
      gatewayProc.kill("SIGKILL"); // Force kill immediately
    }
  } catch (cleanupErr) {
    console.error("[wrapper] Error during emergency cleanup:", cleanupErr);
  }
  
  // Exit immediately - do not attempt graceful shutdown
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[wrapper] Unhandled rejection at:", promise);
  console.error("[wrapper] Reason:", reason);
  // Don't exit on unhandled rejection, just log it
  // In production, you might want to exit gracefully here
});
