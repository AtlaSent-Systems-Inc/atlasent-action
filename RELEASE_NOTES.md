# Release Notes — v1.3.0

**Release date:** 2026-04-30

## AtlaSent GitHub Actions Gate v1.3.0

### Highlights

- **Verify-permit contract** — `verified=true` only when `evaluate` returns `allow` AND `/v1/verify-permit` confirms the permit token. Replay/expired/revoked tokens are fail-closed. Single-eval path delegates to `@atlasent/enforce`.
- **v2.1 batch mode** — `evaluations` input accepts a JSON array. `runV21 → evaluateMany → per-decision verifyOne`. Outputs: `decisions` (JSON array), `batch-id`.
- **Streaming wait** — `wait-for-id` blocks on a hold/escalate decision until the upstream approver resolves it, via SSE or HTTP polling. `wait-timeout-ms`, `v2-batch`, `v2-streaming` flags.
- **99 SIM tests** across 9 test files covering gate, batch, stream, v21, inputs, evaluate, verify, verify-permit, and enforce.
- **Bug fixes** — transport ECONNRESET crash, polling retry inconsistency, JSON parse error messages, GateInfraError labelling, batch outputs unset on error, hold/escalate included in `failed` flag.

### Inputs added

| Input | Description |
|---|---|
| `evaluations` | JSON array of `{action, actor, ...}` objects for batch mode |
| `wait-for-id` | Evaluation ID to block on until terminal decision |
| `wait-timeout-ms` | Max wait time in ms (default: 600000) |
| `v2-batch` | Use `/v1/evaluate/batch` endpoint (default: false) |
| `v2-streaming` | Use SSE stream for wait (default: false) |

### Outputs added

| Output | Description |
|---|---|
| `decisions` | JSON array of per-item results (batch path) |
| `batch-id` | Server-assigned batch ID |
| `verified` | `"true"` only when every allow decision passed `/v1/verify-permit` |

### Breaking changes

None. Single-eval path behavior is identical; new inputs are opt-in.

---

# Release Notes — v1.0.0

**Release date:** 2026-04-17

## AtlaSent GitHub Actions Gate v1.0.0

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
