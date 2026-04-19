# Changelog

All notable changes to `atlasent-action` are documented here.

## [2.0.0] — 2026-04-19

### Breaking Changes
- Inputs renamed from snake_case to kebab-case; `atlasent_api_key` → `atlasent-api-key`, `action` → `action-id`, etc.
- New required input `atlasent-api-url`; `atlasent_anon_key` / `atlasent_base_url` removed
- `verify` step removed; the action now only calls `POST /v1/evaluate` (no permit-verify round trip)
- Outputs renamed: `decision_id` → `evaluation-id`, `permit_token` → `permit-id`; `audit_hash` and `verified` removed
- New output `risk-level` surfaces the server-side risk assessment
- `change_window` / `approvals` inputs removed; send policy context via the new `context` JSON input
- Consumers must switch `uses: ...@v1` → `uses: ...@v2`

### Changed
- Rewritten in TypeScript; bundled with `@vercel/ncc` into `dist/index.js`
- Runtime stays on `node20`
- Dependency bumps: `@actions/core` 1 → 2, `typescript` 5 → 6, `vitest` 1 → 4, `@vercel/ncc` 0.38.1 → 0.38.4; dropped unused `@actions/github`

### Migration
See [`docs/v1-migration.md`](./docs/v1-migration.md) and [`docs/DESIGN_V2.md`](./docs/DESIGN_V2.md).

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
