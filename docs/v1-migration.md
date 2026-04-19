# Migrating from v1 to v2

`atlasent-action@v2` removes the bundled evaluator and calls `POST /v1/evaluate`
on the AtlaSent API directly. Policies live server-side; the local permit-verify
round trip is gone. This is a major version bump with breaking changes.

## At a glance

1. Rename every input key (snake_case → kebab-case) and add the new required
   `atlasent-api-url`.
2. Drop `atlasent_anon_key`, `atlasent_base_url`, `approvals`, and
   `change_window` — send arbitrary policy context via the new `context` JSON
   input instead.
3. Rename output refs (`decision_id` → `evaluation-id`, `permit_token` →
   `permit-id`). Remove references to `audit_hash` and `verified`.
4. Drop the second `verify` step (`if: always()`) — it no longer exists in v2.
5. Update your `uses:` line from `@v1` to `@v2`.

## Input rename table

| v1 | v2 | Notes |
|---|---|---|
| `atlasent_api_key` | `atlasent-api-key` | Kebab-case |
| — | `atlasent-api-url` | **New required input** — base URL of your AtlaSent API |
| `action` | `action-id` | Now always an action identifier string (e.g. `ci.production-deploy`) |
| `environment` | `environment` | Default changed from `prod` → `production` |
| — | `actor-id` | New; defaults to `github.actor` |
| — | `context` | New; JSON string of arbitrary policy context |
| — | `fail-on-deny` | New; default `true` |
| `atlasent_anon_key` | *removed* | Supabase anon key no longer needed |
| `atlasent_base_url` | *removed* | Use `atlasent-api-url` instead |
| `approvals` | *removed* | Pass via `context` if your server policy uses it |
| `change_window` | *removed* | Pass via `context` if your server policy uses it |

## Output rename table

| v1 | v2 | Notes |
|---|---|---|
| `decision` | `decision` | Values: `allow`, `deny`, `require_approval` |
| `decision_id` | `evaluation-id` | Renamed |
| `permit_token` | `permit-id` | Server no longer returns a single-use token |
| — | `risk-level` | New: `low` / `medium` / `high` / `critical` |
| `audit_hash` | *removed* | No local tamper-evident hash; audit trail lives server-side |
| `verified` | *removed* | Permit-verify step is gone |

## Example

**v1:**

```yaml
- uses: AtlaSent-Systems-Inc/atlasent-action@v1
  with:
    atlasent_api_key: ${{ secrets.ATLASENT_API_KEY }}
    atlasent_anon_key: ${{ vars.ATLASENT_ANON_KEY }}
    action: production-deploy
    environment: prod
    approvals: 2
    change_window: true

# ... deploy steps ...

- name: Verify permit
  if: always()
  uses: AtlaSent-Systems-Inc/atlasent-action@v1
  with:
    atlasent_api_key: ${{ secrets.ATLASENT_API_KEY }}
    atlasent_anon_key: ${{ vars.ATLASENT_ANON_KEY }}
    action: verify
    permit_id: ${{ steps.gate.outputs.permit-id }}
    outcome: ${{ job.status == 'success' && 'success' || 'failure' }}
```

**v2:**

```yaml
- uses: AtlaSent-Systems-Inc/atlasent-action@v2
  with:
    atlasent-api-url: ${{ vars.ATLASENT_API_URL }}
    atlasent-api-key: ${{ secrets.ATLASENT_API_KEY }}
    action-id: ci.production-deploy
    environment: production
    actor-id: ${{ github.actor }}
    context: |
      {
        "approvals": 2,
        "change_window": true
      }

# ... deploy steps (no verify step needed) ...
```

## Further reading

- [`docs/DESIGN_V2.md`](./DESIGN_V2.md) — full design doc for v2
- [`../CHANGELOG.md`](../CHANGELOG.md) — complete list of v2 changes
