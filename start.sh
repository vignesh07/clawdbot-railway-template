#!/usr/bin/env bash
set -euo pipefail

# Create directories for Tailscale state
mkdir -p /data/tailscale /var/run/tailscale

# Start Tailscale daemon in the background (userspace networking for containers)
if [ -n "${TAILSCALE_AUTHKEY:-}" ]; then
  echo "[tailscale] Starting tailscaled..."
  tailscaled --tun=userspace-networking --state=/data/tailscale/state --socket=/var/run/tailscale/tailscaled.sock &
  sleep 2

  HOSTNAME="${TAILSCALE_HOSTNAME:-openclaw-railway}"
  echo "[tailscale] Logging in as ${HOSTNAME}..."
  tailscale up --authkey="${TAILSCALE_AUTHKEY}" --hostname="${HOSTNAME}" --accept-routes

  echo "[tailscale] Running. IP: $(tailscale ip -4)"
else
  echo "[tailscale] TAILSCALE_AUTHKEY not set, skipping Tailscale setup."
fi

# Start the Railway wrapper (which starts the OpenClaw gateway)
exec node src/server.js