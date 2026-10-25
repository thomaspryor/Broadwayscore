import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseArgs, evaluate, parseCount, isGhAuthError, normalizeRestRun, resolveWorkflowId, fetchWorkflowRuns, proxyAwareFetch, PUBLIC_REPO } = require('./check-workflow-run-status.js');
const { isSafeCheckCommand } = require('./lib/autonomous-triage-core.js');

const r = (c) => ({ conclusion: c, status: 'completed', url: 'u' });

test('parseArgs reads --workflow/--expect', () => {
  assert.deepEqual(parseArgs(['--workflow=data-health-check.yml', '--expect=success']), { workflow: 'data-health-check.yml', expect: 'success' });
});

// BRO-3320 original intent: most recent data-health-check.yml run succeeded.
test('BRO-3320: single most-recent run matches --expect', () => {
  assert.equal(evaluate([r('success'), r('failure')], { expect: 'success' }).ok, true);
  assert.equal(evaluate([r('failure'), r('success')], { expect: 'success' }).ok, false);
});

test('no runs is a failure, never vacuous', () => {
  assert.equal(evaluate([], { expect: 'success' }).ok, false);
  assert.equal(evaluate([], { expect: 'cancelled', limit: 20, maxMatch: 0 }).ok, false);
});

test('BRO-3145: 3 consecutive non-failure = failure max 0 of last 3', () => {
  assert.equal(evaluate([r('success'), r('success'), r('success')], { expect: 'failure', limit: 3, maxMatch: 0 }).ok, true);
  assert.equal(evaluate([r('success'), r('failure'), r('success')], { expect: 'failure', limit: 3, maxMatch: 0 }).ok, false);
});

test('BRO-3197: >=K successes in last N; short history cannot satisfy min-match', () => {
  const runs = [r('success'), r('failure'), r('success'), r('success'), r('failure')];
  assert.equal(evaluate(runs, { expect: 'success', limit: 5, minMatch: 3 }).ok, true);
  assert.equal(evaluate(runs, { expect: 'success', limit: 5, minMatch: 4 }).ok, false);
  assert.equal(evaluate([r('success'), r('success')], { expect: 'success', limit: 3, minMatch: 2 }).ok, false);
});

test('BRO-3152/3388: failure/cancelled count caps', () => {
  const runs = [r('failure'), r('success'), r('success'), r('success'), r('success')];
  assert.equal(evaluate(runs, { expect: 'failure', limit: 5, maxMatch: 1 }).ok, true);
  assert.equal(evaluate(runs, { expect: 'failure', limit: 5, maxMatch: 0 }).ok, false);
  assert.equal(evaluate([r('success')], { expect: 'cancelled', limit: 20, maxMatch: 0 }).ok, false, 'short history is not a pass');
  const twenty = Array.from({ length: 20 }, () => r('success'));
  assert.equal(evaluate(twenty, { expect: 'cancelled', limit: 20, maxMatch: 0 }).ok, true);
});

test('parseCount validates bounds', () => {
  assert.equal(parseCount(undefined, 'limit', 1), undefined);
  assert.equal(parseCount('5', 'limit', 1), 5);
  assert.throws(() => parseCount('0', 'limit', 1));
  assert.throws(() => parseCount('abc', 'limit', 1));
  assert.throws(() => parseCount('999', 'limit', 1));
});

test('SAFE_CHECK_FORMS admits the single and multi-run shapes, refuses raw gh run list', () => {
  const base = 'node scripts/check-workflow-run-status.js --workflow=data-health-check.yml --expect=success';
  assert.equal(isSafeCheckCommand(base), true);
  assert.equal(isSafeCheckCommand(`${base} --limit=5 --min-match=3`), true);
  assert.equal(isSafeCheckCommand('node scripts/check-workflow-run-status.js --workflow=x.yml --expect=failure --limit=5 --max-match=1'), true);
  assert.equal(isSafeCheckCommand(`${base} --limit=abc`), false);
  assert.equal(isSafeCheckCommand('gh run list --workflow=data-health-check.yml --limit 1'), false);
});

test('in-progress runs are not credited as clean', () => {
  const ip = { conclusion: '', status: 'in_progress', url: 'u' };
  assert.equal(evaluate([ip, ip, ip], { expect: 'failure', limit: 3, maxMatch: 0 }).ok, false);
  assert.equal(evaluate([ip, r('success'), r('success'), r('success')], { expect: 'failure', limit: 3, maxMatch: 0 }).ok, true);
});

test('CLI rejects vacuous/impossible bounds with exit 2', async () => {
  const { spawnSync } = await import('node:child_process');
  for (const extra of ['--limit=5 --min-match=0', '--limit=5 --max-match=5', '--limit=3 --min-match=4', '--limit=5 --min-match=3 --max-match=2']) {
    const res = spawnSync('node', ['scripts/check-workflow-run-status.js', '--workflow=x.yml', '--expect=success', ...extra.split(' ')], { encoding: 'utf8' });
    assert.equal(res.status, 2, extra);
  }
});

test('safe-form regex limit bounded to 1-50', () => {
  const base = 'node scripts/check-workflow-run-status.js --workflow=x.yml --expect=success';
  assert.equal(isSafeCheckCommand(`${base} --limit=50 --min-match=1`), true);
  assert.equal(isSafeCheckCommand(`${base} --limit=99 --min-match=1`), false);
});

// ── BRO-5661: public-API fallback when gh has no auth (done-gate env) ───────

const restRun = (conclusion, status = 'completed') => ({ conclusion, status, head_branch: 'main', html_url: `https://x/${conclusion}` });

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const hit = routes.find(([re]) => re.test(url));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => hit[1](url) };
  };
  return { impl, calls };
}

