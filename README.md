![AtlaSent Deploy Gate](https://github.com/AtlaSent-Systems-Inc/deploy-gate-demo/actions/workflows/deploy.yaml/badge.svg)

# AtlaSent Action

Gate AI agent actions in regulated environments before they execute.

AtlaSent is the execution-time authorization layer for AI agents in GxP-regulated life sciences. Before an agent writes to a validated system, modifies a batch record, or touches clinical trial data, AtlaSent evaluates the action against your policies — and blocks it if it doesn't pass.

This GitHub Action adds AtlaSent authorization to any CI/CD workflow.

## Why This Exists

Your AI agent can write to a validated batch record, modify clinical trial data, or trigger a production process. FDA 21 CFR Part 11 and EU GMP Annex 11 require that every action on a computerized system is authorized, attributable, and auditable.

The problem: traditional approval workflows authorize at planning time. But between approval and execution, agent configurations change, artifacts get modified, and context diverges from what was reviewed.

AtlaSent closes that gap. Every action is evaluated against policy **and** verified at the moment of execution. Every decision is recorded in a tamper-evident audit trail.

## Quick Start

```yaml
steps:
  - uses: actions/checkout@v4

  - name: AtlaSent Gate
    uses: AtlaSent-Systems-Inc/deploy-gate-demo@v1
    with:
      api_key: ${{ secrets.ATLASENT_API_KEY }}
      anon_key: ${{ vars.ATLASENT_ANON_KEY }}
      action_type: 'agent.write_batch_record'
      environment: 'prod'
      approvals: '2'

  - name: Execute (only runs if authorized)
    run: ./run-agent.sh
```

That's it. If the action isn't authorized, the workflow fails before your agent runs.

## How It Works

```
Agent action requested
    ↓
POST /v1-evaluate
    → Checks policy, context, approvals
    → Returns single-use permit token
    ↓
POST /v1-verify-permit
    → Confirms permit at execution time
    → Blocks if context changed or permit expired
    ↓
Agent executes (or doesn't)
    ↓
Tamper-evident audit trail recorded
```

Both steps are **fail-closed** — any error (network failure, unexpected response, missing fields) blocks the action. No silent failures.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api_key` | Yes | — | AtlaSent API key (store as a secret) |
| `anon_key` | Yes | — | AtlaSent public anon key |
| `base_url` | No | AtlaSent API | Override the API endpoint |
| `action_type` | No | `production.deploy` | The action being authorized |
| `environment` | No | `prod` | Target environment |
| `approvals` | No | `2` | Number of approvals obtained |
| `change_window` | No | `true` | Whether action is within an approved change window |

## Outputs

| Output | Description |
|--------|-------------|
| `decision` | The evaluate decision (`allow` or `deny`) |
| `permit_token` | The single-use permit token (if allowed) |
| `verified` | Whether the permit was verified at execution time (`true`/`false`) |

## Examples

### Gate an AI agent writing to a validated system

```yaml
- name: Authorize batch record write
  uses: AtlaSent-Systems-Inc/deploy-gate-demo@v1
  with:
    api_key: ${{ secrets.ATLASENT_API_KEY }}
    anon_key: ${{ vars.ATLASENT_ANON_KEY }}
    action_type: 'agent.write_batch_record'
    environment: 'prod'
    approvals: '2'
```

### Gate a production deployment

```yaml
- name: Authorize production deploy
  uses: AtlaSent-Systems-Inc/deploy-gate-demo@v1
  with:
    api_key: ${{ secrets.ATLASENT_API_KEY }}
    anon_key: ${{ vars.ATLASENT_ANON_KEY }}
    action_type: 'production.deploy'
    environment: 'prod'
    approvals: '2'
```

### Gate a staging deployment with lower threshold

```yaml
- name: Authorize staging deploy
  uses: AtlaSent-Systems-Inc/deploy-gate-demo@v1
  with:
    api_key: ${{ secrets.ATLASENT_API_KEY }}
    anon_key: ${{ vars.ATLASENT_ANON_KEY }}
    action_type: 'staging.deploy'
    environment: 'staging'
    approvals: '1'
```

## Try the Demo Workflow

This repo includes a working workflow that uses the action to gate itself.

### 1. Fork this repo

### 2. Add your credentials

Settings → Secrets and variables → Actions:

- **Secret:** `ATLASENT_API_KEY` — your AtlaSent API key
- **Variable:** `ATLASENT_ANON_KEY` — your AtlaSent public anon key

Don't have credentials yet? **[Get a sandbox key at atlasent.io](https://atlasent.io)**

### 3. Push to main or use manual dispatch

The Actions tab will show the gate step evaluating and verifying, then the deploy step executing only if authorized.

### Test a denial

Run the workflow manually and check **"Force a denial"**. This sends `approvals: 0` and `change_window: false`, which violates the policy. The workflow blocks:

```
BLOCKED — decision=deny code=POLICY_VIOLATION
  reason=insufficient approvals and outside change window
```

## Sample API Responses

See [`docs/`](./docs/) for captured examples:

- [`evaluate-allow.json`](./docs/evaluate-allow.json) — Action authorized, permit issued
- [`evaluate-deny.json`](./docs/evaluate-deny.json) — Action denied with violation details
- [`verify-allow.json`](./docs/verify-allow.json) — Permit verified at execution time

## Regulatory Alignment

Designed for organizations operating under:

- **FDA 21 CFR Part 11** — Electronic records, electronic signatures, audit trails
- **EU GMP Annex 11** — Computerized systems validation, data integrity (ALCOA+)
- **ICH E6(R2) GCP** — Good Clinical Practice, clinical trial data governance
- **General GxP** — Any regulated life sciences environment deploying AI agents

## Get Started

**[Book a demo at atlasent.io](https://atlasent.io)** — We work directly with compliance teams to configure policies that match your regulatory obligations.

## License

MIT
