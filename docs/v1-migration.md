# Migrating to v1

This guide covers changes when upgrading to `atlasent-action@v1`.

## Breaking Changes from Pre-release

### Input renames

| Old | New | Notes |
|-----|-----|-------|
| `api_key` | `atlasent_api_key` | More explicit naming |
| `anon_key` | `atlasent_anon_key` | More explicit naming |
| `action_type` | `action` | Shortened |

### Output additions

v1 adds three new outputs:
- `permit_token`: pass to verify step
- `verified`: boolean from verify step  
- `audit_hash`: tamper-evident context hash

## Upgrade Example

**Before (pre-release):**
```yaml
- uses: atlasent-systems-inc/atlasent-action@v0
  with:
    api_key: ${{ secrets.ATLASENT_API_KEY }}
    action_type: deploy
```

**After (v1):**
```yaml
- name: Gate with AtlaSent
  id: gate
  uses: atlasent-systems-inc/atlasent-action@v1
  with:
    atlasent_api_key: ${{ secrets.ATLASENT_API_KEY }}
    atlasent_anon_key: ${{ secrets.ATLASENT_ANON_KEY }}
    action: production-deploy
    environment: production

# ... your deploy steps ...

- name: Verify permit
  if: always()
  uses: atlasent-systems-inc/atlasent-action@v1
  with:
    atlasent_api_key: ${{ secrets.ATLASENT_API_KEY }}
    atlasent_anon_key: ${{ secrets.ATLASENT_ANON_KEY }}
    action: verify
    permit_id: ${{ steps.gate.outputs.permit-id }}
    outcome: ${{ job.status == 'success' && 'success' || 'failure' }}
```

## New: Verify Step

v1 introduces a mandatory verify step that closes the audit record after execution. This satisfies 21 CFR Part 11 §11.10(e) audit trail requirements.

Always add a verify step with `if: always()` so it runs even when deployment fails.
