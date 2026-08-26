import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main as preflightMain } from '../.atlasent/salesforce/preflight.mjs';
import { main as deployMain } from '../.atlasent/salesforce/deploy.mjs';
import { computeGithubPlanDigest } from '../.atlasent/salesforce/lib.mjs';

const HEAD_SHA = 'b'.repeat(40);
const BASE_SHA = 'a'.repeat(40);
const REPOSITORY = 'acme/salesforce';
const SF_ORG_ID = '00D000000000001AAA';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function withEnvironment(values) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = String(value);
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function installFakeSalesforceCli(root) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, 'sf');
  writeFileSync(executable, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_SF_LOG) {
  appendFileSync(process.env.FAKE_SF_LOG, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');
}
let result;
if (args[0] === 'org' && args[1] === 'display') {
  result = { status: 0, result: {
    orgId: '${SF_ORG_ID}', username: 'atlasent-pilot@example.test',
    instanceUrl: 'https://floqast--pilot.sandbox.my.salesforce.com'
  } };
} else if (args[0] === 'data' && args[1] === 'query' && args.join(' ').includes('FROM Organization')) {
  result = { status: 0, result: { totalSize: 1, records: [{
    Id: '${SF_ORG_ID}', IsSandbox: true, InstanceName: 'NA999S', OrganizationType: 'Developer Edition'
  }] } };
} else if (args[0] === 'project' && args[1] === 'deploy') {
  result = { status: 0, result: { id: '0Af000000000001AAA', status: 'Succeeded' } };
} else if (args[0] === 'data' && args[1] === 'query' && args.join(' ').includes('FROM PermissionSet')) {
  const count = Number(process.env.FAKE_MARKER_COUNT || '1');
  result = { status: 0, result: { totalSize: count, records: count ? [{
    Id: '0PS000000000001AAA', Name: 'AtlaSent_Pilot_Marker', Label: 'AtlaSent Pilot Marker'
  }] : [] } };
} else {
  process.stderr.write('unexpected fake sf command: ' + args.join(' '));
  process.exit(2);
}
process.stdout.write(JSON.stringify(result));
`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return bin;
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('zero-write preflight proves GitHub, Gearset, AtlaSent, and Salesforce connections', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atlasent-preflight-'));
  const evidenceDir = join(root, 'evidence');
  const outputFile = join(root, 'github-output');
  writeFileSync(outputFile, '');
  const bin = installFakeSalesforceCli(root);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.host === 'api.github.com') {
      if (url.pathname.endsWith('/pulls/7')) return jsonResponse({
        state: 'open', changed_files: 1, html_url: 'https://github.com/acme/salesforce/pull/7',
        base: { sha: BASE_SHA },
        head: { sha: HEAD_SHA, ref: 'pilot/marker', repo: { full_name: REPOSITORY } },
      });
      if (url.pathname.endsWith('/pulls/7/reviews')) return jsonResponse([
        { state: 'APPROVED', commit_id: HEAD_SHA, user: { login: 'reviewer-one', type: 'User' } },
        { state: 'APPROVED', commit_id: HEAD_SHA, user: { login: 'reviewer-two', type: 'User' } },
      ]);
      if (url.pathname.endsWith(`/commits/${HEAD_SHA}/check-runs`)) return jsonResponse({ check_runs: [{
        name: 'Gearset Validation', status: 'completed', conclusion: 'success', html_url: 'https://gearset.test/check/1',
      }] });
      if (url.pathname.endsWith(`/commits/${HEAD_SHA}/statuses`)) return jsonResponse([]);
      if (url.pathname.endsWith('/pulls/7/files')) return jsonResponse([{ filename: 'force-app/main/default/permissionsets/AtlaSent_Pilot_Marker.permissionset-meta.xml' }]);
    }
    if (url.pathname.endsWith('/v1-health')) return jsonResponse({ status: 'healthy' });
    if (url.pathname.endsWith('/v1-org-status')) return jsonResponse({
      provisioned: true, engine_ready: true, org_id: 'org_test', active_policy_count: 1, engine_version: 'test',
    });
    if (url.pathname.endsWith('/v1-consequential-operations/register')) return jsonResponse({ code: 'INVALID_INPUT' }, 400);
    if (url.pathname.endsWith('/v1-production-change-closeout/execution')) return jsonResponse({ code: 'INVALID_INPUT' }, 400);
    if (url.pathname.endsWith('/v1-github-app-config')) return jsonResponse({
      installations: [{ id: 'installation_1', is_active: true }],
      repo_configs: [{
        id: 'binding_1', installation_id: 'installation_1', repo_full_name: REPOSITORY,
        action_class_id: 'production.deploy', is_active: true,
      }],
    });
    throw new Error(`Unhandled fetch: ${init.method || 'GET'} ${url}`);
  };
  const restoreEnvironment = withEnvironment({
    ATLASENT_BASE_URL: 'https://runtime.example/functions/v1',
    ATLASENT_API_KEY: 'test-key',
    GITHUB_TOKEN: 'github-token',
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_API_URL: 'https://api.github.com',
    GITHUB_SHA: HEAD_SHA,
    PR_NUMBER: '7',
    GEARSET_CHECK_NAME: 'Gearset Validation',
    MIN_APPROVALS: '2',
    SF_TARGET_ORG: 'floqast-sandbox',
    SF_EXPECTED_INSTANCE_HOST: 'floqast--pilot.sandbox.my.salesforce.com',
    CONFIRM_SANDBOX: 'true',
    EVIDENCE_DIR: evidenceDir,
    GITHUB_OUTPUT: outputFile,
    MODE: 'preflight',
    PATH: `${bin}${delimiter}${process.env.PATH}`,
  });
  try {
    await preflightMain();
    const evidence = JSON.parse(readFileSync(join(evidenceDir, 'preflight.json'), 'utf8'));
    assert.equal(evidence.github.head_sha, HEAD_SHA);
    assert.equal(evidence.github.approvals.count, 2);
    assert.equal(evidence.github.gearset.successful, true);
    assert.equal(evidence.atlasent.github_app_repo_binding_id, 'binding_1');
    assert.equal(evidence.salesforce.is_sandbox, true);
    assert.match(readFileSync(outputFile, 'utf8'), /plan_digest=sha256:[0-9a-f]{64}/);
  } finally {
    restoreEnvironment();
    globalThis.fetch = previousFetch;
  }
});

async function runExecution(mode, markerCount) {
  const root = mkdtempSync(join(tmpdir(), `atlasent-${mode}-`));
  const candidate = join(root, 'candidate');
  const evidenceDir = join(root, 'evidence');
  const outputFile = join(root, 'github-output');
  const sfLog = join(root, 'sf-log');
  mkdirSync(join(candidate, 'manifest'), { recursive: true });
  writeFileSync(join(candidate, 'sfdx-project.json'), '{"packageDirectories":[{"path":"force-app","default":true}],"sourceApiVersion":"66.0"}\n');
  writeFileSync(join(candidate, 'manifest/atlasent-pilot-package.xml'), '<Package xmlns="http://soap.sforce.com/2006/04/metadata"/>\n');
  writeFileSync(join(candidate, 'manifest/package-empty.xml'), '<Package xmlns="http://soap.sforce.com/2006/04/metadata"/>\n');
  writeFileSync(join(candidate, 'manifest/atlasent-pilot-destructive.xml'), '<Package xmlns="http://soap.sforce.com/2006/04/metadata"/>\n');
  writeFileSync(outputFile, '');
  writeFileSync(sfLog, '');
  runGit(candidate, ['init', '-b', 'pilot/marker']);
  runGit(candidate, ['config', 'user.email', 'test@example.test']);
  runGit(candidate, ['config', 'user.name', 'AtlaSent Test']);
  runGit(candidate, ['add', '.']);
  runGit(candidate, ['commit', '-m', 'pilot marker']);
  const headSha = runGit(candidate, ['rev-parse', 'HEAD']);
  const bin = installFakeSalesforceCli(root);
  const planDigest = computeGithubPlanDigest({ repository: REPOSITORY, baseSha: BASE_SHA, headSha, ref: 'pilot/marker' });
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path: url.pathname, body });
    if (url.pathname.endsWith('/v1-consequential-operations/register')) return jsonResponse({ operation_id: 'operation_1' });
    if (url.pathname.endsWith('/v1-consequential-operations/begin-attempt')) return jsonResponse({ attempt_id: 'attempt_1' });
    if (url.pathname.endsWith('/v1-consequential-operations/record-attempt')) return jsonResponse({ state: 'completed' });
    if (url.pathname.endsWith('/v1-production-change-closeout/execution')) return jsonResponse({
      execution_correlation: { verdict: 'MATCH', github_server_verified: true },
    });
    throw new Error(`Unhandled fetch: ${init.method || 'GET'} ${url}`);
  };
  const restoreEnvironment = withEnvironment({
    MODE: mode,
    ATLASENT_VERIFIED: 'true',
    ATLASENT_BASE_URL: 'https://runtime.example/functions/v1',
    ATLASENT_API_KEY: 'test-key',
    ATLASENT_PERMIT_TOKEN: 'permit-secret-that-must-not-enter-evidence',
    ATLASENT_DECISION_ID: `decision_${mode}`,
    PLAN_DIGEST: planDigest,
    GITHUB_REPOSITORY: REPOSITORY,
    BASE_SHA,
    HEAD_SHA: headSha,
    HEAD_REF: 'pilot/marker',
    CANDIDATE_DIR: candidate,
    SF_TARGET_ORG: 'floqast-sandbox',
    SF_ORG_ID,
    EVIDENCE_DIR: evidenceDir,
    PR_NUMBER: '7',
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_ACTOR: 'operator',
    GITHUB_WORKFLOW: 'AtlaSent Salesforce change gate',
    GITHUB_OUTPUT: outputFile,
    ATLASENT_CONSOLE_URL: 'https://console.atlasent.test',
    FAKE_MARKER_COUNT: String(markerCount),
    FAKE_SF_LOG: sfLog,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
  });
  try {
    await deployMain();
    const evidence = JSON.parse(readFileSync(join(evidenceDir, `${mode}.json`), 'utf8'));
    const sfCalls = readFileSync(sfLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const record = calls.find((item) => item.path.endsWith('/record-attempt'));
    const correlation = calls.find((item) => item.path.endsWith('/execution'));
    assert.equal(evidence.outcome, 'success');
    assert.equal(evidence.deployment_id, '0Af000000000001AAA');
    assert.equal(record.body.outcome, 'success');
    assert.match(correlation.body.permit_token_hash, /^[0-9a-f]{64}$/);
    assert.equal(correlation.body.executed_github_revision.head_sha, headSha);
    assert.equal(JSON.stringify(evidence).includes('permit-secret-that-must-not-enter-evidence'), false);
    assert.equal(sfCalls[0].cwd, candidate);
    assert.deepEqual(sfCalls[0].args.slice(0, 3), ['project', 'deploy', 'start']);
    return { evidence, sfCalls };
  } finally {
    restoreEnvironment();
    globalThis.fetch = previousFetch;
  }
}

test('acceptance deploys from the exact candidate project and records correlated success', async () => {
  const { evidence, sfCalls } = await runExecution('acceptance', 1);
  assert.equal(evidence.observation.marker_record_count, 1);
  assert.ok(sfCalls[0].args.includes('manifest/atlasent-pilot-package.xml'));
  assert.equal(sfCalls[0].args.includes('--post-destructive-changes'), false);
});

test('cleanup uses the destructive manifest and confirms the marker is absent', async () => {
  const { evidence, sfCalls } = await runExecution('cleanup', 0);
  assert.equal(evidence.observation.marker_record_count, 0);
  assert.ok(sfCalls[0].args.includes('manifest/package-empty.xml'));
  assert.ok(sfCalls[0].args.includes('manifest/atlasent-pilot-destructive.xml'));
});
