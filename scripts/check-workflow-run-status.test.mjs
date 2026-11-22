import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseArgs, evaluate, runMinutes, hungCancelMinutes, readWorkflowYaml, parseCount, isGhAuthError, normalizeRestRun, resolveWorkflowId, fetchWorkflowRuns, proxyAwareFetch, PUBLIC_REPO } = require('./check-workflow-run-status.js');
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

test('single-run mode reads the newest FINISHED run, not a queued one (flaky 2026-11-08)', () => {
  const q = { conclusion: '', status: 'queued', url: 'u' };
  const ip = { conclusion: '', status: 'in_progress', url: 'u' };
  assert.equal(evaluate([q, r('success')], { expect: 'success' }).ok, true, 'a newly queued run does not flip a green check');
  assert.equal(evaluate([ip, r('failure'), r('success')], { expect: 'success' }).ok, false, 'the newest finished run still decides');
  assert.equal(evaluate([q, ip], { expect: 'success' }).ok, false, 'no finished run is not a pass');
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

// BRO-8010: opening-night-poller.yml was fixed (35 success, 0 failure after the
// fix) but VERIFY kept reading MISMATCH because the newest finished run was a
// concurrency supersede / external cancel, not a verdict on the code.
const at = (c, min, url = 'u') => ({ conclusion: c, status: 'completed', url, createdAt: '2026-11-22T10:00:00Z', startedAt: '2026-11-22T10:00:00Z', updatedAt: new Date(Date.parse('2026-11-22T10:00:00Z') + min * 60000).toISOString() });

test('BRO-8010: short cancels are skipped in single-run mode when the hang threshold is known', () => {
  const runs = [at('cancelled', 1), at('cancelled', 52), at('success', 40, 'green')];
  const res = evaluate(runs, { expect: 'success', hungCancelMin: 144 });
  assert.equal(res.ok, true, res.message);
  assert.match(res.message, /green/);
  assert.match(res.message, /skipped 2 newer short cancel/);
});

test('BRO-8010: a cancel that ran up to the job timeout is a hang and still decides', () => {
  assert.equal(evaluate([at('cancelled', 160), at('success', 40)], { expect: 'success', hungCancelMin: 144 }).ok, false);
});

test('BRO-8010: short cancels never hide a failure, and an all-cancel window is not a pass', () => {
  assert.equal(evaluate([at('cancelled', 2), at('failure', 30)], { expect: 'success', hungCancelMin: 144 }).ok, false);
  const storm = evaluate([at('cancelled', 2), at('cancelled', 3)], { expect: 'success', hungCancelMin: 144 });
  assert.equal(storm.ok, false);
  assert.match(storm.message, /cancel storm/);
});

test('BRO-8010: without a known threshold, or when asking about cancels, every cancel still decides (old behaviour)', () => {
  assert.equal(evaluate([at('cancelled', 1), at('success', 40)], { expect: 'success' }).ok, false);
  assert.equal(evaluate([at('cancelled', 1), at('success', 40)], { expect: 'cancelled', hungCancelMin: 144 }).ok, true);
  const noTimes = { conclusion: 'cancelled', status: 'completed', url: 'u' };
  assert.equal(evaluate([noTimes, at('success', 40)], { expect: 'success', hungCancelMin: 144 }).ok, false, 'unknown duration is never skipped');
});

test('BRO-8010: hang threshold = 90% of the largest timeout-minutes, GitHub default when unset, undefined when unreadable', () => {
  assert.equal(hungCancelMinutes('jobs:\n  a:\n    timeout-minutes: 160\n    steps:\n      - run: x\n        timeout-minutes: 15 # step\n'), 144);
  assert.equal(hungCancelMinutes('jobs:\n  a:\n    steps: []\n'), 324);
  assert.equal(hungCancelMinutes('    timeout-minutes: 5\n'), 10, 'floor of 10');
  assert.equal(hungCancelMinutes(undefined), undefined);
  assert.equal(readWorkflowYaml('Opening Night Poller'), undefined, 'display names are not read');
  assert.equal(readWorkflowYaml('../package.json'), undefined, 'no path traversal');
  assert.equal(hungCancelMinutes(readWorkflowYaml('opening-night-poller.yml')) >= 10, true);
});

test('BRO-8010: REST runs carry the timestamps runMinutes needs', () => {
  const n = normalizeRestRun({ conclusion: 'cancelled', status: 'completed', head_branch: 'main', html_url: 'h', created_at: '2026-11-22T10:00:00Z', run_started_at: '2026-11-22T10:00:00Z', updated_at: '2026-11-22T10:03:00Z' });
  assert.equal(runMinutes(n), 3);
});
