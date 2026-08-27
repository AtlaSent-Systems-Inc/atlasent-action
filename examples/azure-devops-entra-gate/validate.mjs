import {
  evaluate,
  requiredBindingsFor,
  verify,
  verifyPermit,
} from "@atlasent/enforce";
import { mintEntraWorkloadIdentity } from "./lib.mjs";

const baseUrl = process.env.ATLASENT_BASE_URL;
const apiKey = process.env.ATLASENT_API_KEY;
const action = process.env.ATLASENT_ACTION ?? "production.deploy";
const environment = process.env.ATLASENT_ENVIRONMENT ?? "staging";
const targetId = process.env.ATLASENT_TARGET_ID;

const identity = await mintEntraWorkloadIdentity({
  baseUrl,
  apiKey,
  accessToken: process.env.ATLASENT_ENTRA_TOKEN,
  action,
  environment,
});

const config = {
  apiUrl: baseUrl,
  apiKey,
  action,
  actor: identity.actorId,
  actorIdentity: identity.assertion,
  environment,
  ...(targetId ? { targetId } : {}),
  requiredBindings: requiredBindingsFor({ environment, targetId }),
};

const decision = await evaluate(config);
verify(decision);
const permit = await verifyPermit(config, decision);

console.log(JSON.stringify({
  decision: decision.decision,
  decision_id: decision.id,
  actor_id: identity.actorId,
  source: identity.source,
  permit_outcome: permit.outcome ?? "verified",
}));
