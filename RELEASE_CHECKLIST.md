# Release Checklist (Railway Template)

## Scope
Use this checklist before publishing or updating the Railway template.

## Ownership
- Product/Docs owner: verifies messaging and setup flow
- Engineering owner: verifies runtime behavior and health checks
- Release owner: confirms rollback readiness and signs off

## Pre-Release Gates
- [ ] `README.md` quickstart reflects current required variables and volume mount path.
- [ ] `RAILWAY_DEPLOYMENT.md` and `DOCKER_TO_RAILWAY.md` cross-links are valid.
- [ ] `railway.toml` values match documented startup and health-check expectations.
- [ ] `IMPLEMENTATION_SUMMARY.md` reflects current repository state.

## Validation Commands
Run from repository root:

```bash
npm run lint
node scripts/smoke.js
```

If Docker is available, also run:

```bash
docker compose config
```

## /setup Verification (Manual)
- [ ] Start app and open `/setup`.
- [ ] Confirm setup authentication works with `SETUP_PASSWORD` policy.
- [ ] Complete configuration flow without validation errors.
- [ ] Confirm gateway routes load at `/` and `/openclaw` after setup.
- [ ] Confirm health endpoint responds as documented.

## Data & Persistence Checks
- [ ] Persistent storage path is mounted at `/data`.
- [ ] `OPENCLAW_STATE_DIR` and `OPENCLAW_WORKSPACE_DIR` resolve to mounted storage.
- [ ] Backup/export path is documented and testable.

## Rollback Triggers
Trigger rollback if any of the following occur:
- [ ] `/setup` cannot complete on clean environment.
- [ ] Gateway fails to become healthy after setup.
- [ ] Persistent state fails to survive restart/redeploy.
- [ ] Critical docs mismatch causes deployment failure.

## Release Sign-Off
- [ ] Product/Docs owner sign-off
- [ ] Engineering owner sign-off
- [ ] Release owner sign-off
- [ ] Tag/PR notes include known limitations and follow-up items
