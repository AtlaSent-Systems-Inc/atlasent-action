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
| `decision`      | The evaluation result: `allow`, `deny`, `hold`, or `escalate`     |
| `permit-token`  | The permit token for authorized actions (`pt_*` prefix)           |
| `evaluation-id` | Unique evaluation ID for the audit trail                          |
| `proof-hash`    | Cryptographic proof hash for tamper detection                     |

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

## Fail-open on network error (by design)

If the action cannot reach the AtlaSent API (DNS, timeout, 5xx), it emits a `::warning::` and lets the workflow proceed. This is **intentional** — an outage at AtlaSent should not block every production deploy across every customer.

If you want strict fail-closed behaviour on network errors, set `fail-on-deny: true` and wrap the step so a `decision=error` output also fails the job. See the FAQ in the AtlaSent docs.

## Documentation

- Full docs: <https://atlasent.io/docs>
- API key guide: [docs/api-keys.md](https://github.com/AtlaSent-Systems-Inc/atlasent-api/blob/main/docs/api-keys.md)
- Examples: <https://github.com/AtlaSent-Systems-Inc/atlasent-examples>

## License

MIT — see [LICENSE](./LICENSE).
