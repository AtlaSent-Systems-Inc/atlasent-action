# atlasent-action — v1 ship plan

GitHub Action that gates CI deploys on an AtlaSent `allow` decision. Distributed via the GitHub Marketplace.

## GA (v1) — status

1. ✅ **`target-id` input** — landed on `main` in `action.yml`. The PR #10 content (input declaration with `GITHUB_REPOSITORY` fallback) is shipped.
2. ✅ **Four-value `decision` output** — `action.yml` advertises `allow/deny/hold/escalate`, aligned with `atlasent-api`'s enum.
3. ✅ **`risk-score` output** — declared in `action.yml`; empty string when the evaluator does not return a risk assessment.
4. ✅ **Branding** — `icon: shield`, `color: green` set in `action.yml`.

## GA (v1) — must ship

5. **Marketplace listing polish — README quickstart + LICENSE** — verify a one-paragraph copy-paste-runnable example sits at the top of `README.md` and that `LICENSE` is present (Apache 2.0 to match the rest of the org).
6. **Pinned SDK version** — the action bundles `@atlasent/sdk` at build time. Pin to the v1 tag once `atlasent-sdk` publishes to npm (currently the highest-leverage unblocked item — see [atlasent-sdk/ROADMAP.md §1](https://github.com/AtlaSent-Systems-Inc/atlasent-sdk/blob/main/ROADMAP.md)).
7. **Marketplace publish** — once 5 + 6 land, publish the listing and lock the major version tag (`v1`).

## Post-GA — ordered by impact

8. **Check-run mode** — in addition to exit-code pass/fail, create a GitHub Check with risk bullets and a link to the evaluation in the console.
9. **Auto-comment on PRs** — summary comment when the action blocks.
10. **Self-hosted runner compat** — document egress requirements (api.atlasent.io), IP allowlist considerations.
11. **Matrix job support** — today one evaluation per job; allow batch eval for matrix fans (requires `POST /v1/evaluate/batch` upstream).

## Cross-repo dependencies

- **atlasent-sdk**: provides the TS client used here. v1 npm publish must land first (only blocker for item 6).
- **atlasent-api**: the `decision` enum change (hold/escalate) is already on `main`; action surfaces both ✅.
- **atlasent-docs**: needs a "CI gate" page pointing at Marketplace once published.
- **atlasent-examples**: end-to-end repo demonstrating the action blocking on `hold` lives in atlasent-examples (see its ROADMAP §3).

## Open questions

- Publish to GitHub Marketplace under `atlasent` or `atlasent-systems`? The org handle affects SEO.
- Fail-open or fail-closed when the AtlaSent API is unreachable? Current behavior is fail-closed (correct default); may need an opt-out for non-critical pipelines.
