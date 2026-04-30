# Release Notes

## v1.3.0

**Release date:** 2026-04-30

Hardening release. Adds the v2.1 batch entry point, wires `verify-permit`
end-to-end in `@atlasent/enforce`, and fixes several fail-open and crash
paths surfaced after the v1.2.0 stamp.

### Highlights

- **v2.1 batch path** — `evaluations` input takes a JSON array of requests
  and runs through `runV21` → `evaluateMany` → per-decision `verifyOne`.
  New `decisions` and `batch-id` outputs expose per-item results.
- **Async approval gate** — `wait-for-id` / `wait-timeout-ms` block on a
  hold/escalate decision until the upstream approver flips it. SSE
  streaming via `v2-streaming`; falls back to polling.
- **`@atlasent/enforce` verify-permit step** — `enforce()` now runs
  `evaluate → verify → verifyPermit → execute`. The wrapped function
  never executes unless all three gates pass.
- **Single-eval path now uses `@atlasent/enforce`** — the parallel
  `runGate()` implementation was removed. Default `api-url` switched to
  `https://api.atlasent.io` to match the enforce package.

### Bug fixes (fail-closed correctness)

- `wait-for-id` allow path no longer skips `verifyOne` on a hold → allow
  transition (previously left `verified=undefined`, so `allVerified` was
  always `false`).
- Batch error path now sets `decisions=[]` and `batch-id=""` before
  `setFailed` so `if: always()` consumers see defined outputs.
- Transport now attaches `res.on("error", reject)` — a mid-response
  ECONNRESET no longer crashes Node.js.
- Polling loop swallows and retries `fetch` throws (network errors,
  malformed-JSON 200s) in addition to non-2xx responses; `AbortError`
  is re-thrown so caller cancellation still works.
- `parseInputs` reports `` `evaluations` is not valid JSON `` /
  `` `context` is not valid JSON `` instead of leaking raw `SyntaxError`.
- `index.ts` batch catch recognises `GateInfraError` alongside
  `EnforceError` for clean message formatting on verify-permit 5xx.
- `failed` flag now includes `hold` / `escalate` when `failOnDeny=true`.

### New inputs

| Input | Description |
|---|---|
| `evaluations` | JSON array of evaluation requests. When set, `action` / `actor` / `context` are ignored and the v2.1 path is used. |
| `wait-for-id` | Evaluation ID to block on until it reaches a terminal state. |
| `wait-timeout-ms` | Max milliseconds to wait for a terminal decision (default `600000`). |
| `v2-batch` | Opt in to `/v1/evaluate/batch` (default `false`, sequential fallback). |
| `v2-streaming` | Opt in to SSE streaming for `wait-for-id` (default `false`, polling fallback). |

### New outputs

| Output | Description |
|---|---|
| `decisions` | JSON array of per-item results for the batch path: `{decision, verified, evaluationId, permitToken, reasons, verifyOutcome}`. |
| `batch-id` | Server-assigned batch ID, or `loop-<ts>` for the sequential fallback. |

`verified` semantics on the batch path: `"true"` only when every allow
decision verified; `"false"` otherwise.

### Breaking changes

None for the single-eval path. Default `api-url` changed to
`https://api.atlasent.io`; users who previously relied on the Supabase
function base must set `api-url` explicitly.

### Notes

- `dist/index.js` is rebuilt and committed. `packages/enforce/dist/`
  (`index.js`, `index.d.ts`, `transport.js`) is built and bundled.
- See `CHANGELOG.md` for the full per-commit list.

## v1.0.0

**Release date:** 2026-04-17

### AtlaSent GitHub Actions Gate v1.0.0

First stable release. Use as a required status check to gate deployments behind an AtlaSent authorization decision.

### Usage

```yaml
- uses: AtlaSent-Systems-Inc/atlasent-action@v1
  with:
    atlasent_api_key: ${{ secrets.ATLASENT_API_KEY }}
    atlasent_anon_key: ${{ vars.ATLASENT_ANON_KEY }}
    agent: ${{ github.actor }}
    action: deployment.production
```

### Inputs

| Input | Required | Description |
|---|---|---|
| `atlasent_api_key` | Yes | Scoped API key (`evaluate` scope minimum) |
| `atlasent_anon_key` | Yes | Supabase anonymous key |
| `agent` | Yes | Agent identifier (typically `github.actor`) |
| `action` | Yes | Action class being gated |
| `context` | No | JSON object with additional context |
| `fail_on_deny` | No | Default: `true`. Set to `false` for audit-only mode |

### Outputs

| Output | Description |
|---|---|
| `decision` | `allow`, `deny`, or `hold` |
| `decision_id` | UUID for the decision record |
| `audit_hash` | SHA-256 hash of the audit chain row |
| `permit_token` | Single-use permit token (only on `allow`) |

### Stability guarantees

The `@v1` tag is maintained. Patch updates are applied automatically. Pin to `@v1.0.0` for pinned reproducibility.
