import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkloadBatchItems,
  EntraWorkloadBatchError,
  evaluateEntraWorkloadBatch,
} from "../batch.mjs";

const IDENTITY = {
  actorId: "entra-workload:tenant:t:object:o",
  assertion: { version: "actor_identity.v1", signature: "signed" },
};
const EVALUATIONS = [
  {
    action_type: "production.deploy",
    environment: "staging",
    target_id: "svc:api",
    execution_payload_hash: "a".repeat(64),
    actor_id: "attacker",
  },
  {
    action_type: "package.release",
    environment: "staging",
    target_id: "pkg:sdk",
    execution_payload_hash: "b".repeat(64),
    actor_identity: { version: "forged" },
  },
];
const BATCH_ID = "99999999-9999-4999-8999-999999999999";

function allowed(index) {
  return {
    index,
    decision: "allow",
    request_id: `decision-${index}`,
    permit_token: `permit-${index}`,
    evaluated_at: "2026-08-27T00:00:00Z",
  };
}

test("one minted identity replaces caller actor fields on every item", () => {
  const items = buildWorkloadBatchItems(EVALUATIONS, IDENTITY);
  for (const item of items) {
    assert.equal(item.actor_id, IDENTITY.actorId);
    assert.deepEqual(item.actor_identity, IDENTITY.assertion);
  }
});

test("posts the exact runtime batch contract and verifies every item binding", async () => {
  let request;
  const verifies = [];
  const result = await evaluateEntraWorkloadBatch({
    baseUrl: "https://runtime.example/functions/v1/",
    apiKey: "key",
    identity: IDENTITY,
    evaluations: EVALUATIONS,
    batchId: BATCH_ID,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({
        batch_id: BATCH_ID,
        items: [allowed(0), allowed(1)],
        partial: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    verifyDecision: () => {},
    verifyPermitImpl: async (config, decision) => {
      verifies.push({ config, decision });
      return { verified: true, outcome: "ok" };
    },
  });
  assert.equal(request.url, "https://runtime.example/functions/v1/v1-evaluate-batch");
  const wire = JSON.parse(request.init.body);
  assert.equal(wire.batch_id, BATCH_ID);
  assert.equal(wire.items.length, 2);
  assert.equal(verifies[0].config.targetId, "svc:api");
  assert.equal(verifies[0].config.executionPayloadHash, "a".repeat(64));
  assert.equal(verifies[1].config.targetId, "pkg:sdk");
  assert.equal(verifies[1].decision.permitToken, "permit-1");
  assert.equal(result.items.every((item) => item.verified), true);
});

test("partial, reordered, oversized, and non-allow batches fail closed", async () => {
  const run = (body) => evaluateEntraWorkloadBatch({
    baseUrl: "https://runtime.example/functions/v1",
    apiKey: "key",
    identity: IDENTITY,
    evaluations: EVALUATIONS,
    batchId: BATCH_ID,
    fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
    verifyDecision: (decision) => {
      if (decision.decision !== "allow") throw new Error("not allowed");
    },
    verifyPermitImpl: async () => ({ verified: true }),
  });
  await assert.rejects(run({ batch_id: BATCH_ID, items: [allowed(0)], partial: true }), /partial/);
  await assert.rejects(
    run({ batch_id: BATCH_ID, items: [allowed(1), allowed(0)], partial: false }),
    /reordered/,
  );
  await assert.rejects(
    run({ batch_id: BATCH_ID, items: [allowed(0), { ...allowed(1), decision: "deny" }], partial: false }),
    /not allowed/,
  );
  assert.throws(
    () => buildWorkloadBatchItems(Array.from({ length: 101 }, () => EVALUATIONS[0]), IDENTITY),
    EntraWorkloadBatchError,
  );
});
