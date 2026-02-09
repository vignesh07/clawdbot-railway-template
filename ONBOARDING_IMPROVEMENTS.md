# Onboarding Improvements Roadmap

This roadmap outlines practical changes to make first-run setup more robust, intuitive, and user-centric.

## Goals

- Reduce time-to-first-success for non-technical deployers.
- Minimize setup failures (password, volume, provider credentials).
- Increase user confidence with clear progress and recovery steps.

## Prioritized Improvements

## P0 — Immediate (Docs + clarity, low effort)

1. **First-10-minutes checklist**
   - Keep only required actions and success checkpoints.
2. **Decision-based guidance**
   - Branch instructions for missing provider key vs. ready provider key.
3. **Failure-first troubleshooting**
   - Map common setup failures to exact fixes.
4. **Post-setup verification sequence**
   - Validate `/setup` → `/` → `/openclaw` (+ health check).

## P1 — Near-term (Setup UX + validation)

1. **Preflight checks in `/setup`**
   - Detect missing volume/env vars before deployment starts.
2. **Stage-based setup progress**
   - Show Validate → Configure → Deploy → Verify status.
3. **Contextual field help**
   - Inline hints for token locations and expected formats.
4. **Actionable error messages**
   - Every error includes next action and retry guidance.

## P2 — Scale (Supportability + optimization)

1. **Guided first successful run**
   - One-click starter action after onboarding.
2. **Diagnostics export**
   - Sanitized diagnostics package for support.
3. **Privacy-safe funnel analytics**
   - Track where users drop off and optimize accordingly.

## Top Failure Modes and Mitigations

| Failure Mode | User Symptom | Mitigation |
|---|---|---|
| Missing `/data` mount | Setup appears to work, state not retained | Add preflight mount check + explicit warning before deploy |
| Unknown `SETUP_PASSWORD` | Cannot enter `/setup` | Add log-location hint + reset instructions |
| Invalid provider credentials | Setup fails late | Validate format before deploy + provider-specific guidance |
| Setup completes but app route fails | `/` or `/openclaw` unavailable | Add final verification step and route-specific troubleshooting |

## Success Metrics

- Median time from deploy to first successful `/` load.
- `/setup` completion rate.
- Stage-level error rate (auth, provider, volume).
- Support requests per 100 new deployments.

## Recommended Execution Sequence

1. Implement P0 documentation and verification improvements.
2. Implement P1 preflight and staged progress UI in `/setup`.
3. Implement P2 diagnostics and analytics for continuous iteration.

## Suggested Owners

- **Docs owner:** quickstart + troubleshooting clarity
- **App owner:** `/setup` preflight + staged UX
- **Ops owner:** release checklist + rollback readiness

## Short Verification Checklist

- [ ] Run **Preflight** in `/setup` and resolve blockers.
- [ ] Confirm stage progress advances through **Validate → Configure → Deploy → Verify**.
- [ ] Confirm success route checks: `/setup`, `/`, `/openclaw`.
- [ ] If deploy fails, use stage-specific errors to retry without restarting from scratch.


## Implemented Debug/Resilience Upgrades

- Structured setup API errors now include machine-readable `code`, user-safe `message`, and a concrete `action`.
- Preflight failures and onboarding failures are surfaced in `/setup` with actionable next steps and output previews when available.
