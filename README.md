# AtlaSent Policy Templates

Pre-built governance policy templates for authorizing AI agent actions in GxP-regulated life sciences environments.

These templates are designed for use with [AtlaSent](https://atlasent.io) — the execution-time authorization layer that ensures every consequential AI agent action is evaluated, permitted, and auditable before it runs.

## How It Works

AtlaSent enforces **Governance Before Execution**. Before an AI agent performs a regulated action — writing to a validated system, modifying batch records, updating clinical data — it must obtain a single-use permit through two API calls:

1. **`POST /v1-evaluate`** — Submit the proposed action with its context. AtlaSent evaluates it against your organization's policies and returns a permit token if allowed.
2. **`POST /v1-verify-permit`** — At execution time, verify the permit is still valid, unmodified, and contextually correct before proceeding.

These templates provide the policy definitions and request structures for common GxP regulatory frameworks, so your team can deploy compliant AI agent governance from day one.

## Templates by Regulation

| Directory | Regulation | Scope |
|-----------|-----------|-------|
| [`21-cfr-part-11/`](./21-cfr-part-11/) | FDA 21 CFR Part 11 | Electronic records, electronic signatures, audit trails |
| [`eu-annex-11/`](./eu-annex-11/) | EU GMP Annex 11 | Computerized systems validation, data integrity |
| [`ich-e6-gcp/`](./ich-e6-gcp/) | ICH E6(R2) GCP | Good Clinical Practice, clinical trial data governance |
| [`general-gxp/`](./general-gxp/) | General GxP | Catch-all AI agent governance for regulated environments |

## Quick Start

### 1. Choose a template

Select the regulatory framework that applies to your environment. Each directory contains:

- A **policy JSON file** structured for AtlaSent's `POST /v1-evaluate` request body
- A **README** explaining the regulation, governed actions, and implementation guidance

### 2. Configure the policy

Adapt the template to your organization's requirements:

```json
{
  "action_type": "validated_system.write",
  "actor_id": "agent:your-agent-name",
  "request_id": "unique-request-id",
  "context": {
    "environment": "production",
    "regulation": "21-cfr-part-11",
    "system_validation_status": "validated",
    "approvals": 2,
    "change_window": true
  }
}
```

### 3. Integrate with your AI agents

Add AtlaSent evaluation calls before every consequential agent action:

```bash
# Step 1: Evaluate — request authorization
curl -X POST https://api.atlasent.io/v1-evaluate \
  -H "Authorization: Bearer $ATLASENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d @your-policy-template.json

# Step 2: Verify — confirm permit at execution time
curl -X POST https://api.atlasent.io/v1-verify-permit \
  -H "Authorization: Bearer $ATLASENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"permit_token": "TOKEN_FROM_STEP_1", ...}'
```

### 4. Deploy with confidence

Every authorized action produces a tamper-evident audit trail — ready for FDA inspections, EU GMP audits, and sponsor oversight.

## Why Execution-Time Authorization Matters

Traditional compliance controls gate actions at *planning time* — approvals happen before packaging, before deployment, before execution. But the window between approval and execution is where risk lives:

- Agent configurations can change after approval
- Deployment artifacts can be altered in transit
- Execution context can diverge from what was reviewed

AtlaSent closes this gap by binding authorization to the specific action, actor, and context — then verifying all three at the moment of execution.

## Book a Demo

These templates cover common regulatory scenarios, but every organization's compliance requirements are unique. Our team works directly with Chief Compliance Officers and their legal/IT teams to configure policies that match your specific regulatory obligations.

**[Book a demo at atlasent.io](https://atlasent.io)**

## Contributing

We welcome contributions from the compliance and life sciences community. See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE) for details.
