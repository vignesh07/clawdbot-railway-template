# Onboarding Improvements Roadmap

This document proposes practical, user-centric improvements to make first-run success faster and more reliable.

## Goals

- Reduce time-to-first-success for non-technical users.
- Minimize setup mistakes (password, volume, provider keys).
- Improve confidence with visible progress and recovery guidance.

## High-Impact Improvements (Prioritized)

## P0 — Immediate (docs + flow clarity)

1. **First 10 Minutes Checklist in README**
   - Add a compact checklist with only required actions.
   - Include explicit “what success looks like” checkpoints.

2. **Decision-based setup guidance**
   - “If you have no provider key yet, do this first.”
   - “If setup password is auto-generated, where to find it.”

3. **Failure-first troubleshooting path**
   - Common failures mapped to exact fixes:
     - missing `/data` volume,
     - wrong/unknown `SETUP_PASSWORD`,
     - invalid provider token,
     - setup completed but `/` not loading.

4. **Stronger post-setup verification**
   - Validate `/setup`, `/`, `/openclaw`, and health endpoint in one short sequence.

## P1 — Productized onboarding UX

1. **Setup progress stages in UI**
   - Show 4 explicit stages: Validate → Configure → Deploy → Verify.
   - Provide stage-specific error messages and next action.

2. **Preflight checks before onboarding**
   - Detect and report missing volume path/env vars before attempting deploy.
   - Validate provider key format and required fields before submission.

3. **Contextual help in `/setup`**
   - Inline “what this field is” and “where to find this value” hints.
   - Quick links for OpenAI/OpenRouter/Anthropic token generation.

4. **Copy-paste safe examples**
   - Provide exact env var snippets users can copy.

## P2 — Confidence + support at scale

1. **Guided “first agent run” after setup**
   - One-click starter task to confirm model/provider works.

2. **Diagnostics bundle export**
   - Export sanitized onboarding diagnostics for support/debugging.

3. **Onboarding analytics (privacy-safe)**
   - Track completion funnel: start, password auth success, deploy success, first route load.
   - Use data to reduce drop-off points.

## Suggested Success Metrics

- Median time from deploy to first successful `/` load.
- `/setup` completion rate.
- Error rate by stage (password/auth, provider key, volume mount).
- Support tickets per 100 new deployments.

## Recommended Implementation Sequence

1. Ship P0 documentation improvements (fastest impact).
2. Add P1 preflight + staged progress UX in `/setup`.
3. Add P2 diagnostics + analytics for continuous optimization.
