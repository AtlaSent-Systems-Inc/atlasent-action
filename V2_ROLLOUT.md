# atlasent-action — V2 Rollout

**Status:** plan · **Wave:** B (action SDK pin + batch + streaming-wait) · **Updated:** 2026-04-26

Action-side cut of the [umbrella v2 rollout](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/claude/plan-v2-rollout-5IPGF/V2_ROLLOUT.md). The action already shipped v2.0.0 (OIDC keyless). v2.1 adds batch fan-out, streaming-wait, and SDK 2.x pin.

## Position

The action is a *bundled* gate — it doesn't runtime-import `@atlasent/sdk`. v2.1 changes that for two new code paths only (batch + streaming) so the bundle stays small for the v2.0 path.

## v2.1 deliverables

| ID | Item | Path | Notes |
|---|---|---|---|
| B.AC1 | Pin `@atlasent/sdk@^2` for the new code paths | `package.json`, build pipeline | Stays bundled. |
| B.AC2 | New `evaluations` list input — fan out via `evaluateMany` | `action.yml`, `src/inputs.ts`, `src/batch.ts` | Single `action.yml` input parser auto-detects single (`action:`) vs list (`evaluations:`). List wins when both. |
| B.AC3 | Streaming-wait for `change_window` approvals | `src/stream.ts` | Consumes `/v1/evaluate/stream` SSE; falls back to 5s polling when `v2_streaming` flag is off. |
| B.AC4 | Wire B.AC1–3 into `src/index.ts` main flow + `action.yml` inputs | `src/index.ts`, `action.yml` | Last; depends on input-shape sign-off in plan PR #15. |
| B.AC5 | Default `auth-mode: oidc` in README example | `README.md` | Backward-compatible (`api-key` remains the default *input* value). |

Each item ships with a fallback path so the v2.0 code stays byte-identical until the matching tenant flag flips.

## Tenant-flag matrix

| Flag (from `atlasent-control-plane`) | Code path |
|---|---|
| `v2_batch=true` | `evaluateMany` → `POST /v1/evaluate/batch` |
| `v2_batch=false` (default) | per-item loop on `/v1/evaluate` (today's behavior) |
| `v2_streaming=true` | SSE consumer for `change_window` waits |
| `v2_streaming=false` (default) | 5-second polling on `/v1/evaluate/:id` |

## Behavior conditioning layer

The action **does not** participate directly in the v2
[behavior conditioning layer](https://github.com/AtlaSent-Systems-Inc/atlasent-docs/blob/main/docs/V2_BEHAVIOR_CONDITIONING_LAYER.md) — the action's
agent is CI infrastructure, not a wellness app. But:

- A future `behavior-aware` policy can deny CI deploys based on the
  on-call engineer's recent escalation rate (drawn from `behavior-insights` aggregates). The action emits `actor` (GitHub username) in the v1 evaluate context already; the policy side is what changes.
- `change_window` decisions today already integrate with human approvals; v2 streaming-wait makes that loop tighter.

## Sequencing

1. Plan PR #15 input-shape decision (single vs list, auto-detect)
2. B.AC1–3 in flight as draft PR #16 (modules sit alongside v2.0 entry, not yet wired)
3. B.AC4 wiring once API endpoints (`/v1/evaluate/batch`, `/v1/evaluate/stream`) are deployed (Waqas lane)
4. v1.2.0 polish (target-id input + risk-score output, draft PR #17) lands FIRST so v2.1 stacks cleanly

## Cross-repo dependencies

- **atlasent-sdk**: 2.x publish must precede B.AC1
- **atlasent-api**: `/v1/evaluate/batch`, `/v1/evaluate/stream`, plus the `evaluations[].id` correlation field — all Waqas lane
- **atlasent-control-plane**: `v2_batch` and `v2_streaming` per-tenant flags
- **atlasent-examples**: `flows/01-deploy-gate` becomes the canonical example workflow; updated in `flows/00-golden-path` once v2.1 ships

## Out of scope for v2.1

- GitLab CI / Bitbucket Pipelines actions — separate companion repos
- Azure DevOps extension — same
- Marketplace listing polish (icon, color, branding) — tracked in v1 GA milestones, not gated on v2

## Open questions

- Input shape: `evaluations:` (list) auto-detect vs explicit `mode: batch`? Plan PR #15 open question.
- Streaming progress UX in GitHub Actions step summary: refresh in place vs append?
- Should the action surface batch decision *summaries* (allow/deny counts) as a separate output for use by downstream summary jobs?

## Cross-repo links

- Per-repo plan: [`atlasent-docs/plans/atlasent-action.md`](https://github.com/AtlaSent-Systems-Inc/atlasent-docs/blob/main/plans/atlasent-action.md)
- Open PRs: #15 (plan, draft), #16 (B.AC1-3 implementation, draft), #17 (v1.2.0 polish, draft)
- Behavior layer: [`V2_BEHAVIOR_CONDITIONING_LAYER.md`](https://github.com/AtlaSent-Systems-Inc/atlasent-docs/blob/main/docs/V2_BEHAVIOR_CONDITIONING_LAYER.md)