test('isGhAuthError: auth failures and missing gh fall back; other gh errors do not', () => {
  assert.equal(isGhAuthError({ stderr: 'To get started with GitHub CLI, please run:  gh auth login' }), true);
  assert.equal(isGhAuthError({ message: 'Command failed\nAlternatively, populate the GH_TOKEN environment variable' }), true);
  assert.equal(isGhAuthError({ code: 'ENOENT' }), true);
  assert.equal(isGhAuthError({ stderr: 'HTTP 404: workflow x.yml not found' }), false);
  assert.equal(isGhAuthError({ stderr: 'error connecting to api.github.com' }), false);
  assert.equal(isGhAuthError(null), false);
});

test('normalizeRestRun maps to the gh --json shape evaluate() reads', () => {
  assert.deepEqual(normalizeRestRun({ conclusion: null, status: 'in_progress', head_branch: 'b', html_url: 'u' }), { conclusion: '', status: 'in_progress', headBranch: 'b', url: 'u' });
  assert.equal(evaluate([normalizeRestRun(restRun('success'))], { expect: 'success' }).ok, true);
});

test('resolveWorkflowId matches file basename or display name', () => {
  const wfs = [{ id: 7, name: 'Test Suite', path: '.github/workflows/test.yml' }];
  assert.equal(resolveWorkflowId(wfs, 'test.yml'), 7);
  assert.equal(resolveWorkflowId(wfs, 'Test Suite'), 7);
  assert.equal(resolveWorkflowId(wfs, 'Nope'), null);
});

test('fetchWorkflowRuns by file: one unauthenticated call with limit/branch/status', async () => {
  const { impl, calls } = fakeFetch([[/\/workflows\/test\.yml\/runs/, () => ({ workflow_runs: [restRun('success'), restRun('failure')] })]]);
  const runs = await fetchWorkflowRuns({ workflow: 'test.yml', branch: 'main', limit: 2, completedOnly: true, fetchImpl: impl });
  assert.equal(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, `/repos/${PUBLIC_REPO}/actions/workflows/test.yml/runs`);
  assert.equal(u.searchParams.get('per_page'), '2');
  assert.equal(u.searchParams.get('branch'), 'main');
  assert.equal(u.searchParams.get('status'), 'completed');
  assert.ok(!Object.keys(calls[0].opts.headers).some((h) => /authorization/i.test(h)), 'never sends a token');
  assert.deepEqual(runs.map((r) => r.conclusion), ['success', 'failure']);
});

test('fetchWorkflowRuns by display name pages the workflow list; unknown name throws', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `W${i}`, path: `.github/workflows/w${i}.yml` }));
  const { impl, calls } = fakeFetch([
    [/workflows\?per_page=100&page=1/, () => ({ workflows: page1 })],
    [/workflows\?per_page=100&page=2/, () => ({ workflows: [{ id: 4242, name: 'Data Health Check', path: '.github/workflows/data-health-check.yml' }] })],
    [/workflows\/4242\/runs/, () => ({ workflow_runs: [restRun('success')] })],
  ]);
  const runs = await fetchWorkflowRuns({ workflow: 'Data Health Check', fetchImpl: impl });
  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[2].url).searchParams.get('status'), null, 'single-run mode keeps in-progress runs, like gh');
  assert.equal(runs[0].conclusion, 'success');
  await assert.rejects(fetchWorkflowRuns({ workflow: 'Missing', fetchImpl: impl }), /not found/);
});

test('fetchWorkflowRuns surfaces HTTP errors (rate limit) instead of a vacuous pass', async () => {
  const impl = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(fetchWorkflowRuns({ workflow: 'test.yml', fetchImpl: impl }), /HTTP 403/);
});

test('CLI falls back to the public API when gh has no auth (scrubbed env)', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwrs-'));
  try {
    // A fake gh that fails exactly like an unauthenticated one, and a preload
    // that stubs fetch, so the test is offline and deterministic.
    fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\necho "To get started with GitHub CLI, please run:  gh auth login" >&2\nexit 4\n', { mode: 0o755 });
    const stub = path.join(dir, 'stub.cjs');
    fs.writeFileSync(stub, `globalThis.fetch = async (u) => ({ ok: true, status: 200, json: async () => ({ workflow_runs: [{ conclusion: process.env.STUB_CONCLUSION, status: 'completed', html_url: u }] }) });`);
    const run = (conclusion) => spawnSync(process.execPath, ['-r', stub, 'scripts/check-workflow-run-status.js', '--workflow=test.yml', '--expect=success'], {
      encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, STUB_CONCLUSION: conclusion },
    });
    const ok = run('success');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stderr, /public GitHub API/);
    assert.equal(run('failure').status, 1, 'a red workflow still fails');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('proxyAwareFetch: plain fetch without a proxy, proxy-honouring wrapper behind one', async () => {
  assert.equal(proxyAwareFetch({}), globalThis.fetch);
  assert.equal(proxyAwareFetch({ HTTPS_PROXY: 'http://p', NODE_USE_ENV_PROXY: '1' }), globalThis.fetch, 'already proxy-aware');
  const wrapped = proxyAwareFetch({ PATH: process.env.PATH, https_proxy: 'http://127.0.0.1:9' });
  assert.notEqual(wrapped, globalThis.fetch);
  // Dead proxy port: the child reports a connection error, never a pass.
  await assert.rejects(wrapped('https://127.0.0.1:9/'), /fetch https:\/\/127\.0\.0\.1:9\/ failed/);
});
