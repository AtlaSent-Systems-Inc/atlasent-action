# atlasent-action — v2.1 rollout

Wave B of the [umbrella v2 rollout](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/claude/plan-v2-rollout-5IPGF/V2_ROLLOUT.md). Companion implementation to plan PR #15.

## Status

| Item | Module | State |
|---|---|---|
| B.AC1 — list-input parser (`evaluations:`) | `src/inputs.ts` | landed (this PR, draft) |
| B.AC2 — batch fan-out via `/v1/evaluate/batch` | `src/batch.ts` | landed (this PR, draft) |
| B.AC3 — streaming-wait for change_window | `src/stream.ts` | landed (this PR, draft) |
| B.AC4 — wire v2.1 modules into `action.yml` + `src/index.ts` | not in this PR | pending review of the new shape |

## Scope (this PR)

New files only. `action.yml` and `src/index.ts` are untouched so the
v2.0 entry point keeps shipping unchanged. The v2.1 entry point at
`src/v21.ts` is a preview surface; B.AC4 wires it in after this PR
settles.

## Tenant flags

- `v2_batch` — `evaluateMany()` switches between `/v1/evaluate/batch`
  and per-item loop.
- `v2_streaming` — `waitForTerminalDecision()` switches between SSE
  consumption and 5s polling.

## Why this PR is a draft

- B.AC4 wiring waits on review of the input shape (single vs list).
- The v2.1 entry point is reviewable in `src/v21.ts` without touching
  the production action.
- Endpoints behind both flags are gated by `atlasent-control-plane#5`
  (now landed as control-plane#6).
