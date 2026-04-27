# atlasent-action — v2 Rollout Plan

Wave B of the org-wide v2 rollout. See umbrella plan:
`atlasent-systems-inc/atlasent` → `V2_ROLLOUT.md`.

## Position

The action already shipped its v2.0.0 release (OIDC keyless, per
`atlasent-docs/plans/atlasent-action.md`). The org-wide v2 rollout treats
this repo as already-on-the-train; this plan defines the v2.1 follow-up that
aligns with the rest of the rollout.

## Scope

### v2.1 deliverables

- Pin to `@atlasent/sdk` 2.x once published.
- Use `evaluateMany` to gate multi-environment deploys in one action call
  (one decision per environment).
- New input `evaluations` (YAML/JSON list) that fans out via batch.
- Default `auth-mode: oidc` in the README example workflow (input default
  remains `api-key` for backward compatibility).
- Surface stream events from `authorizeStream` for long-running approval
  windows (e.g., `change_window` waits) — emits step summary updates while
  the action waits for an approval.

### Examples sync

- `atlasent-examples/v2/github-action/example-workflow.yml` becomes the
  canonical example. README links to it.

## Sequencing

| Step | Description | Depends on |
|---|---|---|
| B.AC1 | Pin `@atlasent/sdk` to 2.x                            | sdk B.2 |
| B.AC2 | New `evaluations` list input + fan-out                | B.AC1 |
| B.AC3 | Streaming wait support for `change_window`            | B.AC1, api A.3 |
| B.AC4 | README: OIDC-first example                            | — |

## Cross-repo dependencies

- **`atlasent-sdk`**: 2.x publish.
- **`atlasent-api`**: batch + stream endpoints live behind the tenant flag.
- **`atlasent-examples`**: shared example workflow.

## Out of scope

- GitLab CI / Bitbucket Pipelines actions — already noted as "Next" in
  `atlasent-docs/plans/atlasent-action.md`, separate roadmap item.

## Open questions

- Should the action auto-detect a list input vs single and pick endpoint, or
  keep them as distinct inputs?
- Streaming approval UX: how do we render mid-action progress in the GitHub
  step summary nicely?
