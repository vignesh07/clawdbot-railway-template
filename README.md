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
   - `AUTH_PASSWORD=your-secure-password` (or leave empty for open access mode)
4. Enable **Public Networking** and deploy.
5. Open `/setup`, sign in with username `admin` and your password, then click **Deploy Configuration**.

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


## Authentication

This template uses simple username/password authentication to protect your OpenClaw instance.

### Configuration Options

**AUTH_USERNAME** (default: `admin`)
- The username required to sign in to `/setup`
- Can be customized via environment variable

**AUTH_PASSWORD** (recommended)
- The primary authentication password
- **IMPORTANT**: Set a strong password (minimum 16 characters with uppercase, lowercase, numbers, and special characters recommended; use a password manager)
- If not set, the instance runs in "Open Access" mode (anyone can access)

**SETUP_PASSWORD** (backward compatibility)
- Maintained as a fallback for existing deployments
- If `AUTH_PASSWORD` is not set, `SETUP_PASSWORD` is used instead

### Open Access Mode

If you don't set `AUTH_PASSWORD`, the instance runs in **Open Access Mode**:
- Anyone with the URL can access `/setup` and manage your instance
- Useful for private networks or testing
- **Not recommended for production deployments**
## Railway deploy instructions (what you’ll publish as a Template)

In Railway Template Composer:

1) Create a new template from this GitHub repo.
2) Add a **Volume** mounted at `/data`.
3) Set the following variables:

**⚠️ IMPORTANT: Authentication Configuration**

For secure deployments, set `AUTH_PASSWORD` to protect access to your instance.

**Required Variables:**
- `OPENCLAW_STATE_DIR=/data/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=/data/workspace`

**Recommended Variables:**
- `AUTH_PASSWORD` — Set a strong password (16+ characters) to secure your instance
- `AUTH_USERNAME` — Optional, defaults to `admin`
- `OPENCLAW_GATEWAY_TOKEN` — if not set, the wrapper generates one. In a template, set it using a generated secret.

Notes:
- This template pins OpenClaw to a known-good version by default via Docker build arg `OPENCLAW_GIT_REF`.
- **Backward compatibility:** The wrapper includes a shim for `CLAWDBOT_*` environment variables (logs a deprecation warning when used). `MOLTBOT_*` variables are **not** shimmed — this repo never shipped with MOLTBOT prefixes, so no existing deployments rely on them.

4) Enable **Public Networking** (HTTP). Railway will assign a domain.
   - This service is configured to listen on port `8080` (including custom domains).
5) Deploy.

Then:
- Visit `https://<your-app>.up.railway.app/setup`
- Sign in with your username (default: `admin`) and `AUTH_PASSWORD`
- Complete setup
- Visit `https://<your-app>.up.railway.app/` and `/openclaw`

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
# Basic build
docker build -t openclaw-railway-template .

# Build with metadata (recommended for production)
docker build \
  --build-arg BUILD_DATE="$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  --build-arg VCS_REF="$(git rev-parse --short HEAD)" \
  --build-arg OPENCLAW_GIT_REF=main \
  -t openclaw-railway-template .

docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e AUTH_PASSWORD=test \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template

# open http://localhost:8080/setup (username: admin, password: test)
```

#### Build Arguments

The Dockerfile supports the following build arguments for enhanced metadata and customization:

- `OPENCLAW_GIT_REF` - Git branch/tag to build (default: `main`)
- `BUILD_DATE` - Build timestamp for image metadata (optional)
- `VCS_REF` - Git commit SHA for traceability (optional)
- `BUN_VERSION` - Specific Bun version to install (default: latest, e.g., `bun-v1.0.0`)

Example:
```bash
docker build \
  --build-arg OPENCLAW_GIT_REF=v1.2.3 \
  --build-arg BUN_VERSION=bun-v1.0.30 \
  -t openclaw-railway-template .
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

### Docker Image Features

The production Docker image includes:

✅ **Security Best Practices**
- Multi-stage build for minimal attack surface
- Non-root user support (optional, commented for Railway compatibility)
- Health checks for container monitoring
- Secure file permissions

✅ **Build Optimization**
- `.dockerignore` for faster builds and smaller context
- Layer caching optimization
- Minimal runtime dependencies

✅ **Metadata & Traceability**
- OCI-compliant image labels
- Build date and VCS revision tracking
- OpenClaw version pinning via build args

✅ **Monitoring**
- Built-in health check endpoint (`/setup/healthz`)
- 30-second interval checks with 40-second startup grace period

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
3. Set `AUTH_PASSWORD` environment variable
4. Enable public networking
5. Access your deployment at the assigned Railway URL

For detailed migration guide, see [RAILWAY_DEPLOYMENT.md](./RAILWAY_DEPLOYMENT.md#migration-from-docker-compose).


## Error Handling & Troubleshooting

This template includes comprehensive error handling to ensure reliability and easy debugging:

### Automatic Features

**Gateway Auto-Restart**
- The OpenClaw gateway automatically restarts if it crashes
- Uses exponential backoff (1s, 2s, 4s delays)
- Maximum 3 restart attempts before requiring manual intervention

**Graceful Shutdown**
- Handles SIGTERM/SIGINT signals properly
- Closes HTTP server and terminates child processes cleanly
- 10-second timeout before force exit

**Request Timeouts**
- Proxy requests timeout after 30 seconds
- Prevents hanging connections

### Error Responses

**API Routes** (`/setup/api/*`)
- Return structured JSON with error details
- Include stack traces in development mode

**Browser Routes**
- Display styled error pages with status codes
- Auto-retry for 502/503 errors (gateway unavailable)
- Optional technical details in development mode

### Common Issues

**502 Bad Gateway / 503 Service Unavailable**
- The gateway is starting up or crashed
- The page will auto-retry every 5 seconds
- Check logs for gateway startup errors

**429 Too Many Requests**
- Too many failed login attempts from your IP
- Wait 15 minutes before trying again
- Rate limit: 10 attempts per 15-minute window

**Authentication Errors**
- Verify `AUTH_PASSWORD` is set correctly
- Check username (default is `admin`)
- Clear browser cookies and try again

### Logging

All errors are logged with:
- Timestamp
- Request method and URL
- Full stack trace
- Process information for child processes

Check Railway deployment logs or container stdout for detailed error information.

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
