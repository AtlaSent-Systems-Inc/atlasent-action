# AtlaSent Gate Action

GitHub Action for the **CI/CD deployment authorization** domain of [AtlaSent](https://www.atlasent.io/) — execution-time authorization infrastructure for governed computational action.

Require execution-time authorization before critical CI/CD actions run. Drop AtlaSent into any GitHub Actions workflow with a single step.

```
Push to main → AtlaSent evaluates → permit issued → deploy
                                  → denied       → fail with reason
```

## Quick Start

```yaml
- uses: AtlaSent-Systems-Inc/atlasent-action@v1
  env:
    ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}
  with:
    action: production.deploy
    target-id: ${{ github.repository }}
```

## Full Configuration

```yaml
- name: Authorization Gate
  id: gate
  uses: AtlaSent-Systems-Inc/atlasent-action@v1
  env:
    ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}
  with:
    action: production.deploy
    actor: ${{ github.actor }}
    target-id: api-service
    environment: live
    fail-on-deny: 'true'
    context: '{"team": "platform", "service": "api"}'
```

## Using Outputs

The action sets several outputs you can reference in subsequent steps.
**Always gate on `verified`, not `decision`** — `verified=true` means the evaluation returned `allow` AND the server confirmed the permit token hasn’t been replayed.

```yaml
- name: Authorization Gate
  id: gate
  uses: AtlaSent-Systems-Inc/atlasent-action@v1
  env:
    ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}
  with:
    action: production.deploy
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
| `batch-id`  | Server-assigned batch ID, `chunked-<ts>` when client-side chunking ran, or `loop-<ts>` for the sequential fallback |

## Inputs

### Single-eval inputs

| Input          | Required | Default                | Description                                             |
|----------------|----------|------------------------|---------------------------------------------------------|
| `ATLASENT_API_KEY` env | Yes | — | AtlaSent API key (`ask_live_*` or `ask_test_*`). This is the only required secret. |
| `action`       | Yes*     | —                      | Action type to evaluate (e.g. `production.deploy`). Ignored when `evaluations` is set. |
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
| `v2-batch`         | No       | `false`   | Use the `/v1-evaluate/batch` endpoint instead of the sequential loop. Falls back to the loop automatically when the endpoint returns 404 or only one item is supplied. |
| `v2-streaming`     | No       | `false`   | Use Server-Sent Events for `wait-for-id` polling instead of HTTP polling. |

## Streaming wait (v2.1)

For long-running approvals such as change-window gates, enable `v2-streaming` to consume the AtlaSent SSE stream instead of polling. The step blocks until the evaluator reaches a terminal decision or `wait-timeout-ms` elapses:

```yaml
- uses: AtlaSent-Systems-Inc/atlasent-action@v1
  env:
    ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}
  with:
    action: production.deploy
    actor: ${{ github.actor }}
    v2-streaming: 'true'
    wait-timeout-ms: '600000'
```

When `v2-streaming` is `false` (the default) the action falls back to 5-second HTTP polling — behaviour is identical, only the transport differs.

## GitHub identity in the policy context

The `actor` input defaults to `${{ github.actor }}`, so no additional identity setup is needed. The action automatically embeds the GitHub username in the evaluation context sent to AtlaSent.

> **No OIDC exchange.** `ATLASENT_API_KEY` is what authenticates the workflow against the AtlaSent API. The GitHub `actor` value is a string the action embeds in the evaluation context so policies can branch on human identity. If you want true OIDC trust between GitHub and AtlaSent (no long-lived API key), file a feature request — the wire today does not support it.

To branch on GitHub identity, write your AtlaSent policy against the `actor` field directly (e.g. `actor == "github:octocat"` or `actor in team:"github:platform-eng"`).

```yaml
- uses: AtlaSent-Systems-Inc/atlasent-action@v1
  env:
    ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}
  with:
    action: production.deploy
    # actor defaults to ${{ github.actor }} — no extra config needed
```

## Batch Mode

Evaluate multiple actions in a single step:

```yaml
- name: Batch Authorization Gate
  id: gate
  uses: AtlaSent-Systems-Inc/atlasent-action@v1
  env:
    ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}
  with:
    v2-batch: 'true'
    evaluations: |
      [
        {"action": "production.deploy", "actor": "${{ github.actor }}", "environment": "live", "context": {"service": "api"}},
        {"action": "production.deploy", "actor": "${{ github.actor }}", "environment": "live", "context": {"service": "worker"}},
        {"action": "production.deploy", "actor": "${{ github.actor }}", "environment": "live", "context": {"service": "web"}}
      ]

- name: Deploy
  if: steps.gate.outputs.verified == 'true'
  run: ./deploy.sh
```

See [`docs/batch-example.yml`](./docs/batch-example.yml) for a fully-commented end-to-end workflow.

### Batch auto-fallback (V2-D3)

The `/v1-evaluate/batch` endpoint is **closed-by-default per tenant** — the
`v2_batch` flag must be flipped on by AtlaSent operations before a given org
can use it. To keep workflows portable across orgs at different rollout stages,
the action falls back automatically:

| Condition                                              | Transport                                       |
|--------------------------------------------------------|-------------------------------------------------|
| `v2-batch: false` (default)                            | Per-item `/v1-evaluate` loop                    |
| `v2-batch: true` AND only 1 item supplied              | Per-item `/v1-evaluate` loop (no batch benefit) |
| `v2-batch: true` AND `/v1-evaluate/batch` returns 404 | Per-item `/v1-evaluate` loop (tenant flag off)  |
| `v2-batch: true` AND `items.length > 100`              | Multiple `/v1-evaluate/batch` POSTs, chunked client-side to the 100-item server cap |
| `v2-batch: true` AND `/v1-evaluate/batch` returns 5xx | Step fails (fail-closed — does NOT silently downgrade) |

`batch-id` distinguishes the path that actually ran: a UUID for server-side
batches, `chunked-<ts>` when the action chunked client-side, and `loop-<ts>`
for the per-item fallback.

## How It Works

1. **Evaluate** — POST `/v1-evaluate` with `action_type`, `actor_id`, `target_id`, and a context object populated from GitHub workflow metadata (repo, ref, sha, workflow, run id, PR number, optional user-supplied `context`).
2. **Decide** — Server returns `allow` / `deny` / `hold` / `escalate` plus a single-use `permit_token` (only when `allow`) and an optional `risk-score`.
3. **Verify permit** — POST `/v1-verify-permit` to confirm the token hasn’t been replayed. `verified=true` only when both steps pass.
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

Licensed under the [Apache License, Version 2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution.

Copyright (c) AtlaSent IP Holdings LLC

Commercial licensing inquiries: [legal@atlasent.io](mailto:legal@atlasent.io)
