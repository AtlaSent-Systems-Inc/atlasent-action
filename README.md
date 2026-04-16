# AtlaSent Deploy Gate Demo

A working example of execution-time authorization for production deployments using [AtlaSent](https://atlasent.io). Fork this repo, add your API key, push to `main`, and watch the gate work.

## What This Does

Every push to `main` triggers a GitHub Actions workflow that gates the deploy through AtlaSent:

1. **Evaluate** — Calls `POST /v1-evaluate` with the deployment context (who, what, where, how many approvals). AtlaSent returns an allow/deny decision and a single-use permit token.
2. **Verify** — At execution time, calls `POST /v1-verify-permit` to confirm the permit is still valid, unmodified, and contextually correct.
3. **Deploy** — Proceeds only if verification succeeds. If anything fails, the deploy is blocked (fail-closed).

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
Deploy proceeds
    ↓
Tamper-evident audit trail recorded
```

## Try It

### 1. Fork this repo

### 2. Add your credentials

In your fork's Settings → Secrets and variables → Actions:

- **Secret:** `ATLASENT_API_KEY` — your AtlaSent API key
- **Variable:** `ATLASENT_ANON_KEY` — your AtlaSent public anon key

Don't have credentials yet? [Get a sandbox key at atlasent.io](https://atlasent.io)

### 3. Push to main

```bash
git clone https://github.com/YOUR_ORG/deploy-gate-demo.git
cd deploy-gate-demo
echo "trigger" >> trigger.txt
git add trigger.txt && git commit -m "Test deploy gate"
git push origin main
```

### 4. Watch the Actions tab

Open the Actions tab in your fork. You'll see the workflow:
- Evaluate step: requesting authorization
- Verify step: confirming the permit at execution time
- Deploy step: proceeding (or blocked)

## Testing a Denial

Use the manual workflow dispatch to trigger a deliberate denial. Go to Actions → AtlaSent Deploy Gate → Run workflow, and select **"Force a denial"**.

This sets `approvals: 0` and `change_window: false`, which violates the policy. You'll see:

```
Decision: deny
Reason:   insufficient approvals and outside change window
```

This is the expected behavior — AtlaSent blocks actions that don't meet policy requirements.

## Sample API Responses

See the [`docs/`](./docs/) directory for captured examples of every API response:

- [`docs/evaluate-allow.json`](./docs/evaluate-allow.json) — Successful evaluation (action allowed)
- [`docs/evaluate-deny.json`](./docs/evaluate-deny.json) — Evaluation denied (policy violation)
- [`docs/verify-allow.json`](./docs/verify-allow.json) — Permit verified at execution time

## How the Workflow Works

The workflow (`.github/workflows/deploy.yaml`) does three things:

**Step 1 — Evaluate:** Builds a JSON request with the action type (`production.deploy`), actor, and context (environment, approvals count, change window status, repo, SHA, ref). Sends it to `/v1-evaluate`. If the decision is `allow`, extracts the `permit_token` for the next step.

**Step 2 — Verify:** Takes the permit token from Step 1 and sends it to `/v1-verify-permit` along with the same action context. This confirms the permit hasn't been tampered with and the context hasn't changed between evaluation and execution.

**Step 3 — Deploy:** Placeholder for your real deployment command. Only reached if both evaluate and verify succeed.

Both steps are **fail-closed** — any error (network failure, unexpected response, missing fields) blocks the deploy.

## More Resources

- **[AtlaSent GxP Starter](https://github.com/AtlaSent-Systems-Inc/atlasent-gxp-starter)** — Full quickstart kit with policy templates for 21 CFR Part 11, EU Annex 11, ICH E6 GCP, and integration examples for Python, LangChain, and more.
- **[atlasent.io](https://atlasent.io)** — Book a demo or get sandbox credentials.

## License

MIT
