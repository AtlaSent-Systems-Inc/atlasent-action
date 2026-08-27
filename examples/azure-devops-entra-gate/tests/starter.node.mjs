import assert from "node:assert/strict";
import test from "node:test";
import {
  EntraWorkloadGateError,
  mintEntraWorkloadIdentity,
} from "../lib.mjs";

const INPUT = {
  baseUrl: "https://runtime.example/functions/v1/",
  apiKey: "api-key",
  accessToken: "entra-secret-token",
  action: "production.deploy",
  environment: "staging",
};

test("mints only through provider=entra_workload without caller principal fields", async () => {
  let request;
  const identity = await mintEntraWorkloadIdentity({
    ...INPUT,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({
        kind: "actor_identity.v1",
        actor_id: "entra-workload:tenant:t:object:o",
        assertion: { version: "actor_identity.v1", signature: "signed" },
        source: { provider: "microsoft_entra" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(
    request.url,
    "https://runtime.example/functions/v1/v1-idp-broker/mint/actor-identity",
  );
  assert.equal(request.init.headers.authorization, "Bearer api-key");
  const body = JSON.parse(request.init.body);
  assert.deepEqual(body, {
    provider: "entra_workload",
    id_token: "entra-secret-token",
    action_type: "production.deploy",
    environment: "staging",
  });
  assert.equal(identity.actorId, "entra-workload:tenant:t:object:o");
});

test("fails closed on rejected and malformed broker responses", async () => {
  await assert.rejects(
    mintEntraWorkloadIdentity({
      ...INPUT,
      fetchImpl: async () => new Response(JSON.stringify({ message: "wrong binding" }), { status: 401 }),
    }),
    EntraWorkloadGateError,
  );
  await assert.rejects(
    mintEntraWorkloadIdentity({
      ...INPUT,
      fetchImpl: async () => new Response(JSON.stringify({ kind: "actor_identity.v1" }), { status: 200 }),
    }),
    /malformed actor identity/,
  );
});
