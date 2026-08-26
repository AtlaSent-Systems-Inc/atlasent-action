import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalize,
  computeGithubPlanDigest,
  findRequiredGithubCheck,
  latestApprovedReviews,
  normalizeBaseUrl,
  parseJsonOutput,
} from '../.atlasent/salesforce/lib.mjs';
import { classifySalesforceDeploy } from '../.atlasent/salesforce/deploy.mjs';

test('canonicalize sorts object keys recursively', () => {
  assert.equal(canonicalize({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
});

test('GitHub plan digest is stable and ref-sensitive', () => {
  const input = {
    repository: 'example/repo',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    ref: 'feature/pilot',
  };
  const first = computeGithubPlanDigest(input);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first, computeGithubPlanDigest({ ...input }));
  assert.notEqual(first, computeGithubPlanDigest({ ...input, ref: 'feature/other' }));
});

test('latest review state wins and comments do not revoke approval', () => {
  const result = latestApprovedReviews([
    { user: { login: 'amy' }, state: 'APPROVED' },
    { user: { login: 'bob' }, state: 'APPROVED' },
    { user: { login: 'amy' }, state: 'COMMENTED' },
    { user: { login: 'bob' }, state: 'CHANGES_REQUESTED' },
  ]);
  assert.deepEqual(result, { count: 1, reviewers: ['amy'] });
});

test('only human approvals on the exact current head count', () => {
  const headSha = 'b'.repeat(40);
  const result = latestApprovedReviews([
    { user: { login: 'old', type: 'User' }, state: 'APPROVED', commit_id: 'a'.repeat(40) },
    { user: { login: 'current', type: 'User' }, state: 'APPROVED', commit_id: headSha },
    { user: { login: 'automation', type: 'Bot' }, state: 'APPROVED', commit_id: headSha },
  ], { headSha });
  assert.deepEqual(result, { count: 1, reviewers: ['current'] });
});

test('Gearset evidence can be a check run or commit status', () => {
  assert.deepEqual(
    findRequiredGithubCheck({
      name: 'Gearset Validation',
      checkRuns: [{ name: 'Gearset Validation', status: 'completed', conclusion: 'success', html_url: 'https://check' }],
    }),
    { source: 'check_run', name: 'Gearset Validation', state: 'success', successful: true, url: 'https://check' },
  );
  assert.equal(
    findRequiredGithubCheck({
      name: 'Gearset Validation',
      statuses: [{ context: 'Gearset Validation', state: 'failure' }],
    }).successful,
    false,
  );
  assert.equal(
    findRequiredGithubCheck({
      name: 'Gearset Validation',
      checkRuns: [{ name: 'Gearset Validation', status: 'completed', conclusion: 'neutral' }],
    }).successful,
    false,
  );
});

test('AtlaSent base URL must be HTTPS and end at the function root', () => {
  assert.equal(normalizeBaseUrl('https://example.supabase.co/functions/v1/'), 'https://example.supabase.co/functions/v1');
  assert.throws(() => normalizeBaseUrl('http://example.test/functions/v1'), /https/);
  assert.throws(() => normalizeBaseUrl('https://example.test'), /functions\/v1/);
});

test('Salesforce JSON parser tolerates a warning prefix', () => {
  assert.deepEqual(parseJsonOutput('warning\n{"status":0,"result":{"status":"Succeeded"}}'), {
    status: 0,
    result: { status: 'Succeeded' },
  });
});

test('Salesforce success requires an independent marker observation', () => {
  const command = { status: 0 };
  const parsed = { status: 0, result: { status: 'Succeeded' } };
  assert.equal(classifySalesforceDeploy(command, parsed, true), 'success');
  assert.equal(classifySalesforceDeploy(command, parsed, null), 'unknown');
  assert.equal(classifySalesforceDeploy({ status: 1 }, { status: 1, result: { status: 'Failed' } }, false), 'failure');
});
