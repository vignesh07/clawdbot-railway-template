FROM node:22-bookworm

ENV NODE_ENV=production

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    python3 \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

# `openclaw update` expects pnpm. Provide it in the runtime image.
RUN corepack enable && corepack prepare pnpm@10.23.0 --activate

# Persist user-installed tools by default by targeting the Railway volume.
ENV NPM_CONFIG_PREFIX=/data/npm
ENV NPM_CONFIG_CACHE=/data/npm-cache
ENV PNPM_HOME=/data/pnpm
ENV PNPM_STORE_DIR=/data/pnpm-store
ENV PATH="/usr/local/bin:/data/npm/bin:/data/pnpm:${PATH}"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --foreground-scripts --loglevel verbose

RUN npm_config_global=true node node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs

RUN npm cache clean --force

RUN test -f node_modules/openclaw/dist/entry.js

RUN test -d node_modules/openclaw/skills || (echo "missing: node_modules/openclaw/skills" && ls -la node_modules/openclaw && exit 1)

COPY src ./src

# Canonical OpenClaw launcher
RUN printf '%s\n' '#!/usr/bin/env bash' 'exec node /app/node_modules/openclaw/dist/entry.js "$@"' > /usr/local/bin/openclaw \
  && chmod +x /usr/local/bin/openclaw

EXPOSE 8080

ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]
