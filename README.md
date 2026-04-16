# AtlaSent Action

Official GitHub Action for [AtlaSent](https://atlasent.io) — execution-time authorization for AI agent actions in GxP-regulated life sciences environments.

Add `uses: AtlaSent-Systems-Inc/atlasent-action@v1` to any workflow to gate agent actions through AtlaSent's evaluate/verify API before they execute. Fail-closed design: if anything goes wrong, the action is blocked.

## How It Works

```
Workflow step triggers
    |
    v
POST /v1-evaluate
    -> Decision: allow
    -> Permit token: ats_permit_a1b2c3...
    |
    v
POST /v1-verify-permit
    -> Outcome: allow
    -> Valid: true
    |
    v
Next step proceeds (deploy, data export, etc.)
    |
    v
Tamper-evident audit trail recorded
```

1. **Evaluate** — Sends the action type, actor, and context to AtlaSent. Returns an allow/deny decision and a single-use permit token.
2. **Verify** — At execution time, confirms the permit is still valid, unmodified, and contextually correct.
3. **Proceed or block** — Downstream steps only run if both evaluate and verify succeed.

## Quick Start

### 1. Add your credentials

In your repo's Settings > Secrets and variables > Actions:

- **Secret:** `ATLASENT_API_KEY` — your AtlaSent API key
- **Variable:** `ATLASENT_ANON_KEY` — your AtlaSent public anon key

Don't have credentials yet? [Get a sandbox key at atlasent.io](https://atlasent.io)

### 2. Add the action to your workflow

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: AtlaSent authorization gate
        id: gate
        uses: AtlaSent-Systems-Inc/atlasent-action@v1
        with:
          action_type: production.deploy
          environment: prod
          approvals: 2
          change_window: true
          atlasent_api_key: ${{ secrets.ATLASENT_API_KEY }}
          atlasent_anon_key: ${{ vars.ATLASENT_ANON_KEY }}

      - name: Deploy
        run: echo "Deploying — permit verified: ${{ steps.gate.outputs.verified }}"
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `action_type` | Yes | — | Action type to evaluate (e.g., `production.deploy`, `data.export`) |
| `environment` | Yes | `prod` | Target environment (e.g., `prod`, `staging`) |
| `approvals` | No | `0` | Number of approvals obtained |
| `change_window` | No | `false` | Whether the action is within an approved change window |
| `atlasent_api_key` | Yes | — | AtlaSent API key (use a GitHub secret) |
| `atlasent_anon_key` | Yes | — | AtlaSent public anon key |
| `atlasent_base_url` | No | *(production)* | AtlaSent API base URL |

## Outputs

| Output | Description |
|---|---|
| `decision` | The evaluate decision (`allow` or `deny`) |
| `permit_token` | Single-use permit token (only set when decision is `allow`) |
| `verified` | Whether the permit was verified at execution time (`true`/`false`) |

## Testing a Denial

Use the included demo workflow with `force_denial: true` to trigger a deliberate denial. Go to Actions > AtlaSent Deploy Gate (Demo) > Run workflow, and check "Force a denial".

This sets `approvals: 0` and `change_window: false`, which violates the policy:

```
Decision: deny
Reason:   insufficient approvals and outside change window
```

## Multi-Environment Support

Gate different environments with different contexts:

```yaml
- name: Gate staging deploy
  uses: AtlaSent-Systems-Inc/atlasent-action@v1
  with:
    action_type: staging.deploy
    environment: staging
    approvals: 1
    change_window: true
    atlasent_api_key: ${{ secrets.ATLASENT_API_KEY }}
    atlasent_anon_key: ${{ vars.ATLASENT_ANON_KEY }}
```

## Sample API Responses

See the [`docs/`](./docs/) directory for captured examples of every API response:

- [`docs/evaluate-allow.json`](./docs/evaluate-allow.json) — Successful evaluation (action allowed)
- [`docs/evaluate-deny.json`](./docs/evaluate-deny.json) — Evaluation denied (policy violation)
- [`docs/verify-allow.json`](./docs/verify-allow.json) — Permit verified at execution time

## More Resources

- **[AtlaSent GxP Starter](https://github.com/AtlaSent-Systems-Inc/atlasent-gxp-starter)** — Full quickstart kit with policy templates for 21 CFR Part 11, EU Annex 11, ICH E6 GCP, and integration examples for Python, LangChain, and more.
- **[atlasent.io](https://atlasent.io)** — Book a demo or get sandbox credentials.

## License

MIT
