# Clawdbot Railway Template (1‑click deploy)

This repo packages **Clawdbot** for Railway with a small **/setup** web wizard so users can deploy and onboard **without running any commands**.

## What you get

- **Clawdbot Gateway + Control UI** (served at `/` and `/clawdbot`)
- A friendly **Setup Wizard** at `/setup` (protected by a password)
- Persistent state via **Railway Volume** (so config/credentials/memory survive redeploys)
- One-click **Export backup** (so users can migrate off Railway later)

## How it works (high level)

- The container runs a wrapper web server.
- The wrapper protects `/setup` with `SETUP_PASSWORD`.
- During setup, the wrapper runs `clawdbot onboard --non-interactive ...` inside the container, writes state to the volume, and then starts the gateway.
- After setup, **`/` is Clawdbot**. The wrapper reverse-proxies all traffic (including WebSockets) to the local gateway process.

## System Requirements

### Memory Requirements

Clawdbot requires adequate memory to run both the wrapper server and the gateway process:

- **Minimum:** 1GB RAM (Railway Hobby plan)
- **Recommended:** 2GB+ RAM for stable operation
- **Not Supported:** Railway free tier (512MB) - will crash with out-of-memory errors

### Railway Plan Requirements

- **Hobby Plan ($5/month):** 1GB RAM - Adequate for basic usage
- **Pro Plan ($20/month):** 8GB RAM - Recommended for production
- **Free Trial:** 512MB RAM - Insufficient, will cause crashes

**Important:** The free trial will not work. You need at least the Hobby plan.

## Railway deploy instructions (what you'll publish as a Template)

In Railway Template Composer:

1) Create a new template from this GitHub repo.
2) Add a **Volume** mounted at `/data`.

> ⚠️ **Memory Requirement:** Ensure your Railway plan provides at least 1GB RAM. The free trial (512MB) will cause out-of-memory crashes during startup. See [System Requirements](#system-requirements) above.

3) Set the following variables:

Required:
- `SETUP_PASSWORD` — user-provided password to access `/setup`

Recommended:
- `CLAWDBOT_STATE_DIR=/data/.clawdbot`
- `CLAWDBOT_WORKSPACE_DIR=/data/workspace`

Optional:
- `CLAWDBOT_GATEWAY_TOKEN` — if not set, the wrapper generates one (not ideal). In a template, set it using a generated secret.

Notes:
- This template pins Clawdbot to a known-good version by default via Docker build arg `CLAWDBOT_VERSION`.

4) Enable **Public Networking** (HTTP). Railway will assign a domain.
5) Deploy.

Then:
- Visit `https://<your-app>.up.railway.app/setup`
- Complete setup
- Visit `https://<your-app>.up.railway.app/` and `/clawdbot`

## Getting chat tokens (so you don’t have to scramble)

### Telegram bot token
1) Open Telegram and message **@BotFather**
2) Run `/newbot` and follow the prompts
3) BotFather will give you a token that looks like: `123456789:AA...`
4) Paste that token into `/setup`

### Discord bot token
1) Go to the Discord Developer Portal: https://discord.com/developers/applications
2) **New Application** → pick a name
3) Open the **Bot** tab → **Add Bot**
4) Copy the **Bot Token** and paste it into `/setup`
5) Invite the bot to your server (OAuth2 URL Generator → scopes: `bot`, `applications.commands`; then choose permissions)

## Local smoke test

```bash
docker build -t clawdbot-railway-template .

docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e CLAWDBOT_STATE_DIR=/data/.clawdbot \
  -e CLAWDBOT_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  clawdbot-railway-template

# open http://localhost:8080/setup (password: test)
```

## Troubleshooting

### Out of Memory Errors

**Symptoms:**
- Container crashes 30-60 seconds after startup
- Railway logs show: `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`
- Memory logs show: `Scavenge XXX.X -> XXX.X MB` followed by crash

**Solutions:**

1. **Upgrade Railway Plan** (Required)
   - The free trial (512MB) is insufficient
   - Upgrade to Hobby plan ($5/month, 1GB RAM) minimum
   - Navigate to Project Settings → Upgrade Plan
   - Redeploy after upgrading

2. **Verify Memory Flag** (Already configured)
   - This template includes `--max-old-space-size=2048` in the Dockerfile
   - No action needed unless you modified the Dockerfile

3. **Check Current Memory Usage**
   - In Railway dashboard, go to Metrics tab
   - Monitor memory usage over time
   - If consistently near limit, consider Pro plan (8GB RAM)

### Gateway Startup Timeout

**Symptoms:**
- Setup completes but gateway doesn't respond
- Browser shows connection errors

**Solution:**
- The wrapper waits 20 seconds for gateway startup
- On constrained resources or slow networks, this may be insufficient
- Wait 1-2 minutes and refresh the page
- Check Railway logs for gateway startup progress

### Setup Password Issues

**Symptoms:**
- Cannot access `/setup` endpoint
- Error: "SETUP_PASSWORD is not set"

**Solution:**
- Add `SETUP_PASSWORD` variable in Railway project settings (Variables tab)
- Set to a strong, unique password
- Redeploy the service
