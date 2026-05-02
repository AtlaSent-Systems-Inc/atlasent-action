# Release Notes — v1.4.0

**Release date:** 2026-05-02

## AtlaSent GitHub Action Gate v1.4.0

Adds batch evaluation, streaming-wait for change-window approvals, and OIDC keyless authentication.

### Usage

```yaml
- uses: AtlaSent-Systems-Inc/atlasent-action@v1
  with:
    api-key: ${{ secrets.ATLASENT_API_KEY }}
    action: deployment.production
    actor: ${{ github.actor }}
    context: '{"repo":"${{ github.repository "}}"}'
```

### What's new in v1.4.0

#### Batch evaluation
- `evaluations` input: JSON array for batch mode; overrides single-eval inputs when set
- `decisions` output: JSON array of per-item decision/verification results
- `batch-id` output: server-assigned batch ID or local fallback
- `v2-batch` flag: opt into `/v1/evaluate/batch` endpoint

#### Streaming wait
- `wait-for-id` + `wait-timeout-ms` inputs: block on a `hold`/`escalate` until resolved
- `v2-streaming` flag: opt into SSE streaming-wait for change-window approvals
- Falls back to 5-second polling when `v2-streaming` is `false`

#### OIDC / keyless authentication
- `auth-mode: oidc` supported — no long-lived API key required in Actions secrets
- `api-key` remains the default for backward compatibility

### Inputs

| Input | Required | Description |
|---|---|---|
| `api-key` | Yes* | AtlaSent API key (`ask_live_*` or `ask_test_*`). |
| `action` | No* | Action type for single-eval path (ignored when `evaluations` is set). |
| `actor` | No | Actor identity. Defaults to `${{ github.actor }}`. |
| `target-id` | No | Target resource identifier; propagated for policy gating. |
| `environment` | No | Environment hint (`live` on main, `test` otherwise by convention). |
| `api-url` | No | API base URL. Default: `https://api.atlasent.io`. |
| `fail-on-deny` | No | Default: `true`. Set `false` for audit-only on policy deny. |
| `context` | No | JSON context object for single-eval path. Default: `{}`. |
| `evaluations` | No | JSON array for batch mode; overrides single-eval inputs. |
| `wait-for-id` | No | Evaluation ID to wait on until terminal (`allow`/`deny`). |
| `wait-timeout-ms` | No | Wait timeout in ms when using `wait-for-id`. Default: `600000`. |
| `v2-batch` | No | Opt into `/v1/evaluate/batch`. Default: `false`. |
| `v2-streaming` | No | Opt into SSE wait stream. Default: `false`. |
| `auth-mode` | No | `api-key` (default) or `oidc` for keyless auth. |

\* `api-key` not required when `auth-mode: oidc`. `action` is effectively required for single-evaluation usage.

### Outputs

| Output | Description |
|---|---|
| `decision` | Single-eval decision (`allow` / `deny` / `hold` / `escalate`). |
| `permit-token` | Consumed permit token audit reference (single-eval path). |
| `evaluation-id` | Evaluation ID (single-eval path). |
| `proof-hash` | Cryptographic proof hash (single-eval path). |
| `risk-score` | Numeric risk score or empty string if unavailable. |
| `verified` | `"true"` only when required permit verification passes; otherwise `"false"` (fail-closed). |
| `decisions` | Batch JSON array of per-item decision/verification results. |
| `batch-id` | Batch identifier from server or local fallback. |

### Tag policy

The `@v1` tag is maintained for compatible updates within the v1 series. Pin to a specific version tag for reproducible builds.
