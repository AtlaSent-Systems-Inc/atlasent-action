# Changelog

All notable changes to `atlasent-action` are documented here.

## [2.1.0-beta] — 2026-04-29

### Added
- **`@atlasent/enforce` package** (`packages/enforce`) — standalone npm package
  implementing the fail-closed `evaluate → verify → execute` contract. The
  action's single-eval path now delegates HTTP transport and infra-error
  classification to `@atlasent/enforce`'s `evaluate()`.
- **Batch fan-out** — new `evaluations` input accepts a JSON array of evaluation
  requests. Fans out via `POST /v1/evaluate/batch` (when `ATLASENT_V2_BATCH=true`)
  or per-item loop fallback. Aggregate decision follows `deny > hold > escalate > allow`.
- **`decisions-json` output** — full JSON array of per-evaluation decisions for
  downstream matrix jobs (batch path only).
- **Streaming wait** — new `wait-for-id` and `wait-timeout-ms` inputs block the
  step on a `hold`/`escalate` decision until an approver issues a terminal
  decision. Uses SSE (`ATLASENT_V2_STREAMING=true`) or 5-second polling fallback.
- **Tenant-flag model** — `ATLASENT_V2_BATCH` and `ATLASENT_V2_STREAMING` env
  vars gate the new code paths; both default to the safe fallback so existing
  workflows are unaffected.
- **53 tests** — `@atlasent/enforce` (30) + action modules (23) covering both
  polling and SSE paths, batch fan-out, input parsing, and contract invariants.

### Changed
- Default `api-url` updated from the Supabase edge URL to `https://api.atlasent.io`.
  Evaluate endpoint changed from `/v1-evaluate` to `/v1/evaluate`.
- Single-eval path inline HTTP transport (~100 lines) replaced by
  `@atlasent/enforce`'s `evaluate()`; `EnforceError(phase="evaluate")` now owns
  all infra-error classification.

### Fixed
- Infra errors (transport failure, 5xx, 401/403, 429) now always fail closed
  regardless of `fail-on-deny`. Previously they were routed through the
  `fail-on-deny` branch, which could silently pass the gate when `fail-on-deny: false`.

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
