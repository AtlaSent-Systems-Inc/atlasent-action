import * as core from '@actions/core';

type Decision = 'allow' | 'deny' | 'hold' | 'escalated';

interface EvaluateResponse {
  decision: Decision;
  evaluation_id: string;
  reason?: string;
  policy_version?: string;
  permit?: {
    id: string;
    token?: string;
    expires_at?: string;
  };
  verification?: {
    verified: boolean;
    audit_hash?: string;
  };
  escalation?: {
    url?: string;
    required_approvers?: number;
  };
}

interface EvaluateRequest {
  action_type: string;
  actor_id: string;
  context: Record<string, unknown>;
}

function parseContext(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('context must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(`invalid JSON in 'context' input: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function buildGithubContext(): Record<string, unknown> {
  return {
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
    workflow: process.env.GITHUB_WORKFLOW,
    run_id: process.env.GITHUB_RUN_ID,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT,
    event: process.env.GITHUB_EVENT_NAME,
    actor: process.env.GITHUB_ACTOR,
    runner_os: process.env.RUNNER_OS,
  };
}

async function evaluate(
  apiUrl: string,
  apiKey: string,
  body: EvaluateRequest,
  timeoutMs: number,
): Promise<EvaluateResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
  const endpoint = `${apiUrl.replace(/\/+$/, '')}/v1/evaluate`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'X-Request-Id': requestId,
        'User-Agent': 'atlasent-action/2',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = `${res.status} ${res.statusText}`;
      try {
        const parsed = text ? JSON.parse(text) : null;
        if (parsed?.message) message = `${res.status} ${parsed.message}`;
        else if (parsed?.error) message = `${res.status} ${parsed.error}`;
        else if (text) message = `${res.status} ${text.slice(0, 300)}`;
      } catch {
        if (text) message = `${res.status} ${text.slice(0, 300)}`;
      }
      throw new Error(`AtlaSent ${endpoint} → ${message}`);
    }

    const data = (await res.json()) as EvaluateResponse;
    if (!data || typeof data.decision !== 'string' || !data.evaluation_id) {
      throw new Error('AtlaSent returned a malformed evaluate response');
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function iconFor(decision: Decision): string {
  switch (decision) {
    case 'allow': return 'ALLOW';
    case 'deny': return 'DENY';
    case 'hold': return 'HOLD';
    case 'escalated': return 'ESCALATED';
  }
}

async function writeSummary(req: EvaluateRequest, result: EvaluateResponse): Promise<void> {
  const rows: Array<[string, string]> = [
    ['Decision', `\`${result.decision}\``],
    ['Action', `\`${req.action_type}\``],
    ['Actor', `\`${req.actor_id}\``],
    ['Evaluation ID', `\`${result.evaluation_id}\``],
  ];
  if (result.reason) rows.push(['Reason', result.reason]);
  if (result.policy_version) rows.push(['Policy version', `\`${result.policy_version}\``]);
  if (result.permit?.id) rows.push(['Permit ID', `\`${result.permit.id}\``]);
  if (result.permit?.expires_at) rows.push(['Permit expires', `\`${result.permit.expires_at}\``]);
  if (result.verification) {
    rows.push(['Verified', result.verification.verified ? 'yes' : 'no']);
    if (result.verification.audit_hash) rows.push(['Audit hash', `\`${result.verification.audit_hash}\``]);
  }
  if (result.escalation?.url) rows.push(['Review', result.escalation.url]);

  await core.summary
    .addHeading(`AtlaSent — ${iconFor(result.decision)}`)
    .addTable([
      [{ data: 'Field', header: true }, { data: 'Value', header: true }],
      ...rows.map(([k, v]) => [k, v]),
    ])
    .write();
}

function logResult(req: EvaluateRequest, result: EvaluateResponse): void {
  core.info('');
  core.info(`AtlaSent decision: ${result.decision.toUpperCase()}`);
  core.info(`  action_type:   ${req.action_type}`);
  core.info(`  actor_id:      ${req.actor_id}`);
  core.info(`  evaluation_id: ${result.evaluation_id}`);
  if (result.reason) core.info(`  reason:        ${result.reason}`);
  if (result.policy_version) core.info(`  policy:        ${result.policy_version}`);
  if (result.permit?.id) core.info(`  permit_id:     ${result.permit.id}`);
  if (result.permit?.expires_at) core.info(`  permit_exp:    ${result.permit.expires_at}`);
  if (result.verification) {
    core.info(`  verified:      ${result.verification.verified}`);
    if (result.verification.audit_hash) core.info(`  audit_hash:    ${result.verification.audit_hash}`);
  }
  if (result.escalation?.url) core.info(`  review:        ${result.escalation.url}`);
  core.info('');
}

function setOutputs(result: EvaluateResponse): void {
  core.setOutput('decision', result.decision);
  core.setOutput('reason', result.reason ?? '');
  core.setOutput('evaluation-id', result.evaluation_id);
  core.setOutput('permit-id', result.permit?.id ?? '');
  core.setOutput('permit-expires-at', result.permit?.expires_at ?? '');
  core.setOutput('verified', result.verification?.verified ? 'true' : 'false');
  core.setOutput('audit-hash', result.verification?.audit_hash ?? '');
  core.setOutput('escalation-url', result.escalation?.url ?? '');
  core.setOutput('policy-version', result.policy_version ?? '');

  if (result.permit?.token) core.setSecret(result.permit.token);
}

async function run(): Promise<void> {
  try {
    const apiUrl = core.getInput('api-url') || 'https://api.atlasent.io';
    const apiKey = core.getInput('api-key', { required: true });
    const actionType = core.getInput('action-type', { required: true });
    const actorIdInput = core.getInput('actor-id');
    const actorId = actorIdInput || `gha:${process.env.GITHUB_ACTOR ?? 'unknown'}`;
    const userContext = parseContext(core.getInput('context'));
    const failOnDeny = core.getBooleanInput('fail-on-deny');
    const timeoutMs = Number(core.getInput('timeout-ms') || '15000');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`invalid timeout-ms: ${core.getInput('timeout-ms')}`);
    }

    core.setSecret(apiKey);

    const request: EvaluateRequest = {
      action_type: actionType,
      actor_id: actorId,
      context: { ...buildGithubContext(), ...userContext },
    };

    core.startGroup('AtlaSent evaluate request');
    core.info(`POST ${apiUrl.replace(/\/+$/, '')}/v1/evaluate`);
    core.info(JSON.stringify(request, null, 2));
    core.endGroup();

    const result = await evaluate(apiUrl, apiKey, request, timeoutMs);

    setOutputs(result);
    logResult(request, result);
    await writeSummary(request, result);

    if (result.decision === 'allow') return;

    const headline = `AtlaSent ${result.decision.toUpperCase()} — action_type=${actionType}` +
      (result.reason ? ` reason="${result.reason}"` : '') +
      ` evaluation_id=${result.evaluation_id}`;

    if (failOnDeny) core.setFailed(headline);
    else core.warning(`${headline} (advisory mode — step not failed)`);
  } catch (e) {
    // Fail-closed: any error (network, auth, malformed response) blocks the protected step.
    core.setFailed(`AtlaSent gate failed closed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

void run();
