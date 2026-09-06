# Production Change Authority

AtlaSent adds execution-time organizational authorization to consequential production changes.

> Access to a deployment tool is not the same as authority to make every production change.

The AtlaSent GitHub Action evaluates the exact proposed action against current organizational authority, approval evidence, environment, and other required context before the protected step can run. A positive decision is carried to the execution boundary as a bounded permit and must verify before execution.

## Start with one protected action

The flagship path is `production.deploy`.

Typical safeguards include:

- verified workload actor identity;
- production-environment binding;
- independent approval;
- separation of duties;
- current change context and evidence;
- replay/freshness protections;
- binding between the authorized revision/artifact and the change that actually executes.

## Rehearse before production

A first implementation should exercise representative cases before production activation:

| Scenario | Expected result |
|---|---|
| Unauthorized or unverified actor | DENY |
| Missing required approval | HOLD or DENY, depending on policy |
| Self-approval / SoD conflict | DENY |
| Stale or invalid evidence | DENY |
| Correct actor + current independent approval + correct target | ALLOW, followed by permit verification |

A failed rehearsal is not a dead end. Treat the failed condition as a resolution item: identify what is missing, who owns the fix, and what evidence will verify closure. Preserve the original decision; a new evaluation proves the corrected state.

## Production-readiness path

**Setup Required → Ready to Rehearse → Rehearsal Passed → Acceptance Required → Ready for Production → Production Active**

Installation does not imply production authority. Production activation should remain an explicit customer-controlled event.

## What the proof should answer

For a governed production action, the organization should be able to determine:

- who or what requested the action;
- under which organizational authority;
- what approvals/evidence were current;
- which policy/control version was evaluated;
- why the action was allowed, denied, or held;
- whether execution matched what was authorized;
- what evidence proves the result.

## Fits the existing stack

AtlaSent complements GitHub, identity providers, deployment/change systems, and target-native controls. Identity establishes who the principal is. AtlaSent determines whether that principal has authority for this exact consequential action now.

## Next step

Use the repository README quick start to wire the Action, then run a non-consequential rehearsal before enabling a real production effect.

For the execution contract, permit-verification boundary, and current pinning guidance, see the main [README](../README.md).
