# AtlaSent Action

Block production deploys unless AtlaSent authorizes them. Sits as a required status check so nothing reaches production without an evaluated decision.

```
Push to main → AtlaSent evaluates → allow         → deploy
                                  → deny          → fail with reason
                                  → require_approval → warn / gated
```

## Add to Any Repo in 3 Steps

### Step 1: Add secrets

In your repo's **Settings → Secrets and variables → Actions**:

| Type | Name | Value |
|---|---|---|
| Variable | `ATLASENT_API_URL` | Base URL of your AtlaSent API (e.g. `https://api.atlasent.io`) |
| Secret | `ATLASENT_API_KEY` | Org-scoped API key with `evaluation:execute` scope |

No credentials yet? → [atlasent.io](https://atlasent.io)

### Step 2: Add the workflow

Create `.github/workflows/deploy.yaml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: AtlaSent authorization gate
        id: gate
        uses: AtlaSent-Systems-Inc/atlasent-action@v2
        with:
          atlasent-api-url: ${{ vars.ATLASENT_API_URL }}
          atlasent-api-key: ${{ secrets.ATLASENT_API_KEY }}
          action-id: ci.production-deploy
          environment: production
          actor-id: ${{ github.actor }}

      # This step only runs if AtlaSent authorized the deploy
      - name: Deploy
        run: ./deploy.sh
```

### Step 3: Require the check

In **Settings → Branches → Branch protection rules** for `main`:

- Check **Require status checks to pass before merging**
- Add **deploy** as a required check

Done. Every push to `main` now requires AtlaSent authorization.

## What a Blocked Deploy Looks Like

When AtlaSent denies an action, the workflow fails immediately and the reason is surfaced in the Actions log:

```
Error: AtlaSent denied action "ci.production-deploy" — risk high (82/100)
```

The job's outputs include the decision ID so you can correlate against the AtlaSent audit trail:

| Field | Value |
|---|---|
| **Decision** | `deny` |
| **Evaluation ID** | `eval_1a2b3c4d5e6f7890` |
| **Risk level** | `high` |
| **Action** | `ci.production-deploy` |
| **Actor** | `deploy-engineer` |

When used as a required check on a PR, the merge button is blocked with: _"Required status check — deploy — failing"_.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `atlasent-api-url` | **Yes** | — | Base URL of your AtlaSent API |
| `atlasent-api-key` | **Yes** | — | Org-scoped API key with `evaluation:execute` scope |
| `action-id` | **Yes** | — | Action identifier to evaluate (e.g. `ci.production-deploy`) |
| `environment` | No | `production` | Target environment |
| `actor-id` | No | `github.actor` | Actor identifier |
| `context` | No | `{}` | JSON string of additional context |
| `fail-on-deny` | No | `true` | Fail the step if the decision is `deny` |

## Outputs

| Output | Description |
|---|---|
| `decision` | `allow`, `deny`, or `require_approval` |
| `permit-id` | Permit ID when decision is `allow` |
| `risk-level` | `low`, `medium`, `high`, or `critical` |
| `evaluation-id` | Evaluation ID for the audit trail |

## How It Works

1. **Evaluate** — Calls `POST /v1/evaluate` with the actor, action, and target (repository, environment, workflow metadata). Returns a decision and risk assessment.

2. **Proceed or block** — On `allow`, downstream steps run. On `deny`, the step fails (unless `fail-on-deny: false`). On `require_approval`, the step warns and surfaces the permit ID for an out-of-band approval flow.

## Customizing the Action

Gate staging deploys, data exports, or any agent action:

```yaml
- uses: AtlaSent-Systems-Inc/atlasent-action@v2
  with:
    atlasent-api-url: ${{ vars.ATLASENT_API_URL }}
    atlasent-api-key: ${{ secrets.ATLASENT_API_KEY }}
    action-id: ci.staging-deploy
    environment: staging
    context: |
      {
        "ref": "${{ github.ref }}",
        "sha": "${{ github.sha }}",
        "workflow": "${{ github.workflow }}"
      }
```

## Migrating from v1

See [`docs/v1-migration.md`](./docs/v1-migration.md) and [`docs/DESIGN_V2.md`](./docs/DESIGN_V2.md) for the full breaking-change list. Short version: the action now calls the AtlaSent API directly — `supabase-url`, `supabase-anon-key`, and `policy-file` are gone; `atlasent-api-url` and `atlasent-api-key` take their place.

## Sample API Responses

See [`docs/`](./docs/) for examples of every API response:
- [`evaluate-allow.json`](./docs/evaluate-allow.json) — allowed, permit issued
- [`evaluate-deny.json`](./docs/evaluate-deny.json) — denied, policy violation with reasons

## License

MIT — see [LICENSE](./LICENSE).
