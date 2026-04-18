# Changelog

All notable changes to `atlasent-action` are documented here.

## [1.1.0] — 2026-04-18

### Added
- **Permit-token masking.** Both `evaluate` and `verify` steps now
  register the issued `permit_token` with GitHub Actions' log-mask
  (`::add-mask::`) so it can't leak into downstream step logs,
  summaries, or third-party actions that echo `steps.*.outputs.*`.
- **429 Retry-After honoring.** On HTTP 429, the action parses the
  `Retry-After` header (seconds), sleeps up to 120s, and retries
  once before failing closed. No more fail-fast on transient limits.
- **5xx single retry.** Server errors retry once after a 3 s fixed
  backoff before failing closed.
- **SDK-canonical fields.** The action reads `permitted` first and
  falls back to native `decision == "allow"`; reads `verified` first
  and falls back to `valid`. Works against both pre- and
  post-realignment servers (see atlasent-api PR).
- New input `http_timeout_seconds` (default `60`, was hard-coded 30).

### Changed
- **HTTP response parsing rewritten.** Previously parsed the status
  from `curl -i`'s first line with `awk` and hand-split headers on
  a blank line — fragile against HTTP/2, intermediate proxies, and
  100-continue responses. Now uses `curl -w '%{http_code}\t%header{Retry-After}'`
  with `-o <body_file>`, which is deterministic.
- Every request now sends `Accept: application/json`, `X-Request-ID`
  (reusing the action's `REQUEST_ID`), and `User-Agent:
  atlasent-action/v1 gha/<run_id>` for server-side log correlation.
- Explicit null-guard in the `verify` step: if `permit_token` is
  empty or `"null"`, the step exits loudly without POSTing, instead
  of relying on the server to reject.
- Verify request body now includes both `permit_token` and
  `decision_id` — the server's SDK-canonical input field is
  `decision_id`; keeping `permit_token` for pre-realignment servers.

### Security
- Permit tokens no longer risk appearing in plain text in CI logs
  when the caller inadvertently references `steps.eval.outputs.permit_token`
  (e.g. in a `run: echo "token: ${{ … }}"` debug step).

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
