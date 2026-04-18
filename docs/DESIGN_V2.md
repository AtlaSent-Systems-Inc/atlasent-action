# atlasent-action v2 Design

## Breaking Change

`atlasent-action` v2 removes its bundled evaluator and calls `POST /v1/evaluate`
on the AtlaSent API instead. This is a **major version bump** (v2 tag).

## New Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `atlasent-api-url` | Yes | Base URL of your AtlaSent API (e.g. `https://api.atlasent.io`) |
| `atlasent-api-key` | Yes | Org-scoped API key with `evaluation:execute` scope |
| `action-id` | Yes | Action identifier to evaluate (e.g. `ci.production-deploy`) |
| `environment` | No | Target environment (default: `production`) |
| `actor-id` | No | Actor ID (default: GitHub actor) |
| `context` | No | JSON string of extra context |

## Removed Inputs (v1 → v2)

| Removed Input | Reason |
|---------------|--------|
| `policy-file` | Policies are managed server-side; no local file needed |
| `supabase-url` | Action no longer talks to Supabase directly |
| `supabase-anon-key` | Same |

## Example Usage (v2)

```yaml
- uses: atlasent-systems-inc/atlasent-action@v2
  with:
    atlasent-api-url: ${{ vars.ATLASENT_API_URL }}
    atlasent-api-key: ${{ secrets.ATLASENT_API_KEY }}
    action-id: ci.production-deploy
    environment: production
    actor-id: ${{ github.actor }}
    context: |
      {
        "ref": "${{ github.ref }}",
        "sha": "${{ github.sha }}",
        "workflow": "${{ github.workflow }}"
      }
```

## Decision Handling

The action sets these outputs:

| Output | Description |
|--------|-------------|
| `decision` | `allow`, `deny`, or `require_approval` |
| `permit-id` | Permit ID if decision is `allow` |
| `risk-level` | `low`, `medium`, `high`, or `critical` |
| `evaluation-id` | Evaluation ID for audit trail |

If the decision is `deny`, the action fails the workflow step by default
(set `fail-on-deny: false` to override).

## v1 → v2 Migration

```yaml
# v1 (deprecated)
- uses: atlasent-systems-inc/atlasent-action@v1
  with:
    supabase-url: ${{ secrets.SUPABASE_URL }}
    supabase-anon-key: ${{ secrets.SUPABASE_ANON_KEY }}
    policy-file: .atlasent/policy.yaml

# v2
- uses: atlasent-systems-inc/atlasent-action@v2
  with:
    atlasent-api-url: ${{ vars.ATLASENT_API_URL }}
    atlasent-api-key: ${{ secrets.ATLASENT_API_KEY }}
    action-id: ci.production-deploy
```
