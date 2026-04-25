# atlasent-action — v1 ship plan

GitHub Action that gates CI deploys on an AtlaSent `allow` decision. Distributed via the GitHub Marketplace.

## GA (v1) — must ship

Status snapshot (2026-04-25):

1. **`target-id` input + `risk-score` output** — ✅ DONE in this branch. Runtime in `src/index.ts` now reads `target-id` (with `GITHUB_REPOSITORY` fallback) and emits `risk-score` from `response.risk.score`. Declared in `action.yml` and documented in README.
2. **Four-value `decision` output** — ✅ DONE. README + action.yml outputs table both document `allow|deny|hold|escalate`.
3. **Marketplace listing polish** — ✅ DONE. Icon (shield), color (green), README quickstart, LICENSE all present.
4. **Pinned SDK version** — 🚫 BLOCKED on `atlasent-sdk` v1.0.0 publish (which is itself blocked on `NPM_TOKEN`). Today the action vendors the SDK via the build, not via a `package.json` dep on `@atlasent/sdk`.

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
