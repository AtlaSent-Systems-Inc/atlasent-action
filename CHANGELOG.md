# Changelog

All notable changes to `atlasent-action` are documented here.

## [Unreleased]

## [1.3.0] — 2026-04-30

### Bug fixes
- **`wait-for-id` allow path was permanently broken** — when
  `waitForTerminalDecision` resolved a hold/escalate to `allow`,
  `v21.ts` assigned the terminal decision without calling `verifyOne`.
  `verified` was always `undefined`, so `allVerified` was always
  `false`. The hold → allow path now calls `verifyOne` on the terminal
  permit (no `permitToken` → `verified=false`, fail-closed).
- **`decisions` and `batch-id` outputs unset on batch error** —
  the `runV21()` catch block only wrote `verified=false` before
  `setFailed`. Downstream steps using `if: always()` got unset values.
  Now emits `decisions=[]` and `batch-id=""` before failing.
- **Transport ECONNRESET crash** — `packages/enforce/src/transport.ts`
  had no `res.on("error")` handler. A mid-response connection reset
  fired an unhandled EventEmitter error and crashed Node.js. Fixed by
  adding `res.on("error", reject)` alongside `req.on("error", reject)`.
- **Polling retried 5xx but not network errors** — `waitViaPolling`
  swallowed non-2xx responses but let `fetch` throws (network errors,
  malformed-JSON 200s) propagate immediately, breaking the retry
  contract. Both cases now swallowed and retried; `AbortError` is
  re-thrown so caller cancellation still works.
- **Raw `SyntaxError` leaked on bad `evaluations`/`context` JSON** —
  `parseInputs` called `JSON.parse` without try/catch; invalid JSON
  surfaced as `Unexpected error: SyntaxError: ...`. Now reports
  `` `evaluations` is not valid JSON `` and `` `context` is not valid
  JSON ``.
- **`GateInfraError` labelled "Unexpected error"** — the batch catch
  block in `index.ts` only recognised `EnforceError` for clean message
  formatting. `GateInfraError` from `verifyOne` on a 5xx appeared as
  `Unexpected error: verify-permit HTTP 500`. Now detected alongside
  `EnforceError`.

### Action — v1-verify-permit wiring (A5 end-to-end)
- `verified` output: `"true"` only when evaluate returned `decision=allow`
  AND `/v1/verify-permit` confirmed `verified=true`; `"false"` in every
  other case. Downstream steps must branch on `verified`, not re-derive
  from `decision`.
- `src/gate.ts`: `verifyOne()` and `GateInfraError` for the verify-permit
  round-trip; infrastructure failures (network, 5xx, 401, 429, no
  permit_token) are always fail-closed. Single-eval enforcement delegated
  to `@atlasent/enforce`; `verifyOne()` is used by the v2.1 batch path.
- 9 SIM tests (`src/__tests__/gate.test.ts`) for `verifyOne()`.
- `permit-token` output is an audit reference (single-use, already consumed).
- Replay protection: stale or consumed `permit_token` → `verified=false`.

### Action — v2.1 batch entry point (B.AC4)
- `evaluations` input: JSON array of evaluation requests for batch
  mode. When set, `action` / `actor` / `context` are ignored and the
  v2.1 path (`runV21` → `evaluateMany` → per-decision `verifyOne`) is
  used instead of the single-eval path.
- `wait-for-id`, `wait-timeout-ms` inputs: block on a hold/escalate
  decision until the upstream approver flips it (SSE stream or polling).
- `v2-batch`, `v2-streaming` flags: opt in to `/v1/evaluate/batch` and
  SSE streaming respectively.
- `decisions` output: JSON array of per-item results for the batch path.
- `batch-id` output: server-assigned batch ID (or `loop-<ts>` for the
  sequential fallback).
- `verified` on the batch path: `"true"` only when every allow decision
  verified; `"false"` otherwise.
- 6 batch SIM tests (`src/__tests__/batch.test.ts`).

### `@atlasent/enforce` — verifyPermit step
- `verifyPermit(config, decision)`: calls POST `/v1/verify-permit`;
  throws `EnforceError(phase="verify-permit")` for replay, expired
  tokens, no permit_token, network errors, and `!2xx` responses.
- `enforce()` updated: `evaluate → verify → verifyPermit → execute`.
  `fn` never runs unless all three gates pass. Return gains
  `verifyOutcome`.
