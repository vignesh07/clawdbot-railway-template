# OpenClaw Railway Template (1‑click deploy)

This repo packages **OpenClaw** for Railway with a small **/setup** web wizard so users can deploy and onboard **without running any commands**.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/clawdbot-railway-template)

## What you get

- **OpenClaw Gateway + Control UI** (served at `/` and `/openclaw`)
- A friendly **Setup Wizard** at `/setup` (protected by a password)
- Persistent state via **Railway Volume** (so config/credentials/memory survive redeploys)
- One-click **Export backup** (so users can migrate off Railway later)
- **Import backup** from `/setup` (advanced recovery)
- **Docker-based deployment** optimized for Railway's platform

## 2-minute quickstart (zero guesswork)

If you want truly seamless onboarding, ignore everything else for now and do only this:

1. Click **Deploy on Railway**.
2. Add a **Volume** mounted at `/data`.
3. Set these variables:
   - `OPENCLAW_STATE_DIR=/data/.openclaw`
   - `OPENCLAW_WORKSPACE_DIR=/data/workspace`
   - `SETUP_PASSWORD=` (leave empty to auto-generate)
4. Enable **Public Networking** and deploy.
5. Open `/setup`, use the password from logs, click **Deploy Configuration**.

Done. Your app is live at `/` and `/openclaw`.

### The only things you actually need up front

- One model provider key (OpenRouter/OpenAI/Anthropic/etc.)
- Optional: Telegram/Discord/Slack tokens (can be added later)

Everything else can wait.

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

**⚠️ IMPORTANT: SETUP_PASSWORD Configuration**

The `SETUP_PASSWORD` is **required** to access the `/setup` configuration panel. You have two options:

- **Option 1 (Recommended for Railway)**: Leave `SETUP_PASSWORD` empty in your deployment variables. The system will **auto-generate a secure random password** on first startup and display it in the deployment logs. You can retrieve it from Railway's deployment logs.

- **Option 2**: Set a custom `SETUP_PASSWORD` in Railway variables before deployment (minimum 16 characters recommended).

**Required Variables:**
- `OPENCLAW_STATE_DIR=/data/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=/data/workspace`

**Optional Variables:**
- `SETUP_PASSWORD` — Leave empty for auto-generation (recommended), or set a strong password (16+ characters)
- `OPENCLAW_GATEWAY_TOKEN` — if not set, the wrapper generates one (not ideal). In a template, set it using a generated secret.

Notes:
- This template pins OpenClaw to a known-good version by default via Docker build arg `OPENCLAW_GIT_REF`.

4) Enable **Public Networking** (HTTP). Railway will assign a domain.
5) Deploy.

Then:
- Visit `https://<your-app>.up.railway.app/setup`
- If you used auto-generated password, check Railway deployment logs for the password
- Enter the password when prompted
- Complete setup
- Visit `https://<your-app>.up.railway.app/` and `/openclaw`


## Make onboarding easier (user-centric)

If your goal is highest first-run success, use this sequence:

1. Deploy with a mounted `/data` volume.
2. Confirm `OPENCLAW_STATE_DIR` and `OPENCLAW_WORKSPACE_DIR` point to `/data`.
3. Open `/setup` and finish provider key setup first.
4. Verify routes in order: `/setup` → `/` → `/openclaw`.
5. If anything fails, follow the release checklist and troubleshooting docs before retrying.

For a prioritized roadmap to make onboarding more intuitive and robust, see [ONBOARDING_IMPROVEMENTS.md](./ONBOARDING_IMPROVEMENTS.md).

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

### Using Docker directly

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

### Using Docker Compose

For easier local development and testing, use docker-compose:

```bash
# Copy the example environment file
cp .env.example .env

# Edit .env and set your SETUP_PASSWORD
# Then start the container
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the container
docker-compose down

# open http://localhost:8080/setup (use password from .env)
```

This approach is useful for:
- Testing the Docker setup before deploying to Railway
- Local development and debugging
- Validating environment variable configuration

See `.env.example` for all available configuration options.

## Docker to Railway Migration

This template makes it easy to migrate from Docker/Docker Compose to Railway:

**Key Benefits:**
- ✅ No docker-compose needed - Railway handles orchestration
- ✅ Automatic HTTPS - Railway provides SSL certificates  
- ✅ Built-in logging - Access logs via Railway dashboard
- ✅ Zero-downtime deploys - Railway handles rolling updates
- ✅ Persistent volumes - Railway Volumes for state storage
- ✅ One-click deploys - Use the template button above

**Migration Steps:**
1. Deploy this template to Railway (one-click button above)
2. Add a Railway Volume mounted at `/data`
3. Set `SETUP_PASSWORD` environment variable
4. Enable public networking
5. Access your deployment at the assigned Railway URL

For detailed migration guide, see [RAILWAY_DEPLOYMENT.md](./RAILWAY_DEPLOYMENT.md#migration-from-docker-compose).

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
