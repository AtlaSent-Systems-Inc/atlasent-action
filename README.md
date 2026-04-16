![AtlaSent Deploy Gate](https://github.com/AtlaSent-Systems-Inc/deploy-gate-demo/actions/workflows/deploy.yaml/badge.svg)

# AtlaSent Deploy Gate Demo

A working example of execution-time authorization for production deployments using [AtlaSent](https://atlasent.io). Fork this repo, add your API key, push to `main`, and watch the gate work.

This repo is also a **reusable GitHub Action** — add AtlaSent authorization to any workflow in 4 lines.

## What This Does

Every push to `main` triggers a GitHub Actions workflow that gates the deploy through AtlaSent:

1. **Evaluate** — Calls `POST /v1-evaluate` with the deployment context (who, what, where, how many approvals). AtlaSent returns an allow/deny decision and a single-use permit token.
2. **Verify** — At execution time, calls `POST /v1-verify-permit` to confirm the permit is still valid, unmodified, and contextually correct.
3. **Deploy** — Proceeds only if verification succeeds. Deploys a live page to GitHub Pages as proof.

```
Push to main
    ↓
POST /v1-evaluate
    → Decision: allow
    → Permit token: ats_permit_a1b2c3...
    ↓
POST /v1-verify-permit
    → Outcome: allow
    → Valid: true
    ↓
Deploy to GitHub Pages
    ↓
Tamper-evident audit trail recorded
```

## Use as a Reusable Action

Add AtlaSent authorization to any GitHub Actions workflow:

```yaml
steps:
  - uses: actions/checkout@v4

  - name: AtlaSent Deploy Gate
    uses: AtlaSent-Systems-Inc/deploy-gate-demo@main
    with:
      api_key: ${{ secrets.ATLASENT_API_KEY }}
      anon_key: ${{ vars.ATLASENT_ANON_KEY }}
      environment: 'prod'
      approvals: '2'

  - name: Deploy (only runs if authorized)
    run: ./deploy.sh
```

### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api_key` | Yes | — | AtlaSent API key (store as a secret) |
| `anon_key` | Yes | — | AtlaSent public anon key |
| `base_url` | No | AtlaSent API | Override the API endpoint |
| `action_type` | No | `production.deploy` | The action being authorized |
| `environment` | No | `prod` | Target environment |
| `approvals` | No | `2` | Number of approvals obtained |
| `change_window` | No | `true` | Whether action is within an approved change window |

### Outputs

| Output | Description |
|--------|-------------|
| `decision` | The evaluate decision (`allow` or `deny`) |
| `permit_token` | The single-use permit token (if allowed) |
| `verified` | Whether the permit was verified (`true`/`false`) |

## Try the Demo

### 1. Fork this repo

### 2. Add your credentials

In your fork's Settings → Secrets and variables → Actions:

- **Secret:** `ATLASENT_API_KEY` — your AtlaSent API key
- **Variable:** `ATLASENT_ANON_KEY` — your AtlaSent public anon key

Don't have credentials yet? [Get a sandbox key at atlasent.io](https://atlasent.io)

### 3. Enable GitHub Pages

Settings → Pages → Source: **GitHub Actions**

### 4. Push to main

```bash
git clone https://github.com/YOUR_ORG/deploy-gate-demo.git
cd deploy-gate-demo
echo "trigger" >> trigger.txt
git add trigger.txt && git commit -m "Test deploy gate"
git push origin main
```

### 5. Watch the Actions tab

You'll see two jobs:
- **gate** — AtlaSent evaluate + verify
- **deploy** — GitHub Pages deployment (only if gate passes)

## Multi-Environment Support

The workflow supports different policy thresholds per environment:

| Environment | Approvals Required | Change Window |
|-------------|-------------------|---------------|
| **prod** | 2 | Required |
| **staging** | 1 | Required |

Use the manual dispatch to select an environment: Actions → AtlaSent Deploy Gate → Run workflow → choose `prod` or `staging`.

## Testing a Denial

Use the manual workflow dispatch to trigger a deliberate denial. Go to Actions → AtlaSent Deploy Gate → Run workflow, and check **"Force a denial"**.

This sets `approvals: 0` and `change_window: false`, which violates the policy. You'll see:

```
Decision: deny
Reason:   insufficient approvals and outside change window
```

The deploy job won't run. This is the expected behavior — AtlaSent blocks actions that don't meet policy requirements.

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
