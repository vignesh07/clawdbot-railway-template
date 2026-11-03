# Use the same official prebuilt OpenClaw runtime as production so Workstudio
# is tested against the same Gateway version and runtime behavior.
FROM ghcr.io/openclaw/openclaw:2026.9.35

# Keep compatibility with the existing Railway /data volume permissions.
USER root

# Preserve python venv support used by the Railway wrapper environment.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

# Keep the Railway wrapper isolated from OpenClaw's /app tree.
WORKDIR /wrapper

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src

# The official image ships the OpenClaw CLI at /app/openclaw.mjs.
ENV OPENCLAW_ENTRY=/app/openclaw.mjs
ENV OPENCLAW_NODE=node

# Persist user-installed tools on the Railway volume.
ENV NPM_CONFIG_PREFIX=/data/npm
ENV NPM_CONFIG_CACHE=/data/npm-cache
ENV PNPM_HOME=/data/pnpm
ENV PNPM_STORE_DIR=/data/pnpm-store
ENV PATH="/data/npm/bin:/data/pnpm:${PATH}"

# Railway injects PORT at runtime and routes traffic to that port.
EXPOSE 8080

# Keep the Workstudio shutdown supervisor on the test branch. It forwards
# termination to src/server.js and gives the Gateway time to release its lease.
ENTRYPOINT ["tini", "-s", "--"]
CMD ["node", "src/railway-supervisor.js"]
