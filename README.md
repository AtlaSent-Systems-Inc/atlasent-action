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
    ATLASENT_BASE_URL: ${{ secrets.ATLASENT_BASE_URL }}
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
    ATLASENT_BASE_URL: ${{ secrets.ATLASENT_BASE_URL }}
  with:
    action: production.deploy
    actor: ${{ github.actor }}
    target-id: api-service
    environment: live
    fail-on-deny: 'true'
    context: |
      {
        "team": "platform",
        "service": "api",
        "state_snapshot": {
          "source": "github-actions",
          "complete": true,
          "run_id": "${{ github.run_id }}"
        }
      }
```

## Required context: `state_snapshot`

All `production.deploy` evaluations (and all action classes in the AtlaSent system) **require a `state_snapshot` field** in the context. Omitting it results in an immediate `SNAPSHOT_REQUIRED` deny regardless of policy.

Include it in the `context` JSON:

```yaml
context: |
  {
    "state_snapshot": {
      "source": "github-actions",
      "complete": true,
      "run_id": "${{ github.run_id }}"
    }
  }
```

The `source` field identifies where the snapshot was captured (`github-actions`, `buildkite`, `jenkins`, etc.). The `complete: true` flag signals that the pre-deploy state was captured successfully. The action will pass it through to the AtlaSent evaluator exactly as provided.

> **Why is this required?** AtlaSent enforces that every protected action is evaluated against a known, captured state — this closes the TOCTOU (time-of-check, time-of-use) window by proving the workflow observed the environment before the gate ran.

## Using Outputs

The action sets several outputs you can reference in subsequent steps.
**Always gate on `verified`, not `decision`** — `verified=true` means the evaluation returned `allow` AND the server confirmed the permit token hasn't been replayed.

```yaml
- name: Authorization Gate
  id: gate
  uses: AtlaSent-Systems-Inc/atlasent-action@v1
  env:
    ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}
    ATLASENT_BASE_URL: ${{ secrets.ATLASENT_BASE_URL }}
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
| `ATLASENT_API_KEY` env | Yes | — | AtlaSent API key (`ask_live_*` or `ask_test_*`). |
| `ATLASENT_BASE_URL` env | Yes (pilot profile) | — | Runtime base URL for your AtlaSent V1 authority service. |
| `action`       | Yes*     | —                      | Action type to evaluate (e.g. `production.deploy`). Ignored when `evaluations` is set. |
| `actor`        | No       | `${{ github.actor }}`  | Actor identity                                          |
| `target-id`    | No       | —                      | Target resource being acted on (service, artifact, etc) |
| `environment`  | No       | Auto-detected          | `live` for `main`/`master`, `test` otherwise            |
| `api-url`      | No       | `ATLASENT_BASE_URL` or `https://api.atlasent.io` | AtlaSent API base URL override. |
| `fail-on-deny` | No       | `true`                 | Deprecated for pilot mode; deny/hold/escalate still fail closed. |
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
    ATLASENT_BASE_URL: ${{ secrets.ATLASENT_BASE_URL }}
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
    ATLASENT_BASE_URL: ${{ secrets.ATLASENT_BASE_URL }}
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
    ATLASENT_BASE_URL: ${{ secrets.ATLASENT_BASE_URL }}
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

## Phase B7 Connectors

The GitHub Actions step is the reference connector. Phase B7 ships two additional
connectors — **webhook** and **AI-agent** — that implement the same
`evaluate → verify → verifyPermit` contract and are importable from
`@atlasent/action/connectors` (or from the package root).

### Webhook connector

Gates incoming webhook payloads in any Express/Hono/Node.js server.

```typescript
import { webhookGuard } from '@atlasent/action/connectors';

const guard = webhookGuard({
  apiKey: process.env.ATLASENT_API_KEY!,
  // apiUrl: 'https://api.atlasent.io',   // default
  // environment: 'live',
  // failClosed: true,                    // default — 403/500 on deny/error
});
```

**Standalone evaluation** — call `guard.evaluate(payload)` directly and handle
the result yourself. Useful in Hono, raw `http.createServer`, or any
non-Express framework:

