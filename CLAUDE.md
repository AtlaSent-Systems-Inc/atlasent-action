# CLAUDE.md — atlasent-action

GitHub Action that enforces execution-time AtlaSent authorization gates on deployments and other critical CI/CD actions. Calls the AtlaSent API (`v1-evaluate` + `v1-verify-permit`), issues a cryptographically signed permit on `allow`, and fails closed (`deny`, `hold`, `escalate` all fail the workflow step with a human-readable denial reason).

## Architecture baseline

> Canonical cross-repo reference: [`atlasent-docs/architecture/ARCHITECTURE-BASELINE.md`](https://github.com/AtlaSent-Systems-Inc/atlasent-docs/blob/main/architecture/ARCHITECTURE-BASELINE.md)

This repo's role: **CI/CD integration layer** — the published GitHub Action that wires the AtlaSent runtime API into any workflow. Wire-type source of truth is `atlasent-api`; this repo adds no authorization state.

Cross-repo invariants:
- Wire request/response shapes are defined in `atlasent-api/packages/types/`. Do not invent new fields here; consume what the API returns.
- The action is fail-closed by design: any non-`allow` decision, any network error, and any missing `ATLASENT_API_KEY` all fail the step. Do not add fail-open fallbacks.
- Gate on `verified`, not `decision`. `verified=true` means the evaluation returned `allow` AND the server confirmed the permit token was not replayed.
- `dist/index.js` is the committed runtime artifact. It must be current before a release tag is pushed. The release workflow verifies this and rejects a stale dist.

## What it does

The action supports several mutually exclusive modes, checked in this priority order:

| Mode | Trigger input | What happens |
|------|--------------|--------------|
| **Single-eval** (default) | `action:` set | Calls `/v1-evaluate` for one action, verifies the permit, outputs `decision` / `verified` / `permit-token` / `proof-hash` / `risk-score` / `evaluation-id` |
| **Batch-eval** | `evaluations:` set (JSON array) | Fan-out over multiple `{action, actor, context}` items; outputs `decisions` (JSON array) and `batch-id` |
| **Policy sync** | `policy-sync: "true"` | Reads a JSON bundle file and posts it to `v1-policy-sync`; outputs `sync-status` / `sync-diff` / `sync-summary` |
| **Release-mode** | `release-mode: "register-and-verify"` | Registers a release candidate and drives two verification probes against the control-plane |
| **Governance agents** | `governance-agents:` set | Runs advisory governance-agent slugs and emits `governance-findings` / `governance-highest-severity` |
| **VQP verify** | `vqp-snapshot-id:` set | Re-derives a VQP snapshot and audits hash/verdict drift |
| **Trajectory verify** | `trajectory-verify: "true"` | Calls `v1/trajectory-verify` to check the current CI step against an authorized trajectory |

## Project structure

```
src/                  TypeScript source
  index.ts            Main entry point (wires all modes)
  inputs.ts           Input parser + mode dispatch
  batch.ts            Batch evaluate + sequential fallback
  gate.ts             Fail-closed gate logic
  approvals.ts        GitHub PR review count derivation
  canonicalAction.ts  Action-type normalization + allowlist
  policySync.ts       Policy-sync mode
  governanceAgents.ts Governance-agent mode
  releaseCandidate.ts Release-candidate mode
  vqpVerify.ts        VQP re-derivation mode
  stateTransition.ts  Trajectory-verify mode
  evidenceBundle.ts   Post-deploy compliance evidence bundle
  stepSummary.ts      GitHub Actions job summary writer
  stream.ts           SSE poll for hold/escalate decisions
  v21.ts              v2.1 batch endpoint helpers
  __tests__/          Vitest unit tests (one per source file)
dist/
  index.js            Compiled bundle (committed; runs on node24)
packages/
  action/             @atlasent/action npm package
  enforce/            @atlasent/enforce npm package
action.yml            GitHub Action metadata (inputs, outputs, runs)
```

## Key inputs

Required secrets (set in repository or org secrets):

| Secret / env | Description |
|---|---|
| `ATLASENT_API_KEY` | API key scoped to at least `evaluate:write` + `verify:execute` |
| `ATLASENT_BASE_URL` | Supabase project URL, e.g. `https://<ref>.supabase.co/functions/v1` |

Key action inputs (see `action.yml` for the full list of 57 inputs / 42 outputs):

| Input | Default | Description |
|---|---|---|
| `action` | — | Protected action type (e.g. `production.deploy`, `package.release`) |
| `actor` | `${{ github.actor }}` | Actor identity |
| `target-id` | — | Target resource identifier (service name, artifact id, etc.) |
| `environment` | auto | Deployment environment (`live` on main, `test` otherwise) |
| `context` | `{}` | JSON context passed to the evaluator |
| `approvals-from` | `pr-reviews` | Source for `context.approvals`: `"pr-reviews"` (auto-derive from GitHub API) or `"none"` |
| `evaluations` | — | JSON array for batch mode (overrides single-eval inputs) |
| `policy-sync` | `"false"` | Set `"true"` to run policy-sync mode |
| `policy-bundle` | — | Path to JSON bundle file (required when `policy-sync: "true"`) |
| `evidence-bundle` | `"false"` | Request a compliance evidence bundle after authorization (`"true"`, `"soc2_type_ii"`, `"hipaa"`, `"gdpr"`) |
| `slack-webhook` | — | Slack Incoming Webhook URL for deny/hold/escalate notifications |
| `pr-comment-on-deny` | `"true"` | Post a PR comment on deny/hold/escalate |
| `governance-agents` | — | Comma-separated advisory governance-agent slugs |
| `release-mode` | — | Set `"register-and-verify"` for post-deploy release verification |
| `trajectory-verify` | `"false"` | Set `"true"` to verify a trajectory step |

> The table above is a curated subset. Two further input families in `action.yml` are not represented in the modes table: the `financial-governance` family (`financial-governance`, `financial-action-value`, `financial-action-currency`) and the `insights-*` family (`insights-org-id`, `insights-subject-id`, `insights-session-count`). See `action.yml` for the complete set.

## Key outputs

| Output | Description |
|---|---|
| `verified` | `"true"` only when `decision=allow` AND permit verified (gate on this, not `decision`) |
| `decision` | `allow` / `deny` / `hold` / `escalate` |
| `permit-token` | Single-use permit token (already consumed; audit reference only) |
| `evaluation-id` | Unique evaluation ID for the audit trail |
| `proof-hash` | Cryptographic proof hash |
| `risk-score` | Numeric risk score 0–100; empty string when not assessed |
| `chain-entry` | v1.1 immutable audit chain entry (JSON) |
| `snapshot` | Decision snapshot (JSON) |
| `decisions` | JSON array of per-item results (batch mode) |

## Usage examples

### Standard deployment gate

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write   # for pr-comment-on-deny
    steps:
      - uses: actions/checkout@v4

      - name: AtlaSent gate
        id: gate
        uses: AtlaSent-Systems-Inc/atlasent-action@v1
        env:
          ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}
          ATLASENT_BASE_URL: ${{ secrets.ATLASENT_BASE_URL }}
          GITHUB_TOKEN: ${{ github.token }}
        with:
          action: production.deploy
          target-id: api-service
          environment: live

      - name: Deploy
        # Gate on verified, not decision
        if: steps.gate.outputs.verified == 'true'
        run: ./scripts/deploy.sh
