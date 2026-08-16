# AtlaSent Gate Action

Execution-time authorization for consequential GitHub Actions.

AtlaSent evaluates an attempted action before it executes, issues a scoped permit
when the action is authorized, and verifies that permit before the protected step
runs. A deny, hold, escalation, invalid permit, infrastructure failure, or binding
mismatch fails closed.

```text
workflow attempts action
        │
        ▼
AtlaSent evaluates organizational authority
        │
   ┌────┴────┐
   │         │
 permit     deny / hold / escalate / error
   │         │
 verify      └──────────────► protected step does not run
   │
   ▼
protected step may run
```

## Release status

The security fix that prevents caller-supplied context from overriding verified
GitHub-derived facts is on `main` at commit
`01cfce7461c3ebff736ca3396deb2467cf2829a1`. Until the next signed `v1` release
moves the floating tag, external workflows should pin that reviewed commit SHA
rather than relying on the older `@v1` tag.

After the signed release is published and `@v1` moves, the normal floating-major
form is `AtlaSent-Systems-Inc/atlasent-action@v1`.

## Quick start

```yaml
- name: Authorization gate
  id: gate
  uses: AtlaSent-Systems-Inc/atlasent-action@01cfce7461c3ebff736ca3396deb2467cf2829a1
  env:
    ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}
    ATLASENT_BASE_URL: ${{ secrets.ATLASENT_BASE_URL }}
  with:
    action: production.deploy
    target-id: ${{ github.repository }}

- name: Deploy
  if: steps.gate.outputs.verified == 'true'
  run: ./deploy.sh
```

**Gate on `verified`, not on `decision`.** `verified=true` means the action was
allowed and the server successfully verified the single-use permit.

## Supported protected actions

The GitHub Action intentionally has a conservative client-side allowlist for its
single-evaluation path. Current values are:

- `production.deploy`
- `package.release`
- `trial.blinding.setup`
- `trial.unblinding.execute`
- `trial.unblinding.emergency`
- `trust_root.publish`

This allowlist is input validation, **not the authorization authority**. Passing
client-side validation does not authorize an action; the AtlaSent runtime policy
still decides whether the request is allowed, denied, held, or escalated.

Other action namespaces can be governed through AtlaSent SDK and MCP integration
surfaces. A new action type must be deliberately added to this GitHub Action
before the single-evaluation path will forward it.

## GitHub-derived facts cannot be overridden

The optional `context` input is useful for application-specific facts such as
service name, change-window state, or deployment metadata. Caller-supplied
context is applied first.

Facts derived or verified from the GitHub runtime are then applied last and win
on collision. These include repository, ref, SHA, workflow/run metadata, PR
number/run URL, and — when `approvals-from: pr-reviews` is enabled — approval
count and approving-reviewer identities.

That ordering is security-significant: a workflow cannot claim a different
repository or manufacture an approval count by placing those keys in `context`.
Non-colliding application context is preserved.

## PR-review approvals

By default, `approvals-from: pr-reviews` asks the GitHub API for the pull
request's current reviews and derives:

- `context.approvals`
- `context.approving_reviewers`

Provide `GITHUB_TOKEN` when the policy depends on review evidence:

```yaml
- name: Authorization gate
  id: gate
  uses: AtlaSent-Systems-Inc/atlasent-action@01cfce7461c3ebff736ca3396deb2467cf2829a1
  env:
    ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}
    ATLASENT_BASE_URL: ${{ secrets.ATLASENT_BASE_URL }}
    GITHUB_TOKEN: ${{ github.token }}
  with:
    action: production.deploy
    environment: live
    context: '{"change_window": true}'
```

If review lookup fails, the derived approval count falls to zero. For an
approval-gated policy that is the fail-closed direction: the workflow does not
invent approval evidence.

Set `approvals-from: none` only when the selected policy does not depend on
GitHub-review-derived approval evidence or when a different, explicitly trusted
authority source is being used.

## Stronger execution-boundary pattern

The default one-step mode performs evaluate → permit → verify in the gate step.
For a stronger boundary across jobs, bind the built artifact into the permit,
issue without consuming it, then consume it immediately before execution.

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      digest: ${{ steps.digest.outputs.digest }}
    steps:
      - uses: actions/checkout@v4
      - run: ./build.sh out/
      - id: digest
        run: echo "digest=sha256:$(tar -cf - out | sha256sum | cut -d' ' -f1)" >> "$GITHUB_OUTPUT"

  authorize:
    needs: build
    runs-on: ubuntu-latest
    outputs:
      permit: ${{ steps.gate.outputs.permit-token }}
    steps:
      - id: gate
        uses: AtlaSent-Systems-Inc/atlasent-action@01cfce7461c3ebff736ca3396deb2467cf2829a1
        env:
          ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}
          ATLASENT_BASE_URL: ${{ secrets.ATLASENT_BASE_URL }}
        with:
          action: production.deploy
          environment: production
          artifact-digest: ${{ needs.build.outputs.digest }}
          mode: evaluate-only

  deploy:
    needs: [build, authorize]
    runs-on: ubuntu-latest
    steps:
      - id: verify
        uses: AtlaSent-Systems-Inc/atlasent-action@01cfce7461c3ebff736ca3396deb2467cf2829a1
        env:
          ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}
          ATLASENT_BASE_URL: ${{ secrets.ATLASENT_BASE_URL }}
        with:
          verify-permit: 'true'
          permit-token: ${{ needs.authorize.outputs.permit }}
          action: production.deploy
          environment: production
          artifact-digest: ${{ needs.build.outputs.digest }}

      - if: steps.verify.outputs.verified == 'true'
        run: ./deploy.sh out/
