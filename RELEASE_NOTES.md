# Release Notes — v2.0.0

**Release date:** 2026-04-19

## AtlaSent GitHub Actions Gate v2.0.0

Major release. The action now calls `POST /v1/evaluate` on the AtlaSent API directly — policies live server-side, and the separate permit-verify round trip has been removed. Use as a required status check to gate deployments behind an AtlaSent decision.

### Usage

```yaml
- uses: AtlaSent-Systems-Inc/atlasent-action@v2
  with:
    atlasent-api-url: ${{ vars.ATLASENT_API_URL }}
    atlasent-api-key: ${{ secrets.ATLASENT_API_KEY }}
    action-id: ci.production-deploy
    environment: production
    actor-id: ${{ github.actor }}
```

### Inputs

| Input | Required | Description |
|---|---|---|
| `atlasent-api-url` | Yes | Base URL of your AtlaSent API |
| `atlasent-api-key` | Yes | Org-scoped API key with `evaluation:execute` scope |
| `action-id` | Yes | Action identifier to evaluate (e.g. `ci.production-deploy`) |
| `environment` | No | Target environment (default: `production`) |
| `actor-id` | No | Actor identifier (default: `github.actor`) |
| `context` | No | JSON string of additional context (default: `{}`) |
| `fail-on-deny` | No | Fail the step if decision is `deny` (default: `true`) |

### Outputs

| Output | Description |
|---|---|
| `decision` | `allow`, `deny`, or `require_approval` |
| `permit-id` | Permit ID when decision is `allow` |
| `risk-level` | `low`, `medium`, `high`, or `critical` |
| `evaluation-id` | Evaluation ID for the audit trail |

### Breaking changes from v1

- Inputs renamed to kebab-case; `atlasent_anon_key`, `atlasent_base_url`, `approvals`, `change_window` removed
- Outputs renamed; `audit_hash` and `verified` removed (permit-verify step is gone)
- Consumers must migrate `@v1` → `@v2`

See [`docs/v1-migration.md`](./docs/v1-migration.md) and [`docs/DESIGN_V2.md`](./docs/DESIGN_V2.md) for migration details.

### Stability guarantees

The `@v2` tag is maintained and auto-advances to the latest v2.x patch. Pin to `@v2.0.0` for reproducibility.
