#!/bin/bash
# Install OpenClaw plugins for this setup

set -e

echo "Installing plugins..."

# Camoufox - Anti-fingerprint browser
openclaw plugins install @askjo/camoufox-browser

# Add more plugins here as needed
# openclaw plugins install @openclaw/linear-skill

echo "Done. Restart gateway to load plugins:"
echo "  openclaw gateway restart"
