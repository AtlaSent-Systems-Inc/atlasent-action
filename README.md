# atlasent-deploy-gate-demo

Demo repo for execution-time authorization: bind approvals/context to the deploy artifact, verify at runtime, and emit tamper-evident proof.

## Why This Matters

Production deploys are high-risk moments. Standard approvals happen *before* packaging—but what happens between approval and execution? Code can be altered, contexts change, deployments can be hijacked.

This demo shows how to:
- **Bind approvals to the artifact** — the approval token is locked to your specific deployment package
- **Verify at runtime** — before deployment, check that nothing's changed and the approval is still valid
- **Emit proof** — generate tamper-evident audit logs that satisfy compliance and forensics requirements

## How It Works

```
GitHub Actions Workflow
    ↓
AtlaSent Evaluate (issue single-use permit)
    ↓
Package & Sign Deploy Artifact
    ↓
AtlaSent Verify (check permit against artifact at execution time)
    ↓
Deploy (only if verification succeeds)
    ↓
Emit Tamper-Evident Proof (audit trail)
```

## Getting Started

[Setup instructions coming soon]

## License

GPL-3.0