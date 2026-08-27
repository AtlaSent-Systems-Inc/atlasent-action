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
| **Single-eval** (default) | `action:` set | Calls `/v1-evaluate` for one action, verifies the permit, outputs `decision` / `verified` / `permit-token` / `proof-hash` / `risk-score` / `evaluation-id`. On hold/escalate, `wait-for-approval: "true"` pauses and resumes on a human resolution instead of failing immediately — see README's "Pause-and-resume" section |
| **Batch-eval** | `evaluations:` set (JSON array) | Fan-out over multiple `{action, actor, context}` items; outputs `decisions` (JSON array) and `batch-id` |
| **Policy sync** | `policy-sync: "true"` | Reads a JSON bundle file and posts it to `v1-policy-sync`; outputs `sync-status` / `sync-diff` / `sync-summary` |
| **Release-mode** | `release-mode: "register-and-verify"` | Registers a release candidate and drives two verification probes against the control-plane |
| **Governance agents** | `governance-agents:` set | Runs advisory governance-agent slugs and emits `governance-findings` / `governance-highest-severity` |
| **Change Brief** | `change-brief: "true"` | Gathers this run's real GitHub/CI facts, calls `v1-change-brief`, and renders an evidence-bound `management_decision_brief.v1` projection. Source-read gaps are disclosed as `evidence_incomplete`; the projection remains advisory and never authorizes execution. |
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

Key action inputs (see `action.yml` for the full list of 71 inputs / 53 outputs):

| Input | Default | Description |
|---|---|---|
| `action` | — | Protected action type (e.g. `production.deploy`, `package.release`) |
| `actor` | `${{ github.actor }}` | Actor identity |
| `target-id` | — | Target resource identifier (service name, artifact id, etc.) |
| `environment` | auto | Deployment environment (`live` on main, `test` otherwise) |
| `context` | `{}` | JSON context passed to the evaluator |
| `approvals-from` | `pr-reviews` | Source for `context.approvals`: `"pr-reviews"` (auto-derive from GitHub API) or `"none"` |
| `wait-for-approval` | `"false"` | Set `"true"` to pause on hold/escalate and resume once a human resolves it in Console, instead of failing immediately (`mode: enforce` only) |
| `max-wait-minutes` | `30` | Bound on `wait-for-approval`'s poll window; exceeding it fails closed |
| `evaluations` | — | JSON array for batch mode (overrides single-eval inputs) |
| `policy-sync` | `"false"` | Set `"true"` to run policy-sync mode |
| `policy-bundle` | — | Path to JSON bundle file (required when `policy-sync: "true"`) |
| `evidence-bundle` | `"false"` | Request a compliance evidence bundle after authorization (`"true"`, `"soc2_type_ii"`, `"hipaa"`, `"gdpr"`) |
| `slack-webhook` | — | Slack Incoming Webhook URL for deny/hold/escalate notifications |
| `pr-comment-on-deny` | `"true"` | Post a PR comment on deny/hold/escalate |
| `governance-agents` | — | Comma-separated advisory governance-agent slugs |
| `change-brief` | `"false"` | Set `"true"` to run change-brief mode instead of evaluate — gathers real GitHub/CI facts and calls `v1-change-brief` |
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

C3 (architecture-hardening-review 2026-08-25): this example issues a permit
bound to `target-id` / `environment` / `artifact-digest` in one job, then
re-verifies those exact same bindings immediately before execution in the
job that actually runs `./scripts/deploy.sh` — not a single combined
evaluate+verify step. A single-step gate answers "was this request
authorized," which is not the same question as "is what's about to execute
still the thing that was authorized." Re-presenting the bindings at the
execution boundary is what makes a stale or substituted artifact fail
closed with `PAYLOAD_MISMATCH` / `MISSING_BINDING` instead of silently
running. See `requiredBindingsFor` in `packages/enforce/src/index.ts` for
the exact re-presentation contract this depends on: every binding present
at evaluate time must be present again at verify time, or verification
fails closed.

This is a documentation change only — `verify-permit` re-verification is
NOT automatic or code-enforced by default; a caller that omits the
`deploy` job below still gets the single-step evaluate+verify behavior
this action has always had. Silently making cross-job re-verification
mandatory would be a breaking behavior change for a widely-consumed public
GitHub Action and needs its own deprecation-window announcement, not a
docs edit — see the "Stronger execution-boundary pattern" section of
README.md for the full mechanics this example is now built on.

