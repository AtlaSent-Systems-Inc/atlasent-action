# GitHub Actions Example

Gate CI/CD deployments with AtlaSent execution-time authorization.

This workflow ensures every production deployment is authorized in real time — not just approved at merge time, but verified at the moment of execution.

## Setup

1. Add your AtlaSent API key as a repository secret: `ATLASENT_API_KEY`
2. Add your AtlaSent anon key as a repository variable: `ATLASENT_ANON_KEY`
3. Copy `deploy.yaml` into `.github/workflows/`

## How It Works

```
Push to main
    ↓
AtlaSent Evaluate → checks approvals, context, change window
    ↓
Permit token issued (single-use)
    ↓
AtlaSent Verify → confirms permit at execution time
    ↓
Deploy proceeds (only if verified)
```

## Full Working Example

See the [deploy-gate-demo](https://github.com/AtlaSent-Systems-Inc/deploy-gate-demo) repository for a complete, working GitHub Actions workflow with AtlaSent integration.