- New `EnforcePhase` value: `"verify-permit"`.
- 14 SIM tests (`verify-permit.test.ts`); `enforce.test.ts` updated to
  mock both evaluate and verify-permit calls.
- 5 socket-level tests (`transport.test.ts`) covering success, request
  error, response-stream error (ECONNRESET), timeout, and header forwarding.
- Built `packages/enforce/dist/` (`index.js`, `index.d.ts`, `transport.js`).

### Action — v21 + stream SIM tests
- 10 SIM tests for `runV21()` (`src/__tests__/v21.test.ts`): items passed
  to `evaluateMany`, single action wrapped into a 1-item batch, batchId
  forwarded, `failed` flag respects `failOnDeny`, `waitForTerminalDecision`
  called/skipped based on `waitForId` matching a hold/escalate id.
  Dependencies mocked via `vi.mock()`.
- 8 SIM tests for `waitForTerminalDecision()` (`src/__tests__/stream.test.ts`),
  covering the polling path (immediate allow/deny, non-terminal retry,
  timeout) and the SSE streaming path (terminal event, non-terminal skip,
  body shape, non-2xx error).
- Timeout test uses `vi.useFakeTimers()` / `vi.advanceTimersByTimeAsync()`
  to avoid real 5-second poll intervals in CI.

### CI
- `test.yml`: `Check evaluate step present` updated to grep `src/batch.ts`
  for `v1/evaluate` instead of the removed `runGate()` path in `src/gate.ts`.

### Action — enforce unification
- Single-eval path now uses `@atlasent/enforce` as the canonical
  enforcement wrapper; `runGate()` (parallel fetch-based implementation)
  removed from production code. `src/gate.ts` now only exports
  `verifyOne()` and `GateInfraError` for the v2.1 batch path.
- `@atlasent/enforce` added as a workspace dependency; esbuild bundles
  it into `dist/index.js`.
- Default `api-url` changed from the Supabase function base to
  `https://api.atlasent.io` to match the enforce package's default and
  the current REST API.
- `fail-on-deny=false` behaviour preserved: only `phase="verify"` errors
  (policy decisions) respect the flag; all other phases remain
  fail-closed.
- Gate SIM tests retargeted: 18 `runGate()` tests replaced with 9
  focused `verifyOne()` tests (`src/__tests__/gate.test.ts`).

### Workflows
- `deploy.yaml`: fixed stale inputs (`atlasent_api_key` → `api-key`,
  removed `atlasent_anon_key`/`approvals`/`change_window`) and stale
  outputs (`decision_id` → `evaluation-id`, `audit_hash` →
  `proof-hash`) to match current `action.yml`.
- `test.yml`: grep targets corrected to `src/gate.ts`; build,
  typecheck, and test steps added to CI.

## [1.2.0] — 2026-04-25

### Added
- `target-id` input — identifies the resource being acted on (service
  name, artifact id, etc). Threaded into both top-level `target_id`
  and `context.target_id` in the evaluate request so policies can
  gate on _what_ is being deployed in addition to _who_ is deploying.
- `risk-score` output — exposes the numeric risk score from the
  Decision response. Probes the canonical `result.risk.score` shape
  first (matches atlasent-api openapi `Decision.risk`) and falls back
  to a flat `result.risk_score` for older evaluators. Empty string
  when neither is present so downstream `if: steps.gate.outputs.risk-score`
  branches don't see `undefined`.

### Notes
- Source-only release. `dist/index.js` must be rebuilt
  (`npm run build`) before tagging — release engineering tracks the
  rebuild step.

## [1.0.0] — 2026-04-17

### Added
- `evaluate` step: calls `/v1-evaluate` before any deployment step executes
- `verify` step: calls `/v1-verify-permit` after execution to close the audit record
- `permit_token` output: single-use token passed from evaluate to verify
- `decision_id` output: UUID for audit trail correlation
- `audit_hash` output: tamper-evident context hash
- `verified` output: boolean confirming execution-time permit validation
- Fail-closed behavior: any API error, network timeout, or missing decision blocks the workflow
- GitHub Actions job summary table with decision, actor, SHA, branch, and reason
- Support for `change_window` and `approvals` context inputs for GxP environments
- `atlasent_base_url` input for self-hosted AtlaSent deployments

### Security
- Permit tokens are single-use and expire after 5 minutes
- All API calls use `--max-time 30` to prevent indefinite hangs
- Fail-closed: missing or malformed responses block the workflow

## [0.x] — Pre-release

Internal development and beta testing.
