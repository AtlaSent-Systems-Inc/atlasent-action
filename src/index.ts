import * as core from '@actions/core';

async function run(): Promise<void> {
  const apiUrl = core.getInput('atlasent-api-url', { required: true });
  const apiKey = core.getInput('atlasent-api-key', { required: true });
  const actionId = core.getInput('action-id', { required: true });
  const actorId = core.getInput('actor-id') || process.env.GITHUB_ACTOR || 'unknown';
  const targetId = core.getInput('target-id') || process.env.GITHUB_REPOSITORY || 'unknown';
  const failOnDeny = core.getBooleanInput('fail-on-deny');

  core.info(`AtlaSent: evaluating action "${actionId}" for actor "${actorId}"`);

  const payload = {
    actor: { id: actorId, type: 'service', metadata: { workflow: process.env.GITHUB_WORKFLOW, run_id: process.env.GITHUB_RUN_ID } },
    action: { id: crypto.randomUUID(), type: actionId },
    target: { id: targetId, type: 'repository', environment: process.env.GITHUB_REF?.includes('main') ? 'production' : 'staging' },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let result: { decision: string; risk?: { level: string; score: number }; id?: string; permitId?: string };

  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, '')}/v1/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AtlaSent-Key': apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`AtlaSent API error ${res.status}: ${err.message}`);
    }
    result = await res.json();
  } catch (e) {
    clearTimeout(timer);
    core.setFailed(`AtlaSent evaluation failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  core.setOutput('decision', result.decision);
  core.setOutput('risk-level', result.risk?.level ?? 'unknown');
  core.setOutput('risk-score', String(result.risk?.score ?? 0));
  core.setOutput('evaluation-id', result.id ?? '');
  core.setOutput('permit-id', result.permitId ?? '');

  core.info(`AtlaSent decision: ${result.decision} (risk: ${result.risk?.level}, score: ${result.risk?.score})`);

  if (result.decision === 'deny') {
    const msg = `AtlaSent denied action "${actionId}" — risk ${result.risk?.level} (${result.risk?.score}/100)`;
    if (failOnDeny) core.setFailed(msg);
    else core.warning(msg);
  } else if (result.decision === 'require_approval') {
    core.warning(`AtlaSent requires approval for action "${actionId}". Permit: ${result.permitId ?? 'none'}`);
  } else {
    core.info(`AtlaSent allowed action "${actionId}". Permit: ${result.permitId}`);
  }
}

run();