```typescript
app.post('/hooks/deploy', async (c) => {
  const payload = await c.req.json();
  const result = await guard.evaluate(payload);

  if (result.decision !== 'allow' || !result.verified) {
    return c.json({ error: result.reason ?? 'denied' }, 403);
  }

  // Safe to proceed — permit verified
  await executeDeploy(payload);
  return c.json({ status: 'executed' });
});
```

**Express middleware** — mount `guard.middleware` to block automatically:

```typescript
import express from 'express';
const app = express();
app.use(express.json());

// The middleware responds 403/500 on deny/hold/error and calls next() on allow.
// req.atlasent holds the full result for downstream handlers.
app.post('/hooks/deploy', guard.middleware, (req, res) => {
  const { evaluationId, riskScore } = req.atlasent!;
  res.json({ status: 'executed', evaluationId });
});
```

**Custom payload extraction** — when your payload uses different field names:

```typescript
const guard = webhookGuard({
  apiKey: process.env.ATLASENT_API_KEY!,
  extractor: (payload) => ({
    action_type: payload.event_type as string,
    actor_id:    `user:${payload.triggered_by as string}`,
    context:     { repo: payload.repository },
  }),
});
```

**Result shape** — `guard.evaluate()` always resolves (never throws on
infra errors):

```typescript
interface WebhookGuardResult {
  decision: 'allow' | 'deny' | 'hold' | 'escalate' | 'error';
  verified: boolean;      // true only when decision=allow AND verifyPermit passed
  evaluationId?: string;
  proofHash?: string;
  riskScore?: number;
  reason?: string;        // deny/hold reason or infra error message
  error?: EnforceError;   // present on decision='error'
}
```

> **Always gate on `verified`, not `decision`.**  
> `verified=true` means the evaluation returned `allow` AND the permit token
> was confirmed server-side. An `allow` without `verified` means permit
> verification failed — the connector treats this as a block.

### AI-agent connector

Guards LangChain-style tool execution. Before any tool call, the guard
evaluates the call against AtlaSent and blocks (`AgentGuardError`) on
deny or hold.

**AgentGuard class:**

```typescript
import { AgentGuard, AgentGuardError } from '@atlasent/action/connectors';

const guard = new AgentGuard({
  apiKey: process.env.ATLASENT_API_KEY!,
  // defaultActorId: 'service:my-agent',
  // environment: 'live',
  // blockOnHold: true,   // default — hold blocks like deny
});

try {
  const result = await guard.call(
    webSearchTool,
    { query: 'latest CVEs' },
    { agentId: 'security-scanner', sessionId: 'sess-42' },
  );
} catch (err) {
  if (err instanceof AgentGuardError) {
    console.error(`Blocked: ${err.decision} — ${err.message}`);
    // err.toolName      → 'web_search'
    // err.evaluationId  → AtlaSent evaluation id for audit
  }
}
```

**Wrap a tool** so every call is automatically guarded:

```typescript
const guardedSearch = guard.wrap(webSearchTool, { agentId: 'planner' });
// guardedSearch has the same interface as webSearchTool
const results = await guardedSearch.call({ query: 'hello' });
```

**Wrap an entire toolkit** at once:

```typescript
const tools = guard.wrapAll(
  [webSearchTool, codeExecutorTool, fileReadTool],
  { agentId: 'executor', sessionId: currentSessionId },
);
// Pass `tools` to your LangChain agent — every call goes through AtlaSent
```

**agentGuard() factory** — convenience shorthand:

```typescript
import { agentGuard } from '@atlasent/action/connectors';

const guard = agentGuard({ apiKey: process.env.ATLASENT_API_KEY! });

// Direct call:
const result = await guard.call(tool, args, { agentId: 'planner-v2' });

// Wrap:
const wrapped = guard.wrap(tool, { agentId: 'planner-v2' });

// Underlying AgentGuard instance:
console.log(guard.guard instanceof AgentGuard); // true
```

**Actor resolution** — the connector resolves the actor forwarded to AtlaSent
in the following priority order:

1. `ctx.agentId` → `"agent:<agentId>"`
2. `ctx.userId` → `"user:<userId>"`
3. `config.defaultActorId`
4. `"agent:unknown"` (default fallback)

**AgentGuardError** fields:

```typescript
class AgentGuardError extends Error {
  decision:    'deny' | 'hold' | 'escalate' | 'error';
  toolName:    string;   // tool.name that was blocked
  evaluationId?: string; // AtlaSent evaluation id for the audit trail
}
```

