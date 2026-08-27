# Azure DevOps Entra workload gate (draft)

This no-deploy starter obtains an app-only Microsoft Entra access token from an
Azure DevOps workload-identity-federated Azure Resource Manager service
connection, asks AtlaSent to mint a claim-minimized `actor_identity.v1`, and
runs the evaluate → verify → consume contract. It never runs a protected
command.

The matching runtime contract is being reviewed separately. Do not run this
pipeline until the runtime draft, organization-owned enrollment, durable replay
admission, signer trust root, and exact staging fixture have all passed human
review.

## Required Azure DevOps configuration

Create or select a workload-identity-federated Azure Resource Manager service
connection. New connections must use the current Microsoft Entra issuer model,
not the legacy Azure DevOps issuer scheduled for retirement.

Add these protected pipeline variables:

| Variable | Secret | Purpose |
|---|---:|---|
| `ATLASENT_AZURE_SERVICE_CONNECTION` | no | Exact service connection name used by `AzureCLI@2`. |
| `ATLASENT_ENTRA_SCOPE` | no | Broker application scope, normally `api://<broker-app-id>/.default`. |
| `ATLASENT_API_KEY` | yes | Organization-scoped key with `idp_broker:mint`, `evaluate:write`, and `verify:execute`. |
| `ATLASENT_BASE_URL` | no | Runtime function root ending in `/functions/v1`. |
| `ATLASENT_ACTION` | no | Protected action, for example `production.deploy`. |
| `ATLASENT_ENVIRONMENT` | no | Use `staging` for validation. |
| `ATLASENT_TARGET_ID` | no | Optional exact protected target binding. |

Copy this directory to the customer repository, preserving its package and lock
files. Both CI and PR triggers are disabled in the starter; a human must
explicitly authorize any validation run. The script never prints the Entra
token or the AtlaSent API key.

## Expected boundary

- Azure DevOps owns token acquisition through its service connection.
- AtlaSent verifies the Entra signature and exact issuer/audience, refuses
  delegated tokens, and derives the actor from tenant + service-principal
  object identifiers.
- `@atlasent/enforce` sends the signed actor assertion to evaluation and
  consumes the resulting permit with the same environment and target binding.
- No deployment command exists in this starter.

The eventual customer rollout order remains runtime → consumer → batch after
human review. This draft does not merge, deploy, enable, enroll, or dispatch.

## Batch validation

`azure-pipelines-batch.yml` is the stacked no-deploy batch variant. Set
`ATLASENT_EVALUATIONS_JSON` to an array of 2–100 items containing
`action_type`, `environment`, and optional `target_id`,
`execution_payload_hash`, and `context`. The client discards caller-supplied
`actor_id` or `actor_identity` and binds the one broker-minted assertion to
every item.

The batch validator requires an exact batch ID, ordered one-for-one results,
`partial=false`, an allow decision for every item, and successful permit
verification under each item's own environment, target, and payload digest.
It contains no protected command. `ATLASENT_BATCH_ID` is optional for ordinary
validation and may be fixed to a UUID only for the separately reviewed
idempotency/replay case.
