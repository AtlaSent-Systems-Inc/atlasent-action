# Changelog

All notable changes to `atlasent-action` are documented here.

## [Unreleased]

## [0.1.0] — 2026-05-02

Initial public release.

### Action
- `evaluate` step: calls `/v1-evaluate` before any deployment step executes
- `verify` step: calls `/v1-verify-permit` after execution to close the audit record
- `permit-token` output: single-use audit reference token
- `evaluation-id` output: UUID for audit trail correlation
- `proof-hash` output: tamper-evident context hash
- `verified` output: `"true"` only when evaluate returned `allow` AND verify-permit confirmed — fail-closed in all other cases
- `decision` output: single-eval decision (`allow` / `deny` / `hold` / `escalate`)
- `risk-score` output: numeric risk score or empty string
- `target-id` input: identifies the resource being gated (service name, artifact id, etc.)
- `fail-on-deny` input: set `false` for audit-only mode on policy deny
- Fail-closed: any API error, network timeout, or missing decision blocks the workflow
- GitHub Actions job summary table with decision, actor, SHA, branch, and reason

### Batch evaluation (v2.1)
- `evaluations` input: JSON array for batch mode; overrides single-eval inputs when set
- `decisions` output: JSON array of per-item decision/verification results
- `batch-id` output: server-assigned batch ID
- `wait-for-id` + `wait-timeout-ms` inputs: block on a hold/escalate until resolved
- `v2-batch` flag: opt into `/v1/evaluate/batch` endpoint
- `v2-streaming` flag: opt into SSE streaming-wait for change-window approvals

### Security
- Permit tokens are single-use; stale or consumed tokens → `verified=false`
- All network errors are fail-closed — no silent pass-through
- Transport ECONNRESET handled; polling retries both 5xx and network errors

### `@atlasent/enforce` package
- `enforce()`: evaluate → verify → verifyPermit → execute; `fn` never runs unless all three gates pass
- `verifyPermit()`: calls `POST /v1/verify-permit`; throws `EnforceError(phase="verify-permit")` for replay, expiry, network errors, and non-2xx responses
- Fail-closed: infrastructure failures (network, 5xx, 401, 429, no permit_token) always block

## [0.x] — Pre-release

Internal development and beta testing.
