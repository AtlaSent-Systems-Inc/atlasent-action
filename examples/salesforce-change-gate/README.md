# Salesforce change gate — customer starter

This is the customer-owned seam for a Salesforce sandbox proof. Your GitHub repository never calls or clones the private `atlasent-api` source repository. The workflow calls your deployed AtlaSent runtime over HTTPS through the public, commit-pinned AtlaSent Action.

The proof is intentionally narrow:

1. Read an open same-repository pull request and its current reviews.
2. Require the named Gearset validation check to be successful.
3. Confirm the AtlaSent tenant, policy, API-key scopes, GitHub App binding, and Salesforce sandbox connection without changing Salesforce.
4. Bind a permit to the PR's immutable GitHub plan digest.
5. Verify and consume that permit immediately before execution.
6. Deploy one unassigned Permission Set that grants no permissions.
7. Query Salesforce independently to confirm the marker exists.
8. Write the operation outcome and GitHub execution correlation to AtlaSent.
9. Expose the `decision_id`, Salesforce deployment ID, Authorization Lineage link, closeout link, and a sanitized evidence artifact.
10. Run the separately governed `cleanup` mode to delete the marker and confirm it is gone.

## What you copy

Copy the contents of this directory into the root of the Salesforce repository. The resulting customer repository contains every file the workflow executes:

- `.github/workflows/atlasent-salesforce-gate.yml`
- `.atlasent/salesforce/lib.mjs`
- `.atlasent/salesforce/preflight.mjs`
- `.atlasent/salesforce/deploy.mjs`
- `sfdx-project.json`
- `force-app/main/default/permissionsets/AtlaSent_Pilot_Marker.permissionset-meta.xml`
- the three XML files under `manifest/`

No AtlaSent source-repository access is required.

## Your connection job — and ours

You do not need to learn AtlaSent internals or request access to any private AtlaSent repository.

| Owner | Complete before the first preflight |
|---|---|
| AtlaSent | Provision your test organization; activate the `production.deploy` policy and constraint bundle; provide the deployed runtime URL and org-scoped API key; make Authorization Lineage and Production Change Closeout available in the Console. |
| Your GitHub admin | Create the protected `customer-sandbox` Environment; add the values below; require an environment reviewer; install the AtlaSent GitHub App; allow it on the Salesforce repository; protect the trusted integration paths. |
| Your Salesforce admin | Create or select the dedicated sandbox integration user, grant the bounded pilot permissions below, authenticate it locally, and save only its SFDX auth URL in the protected GitHub Environment. |
| Your Gearset admin | Confirm the exact successful GitHub check name written on the current PR head SHA. |

Once those four rows are complete, your operator only selects the PR branch, enters its PR number, and runs `preflight`, `acceptance`, then `cleanup`. The workflow produces the evidence and links; the operator does not copy IDs between systems.

## One-time connection checklist

Create a protected GitHub Environment named `customer-sandbox`. Require an environment reviewer and prevent self-review. Add these environment values.

| Kind | Name | Value / owner |
|---|---|---|
| Secret | `ATLASENT_API_KEY` | AtlaSent provides an org-scoped test key. Required scopes: `evaluate:write`, `verify:execute`, `consequential_operations:write`, `production_change:write`, and `integrations:read`. |
| Variable | `ATLASENT_BASE_URL` | AtlaSent provides the deployed function root, ending in `/functions/v1`. |
| Variable | `ATLASENT_CONSOLE_URL` | Normally `https://console.atlasent.io`. |
| Secret | `SFDX_AUTH_URL` | You create this from a dedicated Salesforce sandbox integration user and save it directly as a GitHub secret. Never send it by email or place it in a file. |
| Variable | `SF_TARGET_ORG_ALIAS` | Suggested: `customer-sandbox`. |
| Variable | `SF_EXPECTED_INSTANCE_HOST` | Exact sandbox host returned by Salesforce, without `https://`. The preflight refuses every other host and also queries `Organization.IsSandbox`. |
| Variable | `GEARSET_CHECK_NAME` | Exact GitHub check-run name or commit-status context Gearset posts on the PR. |
| Variable | `MIN_APPROVALS` | Suggested: `2`. |
| Variable | `SF_DEPLOY_WAIT_MINUTES` | Suggested: `30`. |