### Connector import paths

```typescript
// Subpath (preferred for tree-shaking):
import { webhookGuard, AgentGuard, agentGuard, AgentGuardError }
  from '@atlasent/action/connectors';

// Or from the package root:
import { webhookGuard, AgentGuard, agentGuard, AgentGuardError }
  from '@atlasent/action';
```

### Enforcement contract

All B7 connectors implement the same contract as the GitHub Actions reference:

1. **Evaluate** — POST `/v1-evaluate` with `action_type`, `actor_id`, and context.
2. **Decide** — non-`allow` decisions block immediately (no verifyPermit call).
3. **Verify permit** — POST `/v1-verify-permit` to confirm the token hasn't
   been replayed. Fail-closed: a missing permit token or failed verification blocks.
4. **Execute** — only reached when all three steps pass.

## SDK 2.11.0 Sub-clients

As of `@atlasent/sdk@2.11.0`, action authors have access to typed sub-clients on the top-level `AtlaSentClient` instance. These are available wherever the SDK client is imported:

| Sub-client | Description |
|---|---|
| `client.auth` | Token refresh and IdP connection listing. Use to exchange short-lived tokens or enumerate configured identity providers. |
| `client.scim` | SCIM 2.0 user and group provisioning. Manage users and groups in the AtlaSent directory via a standards-compliant interface. |
| `client.evidenceBundles` | Generate and download evidence bundles for audit and compliance workflows. Bundles are Ed25519-signed and chain back to the append-only audit log. |

In addition, `verifyEvidenceBundle(bundle)` is now exported from the SDK root for **offline bundle verification** — confirm the cryptographic integrity of a bundle without a network call. Useful in regulated environments where evidence artifacts are archived and re-verified later.

```typescript
import { AtlaSentClient, verifyEvidenceBundle } from '@atlasent/sdk';

const client = new AtlaSentClient({ apiKey: process.env.ATLASENT_API_KEY! });

// Generate an evidence bundle after a governed deploy
const bundle = await client.evidenceBundles.generate({ evaluationId: 'eval-xyz' });

// Verify offline at any future point
const ok = await verifyEvidenceBundle(bundle);
```

## How It Works

1. **Evaluate** — POST `/v1-evaluate` with `action_type`, `actor_id`, `target_id`, and a context object populated from GitHub workflow metadata (repo, ref, sha, workflow, run id, PR number, optional user-supplied `context`).
2. **Decide** — Server returns `allow` / `deny` / `hold` / `escalate` plus a single-use `permit_token` (only when `allow`) and an optional `risk-score`.
3. **Verify permit** — POST `/v1-verify-permit` to confirm the token hasn't been replayed. `verified=true` only when both steps pass.
4. **Proceed or block** — deny/hold/escalate are fail-closed outcomes and fail the step in pilot mode.
5. **Audit** — Every evaluation writes to the AtlaSent append-only, hash-chained audit log. The `evaluation-id` and `proof-hash` outputs reference the record.

## Protecting `main`

Add the action as a required check:

1. Add secrets `ATLASENT_API_KEY` and `ATLASENT_BASE_URL` in **Settings → Secrets and variables → Actions**
2. Wire the step into `.github/workflows/deploy.yaml`
3. Enable **Settings → Branches → Branch protection rules** and mark the workflow as required

## Fail-closed on infrastructure errors

If the action cannot reach the AtlaSent API (DNS, timeout, 5xx, 401/403, 429), it fails the step with `decision=error`. A security gate that silently lets deploys through when its authority source is unreachable is worse than no gate, so this is the default and recommended behaviour.

Infrastructure failures and non-allow policy decisions (`deny` / `hold` / `escalate`) are all fail-closed in pilot mode.

## Documentation

- Full docs: <https://atlasent.io/docs>
- API key guide: [docs/api-keys.md](https://github.com/AtlaSent-Systems-Inc/atlasent-api/blob/main/docs/api-keys.md)
- Examples: <https://github.com/AtlaSent-Systems-Inc/atlasent-examples>

## License

Licensed under the [Apache License, Version 2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution.

Copyright (c) AtlaSent IP Holdings LLC

Commercial licensing inquiries: [legal@atlasent.io](mailto:legal@atlasent.io)
