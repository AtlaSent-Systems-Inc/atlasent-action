# AtlaSent Gate Action

Require execution-time authorization before critical CI/CD actions run. Drop AtlaSent into any GitHub Actions workflow with a single step.

```
Push to main → AtlaSent evaluates → permit issued → deploy
                                  → denied       → fail with reason
```

## Quick Start

```yaml
# Recommended: keyless auth via GitHub OIDC (v2)
- uses: AtlaSent-Systems-Inc/atlasent-action@v2
  with:
    auth-mode: oidc
    action: production_deploy
    target-id: ${{ github.repository }}

# Alternative: API key auth
- uses: AtlaSent-Systems-Inc/atlasent-action@v2
  with:
    api-key: ${{ secrets.ATLASENT_API_KEY }}
    action: production_deploy
    target-id: ${{ github.repository }}
```

## Full Configuration

```yaml
- name: Authorization Gate
  id: gate
  uses: AtlaSent-Systems-Inc/atlasent-action@v2
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

```yaml
- name: Authorization Gate
  id: gate
  uses: AtlaSent-Systems-Inc/atlasent-action@v2
  with:
    api-key: ${{ secrets.ATLASENT_API_KEY }}
    action: production_deploy
    target-id: api-service

- name: Deploy
  if: steps.gate.outputs.decision == 'allow'
  run: |
    echo "Proof hash: ${{ steps.gate.outputs.proof-hash }}"
    echo "Risk score: ${{ steps.gate.outputs.risk-score }}"
    ./deploy.sh --permit "${{ steps.gate.outputs.permit-token }}"
```

## Batch Evaluation

Gate multiple actions in a single step. Results fan out in parallel; the aggregate decision is `deny > hold > escalate > allow`.

```yaml
- name: Multi-service Gate
  id: gate
  uses: AtlaSent-Systems-Inc/atlasent-action@v2
  with:
    api-key: ${{ secrets.ATLASENT_API_KEY }}
    evaluations: |
      [
        { "action": "deploy.staging",    "actor": "${{ github.actor }}", "environment": "staging" },
        { "action": "deploy.production", "actor": "${{ github.actor }}", "environment": "live" }
      ]

- name: Show per-service results
  run: echo '${{ steps.gate.outputs.decisions-json }}'
```

`evaluations` takes precedence over `action` when both are set, so existing single-eval workflows are unaffected.

## Streaming Wait (change window approvals)

Block the job until an approver issues a terminal decision on a specific evaluation:

```yaml
- name: Deploy Gate
  id: gate
  uses: AtlaSent-Systems-Inc/atlasent-action@v2
  with:
    api-key: ${{ secrets.ATLASENT_API_KEY }}
    action: production_deploy
    wait-for-id: ${{ vars.CHANGE_WINDOW_EVAL_ID }}
    wait-timeout-ms: '1800000'   # 30 min
    fail-on-deny: 'true'
```

When the matched evaluation is `hold` or `escalate`, the step blocks and polls for a terminal decision. Set `ATLASENT_V2_STREAMING=true` to use Server-Sent Events instead of 5-second polling.

## Inputs

### Single evaluation

| Input          | Required | Default                | Description                                              |
|----------------|----------|------------------------|----------------------------------------------------------|
| `api-key`      | Yes*     | —                      | AtlaSent API key (`ask_live_*` or `ask_test_*`)          |
| `action`       | Yes*     | —                      | Action type to evaluate (e.g. `production_deploy`)       |
| `actor`        | No       | `${{ github.actor }}`  | Actor identity                                           |
| `target-id`    | No       | `GITHUB_REPOSITORY`    | Target resource (service name, artifact id, etc)         |
| `environment`  | No       | Auto-detected          | `live` for `main`/`master`, `test` otherwise             |
| `api-url`      | No       | `https://api.atlasent.io` | AtlaSent API endpoint                                 |
| `fail-on-deny` | No       | `true`                 | Fail the step on deny/hold/escalate                      |
| `context`      | No       | `{}`                   | Additional JSON context for evaluation                   |

