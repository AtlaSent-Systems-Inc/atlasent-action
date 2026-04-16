# AtlaSent GxP Starter

Authorize every AI agent action before it executes. Try it in 5 minutes.

AtlaSent is the execution-time authorization layer for AI agents in GxP-regulated life sciences environments. This repo gives you everything you need to evaluate it: a working quickstart, integration examples, and starter policies for common regulatory frameworks.

## Quickstart

### Prerequisites

- `curl` and `jq` installed
- A terminal

### Run it

```bash
git clone https://github.com/AtlaSent-Systems-Inc/atlasent-gxp-starter.git
cd atlasent-gxp-starter
./quickstart.sh
```

That's it. The script calls AtlaSent's sandbox API to:

1. **Evaluate** — Request authorization for a simulated agent action (`validated_system.write`)
2. **Verify** — Confirm the permit at execution time, just before the action would run
3. **Display the result** — See the allow/deny decision, permit token, and audit metadata

No account required. The sandbox key is included.

### What you'll see

```
── AtlaSent GxP Quickstart ──────────────────────────
Action:  validated_system.write
Actor:   agent:quickstart-demo
Context: 21 CFR Part 11 · production · 2 approvals

→ Evaluating...
  Decision: allow
  Permit:   ats_permit_a1b2c3d4...

→ Verifying permit at execution time...
  Outcome:  allow
  Valid:    true

✓ Agent action authorized. Audit trail recorded.
──────────────────────────────────────────────────────
```

## How AtlaSent Works

Every consequential AI agent action goes through two checkpoints:

```
Agent wants to act
    ↓
POST /v1-evaluate     →  "Should this action be allowed?"
    ↓                     Checks policy, context, approvals
permit_token          ←  Single-use authorization token
    ↓
POST /v1-verify-permit → "Is this permit still valid right now?"
    ↓                     Verifies token, context, timing
allow / deny          ←  Final execution-time decision
    ↓
Agent executes (or doesn't)
    ↓
Tamper-evident audit trail recorded
```

This closes the gap between approval and execution — the window where agent configs change, artifacts get modified, and context diverges from what was reviewed.

## Integration Examples

| Example | Description |
|---------|-------------|
| [`examples/python-sdk/`](./examples/python-sdk/) | Python wrapper for evaluate + verify. Drop into any agent. |
| [`examples/github-actions/`](./examples/github-actions/) | Gate CI/CD deployments with AtlaSent. |
| [`examples/langchain/`](./examples/langchain/) | Pre-action authorization hook for LangChain agents. |

## Starter Policies by Regulation

Pre-configured policy templates for common GxP frameworks. Each includes a JSON policy file and implementation guidance.

| Directory | Regulation | What It Governs |
|-----------|-----------|-----------------|
| [`policies/21-cfr-part-11/`](./policies/21-cfr-part-11/) | FDA 21 CFR Part 11 | Electronic records, electronic signatures, audit trails |
| [`policies/eu-annex-11/`](./policies/eu-annex-11/) | EU GMP Annex 11 | Computerized systems validation, data integrity |
| [`policies/ich-e6-gcp/`](./policies/ich-e6-gcp/) | ICH E6(R2) GCP | Clinical trial data, Good Clinical Practice |
| [`policies/general-gxp/`](./policies/general-gxp/) | General GxP | Catch-all AI agent governance for regulated environments |

These are starting points. Your compliance team will customize the context fields, approval thresholds, and action types to match your SOPs.

---

## For Your Compliance Team

If you're evaluating AtlaSent for your organization, here's what to share internally:

**What it does:** Every AI agent action in a validated environment is authorized in real time — not just at planning time, but at the moment of execution. Every decision is recorded in a tamper-evident audit trail.

**What it replaces:** Manual approval workflows, after-the-fact audit log reviews, and the compliance gap between "approved to deploy" and "actually deployed."

**Regulatory alignment:** Designed for FDA 21 CFR Part 11, EU GMP Annex 11, ICH E6(R2), and general GxP requirements. Supports electronic signature binding, system validation context, and change control enforcement.

**[Book a demo with our team →](https://atlasent.io)**

We work directly with Chief Compliance Officers, quality assurance leads, and validation engineers to configure policies that match your regulatory obligations.

## License

MIT — see [LICENSE](./LICENSE).
