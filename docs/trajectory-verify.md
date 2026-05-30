# Trajectory Verify Mode

The `trajectory-verify` input enables the AtlaSent Gate action to verify that CI execution remains on the authorized trajectory at each step. This is the GitHub Actions integration for the Deploy Gate pattern described in [AtlaSent Trajectory Authorization](https://docs.atlasent.io/trajectory).

## How It Works

Instead of a single `evaluate` call at the start of a job, trajectory authorization covers the full execution path:

```
Evaluate (with proposed_trajectory) → AuthorizedTransitionSpec
↓
For each step:
  Verify (permit_id + step_id) → on_trajectory: bool
  If false: HALT
  Execute step
↓
ComplianceComparisonArtifact (fidelity_score + trace)
```

## Workflow Example

```yaml
jobs:
  deploy:
    steps:
      # 1. Authorize the trajectory
      - uses: atlasent-systems-inc/atlasent-action@v1
        id: authorize
        with:
          action: production.deploy
          target-id: my-service
          proposed_trajectory: |
            {"steps": [
              {"step_id": "pre-flight",    "description": "Run tests and security scan"},
              {"step_id": "build",         "description": "Build Docker image"},
              {"step_id": "deploy-canary", "description": "Canary deploy (5%)"},
              {"step_id": "deploy-full",   "description": "Full production deploy"}
            ]}
          desired_state: '{"description": "v1.2.3 deployed to production"}'
        env:
          ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}

      # 2. Verify before each step
      - uses: atlasent-systems-inc/atlasent-action@v1
        with:
          trajectory-verify: 'true'
          trajectory-permit-id: ${{ steps.authorize.outputs.evaluation-id }}
          trajectory-step-id: pre-flight
          trajectory-step-name: 'Pre-flight checks'
        env:
          ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}

      - run: npm test && npm run security-scan

      - uses: atlasent-systems-inc/atlasent-action@v1
        with:
          trajectory-verify: 'true'
          trajectory-permit-id: ${{ steps.authorize.outputs.evaluation-id }}
          trajectory-step-id: build
        env:
          ATLASENT_API_KEY: ${{ secrets.ATLASENT_API_KEY }}

      - run: docker build -t myapp:${{ github.sha }} .

      # ... repeat for each step
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `trajectory-verify` | No | `false` | Enable trajectory-verify mode |
| `trajectory-permit-id` | Yes* | `''` | `evaluation-id` output from the authorize step |
| `trajectory-step-id` | Yes* | `''` | Must match a `step_id` in the authorized trajectory |
| `trajectory-step-name` | No | `''` | Human-readable name for job summary |
| `trajectory-halt-on-deviation` | No | `true` | Fail the job on deviation (`false` = advisory) |

*Required when `trajectory-verify: true`

## Outputs

| Output | Description |
|---|---|
| `trajectory-on-trajectory` | `true` / `false` |
| `trajectory-deviation-type` | Type of deviation (empty when on trajectory) |
| `trajectory-fidelity-score` | [0-1] fidelity at this point in execution |
| `trajectory-compliance-artifact-id` | Artifact ID when trajectory completes |

## Deviation Types

| Type | Cause |
|---|---|
| `step_not_on_trajectory` | `step_id` not present in authorized trajectory |
| `step_out_of_sequence` | Step executed out of the authorized order |
| `required_step_skipped` | A required prior step was not verified |
| `time_limit_exceeded` | Trajectory `max_duration_seconds` exceeded |
| `trajectory_expired` | `AuthorizedTransitionSpec` TTL expired |
| `constraint_violation` | A declared trajectory constraint was violated |

## GxP / Compliance Use

For 21 CFR Part 11 compliance, pair with `evidence-bundle: soc2_type_ii` on the authorize step and upload the `trajectory-compliance-artifact-id` to your QMS after execution. See [atlasent-gxp-starter](https://github.com/atlasent-systems-inc/atlasent-gxp-starter) for the 8-step migration trajectory pack.