AtlaSent must also complete these one-time items before handoff:

- Provision your test organization in the runtime.
- Activate `production.deploy` and publish its constraint bundle.
- Mint the scoped API key above.
- Install the AtlaSent GitHub App for your GitHub organization and bind this repository to the active `production.deploy` action class.
- Confirm the runtime routes used by this starter are deployed: `v1-org-status`, `v1-consequential-operations`, `v1-production-change-closeout`, `v1-github-app-config`, `v1-evaluate`, and `v1-verify-permit`.

## Create the Salesforce sandbox credential

You perform this locally; AtlaSent never receives the credential.

```bash
npm install --global @salesforce/cli@2.149.9
sf org login web --instance-url https://test.salesforce.com --alias customer-sandbox
sf org auth show-sfdx-auth-url --target-org customer-sandbox --json
```

Copy only the returned `sfdxAuthUrl` value into the GitHub Environment secret `SFDX_AUTH_URL`. Treat it as a credential. The dedicated user should have only the sandbox and metadata permissions needed for the bounded proof.

For this marker proof, give that dedicated sandbox user a permission set containing:

- `API Enabled`;
- `Modify Metadata Through Metadata API Functions`;
- `Manage Profiles and Permission Sets`, because the proof creates and deletes one unassigned Permission Set; and
- `View Setup and Configuration`, so the independent observation can read setup records.

Do not grant production access. `Modify All Data` is not required for this bounded metadata-only proof. If your Salesforce security policy requires a different permission model, keep the workflow in `preflight` until the sandbox administrator approves the final integration-user permission set.

## Run order

Open a same-repository PR containing the marker files. Let Gearset finish its validation and collect the required human GitHub approvals on the PR's current head SHA. A new push requires new approvals.

The trusted workflow and `.atlasent/salesforce/` scripts must already be on the default branch. Protect those paths with CODEOWNERS and branch protection. If an execution PR changes either path, preflight refuses it; merge integration changes separately, then open a fresh pilot PR.

In **Actions → AtlaSent Salesforce change gate → Run workflow**:

1. Select the PR branch in GitHub's branch selector. This is required so the workflow run itself is anchored to the same head SHA it reports to AtlaSent.
2. Enter the PR number.
3. Choose `preflight` and confirm sandbox. The run performs no Salesforce write.
4. When preflight is green, repeat with `acceptance`.
5. Review the Salesforce deployment ID, Authorization Lineage, Production Change Closeout, and uploaded sanitized evidence.
6. Repeat with `cleanup` and confirm the marker is absent.

The preflight fails with a specific reason if the wrong branch is selected, the PR is a fork, reviews are insufficient, Gearset is not green, the AtlaSent tenant or scopes are incomplete, the GitHub App is not bound, the Salesforce host differs, or Salesforce reports a production org.

## Where you see the result

| Question | System of record |
|---|---|
| What changed and who approved it? | GitHub PR and Gearset check. |
| Was this exact revision authorized? | AtlaSent Console → Authorization Lineage, opened from the workflow summary by `decision_id`. |
| Did the permit verify at execution time? | The same Authorization Lineage and Action Evidence record. |
| What did Salesforce do? | Salesforce deployment record, keyed by the deployment ID in the workflow summary. |
| Did the authorized revision match the executed revision, and did execution succeed? | AtlaSent Console → Production Change Closeout. |
| What can be attached to the pilot record? | The workflow's `atlasent-salesforce-*` sanitized evidence artifact. |

Gearset is used here as native PR validation evidence. Salesforce CLI is the exact-artifact execution path. This starter does not claim that Gearset's Automation API can bind a deployment to the same immutable artifact at execution time.
