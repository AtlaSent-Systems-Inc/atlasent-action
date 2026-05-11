# atlasent-action — v1 ship plan

GitHub Action that gates CI deploys on an AtlaSent `allow` decision. Distributed via the GitHub Marketplace.

> **Last updated:** 2026-05-11

## V1 Status — May 2026

✅ Items 1–3 complete (target-id input, four-value decision output, Marketplace listing polish)
✅ B7 evidence event emitter — `execution_started` emitted after batch authorization; best-effort runtime evidence events
✅ Policy sync mode — post policy bundle to `v1-policy-sync`; fail CI on rejection
✅ Dist bundle rebuilt (ready for v1.3.0)
🔄 **PR #28 open** with automated release workflow — ready to merge → tag v1.3.0 → update Marketplace

### Marketplace status
- Only **v1.0.0** is currently live on the Marketplace
- **v1.3.0** is ready to ship once PR #28 merges
- v1.3.0 includes everything since v1.0.0 (see below)

### What v1.3.0 includes vs v1.0.0
- **Batch path** — `evaluations` / `wait-for-id` / `wait-timeout-ms` / `v2-batch` / `v2-streaming` inputs; `decisions` / `batch-id` outputs
- **Evidence event emitter** — `execution_started` emitted in `runV21` after authorization; best-effort runtime evidence events forwarded to atlasent-api
- **Policy sync mode** — post policy bundle to `v1-policy-sync`, fail CI on rejection
- **Verify-permit wiring** — `verify-permit` input is now meaningful (`verified` output populated)
- **`target-id` input** — landed in v1.2.0 (2026-04-25)
- **`risk-score` output** — landed in v1.2.0
- **All bug fixes** — `transport.ts` ECONNRESET crash, polling not retrying network errors, `wait-for-id` allow path silently fail-closed, `decisions`/`batch-id` unset on batch error, raw `SyntaxError` on bad JSON inputs, `GateInfraError` mislabeled "Unexpected error"

## GA (v1) — must ship

1. ~~**`target-id` input**~~ ✅ landed in v1.2.0 (CHANGELOG 2026-04-25).

2. ~~**Four-value `decision` output**~~ ✅ landed. `action.yml` declares `decision: 'allow/deny/hold/escalate'`; the v2.1 batch path (`runV21`) and the `wait-for-id` poller surface hold/escalate end-to-end.

3. ~~**Marketplace listing polish**~~ ✅ branding in `action.yml` (`icon: shield`, `color: green`). README + LICENSE present on main.

4. **Cut the v1.3.0 release** — **PR #28 open with automated release workflow — ready to merge → tag v1.3.0**. The Marketplace listing customers see is v1.0.0, missing every change documented in CHANGELOG since 2026-04-17.

   Required steps (automated via PR #28):
   - `npm run build` to refresh `dist/index.js`.
   - Commit the rebuilt `dist/` if it has drifted.
   - Tag `v1.3.0` at HEAD.
   - Cut GitHub Release for v1.3.0, with the existing CHANGELOG entry as release notes.
   - Move the floating `v1` major tag to `v1.3.0`.
   - Verify the Marketplace listing reflects v1.3.0.

   Tracking issue: [#25](https://github.com/AtlaSent-Systems-Inc/atlasent-action/issues/25).

## Post-GA — ordered by impact

5. **Check-run mode** — in addition to exit-code pass/fail, create a GitHub Check with risk bullets and a link to the evaluation in the console.
6. **Auto-comment on PRs** — summary comment when the action blocks.
7. **Self-hosted runner compat** — document egress requirements (api.atlasent.io), IP allowlist considerations.
8. **Matrix job support** — today one evaluation per job; allow batch eval for matrix fans. (Partially addressed by the v1.3.0 batch path, but the matrix-fan ergonomics aren't documented.)

## Gaps (identified 2026-05-11)

- **v1.3.0 Marketplace release** — PR #28 is fully ready but not yet merged. Every customer using `atlasent-systems-inc/atlasent-action@v1` is on v1.0.0 and missing 15+ bug fixes and new features. **This is the highest-priority action in this repo.**
- **No docs page for CI gate** — `atlasent-docs` needs a "CI gate" page pointing at the Marketplace listing before the FloQast pilot demo.

## Cross-repo dependencies

- **atlasent-api**: the `decision` enum (`allow|deny|hold|escalate`) and the `/v1/verify-permit` endpoint are on `main` and surfaced here.
- **atlasent-sdk**: no longer a runtime dep — `@atlasent/enforce` is a workspace package bundled into `dist/index.js` at build time.
- **atlasent-docs**: needs a "CI gate" page pointing at Marketplace.

## Open questions

- Publish to GitHub Marketplace under `atlasent` or `atlasent-systems`? The org handle affects SEO.
- Fail-open or fail-closed when the AtlaSent API is unreachable? Current behavior is fail-closed (correct default); may need an opt-out for non-critical pipelines.
