export class EntraWorkloadGateError extends Error {}

function required(value, name) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new EntraWorkloadGateError(`${name} is required`);
  return normalized;
}

export async function mintEntraWorkloadIdentity({
  baseUrl,
  apiKey,
  accessToken,
  action,
  environment,
  fetchImpl = fetch,
}) {
  const root = required(baseUrl, "ATLASENT_BASE_URL").replace(/\/$/, "");
  const token = required(accessToken, "ATLASENT_ENTRA_TOKEN");
  const response = await fetchImpl(
    `${root}/v1-idp-broker/mint/actor-identity`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${required(apiKey, "ATLASENT_API_KEY")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "entra_workload",
        id_token: token,
        action_type: required(action, "ATLASENT_ACTION"),
        environment: required(environment, "ATLASENT_ENVIRONMENT"),
      }),
    },
  );

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = body?.error?.message ?? body?.message ?? `HTTP ${response.status}`;
    throw new EntraWorkloadGateError(`workload identity mint failed: ${reason}`);
  }
  if (
    body?.kind !== "actor_identity.v1" ||
    typeof body.actor_id !== "string" ||
    body.actor_id.length === 0 ||
    body.assertion?.version !== "actor_identity.v1"
  ) {
    throw new EntraWorkloadGateError("broker returned a malformed actor identity");
  }
  return { actorId: body.actor_id, assertion: body.assertion, source: body.source };
}
