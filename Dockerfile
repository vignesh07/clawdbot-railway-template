# Build openclaw from source to avoid npm packaging gaps (some dist files are not shipped).
FROM node:22-bookworm AS openclaw-build

# Dependencies needed for openclaw build
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# Install Bun (openclaw build uses it)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /openclaw

# Pin to a known-good ref (tag/branch). Override in Railway template settings if needed.
# Using a released tag avoids build breakage when `main` temporarily references unpublished packages.
ARG OPENCLAW_GIT_REF=v2026.2.9
RUN git clone --depth 1 --branch "${OPENCLAW_GIT_REF}" https://github.com/openclaw/openclaw.git .

# Patch: relax version requirements for packages that may reference unpublished versions.
# Apply to all extension package.json files to handle workspace protocol (workspace:*).
RUN set -eux; \
  find ./extensions -name 'package.json' -type f | while read -r f; do \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*">=[^"]+"/"openclaw": "*"/g' "$f"; \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*"workspace:[^"]+"/"openclaw": "*"/g' "$f"; \
  done

RUN pnpm install --no-frozen-lockfile
RUN pnpm build
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:install && pnpm ui:build


# Runtime image
FROM node:22-bookworm
ENV NODE_ENV=production
ENV CHROME_BIN=/usr/bin/chromium
ENV GH_CONFIG_DIR=/data/.openclaw/auth/gh
ENV XDG_CONFIG_HOME=/data/.openclaw/auth/xdg
ENV HOMEBREW_PREFIX=/home/linuxbrew/.linuxbrew
ENV PATH=/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    file \
    procps \
    git \
    gh \
    chromium \
  && rm -rf /var/lib/apt/lists/*

# Runtime CLI dependencies used by OpenClaw sessions.
RUN npm install -g clawhub @tantanok221/agentbudget @vercel/agent-browser @infisical/cli \
  && npm cache clean --force

# Turso CLI (https://docs.turso.tech/cli/installation)
RUN curl -sSfL https://get.tur.so/install.sh | bash \
  && mv /root/.turso/bin/turso /usr/local/bin/turso

# Homebrew on Linux (portable bootstrap without interactive installer)
RUN git clone --depth=1 https://github.com/Homebrew/brew /home/linuxbrew/.linuxbrew/Homebrew \
  && mkdir -p /home/linuxbrew/.linuxbrew/bin \
  && ln -sf ../Homebrew/bin/brew /home/linuxbrew/.linuxbrew/bin/brew \
  && ln -sf /home/linuxbrew/.linuxbrew/bin/brew /usr/local/bin/brew \
  && /usr/local/bin/brew --version

# `openclaw update` expects pnpm. Provide it in the runtime image.
RUN corepack enable && corepack prepare pnpm@10.23.0 --activate

WORKDIR /app

# Wrapper deps
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy built openclaw
COPY --from=openclaw-build /openclaw /openclaw

# Provide an openclaw executable
RUN printf '%s\n' '#!/usr/bin/env bash' 'exec node /openclaw/dist/entry.js "$@"' > /usr/local/bin/openclaw \
  && chmod +x /usr/local/bin/openclaw

COPY src ./src

# The wrapper listens on this port.
ENV OPENCLAW_PUBLIC_PORT=8080
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/server.js"]
