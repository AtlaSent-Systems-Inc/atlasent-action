# atlasent-action — Coordinated Release Plan

## Role
GitHub Actions gate. Blocks deploys unless AtlaSent issues a valid permit.

## Protected Action
`deploy.*` action types. No production deployment proceeds without a valid permit.

## Fail-Closed Behavior
Consistent with SDLC enforcement contract:
- Transport errors → workflow fails (BLOCK)
- 5xx responses → workflow fails (BLOCK)
- 401/403/429 → workflow fails (BLOCK)
- `fail-on-deny` flag governs policy decisions (allow operator choice)
- Infrastructure failures always fail-closed regardless of `fail-on-deny`

## Inputs
- `action-type`: e.g. "deploy.production"
- `target-id`: resource identifier (default: GITHUB_REPOSITORY)
- `api-key`: AtlaSent API key
- `fail-on-deny`: whether to fail workflow on policy deny (default: true)

## Outputs
- `decision`: allow | deny | hold | escalate
- `permit-id`: permit token ID if allowed
- `risk-score`: risk score from policy evaluation

## Open PRs
- PR #19: README sync (inputs/outputs table + fail-closed documentation)

## Repo Dependencies
- Depends on: atlasent-sdk (TypeScript), atlasent-api (HTTP)
- Consumed by: any GitHub Actions CI/CD pipeline
