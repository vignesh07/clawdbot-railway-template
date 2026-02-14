# Contributing

Thanks for helping improve the OpenClaw Railway Template.

## Where to ask questions / get help

- Discord: https://discord.com/invite/clawd
- GitHub Issues: https://github.com/vignesh07/openclaw-railway-template/issues

## Reporting bugs

Please include:

1) **Railway logs** around the failure
2) The output of:
   - `GET /healthz`
   - `GET /setup/api/debug` (after authenticating to `/setup`)
3) Your Railway settings relevant to networking:
   - Public Networking enabled?
   - Domain target port set to **8080**?

## Pull requests

- Keep PRs small and focused (one fix per PR)
- Run locally:
  - `pnpm lint`
  - `pnpm test`

If you’re making Dockerfile changes, please explain why they’re needed and how you tested.
