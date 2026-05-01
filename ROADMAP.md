# atlasent-action — v1 ship plan

GitHub Action that gates CI deploys on an AtlaSent `allow` decision. Distributed via the GitHub Marketplace.

## GA (v1) — must ship

1. ~~**`target-id` input**~~ ✅ landed in v1.2.0 (CHANGELOG 2026-04-25). `action.yml` on main declares the input and threads it into both top-level `target_id` and `context.target_id`.

2. ~~**Four-value `decision` output**~~ ✅ landed. `action.yml` declares `decision: 'allow/deny/hold/escalate'`; the v2.1 batch path (`runV21`) and the `wait-for-id` poller surface hold/escalate end-to-end.

3. ~~**Marketplace listing polish**~~ ✅ branding in `action.yml` (`icon: shield`, `color: green`). README + LICENSE present on main. Listing itself still on v1.0.0 — see item 4.

4. **Cut the v1.2.0 + v1.3.0 releases** — code is on main but **only v1.0.0 is tagged or released**. The Marketplace listing customers see is v1.0.0, missing every change documented in CHANGELOG since 2026-04-17:
   - **v1.2.0** (2026-04-25): `target-id` input, `risk-score` output. CHANGELOG entry notes "Source-only release. `dist/index.js` must be rebuilt before tagging — release engineering tracks the rebuild step."
   - **v1.3.0** (2026-04-30): `evaluations` / `wait-for-id` / `wait-timeout-ms` / `v2-batch` / `v2-streaming` inputs; `decisions` / `batch-id` outputs; A5 `verify-permit` wiring (`verified` is meaningful now); plus security-relevant bug fixes — `transport.ts` ECONNRESET crash, polling not retrying network errors, `wait-for-id` allow path silently fail-closed, `decisions`/`batch-id` unset on batch error, raw `SyntaxError` on bad JSON inputs, `GateInfraError` mislabeled "Unexpected error".

   Required steps (release-ops, not code):
   - `npm run build` to refresh `dist/index.js` (`@atlasent/enforce` is bundled via esbuild — there is no runtime SDK pin to chase).
   - Commit the rebuilt `dist/` if it has drifted.
   - Tag `v1.2.0` at the matching commit and `v1.3.0` at HEAD.
   - Cut GitHub Releases for both, with the existing CHANGELOG entries as release notes.
   - Move the floating `v1` major tag to `v1.3.0`.
   - Verify the Marketplace listing reflects v1.3.0.

   Tracking issue: [#25](https://github.com/AtlaSent-Systems-Inc/atlasent-action/issues/25).

## Post-GA — ordered by impact

5. **Check-run mode** — in addition to exit-code pass/fail, create a GitHub Check with risk bullets and a link to the evaluation in the console.
6. **Auto-comment on PRs** — summary comment when the action blocks.
7. **Self-hosted runner compat** — document egress requirements (api.atlasent.io), IP allowlist considerations.
8. **Matrix job support** — today one evaluation per job; allow batch eval for matrix fans. (Partially addressed by the v1.3.0 batch path, but the matrix-fan ergonomics aren't documented.)

## Cross-repo dependencies

- **atlasent-api**: the `decision` enum (`allow|deny|hold|escalate`) and the `/v1/verify-permit` endpoint are on `main` and surfaced here.
- **atlasent-sdk**: no longer a runtime dep — `@atlasent/enforce` is a workspace package bundled into `dist/index.js` at build time. The pre-v1.3.0 "pin SDK version" item is moot.
- **atlasent-docs**: needs a "CI gate" page pointing at Marketplace.

## Open questions

- Publish to GitHub Marketplace under `atlasent` or `atlasent-systems`? The org handle affects SEO.
- Fail-open or fail-closed when the AtlaSent API is unreachable? Current behavior is fail-closed (correct default); may need an opt-out for non-critical pipelines.