*`api-key` and `action` are required for the single-eval path. For OIDC auth (`auth-mode: oidc`), `api-key` is not needed.

### Batch evaluation

| Input          | Required | Default   | Description                                                                      |
|----------------|----------|-----------|----------------------------------------------------------------------------------|
| `evaluations`  | No       | —         | JSON array of `{ action, actor, environment?, context? }`. Takes precedence over `action` when set. |

### Streaming wait

| Input             | Required | Default    | Description                                                           |
|-------------------|----------|------------|-----------------------------------------------------------------------|
| `wait-for-id`     | No       | —          | Evaluation ID to block on when decision is `hold` or `escalate`       |
| `wait-timeout-ms` | No       | `600000`   | Max milliseconds to wait for a terminal decision (default: 10 min)    |

## Outputs

| Output           | Path         | Description                                                          |
|------------------|--------------|----------------------------------------------------------------------|
| `decision`       | Both         | Evaluation result: `allow`, `deny`, `hold`, `escalate`, or `error`  |
| `permit-token`   | Single       | Single-use permit token (present on `allow`)                         |
| `evaluation-id`  | Single       | Evaluation ID for the audit trail                                    |
| `proof-hash`     | Single       | Cryptographic proof hash for tamper detection                        |
| `risk-score`     | Single       | Numeric risk score 0–100; empty string when not assessed             |
| `decisions-json` | Batch        | JSON array of all per-evaluation decisions                           |

## How It Works

**Single-eval path:**

1. **Evaluate** — `@atlasent/enforce` POSTs `/v1/evaluate` with `action_type`, `actor_id`, `target_id`, and a GitHub context object (repo, ref, sha, workflow, run id, PR number, user `context`).
2. **Decide** — Server returns `allow` / `deny` / `hold` / `escalate` plus a single-use `permit_token` and optional `risk-score`.
3. **Wait** (optional) — If `wait-for-id` matches the evaluation and the decision is `hold`/`escalate`, the step blocks until the approver issues a terminal decision.
4. **Proceed or block** — `fail-on-deny: true` (default) surfaces deny/hold/escalate as a failing step. `false` demotes them to `::warning`.
5. **Audit** — Every evaluation writes to the AtlaSent append-only, hash-chained audit log. `evaluation-id` and `proof-hash` reference the record.

**Batch path:**

Same as above, but `evaluations` items fan out in parallel. The aggregate `decision` output follows `deny > hold > escalate > allow`. Full per-item results are in `decisions-json`.

## Tenant flags

Two environment variables gate the new v2.1 code paths. Both default to the safe fallback so no API endpoints need to be live to use the action.

| Variable | Effect when `true` | Default (false) |
|---|---|---|
| `ATLASENT_V2_BATCH` | `POST /v1/evaluate/batch` for batch fan-out | Per-item loop on `/v1/evaluate` |
| `ATLASENT_V2_STREAMING` | SSE consumer on `/v1/evaluate/stream` for wait | 5-second polling on `GET /v1/evaluate/:id` |

## Protecting `main`

1. Add secret `ATLASENT_API_KEY` in **Settings → Secrets and variables → Actions**
2. Wire the step into `.github/workflows/deploy.yaml`
3. Enable **Settings → Branches → Branch protection rules** and mark the workflow as required

## Fail-closed on infrastructure errors

If the action cannot reach the AtlaSent API (DNS, timeout, 5xx, 401/403, 429), it fails the step with `decision=error`. A security gate that silently lets deploys through when its authority source is unreachable is worse than no gate.

This is distinct from `fail-on-deny`, which governs only *policy* decisions (`deny` / `hold` / `escalate`). Infrastructure failures are not policy decisions and always fail closed.

## Documentation

- Full docs: <https://atlasent.io/docs>
- API key guide: [docs/api-keys.md](https://github.com/AtlaSent-Systems-Inc/atlasent-api/blob/main/docs/api-keys.md)
- Examples: <https://github.com/AtlaSent-Systems-Inc/atlasent-examples>

## License

MIT — see [LICENSE](./LICENSE).
