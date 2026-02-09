# =============================================================================
# OpenClaw Railway Template - Dockerfile
# =============================================================================
# Multi-stage build to create an optimized production image for Railway
# deployment. This Dockerfile builds OpenClaw from source and packages it
# with a lightweight web wrapper for easy setup and configuration.
#
# Build arguments:
#   OPENCLAW_GIT_REF - Git ref (branch/tag) to build (default: main)
#   BUILD_DATE - Build timestamp for metadata (optional)
#   VCS_REF - Git commit SHA for traceability (optional)
#
# Usage:
#   docker build -t openclaw-railway .
#   docker build --build-arg OPENCLAW_GIT_REF=v1.2.3 -t openclaw-railway .
# =============================================================================

# Stage 1: Build OpenClaw from source
# -----------------------------------------------------------------------------
# Build openclaw from source to avoid npm packaging gaps (some dist files are not shipped).
FROM node:22-bookworm AS openclaw-build

# Install build dependencies
# Includes git, build tools, and Python for native module compilation
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# Install Bun package manager (required for OpenClaw UI build)
# Note: The install script accepts specific versions (e.g., bun-v1.0.0) or no argument for latest
# For enhanced security, consider pinning to a specific version in production
ARG BUN_VERSION=
RUN set -e; \
    if [ -z "$BUN_VERSION" ]; then \
      curl -fsSL https://bun.sh/install | bash || { echo "Bun installation failed"; exit 1; }; \
    else \
      curl -fsSL https://bun.sh/install | bash -s -- "$BUN_VERSION" || { echo "Bun installation failed for version $BUN_VERSION"; exit 1; }; \
    fi
ENV PATH="/root/.bun/bin:${PATH}"

# Enable pnpm via corepack
RUN corepack enable

WORKDIR /openclaw

# Clone OpenClaw repository at specified ref
# Pin to a known ref (tag/branch) for reproducible builds. Defaults to main.
ARG OPENCLAW_GIT_REF=main
RUN git clone --depth 1 --single-branch --branch "${OPENCLAW_GIT_REF}" \
    https://github.com/openclaw/openclaw.git .

# Patch package.json files to handle workspace protocol references
# Relax version requirements for packages that may reference unpublished versions.
# Apply to all extension package.json files to handle workspace protocol (workspace:*).
RUN set -eux; \
  find ./extensions -name 'package.json' -type f | while read -r f; do \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*">=[^"]+"/"openclaw": "*"/g' "$f"; \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*"workspace:[^"]+"/"openclaw": "*"/g' "$f"; \
  done

# Install dependencies and build OpenClaw
RUN pnpm install --no-frozen-lockfile
RUN pnpm build

# Build UI components
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:install && pnpm ui:build


# Stage 2: Production runtime image
# -----------------------------------------------------------------------------
# Runtime image
FROM node:22-bookworm

# Build arguments for metadata
ARG BUILD_DATE
ARG VCS_REF
ARG OPENCLAW_GIT_REF=main

# OCI-compliant image labels
# See: https://github.com/opencontainers/image-spec/blob/main/annotations.md
LABEL org.opencontainers.image.title="OpenClaw Railway Template"
LABEL org.opencontainers.image.description="One-click OpenClaw deployment for Railway with web-based setup wizard"
LABEL org.opencontainers.image.authors="Vignesh N (@vignesh07)"
LABEL org.opencontainers.image.vendor="NobPolish"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.url="https://github.com/NobPolish/clawdbot-railway-template"
LABEL org.opencontainers.image.source="https://github.com/NobPolish/clawdbot-railway-template"
LABEL org.opencontainers.image.documentation="https://github.com/NobPolish/clawdbot-railway-template/blob/main/README.md"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${VCS_REF}"
LABEL openclaw.git.ref="${OPENCLAW_GIT_REF}"

# Set production environment
ENV NODE_ENV=production

# Install minimal runtime dependencies
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
# Railway typically runs as root, but we provide the option for non-root deployment
# Note: node base image may already have GID 1000, so we check first
RUN if ! id -u 1000 >/dev/null 2>&1; then \
      echo "Creating appuser with UID 1000..."; \
      (getent group 1000 || groupadd -r appuser -g 1000) \
        && useradd -r -u 1000 -g 1000 -m -d /home/appuser -s /bin/bash appuser; \
    else \
      echo "User with UID 1000 already exists, skipping user creation"; \
    fi

WORKDIR /app

# Install wrapper application dependencies
# Copy package files first for better layer caching
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy built OpenClaw from build stage
COPY --from=openclaw-build /openclaw /openclaw

# Install OpenClaw CLI wrapper script
COPY scripts/openclaw-wrapper.sh /usr/local/bin/openclaw
RUN chmod +x /usr/local/bin/openclaw

# Copy wrapper application source
COPY src ./src

# Set ownership for non-root user (optional - comment out if running as root)
# RUN chown -R appuser:appuser /app /openclaw

# Switch to non-root user (optional - uncomment for non-root deployment)
# USER appuser

# Network configuration
# The wrapper listens on this port and proxies to OpenClaw gateway
ENV OPENCLAW_PUBLIC_PORT=8080
ENV PORT=8080
EXPOSE 8080

# Install health check script
COPY scripts/healthcheck.cjs /usr/local/bin/healthcheck.cjs

# Health check endpoint for Railway and monitoring
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node /usr/local/bin/healthcheck.cjs

# Start the wrapper server
CMD ["node", "src/server.js"]