P1 fix (human review): an earlier revision of this example issued and
re-verified a digest but never actually moved the artifact's bytes between
jobs or re-checked them — `deploy` checked out only the repository and ran
`./scripts/deploy.sh` with no `out/` present and no re-hash, so the example
could verify one artifact and deploy something else (or nothing at all)
entirely undetected. The example below is now executable end-to-end: `build`
uploads `out/` as a real GitHub Actions artifact, and `deploy` downloads it
and re-hashes the downloaded bytes against the authorized digest **before**
calling AtlaSent verify — closing the exact gap the prose below was, until
now, only describing rather than demonstrating.

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      digest: ${{ steps.digest.outputs.digest }}
    steps:
      - uses: actions/checkout@v4
      - run: ./scripts/build.sh out/
      - id: digest
        run: echo "digest=sha256:$(tar -cf - out | sha256sum | cut -d' ' -f1)" >> "$GITHUB_OUTPUT"
      - name: Upload build artifact
        uses: actions/upload-artifact@v4
        with:
          name: build-output
          path: out/

  authorize:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write   # for pr-comment-on-deny
    outputs:
      permit: ${{ steps.gate.outputs.permit-token }}
    steps:
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
          artifact-digest: ${{ needs.build.outputs.digest }}
          mode: evaluate-only

  deploy:
    needs: [build, authorize]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Download build artifact
        uses: actions/download-artifact@v4
        with:
          name: build-output
          path: out/

      - name: Verify the downloaded bytes match the authorized digest
        run: |
          set -euo pipefail
          actual="sha256:$(tar -cf - out | sha256sum | cut -d' ' -f1)"
          expected="${{ needs.build.outputs.digest }}"
          if [ "$actual" != "$expected" ]; then
            echo "::error::downloaded artifact ($actual) does not match the authorized digest ($expected)"
            exit 1
          fi

      - name: AtlaSent verify
        id: verify
        uses: AtlaSent-Systems-Inc/atlasent-action@v1
        env:
          ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}
          ATLASENT_BASE_URL: ${{ secrets.ATLASENT_BASE_URL }}
        with:
          verify-permit: 'true'
          permit-token: ${{ needs.authorize.outputs.permit }}
          action: production.deploy
          target-id: api-service
          environment: live
          artifact-digest: ${{ needs.build.outputs.digest }}

      - name: Deploy
        # Gate on verified, not decision
        if: steps.verify.outputs.verified == 'true'
        run: ./scripts/deploy.sh out/
```

`mode: evaluate-only` leaves the single-use permit unconsumed at issue time,
so the `deploy` job's `verify-permit: 'true'` step is the one that actually
consumes it — immediately before `./scripts/deploy.sh` runs, not minutes (or
jobs) earlier. `target-id` / `environment` / `artifact-digest` must match
between the `authorize` and `deploy` steps; a mismatch on any of them fails
verification closed rather than executing against a request that was never
actually authorized.

**The digest binds the *identity* of the artifact into the authorization —
it does not by itself move the artifact's bytes between jobs, and AtlaSent
verify only checks that the DECLARED digest matches what was authorized; it
never sees the artifact's actual bytes.** GitHub Actions jobs run on
separate, isolated runners with no shared filesystem, so `deploy.sh` needs
its own way to obtain the exact thing `digest` describes, and that transfer
needs its own integrity check independent of AtlaSent's:

- **Raw file/directory artifact** (the case shown above): `actions/upload-artifact`
  in `build`, `actions/download-artifact` in `deploy`, then re-hash the
  downloaded bytes and compare against `digest` **before** calling AtlaSent
  verify — never after, and never skip it. This is what fails the run closed
  on a substituted, corrupted, or missing artifact, independent of whatever
  digest string the workflow claims.
- **Container image**: `build` pushes to a registry and `digest` is that
  image's real digest; `deploy` pulls `image@sha256:<digest>` directly — the
  registry pull itself is the integrity check, no separate re-hash step
  needed, and no file transfer between runners is required at all.

Skipping either of these — running `deploy.sh` against something not
independently confirmed to match the verified digest — silently defeats the
binding this whole pattern exists to enforce, exactly as it did in the
version of this example before the download/re-hash step above was added.

For an action with no separable build artifact, a single combined
evaluate+verify step (as in earlier versions of this example) is still
correct — pass `target-id` and `environment` and omit `artifact-digest` and
the `build`/`authorize` split entirely.

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