```

`artifact-digest` is bound into the authorization as the execution payload hash.
A permit issued for one digest and verified against another fails with
`PAYLOAD_MISMATCH`. `mode: evaluate-only` deliberately leaves the single-use
permit unconsumed so the later boundary step can verify and consume it.

## Clinical example

The same execution contract can gate a provisioned clinical action:

```yaml
- name: Clinical unblinding gate
  id: gate
  uses: AtlaSent-Systems-Inc/atlasent-action@01cfce7461c3ebff736ca3396deb2467cf2829a1
  env:
    ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}
    ATLASENT_BASE_URL: ${{ secrets.ATLASENT_BASE_URL }}
  with:
    action: trial.unblinding.execute
    target-id: trial:NCT12345678
    environment: production

- name: Perform unblinding
  if: steps.gate.outputs.verified == 'true'
  run: ./scripts/unblind.sh
```

The GitHub Action does not itself decide whether an unblinding is authorized.
The runtime evaluates the organization's policy, identity/approval evidence, and
required bindings for that action class.

## State snapshot

AtlaSent evaluations require a state snapshot so authorization is tied to known
execution state. The standard GitHub path injects a snapshot from the Actions
runtime automatically.

A custom snapshot can be supplied when a workflow needs to attach a pre-collected
state representation. Treat it as decision-bearing evidence: do not use a custom
snapshot merely to force a policy match.

## Core inputs

| Input | Purpose |
|---|---|
| `action` | Protected action type for the single-evaluation path. |
| `actor` | Actor identity; defaults to `github.actor`. |
| `target-id` | Resource or object being acted on. |
| `environment` | Execution environment. |
| `context` | Additional application context; verified/derived GitHub facts win on collision. |
| `approvals-from` | `pr-reviews` (default) or `none`. |
| `artifact-digest` | SHA-256 artifact/execution binding. |
| `mode` | `enforce` (default) or `evaluate-only`. |
| `verify-permit` | Run verify-only at the execution boundary. |
| `permit-token` | Permit to verify in boundary mode. |
| `api-url` | Runtime base URL override. |

`ATLASENT_API_KEY` authenticates the workflow to the AtlaSent runtime.
`ATLASENT_BASE_URL` should be set for pilot or self-hosted deployments.

For the complete machine-readable input/output surface, see [`action.yml`](./action.yml).

## Core outputs

| Output | Meaning |
|---|---|
| `verified` | `true` only after successful permit verification. |
| `decision` | `allow`, `deny`, `hold`, or `escalate` on the single-eval path. |
| `permit-token` | Permit token; consumed in normal mode, unconsumed in `evaluate-only`. |
| `permit-issued` | Whether a permit was minted. Do not use this to gate execution. |
| `evaluation-id` | Audit-lineage identifier. |
| `proof-hash` | Cryptographic proof reference when returned by the runtime. |
| `verify-outcome` | Coarse permit-verification result. |
| `verify-error-code` | Precise runtime verification error code on failure. |

## Fail-closed behavior

The protected step must not execute when:

- the authorization decision is `deny`, `hold`, or `escalate`;
- no permit is issued when one is required;
- permit verification fails;
- execution bindings differ;
- a permit is expired, revoked, invalid, or already consumed;
- the AtlaSent authority service is unavailable or authentication fails.

A governance control that silently bypasses itself when its authority source is
unreachable would create false assurance; this action therefore fails closed.

## Other modes

The repository also contains additional CI-oriented surfaces such as batch
evaluation, policy sync, release-candidate verification, governance-agent
findings, VQP re-derivation, trajectory verification, and evidence-bundle
output. Their machine-readable configuration is in [`action.yml`](./action.yml).
They do not change the core rule: a protected execution path should proceed only
when its required authorization and verification checks have actually passed.

For agent-tool interception rather than GitHub CI, use the public
[`atlasent-mcp-server`](https://github.com/AtlaSent-Systems-Inc/atlasent-mcp-server)
or the public [`atlasent-sdk`](https://github.com/AtlaSent-Systems-Inc/atlasent-sdk).
For independent audit-chain verification, use
[`atlasent-verify`](https://github.com/AtlaSent-Systems-Inc/atlasent-verify).

## Security

Do not put API keys, private signing material, or customer secrets in workflow
source or the `context` input. Use GitHub Actions secrets for credentials.

The `actor` field is authorization context; the API key authenticates the caller.
Do not treat a caller-supplied actor string by itself as proof of a human's
identity unless the applicable runtime policy explicitly binds it to trusted
identity evidence.

## License

Licensed under the [Apache License, Version 2.0](./LICENSE).

Copyright (c) AtlaSent IP Holdings LLC
