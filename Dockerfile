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

# Pin to a known ref (tag/branch). If it doesn't exist, fall back to main.
ARG OPENCLAW_GIT_REF=main
# Force cache invalidation by using the commit SHA
ARG RAILWAY_GIT_COMMIT_SHA
RUN echo "Invalidating cache for commit: ${RAILWAY_GIT_COMMIT_SHA}" && \
    git clone --depth 1 --branch "${OPENCLAW_GIT_REF}" https://github.com/dodocha2021/openclaw.git .

# Patch: relax version requirements for packages that may reference unpublished versions.
# Apply to all extension package.json files to handle workspace protocol (workspace:*).
RUN set -eux; \
  find ./extensions -name 'package.json' -type f | while read -r f; do \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*">=[^"]+"/"openclaw": "*"/g' "$f"; \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*"workspace:[^"]+"/"openclaw": "*"/g' "$f"; \
  done

# Patch: Make Moonshot API endpoint configurable via build arg
# Default: international endpoint (api.moonshot.ai) for Railway deployments
# Set MOONSHOT_API_REGION=cn to use China endpoint (api.moonshot.cn)
ARG MOONSHOT_API_REGION=international
RUN set -eux; \
  if [ -f "./src/commands/onboard-auth.models.ts" ]; then \
    if [ "$MOONSHOT_API_REGION" = "cn" ]; then \
      echo "[patch] Keeping Moonshot API endpoint as China version (api.moonshot.cn)"; \
    else \
      sed -i 's|https://api.moonshot.cn/v1|https://api.moonshot.ai/v1|g' ./src/commands/onboard-auth.models.ts; \
      echo "[patch] Updated Moonshot API endpoint to international version (api.moonshot.ai)"; \
    fi; \
  fi

RUN pnpm install --no-frozen-lockfile
RUN pnpm build
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:install && pnpm ui:build


# Runtime image
FROM node:22-bookworm
ENV NODE_ENV=production

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

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
