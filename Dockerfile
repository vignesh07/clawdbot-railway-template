# Build clawdbot from source to avoid npm packaging gaps (some dist files are not shipped).
FROM node:22-bookworm AS clawdbot-build
# Dependencies needed for clawdbot build
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*
# Install Bun (clawdbot build uses it)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"
RUN corepack enable
WORKDIR /clawdbot
# Pin to a known ref (tag/branch). Updated to OpenClaw v2026.3.13-1
ARG CLAWDBOT_GIT_REF=v2026.3.28
RUN git clone --depth 1 --branch "${CLAWDBOT_GIT_REF}" https://github.com/openclaw/openclaw.git .
# Patch: relax version requirements for packages that may reference unpublished versions.
# Scope this narrowly to avoid surprising dependency mutations.
RUN set -eux; \
  for f in \
    ./extensions/memory-core/package.json \
    ./extensions/googlechat/package.json \
  ; do \
    if [ -f "$f" ]; then \
      sed -i -E 's/"(clawdbot|openclaw)"[[:space:]]*:[[:space:]]*">=[^"]+"/"openclaw": "*"/g' "$f"; \
    fi; \
  done
RUN pnpm install --no-frozen-lockfile
RUN pnpm build
ENV CLAWDBOT_PREFER_PNPM=1
RUN pnpm ui:install && pnpm ui:build

# Runtime image
FROM node:22-bookworm
ENV NODE_ENV=production
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    cron \
    curl \
    gnupg \
    jq \
    nano \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Install ngrok for tunneling
RUN curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null \
  && echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | tee /etc/apt/sources.list.d/ngrok.list \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ngrok \
  && rm -rf /var/lib/apt/lists/*

# Install Playwright with bundled Chromium for browser automation
RUN npm install -g playwright && npx playwright install --with-deps chromium

# Install Bird CLI for Twitter/X integration (https://github.com/steipete/bird)
RUN npm install -g @steipete/bird

# Install Todoist CLI for task management
RUN npm install -g todoist-ts-cli@^0.2.0

# Install trash-cli for safe file deletion (recoverable rm)
RUN npm install -g trash-cli

# Install gog CLI for Google services - Gmail, Calendar, Drive (https://github.com/steipete/gogcli)
RUN curl -sL https://github.com/steipete/gogcli/releases/download/v0.9.0/gogcli_0.9.0_linux_amd64.tar.gz | tar -xz -C /usr/local/bin gog

# Install Google Workspace CLI for structured Workspace API access (https://github.com/googleworkspace/cli)
RUN npm install -g @googleworkspace/cli

# Install Codex CLI (https://github.com/openai/codex)
RUN npm install -g @openai/codex

WORKDIR /app
# Wrapper deps
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
# Copy built clawdbot
COPY --from=clawdbot-build /clawdbot /clawdbot
# Provide an openclaw executable
RUN printf '%s\n' '#!/usr/bin/env bash' 'exec node /clawdbot/dist/entry.js "$@"' > /usr/local/bin/openclaw \
  && chmod +x /usr/local/bin/openclaw
# Pre-install the Chrome browser relay extension so it persists across restarts
RUN openclaw browser extension install

COPY src ./src

# Create non-root user with pinned UID for stable volume permissions across rebuilds
RUN groupadd -g 1500 appgroup \
  && useradd -u 1500 -g appgroup -m -s /bin/bash claude-user \
  && usermod -aG appgroup root

# Install Claude Code as claude-user (installs to ~claude-user, avoids /root access issues)
USER claude-user
RUN curl -fsSL https://claude.ai/install.sh | bash
USER root

# Entrypoint: set up shared group + setgid on /data volume (fast, no recursive chown)
RUN printf '%s\n' \
  '#!/usr/bin/env bash' \
  'chgrp appgroup /data 2>/dev/null || true' \
  'chmod 2775 /data 2>/dev/null || true' \
  'umask 002' \
  '# Set up system cron jobs (idempotent, safe to re-run)' \
  'if [ -x /data/workspace/scripts/setup-system-crons.sh ]; then' \
  '  /data/workspace/scripts/setup-system-crons.sh || true' \
  'fi' \
  'exec "$@"' \
  > /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh

ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/server.js"]
