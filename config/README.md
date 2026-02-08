# OpenClaw Configuration

Template configuration for OpenClaw deployment.

## Quick Start

1. Copy `openclaw.template.json` to `~/.openclaw/openclaw.json`
2. Replace environment variable placeholders with actual values
3. Run `openclaw gateway start`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GATEWAY_TOKEN` | Gateway auth token (generate random string) |
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key (for Codex) |
| `GEMINI_API_KEY` | Google API key (optional) |
| `GH_PAT` | GitHub Personal Access Token |

## Model Hierarchy

**Engineering Team:**
- `opus` — CTO / Sr. Eng (complex architecture, critical code)
- `sonnet` — Jr. Eng / Intern (features, PRs, tests)
- `codex` — Side projects, adhoc builds
- `codex-mini` — Quick prototypes
- `haiku` — Quick lookups, cheap tasks

**Sub-agents default to Sonnet.**

## Plugins Installed

- **camoufox-browser** — Anti-fingerprint browser for web automation

Install with:
```bash
openclaw plugins install @askjo/camoufox-browser
```

## Token Optimization

Config includes:
- Context pruning (cache-ttl: 1h)
- Compaction (safeguard mode)
- Max concurrent: 4

For more aggressive savings:
- Switch default model to Haiku
- Route heartbeats to local Ollama
- Enable prompt caching

## Security

- Gateway binds to loopback only
- DM policy: pairing (approval required)
- Groups: require @mention
- Tailscale: off by default (enable for remote access)
