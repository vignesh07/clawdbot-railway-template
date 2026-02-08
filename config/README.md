# OpenClaw Configuration

This folder contains the template configuration for OpenClaw.

## Files

- `openclaw.template.json` — Base config with environment variable placeholders

## Environment Variables Required

Set these in Railway (or your deployment platform):

| Variable | Description |
|----------|-------------|
| `GATEWAY_TOKEN` | Gateway auth token (generate a random string) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude models |
| `OPENAI_API_KEY` | OpenAI API key for Codex models |
| `GEMINI_API_KEY` | Google API key for Gemini (optional) |
| `GH_PAT` | GitHub Personal Access Token for repo access |

## Model Aliases

| Alias | Model | Use Case |
|-------|-------|----------|
| `opus` | claude-opus-4-5 | CTO / Sr. Eng — complex tasks |
| `sonnet` | claude-sonnet-4 | Jr. Eng / Intern — general coding |
| `haiku` | claude-3.5-haiku | Quick lookups |
| `codex` | gpt-5.2-codex | Adhoc builds, side projects |
| `codex-mini` | codex-mini-latest | Quick prototypes |

## Sub-agents

Default model: `sonnet` (Jr. Eng level)
Max concurrent: 4
