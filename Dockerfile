# OpenClaw is consumed as the prebuilt release image that upstream publishes
# for every tag (ghcr.io/openclaw/openclaw:<version>), instead of cloning the
# repo and compiling it (pnpm install + 7 tsdown passes + Control UI build)
# on every Railway deploy. Pulling the release layers takes ~1-2 min; the old
# source build took 15-90 min with zero cache hits.
#
# The release image lays out OpenClaw at /app (dist/, node_modules/,
# extensions/, openclaw.mjs, ...). We copy that tree to /openclaw so the
# wrapper's `node /openclaw/dist/entry.js` entry keeps working unchanged.
#
# Pin to a released version. Override in Railway template settings if needed.
# Tag 2026.8.35 = index digest
#   sha256:48fcc97d60d8c5a73d19595066dc0aec64a8317549720ae0cb5f35b4751fafc5
# (built 2026-10-02 from openclaw/openclaw@713ba578, Node 24.19 / bookworm-slim).
ARG OPENCLAW_VERSION=2026.8.35
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION} AS openclaw-release


# Runtime image
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
# - npm global installs -> /data/npm
# - pnpm global installs -> /data/pnpm (binaries) + /data/pnpm-store (store)
ENV NPM_CONFIG_PREFIX=/data/npm
ENV NPM_CONFIG_CACHE=/data/npm-cache
ENV PNPM_HOME=/data/pnpm
ENV PNPM_STORE_DIR=/data/pnpm-store
ENV PATH="/data/npm/bin:/data/pnpm:${PATH}"

WORKDIR /app

# Wrapper deps
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy prebuilt openclaw (dist/, node_modules/, extensions/, skills/, docs/ ...)
# from the upstream release image. Its native addons are N-API builds for
# linux-x64 glibc, so they load on this image's Node as well.
COPY --from=openclaw-release /app /openclaw

# Fail the build early if the release image layout ever changes.
RUN test -f /openclaw/dist/entry.js \
  && test -d /openclaw/dist/control-ui \
  && node /openclaw/openclaw.mjs --version

# Provide an openclaw executable
RUN printf '%s\n' '#!/usr/bin/env bash' 'exec node /openclaw/dist/entry.js "$@"' > /usr/local/bin/openclaw \
  && chmod +x /usr/local/bin/openclaw

COPY src ./src

# The wrapper listens on $PORT.
# IMPORTANT: Do not set a default PORT here.
# Railway injects PORT at runtime and routes traffic to that port.
# If we force a different port, deployments can come up but the domain will route elsewhere.
EXPOSE 8080

# Ensure PID 1 reaps zombies and forwards signals.
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]
