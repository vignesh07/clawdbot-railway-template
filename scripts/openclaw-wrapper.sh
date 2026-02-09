#!/usr/bin/env bash
# Wrapper script to execute OpenClaw CLI
# This provides a convenient 'openclaw' command in the container
# by delegating to the Node.js entry point.
exec node /openclaw/dist/entry.js "$@"
