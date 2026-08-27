import {
  verify,
  verifyPermit,
} from "@atlasent/enforce";

export class EntraWorkloadBatchError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value, name) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new EntraWorkloadBatchError(`${name} is required`);
  return normalized;
}

export function buildWorkloadBatchItems(evaluations, identity) {
  if (!Array.isArray(evaluations) || evaluations.length < 2) {
    throw new EntraWorkloadBatchError("batch requires between 2 and 100 evaluations");
  }
  if (evaluations.length > 100) {
    throw new EntraWorkloadBatchError("batch requires between 2 and 100 evaluations");
  }
  const actorId = text(identity?.actorId, "minted actor_id");
  if (identity?.assertion?.version !== "actor_identity.v1") {
    throw new EntraWorkloadBatchError("minted actor assertion is malformed");
  }

  return evaluations.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new EntraWorkloadBatchError(`evaluation ${index} must be an object`);
    }
    const actionType = text(item.action_type, `evaluation ${index} action_type`);
    const environment = text(item.environment, `evaluation ${index} environment`);
    return {
      action_type: actionType,
      actor_id: actorId,
      actor_identity: identity.assertion,
      environment,
      ...(typeof item.target_id === "string" && item.target_id.trim()
        ? { target_id: item.target_id.trim() }
        : {}),
      ...(typeof item.execution_payload_hash === "string" && item.execution_payload_hash.trim()
        ? { execution_payload_hash: item.execution_payload_hash.trim() }
        : {}),
      ...(item.context && typeof item.context === "object" && !Array.isArray(item.context)
        ? { context: item.context }
        : {}),
    };
  });
}

function mapDecision(raw) {
  return {
    id: typeof raw.request_id === "string" ? raw.request_id : raw.id,
    decision: raw.decision,
    permitToken: raw.permit_token,
    executionHashExpected: raw.execution_hash_expected,
    denyReason: raw.deny_reason,
    holdReason: raw.hold_reason,
    evaluatedAt: raw.evaluated_at,
  };
}

function deriveRequiredBindings({ environment, targetId, executionPayloadHash }) {
  const bindings = [];
  if (environment) bindings.push("environment");
  if (targetId) bindings.push("target_id");
  if (executionPayloadHash) bindings.push("payload_hash");
  return bindings;
}

export async function evaluateEntraWorkloadBatch({
  baseUrl,
  apiKey,
  identity,
  evaluations,
  batchId = crypto.randomUUID(),
  fetchImpl = fetch,
  verifyDecision = verify,
  verifyPermitImpl = verifyPermit,
  requiredBindings = deriveRequiredBindings,
}) {
  const root = text(baseUrl, "ATLASENT_BASE_URL").replace(/\/$/, "");
  const key = text(apiKey, "ATLASENT_API_KEY");
  if (!UUID.test(batchId)) throw new EntraWorkloadBatchError("batch_id must be a UUID");
  const items = buildWorkloadBatchItems(evaluations, identity);

  const response = await fetchImpl(`${root}/v1-evaluate-batch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ batch_id: batchId, items }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new EntraWorkloadBatchError(
      `batch evaluation failed: ${body?.reason ?? body?.message ?? `HTTP ${response.status}`}`,
    );
  }
  if (
    body?.batch_id !== batchId ||
    body.partial !== false ||
    !Array.isArray(body.items) ||
    body.items.length !== items.length
  ) {
    throw new EntraWorkloadBatchError("batch response is partial, malformed, or mismatched");
  }

  const summaries = [];
  for (let index = 0; index < items.length; index += 1) {
    const raw = body.items[index];
    if (!raw || raw.index !== index) {
      throw new EntraWorkloadBatchError(`batch result index ${index} is missing or reordered`);
    }
    const decision = mapDecision(raw);
    if (!["allow", "deny", "hold", "escalate"].includes(decision.decision)) {
      throw new EntraWorkloadBatchError(`batch result ${index} has an invalid decision`);
    }
    verifyDecision(decision);

    const source = evaluations[index];
    const config = {
      apiUrl: root,
      apiKey: key,
      action: items[index].action_type,
      actor: identity.actorId,
      environment: items[index].environment,
      targetId: items[index].target_id,
      executionPayloadHash: items[index].execution_payload_hash,
      requiredBindings: requiredBindings({
        environment: items[index].environment,
        targetId: items[index].target_id,
        executionPayloadHash: items[index].execution_payload_hash,
      }),
    };
    const permit = await verifyPermitImpl(config, decision);
    summaries.push({
      index,
      action_type: source.action_type,
      decision: decision.decision,
      decision_id: decision.id,
      verified: permit.verified === true,
      permit_outcome: permit.outcome ?? "verified",
    });
  }

  return { batchId, actorId: identity.actorId, items: summaries };
}
