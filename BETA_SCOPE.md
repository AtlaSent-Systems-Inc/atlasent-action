# @atlasent/enforce — Beta Scope

**Status:** planning · **Follows:** Alpha (enforce-only pack, `enforce-v0.1.0-alpha`)

---

## What Alpha shipped

| Item | Deliverable |
|---|---|
| `packages/enforce` | `evaluate()`, `verify()`, `enforce()` — fail-closed contract |
| Action wiring | `src/index.ts` uses `@atlasent/enforce` for all evaluate + infra-error handling |
| Endpoint | Switched from Supabase edge URL to `https://api.atlasent.io/v1/evaluate` |
| Tag | `enforce-v0.1.0-alpha` |

## What Beta adds

Beta completes the v2.1 surface: batch fan-out, streaming-wait, and the new `evaluations` list input in `action.yml`. Each item ships behind a per-tenant flag so the Alpha single-eval path stays unchanged until the flag flips.

### B1 — Batch fan-out (`evaluateMany`)

- New `action.yml` input: `evaluations` (JSON array of `{ action, actor, environment?, context? }`)
- Auto-detect: `evaluations` wins when both `evaluations` and `action` are set; single-eval path is preserved unchanged when only `action` is set
- Implementation: `src/batch.ts` `evaluateMany()` already exists; wire into `src/index.ts` under `v2_batch` tenant flag
- Fallback (flag off): per-item loop on `/v1/evaluate` — same latency, no batch endpoint required

**Blocker:** `POST /v1/evaluate/batch` endpoint (Waqas lane)

### B2 — Streaming-wait for `change_window` approvals

- New `action.yml` inputs: `wait-for-id`, `wait-timeout-ms` (default 10 min)
- When a `hold`/`escalate` decision includes an evaluation id that matches `wait-for-id`, the action blocks and streams `/v1/evaluate/stream` SSE until the upstream approver flips it
- Fallback (flag off): 5-second polling on `GET /v1/evaluate/:id`
- Implementation: `src/stream.ts` `waitForTerminalDecision()` already exists; wire into main flow

**Blocker:** `POST /v1/evaluate/stream` SSE endpoint (Waqas lane)

### B3 — Batch decision output

- New `action.yml` output: `decisions-json` — JSON array of per-evaluation decisions for downstream matrix jobs
- Summary counts (`allow_count`, `deny_count`) surfaced as step-summary annotations

**Depends on:** B1

### B4 — Wire into `action.yml` + `src/index.ts` (B.AC4 remainder)

The Alpha wired `@atlasent/enforce` for the single-eval path. Beta wires B1 and B2:

```yaml
inputs:
  evaluations:
    description: 'JSON array of evaluation requests. Takes precedence over action: when both are set.'
    required: false
  wait-for-id:
    description: 'Evaluation ID to block on when decision is hold/escalate.'
    required: false
  wait-timeout-ms:
    description: 'Max ms to wait for a terminal decision (default: 600000).'
    required: false
    default: '600000'
outputs:
  decisions-json:
    description: 'JSON array of all evaluation decisions (batch path only).'
```

## Tenant-flag matrix

| Flag | Module | True | False / unset |
|---|---|---|---|
| `v2_batch` | `evaluateMany` | `POST /v1/evaluate/batch` | per-item loop |
| `v2_streaming` | `waitForTerminalDecision` | SSE on `/v1/evaluate/stream` | 5s poll on `/v1/evaluate/:id` |

## Sequencing

1. Waqas's `/v1/evaluate/batch` lands → unblocks B1
2. Waqas's `/v1/evaluate/stream` lands → unblocks B2
3. B1 + B3 wired into `src/index.ts` + `action.yml`
4. B2 wired in parallel with B1
5. B4 integration tests against staging
6. Tag `enforce-v0.2.0-beta` (or `action-v2.1.0`)

## Out of scope for Beta

- OIDC keyless auth implementation (documented in README; implementation deferred until auth-mode input is designed)
- GitLab CI / Bitbucket / Azure DevOps adapters
- Check-run mode (ROADMAP post-GA item 5)
- `@atlasent/sdk` pin (blocked on SDK v1 tag)
