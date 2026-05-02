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
    target-id: ${{ github.repository }}
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
    target-id: api-service
    environment: live
    fail-on-deny: 'true'
    context: '{"team": "platform", "service": "api"}'
```

## Using Outputs

The action sets several outputs you can reference in subsequent steps.
**Always gate on `verified`, not `decision`** — `verified=true` means the evaluation returned `allow` AND the server confirmed the permit token hasn't been replayed.

```yaml
- name: Authorization Gate
  id: gate
  uses: AtlaSent-Systems-Inc/atlasent-action@v1
  with:
    api-key: ${{ secrets.ATLASENT_API_KEY }}
    action: production_deploy
    target-id: api-service

- name: Deploy
  if: steps.gate.outputs.verified == 'true'
  run: |
    echo "Proof hash: ${{ steps.gate.outputs.proof-hash }}"
    echo "Risk score: ${{ steps.gate.outputs.risk-score }}"
    ./deploy.sh
```

### Outputs — single-eval path

| Output          | Description                                                            |
|-----------------|------------------------------------------------------------------------|
| `verified`      | `"true"` only when `decision=allow` AND permit verified; `"false"` otherwise |
| `decision`      | The evaluation result: `allow`, `deny`, `hold`, or `escalate`          |
| `permit-token`  | Single-use permit token (already consumed; kept for audit reference)   |
| `evaluation-id` | Unique evaluation ID for the audit trail                               |
| `proof-hash`    | Cryptographic proof hash for tamper detection                          |
| `risk-score`    | Numeric risk score 0–100; empty string when not assessed               |

### Outputs — batch path (`evaluations` input set)

| Output      | Description                                                                                      |
|-------------|--------------------------------------------------------------------------------------------------|
| `verified`  | `"true"` only when every allow decision verified; `"false"` otherwise                            |
| `decisions` | JSON array of per-item results: `{decision, verified, evaluationId, permitToken, reasons, verifyOutcome}` |
| `batch-id`  | Server-assigned batch ID, or `loop-<ts>` for the sequential fallback                            |

## Inputs

### Single-eval inputs

| Input          | Required | Default                | Description                                             |
|----------------|----------|------------------------|---------------------------------------------------------|
| `api-key`      | Yes      | —                      | AtlaSent API key (`ask_live_*` or `ask_test_*`)         |
| `action`       | Yes*     | —                      | Action type to evaluate (e.g. `production_deploy`). Ignored when `evaluations` is set. |
| `actor`        | No       | `${{ github.actor }}`  | Actor identity                                          |
| `target-id`    | No       | —                      | Target resource being acted on (service, artifact, etc) |
| `environment`  | No       | Auto-detected          | `live` for `main`/`master`, `test` otherwise            |
| `api-url`      | No       | `https://api.atlasent.io` | AtlaSent API base URL                               |
| `fail-on-deny` | No       | `true`                 | Fail the step on deny/hold/escalate                     |
| `context`      | No       | `{}`                   | Additional JSON context for evaluation                  |

### Batch inputs (v2.1)

| Input              | Required | Default   | Description                                                          |
|--------------------|----------|-----------|----------------------------------------------------------------------|
| `evaluations`      | No       | —         | JSON array of evaluation requests. When set, single-eval inputs are ignored. |
| `wait-for-id`      | No       | —         | Evaluation ID to block on until it reaches a terminal state (allow/deny). |
| `wait-timeout-ms`  | No       | `600000`  | Max milliseconds to wait for a terminal decision (default: 10 min). |
| `v2-batch`         | No       | `false`   | Use the `/v1/evaluate/batch` endpoint instead of sequential loop.   |
| `v2-streaming`     | No       | `false`   | Use Server-Sent Events for `wait-for-id` polling instead of HTTP polling. |

## Batch evaluation (v2.1)

Evaluate multiple actions in a single step and consume per-item results from the `decisions` output:

```yaml
- uses: atlasent-systems-inc/atlasent-action@v1
  id: gate
  with:
    api-key: ${{ secrets.ATLASENT_API_KEY }}
    evaluations: |
      [
        {"action": "build", "actor": "${{ github.actor }}", "environment": "production"},
        {"action": "deploy", "actor": "${{ github.actor }}", "environment": "production"}
      ]
- name: Use results
  run: echo '${{ steps.gate.outputs.decisions }}'
```

