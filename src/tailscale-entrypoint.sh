#!/usr/bin/env bash
set -euo pipefail

[ -z "${TS_AUTHKEY:-}" ] && exec "$@"

mkdir -p /data/tailscale /var/run/tailscale
tailscaled --tun=userspace-networking --statedir=/data/tailscale --socket=/var/run/tailscale/tailscaled.sock &

timeout 10 sh -c 'until [ -S /var/run/tailscale/tailscaled.sock ]; do sleep 0.1; done' \
  || { echo "[tailscale] daemon not ready in 10s" >&2; exit 1; }

tailscale up --authkey="${TS_AUTHKEY}" --hostname="${TS_HOSTNAME:-openclaw-railway}" --accept-dns --accept-routes --ssh

exec "$@"
