# atlasent-action — v1 ship plan

GitHub Action that gates CI deploys on an AtlaSent `allow` decision. Distributed via the GitHub Marketplace.

## GA (v1) — must ship

1. **`target-id` input** — `src/index.ts` already reads `core.getInput('target-id')` with a `GITHUB_REPOSITORY` fallback, but `action.yml` never declared it. This is the content of the now-closed PR #10 and must be re-landed:
   ```yaml
   inputs:
     target-id:
       description: Target resource identifier (defaults to GITHUB_REPOSITORY)
       required: false
   outputs:
     risk-score:
       description: Numeric risk score 0-100
   ```
2. **Four-value `decision` output** — align with `atlasent-api`'s enum: `allow | deny | hold | escalate`. The existing `action.yml` mentions only `allow`.
3. **Marketplace listing polish** — icon, color, branding in `action.yml`; README with a one-paragraph quickstart; LICENSE.
4. **Pinned SDK version** — the action bundles `@atlasent/sdk` at build time; pin to the v1 release once `atlasent-sdk` cuts its tag.

## Post-GA — ordered by impact

5. **Check-run mode** — in addition to exit-code pass/fail, create a GitHub Check with risk bullets and a link to the evaluation in the console.
6. **Auto-comment on PRs** — summary comment when the action blocks.
7. **Self-hosted runner compat** — document egress requirements (api.atlasent.io), IP allowlist considerations.
8. **Matrix job support** — today one evaluation per job; allow batch eval for matrix fans.

## Cross-repo dependencies

- **atlasent-sdk**: provides the TS client used here. v1 release must land first.
- **atlasent-api**: the `decision` enum change (hold/escalate) is already on `main`; make sure the action surfaces both.
- **atlasent-docs**: needs a "CI gate" page pointing at Marketplace.

## Open questions

- Publish to GitHub Marketplace under `atlasent` or `atlasent-systems`? The org handle affects SEO.
- Fail-open or fail-closed when the AtlaSent API is unreachable? Current behavior is fail-closed (correct default); may need an opt-out for non-critical pipelines.
