# AtlaSent Action

Block production deploys unless AtlaSent authorizes them. Sits as a required status check so nothing reaches production without an evaluated, verified permit.

```
Push to main → AtlaSent evaluates → permitted → deploy
                                   → blocked  → fail with reason
```

## Add to Any Repo in 3 Steps

### Step 1: Add secrets

In your repo's **Settings → Secrets and variables → Actions**:

| Type | Name | Value |
|---|---|---|
| Secret | `ATLASENT_API_KEY` | Your AtlaSent API key |
| Variable | `ATLASENT_ANON_KEY` | Your AtlaSent public anon key |

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
        uses: AtlaSent-Systems-Inc/atlasent-action@v1
        with:
          atlasent_api_key: ${{ secrets.ATLASENT_API_KEY }}
          atlasent_anon_key: ${{ vars.ATLASENT_ANON_KEY }}

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

When AtlaSent denies an action, the workflow fails immediately and the reason is surfaced in three places:

**In the Actions log:**
```
Error: BLOCKED by AtlaSent — decision=deny code=POLICY_VIOLATION reason=insufficient approvals and outside change window
```

**In the job summary (visible on the Actions run page):**

| Field | Value |
|---|---|
| **Decision** | `deny` |
| **Decision ID** | `eval_1a2b3c4d5e6f7890` |
| **Audit Hash** | `sha256:e3b0c44298fc1c14...` |
| **Action** | `production-deploy` |
| **Actor** | `deploy-engineer` |
| **SHA** | `a1b2c3d4e5f6` |
| **Branch** | `refs/heads/main` |
| **Reason** | insufficient approvals and outside change window |

**In the PR (when used as a required check):**

The merge button is blocked with: _"Required status check — deploy — failing"_

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `atlasent_api_key` | **Yes** | — | AtlaSent API key (use a secret) |
| `atlasent_anon_key` | **Yes** | — | AtlaSent public anon key |
| `action` | No | `production-deploy` | Action to authorize |
| `environment` | No | `prod` | Target environment |
| `approvals` | No | `0` | Number of approvals obtained |
| `change_window` | No | `false` | Within an approved change window? |
| `atlasent_base_url` | No | *(production)* | API base URL override |

## Outputs

| Output | Description |
|---|---|
| `decision` | `allow` or `deny` |
| `decision_id` | Unique evaluation ID for audit trail |
| `audit_hash` | Tamper-evident hash of the evaluation context |
| `permit_token` | Single-use permit token (only when allowed) |
| `verified` | Whether permit was verified at execution time |

## How It Works

1. **Evaluate** — Calls `POST /v1-evaluate` with `agent="github-actions"`, `action="production-deploy"`, and context (SHA, branch, actor, environment, approvals, change window). Returns a decision and single-use permit token.

2. **Verify** — Calls `POST /v1-verify-permit` to confirm the permit hasn't been tampered with, expired, or had its context change between evaluation and execution.

3. **Proceed or block** — If both succeed, downstream steps run. If anything fails, the workflow is blocked (fail-closed). Decision ID and audit hash are logged to the job summary.

## Customizing the Action

Gate staging deploys, data exports, or any agent action:

```yaml
- uses: AtlaSent-Systems-Inc/atlasent-action@v1
  with:
    atlasent_api_key: ${{ secrets.ATLASENT_API_KEY }}
    atlasent_anon_key: ${{ vars.ATLASENT_ANON_KEY }}
    action: staging-deploy
    environment: staging
    approvals: 1
    change_window: true
```

## Testing a Denial

Use the [demo workflow](./.github/workflows/deploy.yaml) with manual dispatch. Check **"Force a denial"** to send `approvals=0, change_window=false`, which violates the policy and produces a denial you can inspect.

## Sample API Responses

See [`docs/`](./docs/) for examples of every API response:
- [`evaluate-allow.json`](./docs/evaluate-allow.json) — allowed, permit token issued
- [`evaluate-deny.json`](./docs/evaluate-deny.json) — denied, policy violation with reasons
- [`verify-allow.json`](./docs/verify-allow.json) — permit verified at execution time

## License

MIT — see [LICENSE](./LICENSE).
