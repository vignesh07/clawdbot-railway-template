# OpenClaw Railway Template (1‑click deploy)

This repo packages **OpenClaw** for Railway with a small **/setup** web wizard so users can deploy and onboard **without running any commands**.

## What you get

- **OpenClaw Gateway + Control UI** (served at `/` and `/openclaw`)
- A friendly **Setup Wizard** at `/setup` (protected by a password)
- Persistent state via **Railway Volume** (so config/credentials/memory survive redeploys)
- One-click **Export backup** (so users can migrate off Railway later)
- **Import backup** from `/setup` (advanced recovery)
- Runtime tooling preinstalled in image: `gh`, `clawhub`, `agentbudget`, `agent-browser`, `turso`, `brew`, `infisical`, `chromium` (survives container restarts/redeploys)
- CLI auth config persisted to Railway volume (`/data/.openclaw/auth`) via `GH_CONFIG_DIR` and `XDG_CONFIG_HOME`

## How it works (high level)

- The container runs a wrapper web server.
- The wrapper protects `/setup` with `SETUP_PASSWORD`.
- During setup, the wrapper runs `openclaw onboard --non-interactive ...` inside the container, writes state to the volume, and then starts the gateway.
- After setup, **`/` is OpenClaw**. The wrapper reverse-proxies all traffic (including WebSockets) to the local gateway process.

## Railway deploy instructions (what you’ll publish as a Template)

In Railway Template Composer:

1) Create a new template from this GitHub repo.
2) Add a **Volume** mounted at `/data`.
3) Set the following variables:

Required:
- `SETUP_PASSWORD` — user-provided password to access `/setup`

Recommended:
- `OPENCLAW_STATE_DIR=/data/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=/data/workspace`

Optional:
- `OPENCLAW_GATEWAY_TOKEN` — if not set, the wrapper generates one (not ideal). In a template, set it using a generated secret.

Notes:
- This template pins OpenClaw to a released version by default via Docker build arg `OPENCLAW_GIT_REF` (override if you want `main`).
- **Backward compatibility:** The wrapper includes a shim for `CLAWDBOT_*` environment variables (logs a deprecation warning when used). `MOLTBOT_*` variables are **not** shimmed — this repo never shipped with MOLTBOT prefixes, so no existing deployments rely on them.

4) Enable **Public Networking** (HTTP). Railway will assign a domain.
   - This service is configured to listen on port `8080` (including custom domains).
5) Deploy.

Then:
- Visit `https://<your-app>.up.railway.app/setup`
- Complete setup
- Visit `https://<your-app>.up.railway.app/` and `/openclaw`

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

## Troubleshooting

### “disconnected (1008): pairing required” / dashboard health offline

This is not a crash — it means the gateway is running, but no device has been approved yet.

Fix:
- Open `/setup`
- Use the **Debug Console**:
  - `openclaw devices list`
  - `openclaw devices approve <requestId>`

### “unauthorized: gateway token mismatch”

The Control UI connects using `gateway.remote.token` and the gateway validates `gateway.auth.token`.

Fix:
- Re-run `/setup` so the wrapper writes both tokens.
- Or set both values to the same token in config.

### “Application failed to respond” / 502 Bad Gateway

Most often this means the wrapper is up, but the gateway can’t start or can’t bind.

Checklist:
- Ensure you mounted a **Volume** at `/data` and set:
  - `OPENCLAW_STATE_DIR=/data/.openclaw`
  - `OPENCLAW_WORKSPACE_DIR=/data/workspace`
- Ensure **Public Networking** is enabled and `PORT=8080`.
- Check Railway logs for the wrapper error: it will show `Gateway not ready:` with the reason.

### Build OOM (out of memory) on Railway

Building OpenClaw from source can exceed small memory tiers.

Recommendations:
- Use a plan with **2GB+ memory**.
- If you see `Reached heap limit Allocation failed - JavaScript heap out of memory`, upgrade memory and redeploy.

## Local smoke test

```bash
docker build -t openclaw-railway-template .

docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template

# open http://localhost:8080/setup (password: test)
```

---

## Official template / endorsements

- Officially recommended by OpenClaw: <https://docs.openclaw.ai/railway>
- Railway announcement (official): [Railway tweet announcing 1‑click OpenClaw deploy](https://x.com/railway/status/2015534958925013438)

  ![Railway official tweet screenshot](assets/railway-official-tweet.jpg)

- Endorsement from Railway CEO: [Jake Cooper tweet endorsing the OpenClaw Railway template](https://x.com/justjake/status/2015536083514405182)

  ![Jake Cooper endorsement tweet screenshot](assets/railway-ceo-endorsement.jpg)

- Created and maintained by **Vignesh N (@vignesh07)**
- **1800+ deploys on Railway and counting** [Link to template on Railway](https://railway.com/deploy/clawdbot-railway-template)

![Railway template deploy count](assets/railway-deploys.jpg)
