# Release Notes — v1.3.0

**Release date:** 2026-04-30

## AtlaSent GitHub Action Gate v1.3.0

This release aligns the public release notes with the shipped `action.yml` contract and the v2.1 batch/verification flow.

### Usage

```yaml
- uses: AtlaSent-Systems-Inc/atlasent-action@v1
  with:
    api-key: ${{ secrets.ATLASENT_API_KEY }}
    action: deployment.production
    actor: ${{ github.actor }}
    context: '{"repo":"${{ github.repository }}"}'
```

### Inputs

| Input | Required | Description |
|---|---|---|
| `api-key` | Yes | AtlaSent API key (`ask_live_*` or `ask_test_*`). |
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

\* `action` is effectively required for single-evaluation usage.

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

### What was corrected from v1.0.0 notes

- Replaced stale input names (`atlasent_api_key`, `atlasent_anon_key`, `agent`) with live contract keys (`api-key`, `actor`, etc.).
- Removed deprecated/incorrect outputs (`decision_id`, `audit_hash`) and documented current outputs (`evaluation-id`, `proof-hash`, `risk-score`, `decisions`, `batch-id`).
- Documented v2.1 batch controls (`evaluations`, `wait-for-id`, `v2-batch`, `v2-streaming`) and strict `verified` semantics.
- Updated default API base URL to `https://api.atlasent.io`.

### Tag policy

The `@v1` tag is maintained for compatible updates. Pin to a specific version tag for reproducible builds.
