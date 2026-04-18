import * as core from '@actions/core';

async function run() {
  const apiUrl = core.getInput('atlasent-api-url', { required: true });
  const apiKey = core.getInput('atlasent-api-key', { required: true });
  const actionId = core.getInput('action-id', { required: true });
  const environment = core.getInput('environment') || 'production';
  const actorId = core.getInput('actor-id') || process.env.GITHUB_ACTOR || 'ci';
  const contextStr = core.getInput('context') || '{}';
  const failOnDeny = core.getInput('fail-on-deny') !== 'false';

  let extraContext: Record<string, unknown> = {};
  try { extraContext = JSON.parse(contextStr); } catch {}

  const payload = {
    actor: { id: actorId, type: 'service', org_id: '' }, // org resolved server-side from API key
    action: { id: actionId },
    environment,
    context: {
      ...extraContext,
      github: {
        ref: process.env.GITHUB_REF,
        sha: process.env.GITHUB_SHA,
        workflow: process.env.GITHUB_WORKFLOW,
        run_id: process.env.GITHUB_RUN_ID,
        repository: process.env.GITHUB_REPOSITORY,
      },
    },
  };

  core.info(`Evaluating action: ${actionId} in environment: ${environment}`);

  const response = await fetch(`${apiUrl}/v1/evaluate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AtlaSent-Key': apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok && response.status !== 403) {
    throw new Error(`AtlaSent API error: ${response.status} ${await response.text()}`);
  }

  const decision = await response.json();

  core.setOutput('decision', decision.outcome);
  core.setOutput('risk-level', decision.risk?.level ?? 'unknown');
  core.setOutput('evaluation-id', decision.evaluation_id ?? '');
  core.setOutput('permit-id', decision.permit?.id ?? '');

  core.info(`Decision: ${decision.outcome}`);
  core.info(`Risk: ${decision.risk?.level} (${decision.risk?.score}/100)`);

  if (decision.outcome === 'deny') {
    const reasons = decision.risk?.reasons?.join(', ') ?? 'No reasons provided';
    if (failOnDeny) {
      core.setFailed(`Action denied by policy. Reasons: ${reasons}`);
    } else {
      core.warning(`Action denied by policy. Reasons: ${reasons}`);
    }
  } else if (decision.outcome === 'require_approval') {
    core.warning(`Action requires approval. Evaluation ID: ${decision.evaluation_id}`);
  } else {
    core.info(`Action allowed. Permit: ${decision.permit?.id ?? 'none'}`);
  }
}

run().catch(core.setFailed);
