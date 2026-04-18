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
