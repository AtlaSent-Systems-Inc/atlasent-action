# Changelog

All notable changes to `atlasent-action` are documented here.

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
