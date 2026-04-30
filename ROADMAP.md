# atlasent-action — v1 ship plan

GitHub Action that gates CI deploys on an AtlaSent `allow` decision. Distributed via the GitHub Marketplace.

## GA (v1) — must ship

1. ✅ **`target-id` input** — declared in `action.yml`; threaded into evaluate request and `context.target_id`. `risk-score` output added. _(v1.2.0)_
2. ✅ **Four-value `decision` output** — `allow | deny | hold | escalate` surfaced; `fail-on-deny` semantics cover all non-allow outcomes. _(v1.0.0+)_
3. **Marketplace listing polish** — icon, color, branding in `action.yml`; README quickstart updated _(v1.3.0)_; LICENSE present. Icon/color/branding still pending.
4. ✅ **Pinned enforcement library** — action bundles `@atlasent/enforce` (workspace package, pinned) instead of raw `fetch`; evaluate → verify → verifyPermit contract enforced. _(v1.3.0)_

## Post-GA — ordered by impact

5. **Check-run mode** — in addition to exit-code pass/fail, create a GitHub Check with risk bullets and a link to the evaluation in the console.
6. **Auto-comment on PRs** — summary comment when the action blocks.
7. **Self-hosted runner compat** — document egress requirements (api.atlasent.io), IP allowlist considerations.
8. ✅ **Matrix job support** — `evaluations` input accepts a JSON array; `runV21 → evaluateMany` fans out and verifies per-item. `decisions` + `batch-id` outputs. _(v1.3.0)_

## Cross-repo dependencies

- **atlasent-sdk**: provides the TS client used here. v1 release must land first.
- **atlasent-api**: the `decision` enum change (hold/escalate) is already on `main`; make sure the action surfaces both.
- **atlasent-docs**: needs a "CI gate" page pointing at Marketplace.

## Open questions

- Publish to GitHub Marketplace under `atlasent` or `atlasent-systems`? The org handle affects SEO.
- Fail-open or fail-closed when the AtlaSent API is unreachable? Current behavior is fail-closed (correct default); may need an opt-out for non-critical pipelines.