The step fails (fail-closed) if any evaluation returns `deny`, `hold`, or `escalate`. Check `verified == 'true'` before proceeding.

## Streaming wait (v2.1)

For long-running approvals such as change-window gates, enable `v2-streaming` to consume the AtlaSent SSE stream instead of polling. The step blocks until the evaluator reaches a terminal decision or `wait-timeout-ms` elapses:

```yaml
- uses: atlasent-systems-inc/atlasent-action@v1
  with:
    api-key: ${{ secrets.ATLASENT_API_KEY }}
    action: production_deploy
    actor: ${{ github.actor }}
    v2-streaming: 'true'
    wait-timeout-ms: '600000'
```

When `v2-streaming` is `false` (the default) the action falls back to 5-second HTTP polling — behaviour is identical, only the transport differs.

## OIDC / keyless identity

The `actor` input defaults to `${{ github.actor }}`, so no additional identity setup is needed. The action automatically embeds the GitHub username in the evaluation context sent to AtlaSent.

To use keyless policies, ensure your AtlaSent policy references GitHub usernames or teams directly (e.g. `actor == "github:octocat"` or `actor in team:"github:platform-eng"`). No extra OIDC token exchange is required — the `api-key` authenticates the workflow, and `actor` carries the human identity for policy evaluation.

```yaml
- uses: AtlaSent-Systems-Inc/atlasent-action@v1
  with:
    api-key: ${{ secrets.ATLASENT_API_KEY }}
    action: production_deploy
    # actor defaults to ${{ github.actor }} — no extra config needed
```

## Batch Mode

Evaluate multiple actions in a single step:

```yaml
- name: Batch Authorization Gate
  id: gate
  uses: AtlaSent-Systems-Inc/atlasent-action@v1
  with:
    api-key: ${{ secrets.ATLASENT_API_KEY }}
    evaluations: |
      [
        {"action": "deploy.staging", "actor": "${{ github.actor }}"},
        {"action": "deploy.prod",    "actor": "${{ github.actor }}"}
      ]

- name: Deploy
  if: steps.gate.outputs.verified == 'true'
  run: ./deploy.sh
```

## How It Works

1. **Evaluate** — POST `/v1/evaluate` with `action_type`, `actor_id`, `target_id`, and a context object populated from GitHub workflow metadata (repo, ref, sha, workflow, run id, PR number, optional user-supplied `context`).
2. **Decide** — Server returns `allow` / `deny` / `hold` / `escalate` plus a single-use `permit_token` (only when `allow`) and an optional `risk-score`.
3. **Verify permit** — POST `/v1/verify-permit` to confirm the token hasn't been replayed. `verified=true` only when both steps pass.
4. **Proceed or block** — `fail-on-deny: true` (default) surfaces deny/hold/escalate as a failing step. `false` demotes them to a workflow `::warning`.
5. **Audit** — Every evaluation writes to the AtlaSent append-only, hash-chained audit log. The `evaluation-id` and `proof-hash` outputs reference the record.

## Protecting `main`

Add the action as a required check:

1. Add secret `ATLASENT_API_KEY` in **Settings → Secrets and variables → Actions**
2. Wire the step into `.github/workflows/deploy.yaml`
3. Enable **Settings → Branches → Branch protection rules** and mark the workflow as required

## Fail-closed on infrastructure errors

If the action cannot reach the AtlaSent API (DNS, timeout, 5xx, 401/403, 429), it fails the step with `decision=error`. A security gate that silently lets deploys through when its authority source is unreachable is worse than no gate, so this is the default and recommended behaviour.

This is distinct from `fail-on-deny`, which controls only how *policy* decisions (`deny` / `hold` / `escalate`) are surfaced. Infrastructure failures are not policy decisions and always fail closed.

## Documentation

- Full docs: <https://atlasent.io/docs>
- API key guide: [docs/api-keys.md](https://github.com/AtlaSent-Systems-Inc/atlasent-api/blob/main/docs/api-keys.md)
- Examples: <https://github.com/AtlaSent-Systems-Inc/atlasent-examples>

## License

MIT — see [LICENSE](./LICENSE).
