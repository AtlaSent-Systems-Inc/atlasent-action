# Changelog

All notable changes to `atlasent-action` are documented here.

## [0.1.0] — 2026-05-01 — initial public release

This is the first version-stable release. Earlier internal tags
(`v1.0.0` 2026-04-17, plus the source-only `v1.2.0` and `v1.3.0`
milestones) are superseded — they were aspirational version markers
during pre-release development and were never adopted by external
consumers. Resetting to `0.1.0` aligns the version contract with
SemVer (`0.x` while the public surface is still settling) and gives
us room to stabilise inputs/outputs before committing to the
SemVer-1.0 promise.

### Action

- **`evaluate` step** — calls `POST /v1-evaluate` before any
  deployment step executes. Threads `actor`, `action`, `target-id`,
  `bundle-id`, `change_window`, `approvals`, and arbitrary `context`
  into the request.
- **`verify-permit` step (A5)** — calls `POST /v1/verify-permit`
  after evaluate returns `decision: allow`. Closes the audit record
  and confirms the permit hasn't been revoked or already consumed.
  `verified` output is `"true"` only when both gates pass; `"false"`
  otherwise. Downstream steps must branch on `verified`, not
  re-derive from `decision`.
- **v2.1 batch entry point (B.AC4)** — `evaluations` input accepts
  a JSON array; the v2.1 path (`runV21` → `evaluateMany` →
  per-decision `verifyOne`) is used in place of single-eval when set.
- **`wait-for-id` / `wait-timeout-ms`** — block on a hold/escalate
  decision until the upstream approver flips it (SSE stream or
  polling fallback).
- **`v2-batch` / `v2-streaming` flags** — opt in to
  `/v1/evaluate/batch` and SSE streaming respectively.

### Outputs

- `decision` — `allow` / `deny` / `hold` / `escalate`.
- `permit-token` — single-use, audit reference (already consumed by
  the verify-permit step).
- `decision-id` — UUID for audit-trail correlation.
- `audit-hash` — tamper-evident context hash.
- `verified` — `"true"` only when verify-permit succeeded.
- `risk-score` — numeric risk score from the Decision response.
  Probes `result.risk.score` first (atlasent-api openapi
  `Decision.risk` shape), falls back to `result.risk_score` for
  older evaluators. Empty string when neither is present so
  `if: steps.gate.outputs.risk-score` doesn't see `undefined`.
- `decisions` (batch path) — JSON array of per-item results.
- `batch-id` (batch path) — server-assigned batch ID, or
  `loop-<ts>` for the sequential fallback.

### Inputs

- `api-key`, `agent`, `action`, `bundle-id`, `target-id`,
  `change_window`, `approvals`, `context`, `evaluations`,
  `wait-for-id`, `wait-timeout-ms`, `v2-batch`, `v2-streaming`.

### `@atlasent/enforce` (workspace package, v0.1.0)

- `enforce()` — orchestrator: `evaluate → verify → verifyPermit →
  execute`. The user-supplied `fn` never runs unless all three
  gates pass.
- `verifyPermit(config, decision)` — `POST /v1-verify-permit`;
  throws `EnforceError(phase="verify-permit")` for replay, expired
  tokens, missing `permit_token`, network errors, and `!2xx`
  responses.
- `EnforcePhase` enum: `evaluate | verify | verify-permit | execute`.

### Fail-closed behaviour

Every error path blocks the workflow:

- API unreachable, request timeout, or 5xx → step fails.
- Evaluator returns no `permit_token` for an `allow` → step fails.
- Verify-permit returns `verified: false` → `verified` output is
  `"false"`, step continues if `failOnDeny=false`, fails otherwise.
- Replay or consumed permit → `verified: false`, fail-closed.
- Malformed JSON in `evaluations` / `context` inputs → typed error
  message (no raw `SyntaxError` leakage).
- Hold / escalate → step fails when `failOnDeny=true`; gates
  downstream steps via `decision != "allow"` regardless.

### Reliability fixes baked in

- `transport.ts` handles mid-response `ECONNRESET` cleanly
  (`res.on("error", reject)` alongside `req.on("error", reject)`).
  Earlier internal builds crashed Node.js on the unhandled emitter.
- `waitViaPolling` retries both 5xx and `fetch` throws (network
  errors, malformed-JSON 200s); `AbortError` is re-thrown so
  caller cancellation still works.
- Batch error path emits `decisions=[]` and `batch-id=""` before
  failing so downstream `if: always()` steps see defined values.
- `wait-for-id` allow path: when polling resolves a hold/escalate
  to `allow`, `verifyOne` is called on the terminal permit (no
  `permitToken` → `verified=false`, fail-closed).

### Test surface (99 unit tests)

- `src/__tests__/gate.test.ts` — 9 SIM tests for `verifyOne()`.
- `src/__tests__/batch.test.ts` — 6 batch SIM tests.
- `src/__tests__/inputs.test.ts` — JSON parsing + error message tests.
- `packages/enforce/src/__tests__/verify-permit.test.ts` — 14 SIM tests.
- `packages/enforce/src/__tests__/transport.test.ts` — 5 socket-level tests.
- `packages/enforce/src/__tests__/enforce.test.ts` — orchestrator tests.

### GitHub Actions job summary

Renders a markdown table with decision, actor, SHA, branch, reason,
permit-token, audit-hash for every run (success or failure).

### GxP support

`change_window` and `approvals` context inputs ride through to the
evaluator without modification, enabling deny-on-out-of-window and
deny-on-missing-approval policies in regulated environments.

## [0.x] — Pre-release

The repository's earlier `v1.0.0` (2026-04-17), source-only
`v1.2.0` (2026-04-25), and source-only `v1.3.0` (2026-04-30)
milestones predate this release. They were not adopted by external
consumers and are not represented as separate Marketplace releases.
All shipped behaviour from those milestones is documented under
`[0.1.0]` above.