```

### Batch evaluation

```yaml
      - uses: AtlaSent-Systems-Inc/atlasent-action@v1
        env:
          ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}
          ATLASENT_BASE_URL: ${{ secrets.ATLASENT_BASE_URL }}
        with:
          evaluations: |
            [
              {"action": "production.deploy", "actor": "${{ github.actor }}", "context": {"service": "api"}},
              {"action": "production.deploy", "actor": "${{ github.actor }}", "context": {"service": "worker"}}
            ]
```

### Policy sync (dry-run on PRs, live on main)

```yaml
      - uses: AtlaSent-Systems-Inc/atlasent-action@v1
        env:
          ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}
          ATLASENT_BASE_URL: ${{ secrets.ATLASENT_BASE_URL }}
        with:
          policy-sync: "true"
          policy-bundle: policies/deploy-gate.json
          policy-dry-run: ${{ github.ref != 'refs/heads/main' }}
```

## Building locally

```bash
npm install            # install all deps
npm run build          # compile src/index.ts → dist/index.js (esbuild, node24 target)
npm run typecheck      # type-check without emitting
npm test               # run vitest tests
```

`dist/index.js` is the committed runtime artifact — GitHub Actions runs it directly without
an `npm install` step. Always commit the rebuilt dist before pushing a release tag.

If you push a branch with source changes, the `Build dist` workflow
(`.github/workflows/build-dist.yml`) automatically rebuilds and commits `dist/index.js`
for non-main branches.

## Release process

Full details: [`RELEASING.md`](RELEASING.md). Summary:

1. Ensure `dist/index.js` is current: `npm run build`, commit if changed.
2. Push a version tag:
   ```sh
   git tag v1.x.y
   git push origin v1.x.y
   ```
3. The `Release` workflow (`.github/workflows/release.yml`) runs automatically:
   - Builds and verifies `dist/index.js` is current.
   - Runs the AtlaSent release gate (`package.release` action) as a dogfood check.
   - Signs `dist/index.js` with cosign (Sigstore keyless).
   - Creates the GitHub Release.
   - Moves the floating `v1` tag to this release (so `@v1` resolves to the new build).

For the one-time bootstrap publish before any `v1` exists:
```sh
gh workflow run release.yml -f ref=v1.x.y -f bootstrap=true
```

Required secrets: `ATLASENT_API_KEY`, `ATLASENT_BASE_URL`.

## Branch convention

Use `claude/<topic>` for all work in this repo.
