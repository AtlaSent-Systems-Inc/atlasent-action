# AtlaSent Deployment Gate

> Execution-time authorization for CI/CD. A protected step (production deploy,
> release publish, infra apply) calls AtlaSent **before** it runs. AtlaSent
> decides `allow` / `deny` / `hold` / `escalated`. The step only executes on
> `allow`.

```
push to main ─▶ AtlaSent /v1/evaluate ─▶ allow     ─▶ deploy runs
                                      └▶ deny      ─▶ job fails, reason surfaced
                                      └▶ hold      ─▶ job fails, escalation URL surfaced
                                      └▶ escalated ─▶ job fails, awaiting approver
```

This is not an approval workflow bolted onto `on: pull_request`. The decision
is made **at the moment of execution**, against live policy, with a
tamper-evident audit record. A stale approval, a drifted commit, or a request
outside the change window will be denied even if CI was green a minute ago.

## Why this is different from approval-only CI controls

| Approval-only (CODEOWNERS, environments) | AtlaSent gate |
|---|---|
| Check runs at PR merge or manual approval | Check runs at the moment the protected step executes |
| Approval is a single boolean on a PR | Decision is policy-driven over live context (actor, SHA, window, risk) |
| No cryptographic proof | Signed permit + audit hash per execution |
| Can't represent `hold`/`escalated` | Four-state decision; escalations route to on-call |
| Logs are GitHub-only | Decision is logged to AtlaSent with evaluation_id for audit |

## Minimal usage

```yaml
# .github/workflows/deploy.yml
name: Production Deploy
on:
  push: { branches: [main] }

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4

      - name: AtlaSent execution gate
        id: gate
        uses: AtlaSent-Systems-Inc/atlasent-action@v2
        with:
          api-url:     ${{ vars.ATLASENT_API_URL }}
          api-key:     ${{ secrets.ATLASENT_API_KEY }}
          action-type: production.deploy
          context: |
            {
              "service": "checkout-api",
              "environment": "production",
              "approvals": 2,
              "change_window": true
            }

      # Only reached on decision=allow.
      - run: ./scripts/deploy.sh production
```

Set `ATLASENT_API_URL` (repo variable) and `ATLASENT_API_KEY` (repo secret,
scope `evaluation:execute`). No other setup.

## Inputs

| Input          | Required | Default                    | Description |
|----------------|----------|----------------------------|-------------|
| `api-key`      | yes      | —                          | AtlaSent API key (store as a secret). |
| `action-type`  | yes      | —                          | Canonical action being gated, e.g. `production.deploy`, `release.publish`. |
| `api-url`      | no       | `https://api.atlasent.io`  | API base URL. |
| `actor-id`     | no       | `gha:${{ github.actor }}`  | Stable actor identifier. |
| `context`      | no       | `{}`                       | JSON object merged under the request's `context` field. |
| `fail-on-deny` | no       | `true`                     | Fail the step on anything other than `allow`. Set `false` for advisory/dry-run. |
| `timeout-ms`   | no       | `15000`                    | Request timeout. |

## Outputs

| Output              | Description |
|---------------------|-------------|
| `decision`          | `allow` \| `deny` \| `hold` \| `escalated` |
| `reason`            | Human-readable reason from the evaluator. |
| `evaluation-id`     | Evaluation record ID (audit correlation). |
| `permit-id`         | Permit ID, present on `allow`. |
| `permit-expires-at` | ISO-8601 permit expiry. |
| `verified`          | `true` if the evaluator returned a verified proof. |
| `audit-hash`        | SHA-256 of the audit record. |
| `escalation-url`    | Console URL to review `hold` / `escalated` decisions. |
| `policy-version`    | Policy version that produced the decision. |

The permit token itself is registered as a masked secret in the runner and is
**not** exposed as an output. Pass `permit-id` around instead.

## Request contract

`POST {api-url}/v1/evaluate` with `Authorization: Bearer <api-key>`:

```json
{
  "action_type": "production.deploy",
  "actor_id": "gha:octocat",
  "context": {
    "repository": "acme/checkout-api",
    "ref": "refs/heads/main",
    "sha": "0123...",
    "workflow": "Production Deploy",
    "run_id": "8123456789",
    "event": "push",
    "environment": "production",
    "approvals": 2,
    "change_window": true
  }
}
```

The action always merges GitHub runtime context (repo, ref, sha, workflow, run
id, event, actor, runner os) into `context` before the caller's `context` is
applied. Caller keys win on conflict.

See sample responses under [`docs/`](./docs/):
[`evaluate-request.json`](./docs/evaluate-request.json),
[`evaluate-allow.json`](./docs/evaluate-allow.json),
[`evaluate-deny.json`](./docs/evaluate-deny.json),
[`evaluate-hold.json`](./docs/evaluate-hold.json).

## What a blocked deploy looks like

The step fails with a single, parseable error line:

```
Error: AtlaSent DENY — action_type=production.deploy
  reason="missing 2 of 2 required approvals"
  evaluation_id=eval_01HXAAGDENY3K8WV7B2R9C1MDD
```

The job summary renders a table with decision, actor, action, reason, permit,
audit hash, and (for `hold`/`escalated`) a link to the approval request in the
AtlaSent console. The protected step never runs. Branch-protection rules
treating this job as a required check will also block the merge.

## Demo

[`.github/workflows/deploy.yaml`](./.github/workflows/deploy.yaml) is a
runnable demo. Dispatch it from the Actions tab with the `scenario` input set
to `allow`, `deny`, or `hold`. Each scenario drives a different `context`, so
a single policy produces all four decision states end-to-end. Use this to show
a prospect an execution-time block in under a minute.

## Fail-closed guarantees

Any of the following fail the workflow step:

- Non-2xx from `/v1/evaluate`
- Network error or timeout
- Malformed response (missing `decision` or `evaluation_id`)
- Decision is `deny`, `hold`, or `escalated` (unless `fail-on-deny: false`)

There is no implicit allow. If AtlaSent is unreachable, the deploy does not
run.

## Building from source

```
npm ci
npm run typecheck
npm run build      # emits dist/
```

`dist/` is checked in because GitHub Actions runs the pre-built bundle
directly. CI enforces that `dist/` is up to date with `src/`.

## License

MIT — see [LICENSE](./LICENSE).
