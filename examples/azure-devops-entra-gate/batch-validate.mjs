import { mintEntraWorkloadIdentity } from "./lib.mjs";
import { evaluateEntraWorkloadBatch } from "./batch.mjs";

const evaluations = JSON.parse(process.env.ATLASENT_EVALUATIONS_JSON ?? "null");
const first = Array.isArray(evaluations) ? evaluations[0] : null;
const identity = await mintEntraWorkloadIdentity({
  baseUrl: process.env.ATLASENT_BASE_URL,
  apiKey: process.env.ATLASENT_API_KEY,
  accessToken: process.env.ATLASENT_ENTRA_TOKEN,
  action: first?.action_type,
  environment: first?.environment,
});

const result = await evaluateEntraWorkloadBatch({
  baseUrl: process.env.ATLASENT_BASE_URL,
  apiKey: process.env.ATLASENT_API_KEY,
  identity,
  evaluations,
  ...(process.env.ATLASENT_BATCH_ID ? { batchId: process.env.ATLASENT_BATCH_ID } : {}),
});

console.log(JSON.stringify({
  batch_id: result.batchId,
  actor_id: result.actorId,
  item_count: result.items.length,
  items: result.items,
}));
