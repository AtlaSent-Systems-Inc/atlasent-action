# AtlaSent Gate Action

Require execution-time authorization before critical CI/CD actions run. Drop AtlaSent into any GitHub Actions workflow with a single step.

```
Push to main → AtlaSent evaluates → permit issued → deploy
                                  → denied       → fail with reason
```

## Quick Start

```yaml
- uses: AtlaSent-Systems-Inc/atlasent-action@v1
  with:
    api-key: ${{ secrets.ATLASENT_API_KEY }}
    action: production_deploy
```

## Full Configuration

```yaml
- name: Authorization Gate
  id: gate
  uses: AtlaSent-Systems-Inc/atlasent-action@v1
  with:
    api-key: ${{ secrets.ATLASENT_API_KEY }}
    action: production_deploy
    actor: ${{ github.actor }}
    environment: live
    fail-on-deny: 'true'
    context: '{"team": "platform", "service": "api"}'
```

## Using Outputs

The action sets several outputs you can reference in subsequent steps:

```yaml
- name: Authorization Gate
  id: gate
  uses: AtlaSent-Systems-Inc/atlasent-action@v1
  with:
    api-key: ${{ secrets.ATLASENT_API_KEY }}
    action: production_deploy

- name: Deploy
  if: steps.gate.outputs.decision == 'allow'
  run: |
    echo "Deploying with permit: ${{ steps.gate.outputs.permit-token }}"
    echo "Proof hash: ${{ steps.gate.outputs.proof-hash }}"
    ./deploy.sh --permit "${{ steps.gate.outputs.permit-token }}"
```

### Outputs

| Output          | Description                                                       |
|-----------------|-------------------------------------------------------------------|
| `decision`      | The evaluation result: `allow`, `deny`, `hold`, `escalate`, or `error` |
| `permit-token`  | The permit token for authorized actions (`pt_*` prefix, masked in logs) |
| `evaluation-id` | Unique evaluation ID for the audit trail                          |
| `proof-hash`    | Cryptographic proof hash for tamper detection (masked in logs)    |

## Inputs

| Input          | Required | Default                | Description                                             |
|----------------|----------|------------------------|---------------------------------------------------------|
| `api-key`      | Yes      | —                      | AtlaSent API key (`ask_live_*` or `ask_test_*`)         |
| `action`       | Yes      | —                      | Action type to evaluate (e.g. `production_deploy`)      |
| `actor`        | No       | `${{ github.actor }}`  | Actor identity                                          |
| `environment`  | No       | Auto-detected          | `live` for `main`/`master`, `test` otherwise            |
| `api-url`      | No       | Production URL         | AtlaSent API endpoint                                   |
| `fail-on-deny` | No       | `true`                 | Fail the step if denied                                 |
| `context`      | No       | `{}`                   | Additional JSON context for evaluation                  |

## How It Works

1. **Evaluate** — POST `/v1-evaluate` with `action_type`, `actor_id`, and a context object populated from GitHub workflow metadata (repo, ref, sha, workflow, run id, PR number, optional user-supplied `context`).
2. **Decide** — Server returns `allow` / `deny` / `hold` / `escalate` plus a single-use `permit_token` (only when `allow`).
3. **Proceed or block** — `fail-on-deny: true` (default) surfaces deny/hold/escalate as a failing step. `false` demotes them to a workflow `::warning`.
4. **Audit** — Every evaluation writes to the AtlaSent append-only, hash-chained audit log. The `evaluation-id` and `proof-hash` outputs reference the record.

## Protecting `main`

Add the action as a required check:

1. Add secret `ATLASENT_API_KEY` in **Settings → Secrets and variables → Actions**
2. Wire the step into `.github/workflows/deploy.yaml`
3. Enable **Settings → Branches → Branch protection rules** and mark the workflow as required

## Fail-closed on infrastructure errors

If the action cannot confirm a policy decision, the step fails and the deploy is blocked. A gate that silently lets deploys through when its authority source is offline is worse than no gate.

This applies to:

- Network errors (DNS, timeout) reaching the AtlaSent API
- `5xx` responses from the API
- `429` rate-limit responses
- `401` / `403` auth failures (bad or revoked key)

In each of these cases `decision` is set to `error` so downstream steps can distinguish infrastructure failures from policy denials.

Policy decisions (`deny`, `hold`, `escalate`) remain governed by `fail-on-deny`: default `true` fails the step, `false` demotes to `::warning::`.

The permit token and proof hash are registered with `::add-mask::` before being emitted as outputs, so they do not appear in workflow logs in cleartext.

## Documentation

- Full docs: <https://atlasent.io/docs>
- API key guide: [docs/api-keys.md](https://github.com/AtlaSent-Systems-Inc/atlasent-api/blob/main/docs/api-keys.md)
- Examples: <https://github.com/AtlaSent-Systems-Inc/atlasent-examples>

## License

MIT — see [LICENSE](./LICENSE).
