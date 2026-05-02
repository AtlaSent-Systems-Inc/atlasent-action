# Changelog

All notable changes to `atlasent-action` are documented here.

## [Unreleased]

## [1.4.0] — 2026-05-02

### Action
- `evaluations` input: JSON array for batch mode; overrides single-eval inputs when set
- `decisions` output + `batch-id` output for batch evaluation path
- `wait-for-id` + `wait-timeout-ms` inputs: block on `hold`/`escalate` until resolved
- `v2-batch` flag: opt into `/v1/evaluate/batch` endpoint
- `v2-streaming` flag: opt into SSE streaming-wait for change-window approvals; falls back to 5s polling
- `risk-score` output: numeric risk score or empty string
- `target-id` input: identifies the resource being gated (service name, artifact id, etc.)
- OIDC/keyless auth support via `auth-mode: oidc` — no long-lived API key required

### `@atlasent/enforce` package
- `verifyPermit()`: calls `POST /v1/verify-permit`; throws `EnforceError(phase="verify-permit")` for replay, expiry, network errors, and non-2xx responses
- Fail-closed: infrastructure failures (network, 5xx, 401, 429, no permit_token) always block

## [1.3.0] — 2025-12-01

### Action
- `verified` output: `"true"` only when evaluate returned `allow` AND verify-permit confirmed — fail-closed in all other cases
- Permit tokens are single-use; stale or consumed tokens → `verified=false`
- Transport ECONNRESET handled; polling retries both 5xx and network errors
- GitHub Actions job summary table with decision, actor, SHA, branch, and reason

## [1.2.0] — 2025-09-15

### Action
- `fail-on-deny` input: set `false` for audit-only mode on policy deny
- `environment` input: environment hint for policy routing
- `api-url` input: override base URL for self-hosted deployments

## [1.0.0] — 2025-06-01

### Action
- `evaluate` step: calls `/v1-evaluate` before any deployment step executes
- `verify` step: calls `/v1-verify-permit` after execution to close the audit record
- `permit-token` output: single-use audit reference token
- `evaluation-id` output: UUID for audit trail correlation
- `proof-hash` output: tamper-evident context hash
- `decision` output: single-eval decision (`allow` / `deny` / `hold` / `escalate`)
- Fail-closed: any API error, network timeout, or missing decision blocks the workflow
