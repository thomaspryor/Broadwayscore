import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { decideLandRetry, latestJobByName, isRerunRefused, MAX_ATTEMPTS, runGhWithFallback, isRefNotFound, decideCancelledWait } = require('./land-retry-on-cancel.js');

const run = (o = {}) => ({ head_sha: 'aaa', conclusion: 'cancelled', head_branch: 'land/bro-4234-owner-banner', run_attempt: 1, ...o });
const jobs = (land = {}, checks = {}) => [
  { name: 'Checks', conclusion: 'success', ...checks },
  { name: 'Land', conclusion: 'cancelled', steps: [{ conclusion: 'cancelled' }, { conclusion: 'skipped' }], ...land },
];
const d = (o = {}) => decideLandRetry({ run: run(), jobs: jobs(), branchExists: true, ...o });

test('the 2026-09-28 case: Checks success, Land cancelled while queued → retry', () => {
  assert.deepEqual(d(), { retry: true, reason: 'land-cancelled-while-queued', attempt: 1 });
});
test('Land cancelled mid-work (a step completed) is not replayed', () => {
  assert.equal(d({ jobs: jobs({ steps: [{ conclusion: 'success' }, { conclusion: 'cancelled' }] }) }).reason, 'land-started-work');
});
test('Checks not green → no retry', () => {
  assert.equal(d({ jobs: jobs({}, { conclusion: 'cancelled' }) }).retry, false);
  assert.equal(d({ jobs: jobs({}, { conclusion: 'failure' }) }).retry, false);
});
test('run not cancelled / not a land branch / branch gone → no retry', () => {
  assert.equal(d({ run: run({ conclusion: 'success' }) }).retry, false);
  assert.equal(d({ run: run({ head_branch: 'main' }) }).reason, 'not-a-land-branch');
  assert.equal(d({ branchExists: false }).reason, 'branch-gone');
});
test('branch moved to a newer tip → old run is not retried', () => {
  assert.equal(d({ branchTip: 'bbb' }).reason, 'superseded-tip');
  assert.equal(d({ branchTip: 'aaa' }).retry, true);
});
test('attempt budget bounds the loop', () => {
  assert.equal(d({ run: run({ run_attempt: MAX_ATTEMPTS }) }).reason, 'attempts-exhausted');
  assert.equal(d({ run: run({ run_attempt: MAX_ATTEMPTS - 1 }) }).retry, true);
});
test('Land job that succeeded/failed is not retried', () => {
  assert.equal(d({ jobs: jobs({ conclusion: 'failure' }) }).retry, false);
  assert.equal(d({ jobs: [{ name: 'Checks', conclusion: 'success' }] }).reason, 'no-land-job');
});
test('workflow wiring: triggers on Land completion and calls the real script', () => {
  const y = readFileSync(new URL('../../.github/workflows/land-retry-cancelled.yml', import.meta.url), 'utf8');
  // BRO-4653: every Land completion triggers a sweep (not only cancels)
  assert.match(y, /workflows: \['Land', 'Autonomous Merge'\]/);
  assert.match(y, /land-retry-cancelled\.js --sweep/);
  assert.match(y, /scripts\/land-retry-cancelled\.js/);
  assert.match(y, /actions: write/);
  const lib = readFileSync(new URL('../land-retry-cancelled.js', import.meta.url), 'utf8');
  assert.match(lib, /land-retry-on-cancel/);
  // BRO-4651: the fallback token reaches the script, and the script uses it.
  assert.match(y, /GH_FALLBACK_TOKEN: \$\{\{ secrets\.REVIEW_TEXTS_TOKEN \}\}/);
  assert.match(lib, /runGhWithFallback/);
  assert.match(lib, /GH_FALLBACK_TOKEN/);
  assert.match(lib, /isRefNotFound/);
});

// BRO-4651: GITHUB_TOKEN rate limit falls back to REVIEW_TEXTS_TOKEN once.
const rateLimited = () => Object.assign(new Error('Command failed: gh api x'), {
  stderr: 'gh: API rate limit exceeded for installation. (HTTP 403)\n', stdout: '',
});
const recorder = (...outcomes) => {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, token: opts.env.GH_TOKEN, stdio: opts.stdio });
    const o = outcomes[calls.length - 1];
    if (o instanceof Error) throw o;
    return o;
  };
  return { calls, exec };
};
const quiet = () => {};

test('runGhWithFallback: primary succeeds, fallback never used', () => {
  const { calls, exec } = recorder('{"ok":1}');
  assert.equal(runGhWithFallback(['repos/x'], { exec, env: { GH_TOKEN: 'primary' }, fallbackToken: 'pat', log: quiet }), '{"ok":1}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, 'primary');
  assert.deepEqual(calls[0].stdio, ['ignore', 'pipe', 'pipe'], 'output piped so a rate limit is readable');
});

test('runGhWithFallback: rate-limited primary retries once with the fallback token', () => {
  const { calls, exec } = recorder(rateLimited(), '{"ok":2}');
  assert.equal(runGhWithFallback(['-X', 'POST', 'repos/x/rerun'], { exec, env: { GH_TOKEN: 'primary' }, fallbackToken: 'pat', log: quiet }), '{"ok":2}');
  assert.deepEqual(calls.map((c) => c.token), ['primary', 'pat']);
  assert.deepEqual(calls[1].args, ['api', '-X', 'POST', 'repos/x/rerun']);
});

test('runGhWithFallback: non-rate-limit errors and a missing fallback token rethrow', () => {
  const notFound = Object.assign(new Error('Command failed'), { stderr: 'gh: Not Found (HTTP 404)' });
  const a = recorder(notFound);
  assert.throws(() => runGhWithFallback(['repos/x'], { exec: a.exec, env: {}, fallbackToken: 'pat', log: quiet }), /Command failed/);
  assert.equal(a.calls.length, 1);
  const b = recorder(rateLimited());
  assert.throws(() => runGhWithFallback(['repos/x'], { exec: b.exec, env: {}, fallbackToken: '', log: quiet }), /Command failed/);
  assert.equal(b.calls.length, 1);
});

test('runGhWithFallback: both tokens rate-limited throws the fallback error', () => {
  const second = rateLimited();
  second.message = 'fallback failed';
  const { exec } = recorder(rateLimited(), second);
  assert.throws(() => runGhWithFallback(['repos/x'], { exec, env: {}, fallbackToken: 'pat', log: quiet }), /fallback failed/);
});

test('isRefNotFound: only a 404 means the land ref is gone', () => {
  assert.equal(isRefNotFound({ stderr: 'gh: Not Found (HTTP 404)' }), true);
  assert.equal(isRefNotFound(rateLimited()), false, 'a rate limit is not "landed"');
  assert.equal(isRefNotFound({ stderr: 'gh: Server Error (HTTP 502)' }), false);
  assert.equal(isRefNotFound(new Error('spawn gh ENOENT')), false);
});

test('runGhWithFallback: buffer fits a 100-run listing (>1 MB; the 1 MB default failed with ENOBUFS, BRO-4653)', () => {
  let seen;
  runGhWithFallback(['x'], { exec: (cmd, args, opts) => { seen = opts; return '{}'; } });
  assert.ok(seen.maxBuffer >= 16 * 1024 * 1024);
});

// BRO-4677 (BRO-5112: no shared seat any more, so no slot gating): the sweep
// selects the oldest stranded run and decideLandRetry accepts it.
test('BRO-4677: the sweep selects the oldest stranded run and decideLandRetry accepts it', () => {
  const { decideSweep } = require('./land-queue-backoff.js');
  const now = Date.parse('2026-10-05T06:00:00Z');
  const mk = (id, minAgo) => ({
    id, status: 'completed', conclusion: 'cancelled', run_attempt: 1, head_branch: `land/b${id}`, head_sha: `s${id}`,
    created_at: new Date(now - (minAgo + 5) * 60000).toISOString(), updated_at: new Date(now - minAgo * 60000).toISOString(),
  });
  const stranded = [mk(2, 6), mk(1, 12)];
  const refs = new Map(stranded.map((r) => [r.head_branch, r.head_sha]));
  const sweep = decideSweep({ cancelledRuns: stranded, refs, now });
  assert.equal(sweep.action, 'inspect');
  assert.equal(sweep.candidates[0].id, 1, 'oldest stranded run goes first');
  const verdict = decideLandRetry({ run: sweep.candidates[0], jobs: jobs(), branchExists: true, branchTip: 's1' });
  assert.equal(verdict.retry, true);
});

test('decideCancelledWait: a failed rerun POST is benign only when the run already moved on', () => {
  // 2026-10-05: the sweep started attempt 2 seconds before a --run= call's POST.
  assert.equal(decideCancelledWait({ status: 'in_progress', attempt: 2, attemptBefore: 1 }), 'resume');
  assert.equal(decideCancelledWait({ status: 'queued', attempt: 1, attemptBefore: 1 }), 'resume', 'same attempt but no longer completed');
  assert.equal(decideCancelledWait({ status: 'completed', attempt: 1, attemptBefore: 1 }), 'wait', 'still cancelled: the POST really failed');
  assert.equal(decideCancelledWait({ attempt: 1, attemptBefore: 1 }), 'wait', 'missing status is not "moved on"');
  assert.equal(decideCancelledWait({ status: 'completed', attempt: '10', attemptBefore: '9' }), 'resume', 'numeric, not lexical');
});

test('land-branch.js re-exports the same decideCancelledWait (one copy, no drift)', () => {
  assert.equal(require('./land-branch.js').decideCancelledWait, decideCancelledWait);
});

const { landIdentityFromChecks, resolveLandRun, readLatestLandRun } = require('./land-run-identity.js');
const { readLatestRun, landVerdict } = require('./wait-for-land.js');
// Public metadata and the identity-only excerpt of run 39830878697, attempt 1.
const DISPATCH_TIP = '1315178f3276484f4af6c41f6ff8c5facb3f6b64';
const DISPATCH_BRANCH = 'land/bro-5943-theatr-alias';
const DISPATCH = {
  id: 39830878697, event: 'workflow_dispatch', head_branch: 'main',
  head_sha: 'd821c82e42e589e916cb8ef9647e8e208afb90a9', display_title: 'Land',
  status: 'completed', conclusion: 'cancelled', run_attempt: 1,
  created_at: '2026-10-22T18:23:00Z', updated_at: '2026-10-22T18:44:00Z',
};
const CHECKS_LOG = `2026-10-22T18:23:35.7452531Z   BRANCH: ${DISPATCH_BRANCH}
2026-10-22T18:24:35.2144324Z [command]/usr/bin/git log -1 --format=%H
2026-10-22T18:24:35.2173902Z ${DISPATCH_TIP}`;
const dispatchJobs = () => jobs({ id: 120015878755, steps: [
  { name: 'Set up job', conclusion: 'success' },
  { name: 'Admit to the landing queue', conclusion: 'cancelled' },
  { name: 'Checkout main', conclusion: 'skipped' },
] }, { id: 120006368157 });

function dispatchReader({ push = null, dispatch = DISPATCH, log = CHECKS_LOG, runJobs = dispatchJobs() } = {}) {
  const calls = [];
  const read = (endpoint) => {
    calls.push(endpoint);
    if (endpoint.includes('event=push')) return { workflow_runs: push ? [push] : [] };
    if (endpoint.includes('event=workflow_dispatch')) return { workflow_runs: [dispatch] };
    if (endpoint.includes('/jobs?')) return { jobs: runJobs };
    if (endpoint.includes('/annotations?')) return [];
    assert.fail(`unexpected endpoint: ${endpoint}`);
  };
  const readText = (endpoint) => { calls.push(endpoint); return log; };
  return { repo: 'thomaspryor/Broadwayscore', read, readText, cache: new Map(), calls };
}

test('BRO-6012: real dispatch resolves the checked branch AND tip, then permits a parked retry', () => {
  const options = dispatchReader();
  const resolved = resolveLandRun(DISPATCH, options);
  assert.equal(resolved.head_branch, DISPATCH_BRANCH);
  assert.equal(resolved.head_sha, DISPATCH_TIP, 'main head_sha is not the verified tip');
  assert.equal(DISPATCH.head_branch, 'main', 'do not mutate API records');
  const decide = (tip) => decideLandRetry({ run: resolved, jobs: dispatchJobs(), branchExists: true, branchTip: tip });
  assert.equal(decide(DISPATCH_TIP).reason, 'land-parked-behind-deep-queue');
  assert.equal(decide('f'.repeat(40)).reason, 'superseded-tip', 'moved refs never borrow old Checks');
  assert.equal(decideLandRetry({ run: resolved, jobs: dispatchJobs(), branchExists: false }).reason, 'branch-gone');
  assert.equal(options.calls.filter((p) => p.endsWith('/logs')).length, 1);
  resolveLandRun(DISPATCH, options);
  assert.equal(options.calls.filter((p) => p.endsWith('/logs')).length, 1, 'immutable identity is cached');
  const live = resolveLandRun({ ...DISPATCH, status: 'in_progress', conclusion: null }, options);
  assert.equal(live.status, 'in_progress', 'cache identity only, never stale run status');
  assert.equal(live.conclusion, null);
});

test('BRO-6012: identity requires a full checkout SHA, never a main SHA or abbreviated rebase message', () => {
  assert.deepEqual(landIdentityFromChecks(CHECKS_LOG), { branch: DISPATCH_BRANCH, sha: DISPATCH_TIP });
  assert.equal(landIdentityFromChecks(`BRANCH: ${DISPATCH_BRANCH}\nbranch ${DISPATCH_BRANCH} @ 1315178f32`), null);
  assert.equal(landIdentityFromChecks(CHECKS_LOG.replace(DISPATCH_TIP, '1315178f32')), null);
  assert.equal(landIdentityFromChecks(CHECKS_LOG.replace(DISPATCH_BRANCH, 'main')), null);
  const options = dispatchReader({ log: '' });
  assert.equal(resolveLandRun(DISPATCH, options), null, 'unreadable logs cannot authorize a retry');
  const push = { ...DISPATCH, event: 'push' };
  assert.equal(resolveLandRun(push, options), push, 'pushes use their original metadata');
});

test('BRO-6012: the sweep sees dispatched cancelled runs as candidates', () => {
  const { decideSweep } = require('./land-queue-backoff.js');
  const resolved = resolveLandRun(DISPATCH, dispatchReader());
  const decision = decideSweep({ cancelledRuns: [resolved], refs: new Map([[DISPATCH_BRANCH, DISPATCH_TIP]]), now: Date.parse('2026-10-22T19:00:00Z') });
  assert.deepEqual(decision.candidates.map((r) => r.id), [DISPATCH.id]);
});

test('BRO-6012: waiter follows the newer hand dispatch in queued, running and parked states', () => {
  const push = { ...DISPATCH, event: 'push', id: 39804089333, head_branch: DISPATCH_BRANCH,
    head_sha: DISPATCH_TIP, created_at: '2026-10-22T10:00:00Z' };
  for (const status of ['queued', 'in_progress', 'completed']) {
    const options = dispatchReader({ push, dispatch: { ...DISPATCH, status, conclusion: status === 'completed' ? 'cancelled' : null } });
    const followed = readLatestRun(DISPATCH_BRANCH, options);
    assert.equal(followed.id, DISPATCH.id);
    assert.equal(followed.head_sha, DISPATCH_TIP);
    const v = landVerdict({ refSha: DISPATCH_TIP, run: followed, nowMs: Date.parse('2026-10-22T19:00:00Z') });
    assert.equal(v.verdict, 'waiting');
    assert.match(v.why, new RegExp(String(DISPATCH.id)), 'output identifies the run being followed');
    if (status === 'completed') assert.match(v.why, /parked in the landing line/);
  }
});

test('BRO-6012: a dispatch for another branch cannot hide this push, nor can an older dispatch', () => {
  const push = { ...DISPATCH, event: 'push', id: 39804089333, head_branch: 'land/other', created_at: '2026-10-22T10:00:00Z' };
  assert.equal(readLatestLandRun('land/other', dispatchReader({ push })).id, push.id);
  const newerPush = { ...push, id: 39840000000, created_at: '2026-10-22T20:00:00Z' };
  const options = dispatchReader({ push: newerPush });
  assert.equal(readLatestLandRun('land/other', options).id, newerPush.id);
  assert.equal(options.calls.filter((p) => p.endsWith('/logs')).length, 0, 'older dispatches cost no log reads');
});

test('BRO-6012: incomplete Checks and log 404s are retried; permission errors surface', () => {
  const options = dispatchReader({ runJobs: [{ id: 1, name: 'Checks', conclusion: null }] });
  assert.equal(resolveLandRun(DISPATCH, options), null);
  assert.equal(options.calls.filter((p) => p.endsWith('/logs')).length, 0);
  const missing = dispatchReader();
  missing.readText = () => { throw new Error('gh: Not Found (HTTP 404)'); };
  assert.equal(resolveLandRun(DISPATCH, missing), null);
  missing.readText = () => CHECKS_LOG;
  assert.equal(resolveLandRun(DISPATCH, missing).head_sha, DISPATCH_TIP);
  const denied = dispatchReader();
  denied.readText = () => { throw new Error('gh: Forbidden (HTTP 403)'); };
  assert.throws(() => resolveLandRun(DISPATCH, denied), /HTTP 403/);
});

test('BRO-6012: targeted retry and sweep CLI both reach rerun for the dispatched parked run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-6012-retry-'));
  try {
    const prefix = 'repos/thomaspryor/Broadwayscore';
    const dispatch = { ...DISPATCH, created_at: new Date().toISOString() };
    const responses = {
      [`${prefix}/actions/runs/${DISPATCH.id}`]: dispatch,
      [`${prefix}/actions/runs/${DISPATCH.id}/jobs?filter=latest&per_page=100`]: { jobs: dispatchJobs() },
      [`${prefix}/actions/runs/${DISPATCH.id}/jobs?filter=latest&per_page=50`]: { jobs: dispatchJobs() },
      [`${prefix}/actions/jobs/120006368157/logs`]: CHECKS_LOG,
      [`${prefix}/git/ref/heads/${DISPATCH_BRANCH}`]: { object: { sha: DISPATCH_TIP } },
      [`${prefix}/git/matching-refs/heads/land`]: [{ ref: `refs/heads/${DISPATCH_BRANCH}`, object: { sha: DISPATCH_TIP } }],
    };
    // The shims serve API fixtures only. All retry and selection decisions run
    // in the real CLI and libraries; dry-run prevents remote writes.
    writeFileSync(join(dir, 'gh'), `#!${process.execPath}
const responses = JSON.parse(process.env.BRO_6012_RESPONSES);
const endpoint = process.argv.at(-1);
let response = responses[endpoint];
if (endpoint.includes('/workflows/land.yml/runs?')) {
  response = { workflow_runs: /status=cancelled|event=workflow_dispatch/.test(endpoint) ? [responses['${prefix}/actions/runs/${DISPATCH.id}']] : [] };
}
if (response === undefined) throw new Error('Unexpected API request: ' + endpoint);
process.stdout.write(typeof response === 'string' ? response : JSON.stringify(response));
`, { mode: 0o755 });
    writeFileSync(join(dir, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    for (const mode of [`--run=${DISPATCH.id}`, '--sweep']) {
      const output = execFileSync(process.execPath, [new URL('../land-retry-cancelled.js', import.meta.url).pathname, mode, '--dry-run'], {
        encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'thomaspryor/Broadwayscore', BRO_6012_RESPONSES: JSON.stringify(responses) },
      });
      assert.match(output, new RegExp(`dry-run: would re-run ${DISPATCH.id}`), mode);
      assert.doesNotMatch(output, /not-a-land-branch|superseded-tip/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('BRO-6012: dispatch discovery pages past unrelated runs and caches logs across a rerun', () => {
  const options = dispatchReader();
  const read = options.read;
  options.read = (endpoint) => {
    if (endpoint.includes('event=workflow_dispatch') && endpoint.endsWith('page=1')) {
      return { workflow_runs: Array.from({ length: 100 }, (_, i) => ({ ...DISPATCH, id: DISPATCH.id + 1 + i })) };
    }
    return read(endpoint);
  };
  // All newer dispatches are for another branch, the match is on page 2.
  options.read = ((delegate) => (endpoint) => {
    if (endpoint.includes('/actions/runs/') && !endpoint.includes(`/${DISPATCH.id}/`)) return { jobs: [{ name: 'Checks', conclusion: null }] };
    return delegate(endpoint);
  })(options.read);
  assert.equal(readLatestLandRun(DISPATCH_BRANCH, options).id, DISPATCH.id);
  resolveLandRun({ ...DISPATCH, run_attempt: 2 }, options);
  assert.equal(options.calls.filter((p) => p.endsWith('/logs')).length, 1, 'Checks kept across a Land-only rerun need one log fetch');
});

test('BRO-6058: gh refusing escape sequences is retried once with --allow-escape-sequences', () => {
  const log = 'repos/o/r/actions/jobs/123/logs';
  const refusal = Object.assign(new Error('Command failed'), { stderr: 'the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway\n' });
  const { calls, exec } = recorder(refusal, 'log text');
  assert.equal(runGhWithFallback([log], { exec, env: { GH_TOKEN: 'p' }, log: quiet }), 'log text');
  assert.deepEqual(calls.map((c) => c.args), [['api', log], ['api', '--allow-escape-sequences', log]]);
});

test('BRO-6058: unrelated errors are not retried with the flag', () => {
  const { calls, exec } = recorder(new Error('HTTP 404'));
  assert.throws(() => runGhWithFallback(['repos/o/r/actions/jobs/1/logs'], { exec, env: {}, log: quiet }));
  assert.equal(calls.length, 1);
});

test('BRO-6012: a hand dispatch is followable by its run-name while Checks is still running', () => {
  const running = { ...DISPATCH, display_title: `Land ${DISPATCH_BRANCH}`, status: 'in_progress', conclusion: null };
  const options = dispatchReader({ dispatch: running, runJobs: [{ id: 1, name: 'Checks', conclusion: null }] });
  const resolved = resolveLandRun(running, options);
  assert.equal(resolved.head_branch, DISPATCH_BRANCH);
  assert.equal(resolved.head_sha, null, 'the verified tip is unknown until Checks logs exist');
  assert.equal(options.calls.filter((p) => p.endsWith('/logs')).length, 0);
  const latest = readLatestRun(DISPATCH_BRANCH, options);
  assert.equal(latest.id, running.id);
  const verdict = landVerdict({ refSha: DISPATCH_TIP, run: latest, nowMs: Date.parse('2026-10-22T18:30:00Z') });
  assert.equal(verdict.verdict, 'waiting');
  assert.match(verdict.why, /hand dispatch.*verified tip not readable yet/);
  assert.equal(resolveLandRun({ ...running, display_title: 'Land' }, options), null, 'an untitled dispatch still waits for Checks logs');
  assert.equal(resolveLandRun({ ...running, display_title: 'Land main' }, options), null, 'only land/** titles count');
});

test('BRO-6012: a titled unfinished dispatch stays followable while its Checks log 404s; a finished one does not', () => {
  const running = { ...DISPATCH, display_title: `Land ${DISPATCH_BRANCH}`, status: 'in_progress', conclusion: null };
  const options = dispatchReader({ dispatch: running });
  options.readText = () => { throw new Error('gh: Not Found (HTTP 404)'); };
  const resolved = resolveLandRun(running, options);
  assert.equal(resolved.identityPending, true);
  assert.equal(resolved.head_branch, DISPATCH_BRANCH);
  const done = { ...DISPATCH, display_title: `Land ${DISPATCH_BRANCH}` };
  assert.equal(resolveLandRun(done, dispatchReader({ dispatch: done, log: 'no identity here' })), null, 'a finished run never gets a pending identity');
  const finished404 = dispatchReader({ dispatch: done });
  finished404.readText = () => { throw new Error('gh: Not Found (HTTP 404)'); };
  assert.equal(resolveLandRun(done, finished404), null);
});

// BRO-6326: run 40307546415 listed attempt-1's cancelled Land AND attempt-2's
// successful Land; the stale one made a landed run look retryable and its
// rerun-failed-jobs 403 crashed the whole sweep.
test('BRO-6326: the newest attempt\'s Land job decides, whatever the list order', () => {
  const stale = { name: 'Land', run_attempt: 1, conclusion: 'cancelled', started_at: '2026-10-26T10:47:52Z', steps: [{ conclusion: 'cancelled' }] };
  const fresh = { name: 'Land', run_attempt: 2, conclusion: 'success', started_at: '2026-10-26T12:03:03Z', steps: [] };
  const checks = { name: 'Checks', run_attempt: 1, conclusion: 'success' };
  for (const list of [[checks, stale, fresh], [checks, fresh, stale]]) {
    assert.equal(latestJobByName(list, 'Land'), fresh);
    assert.equal(decideLandRetry({ run: run({ run_attempt: 2 }), jobs: list, branchExists: true }).reason, 'land-success');
  }
  // started_at missing on the stale job: run_attempt still wins
  assert.equal(latestJobByName([{ ...fresh }, { ...stale, started_at: null }], 'Land').run_attempt, 2);
  assert.equal(latestJobByName([], 'Land'), undefined);
});

test('BRO-6326: isRerunRefused matches only the 403 "cannot be retried" refusal', () => {
  assert.equal(isRerunRefused(new Error('gh: This workflow run cannot be retried (HTTP 403)')), true);
  assert.equal(isRerunRefused({ stderr: 'gh: This workflow run cannot be retried (HTTP 403)' }), true);
  assert.equal(isRerunRefused(new Error('gh: Resource not accessible by integration (HTTP 403)')), false);
  assert.equal(isRerunRefused(new Error('gh: Server Error (HTTP 502)')), false);
});

test('BRO-6326: the stranded pass picks the newest Land job too', () => {
  const { decideStrandedRef } = require('./land-stranded-refs.js');
  const now = Date.parse('2026-10-26T12:30:00Z');
  const latestRun = { id: 1, head_sha: 'aaa', status: 'completed', conclusion: 'cancelled', run_attempt: 2, updated_at: '2026-10-26T12:25:00Z', created_at: '2026-10-26T10:27:23Z' };
  const jobs = [
    { name: 'Checks', run_attempt: 1, conclusion: 'success' },
    { name: 'Land', run_attempt: 1, conclusion: 'cancelled', started_at: '2026-10-26T10:47:52Z', steps: [{ conclusion: 'success' }, { conclusion: 'cancelled' }] },
    { name: 'Land', run_attempt: 2, conclusion: 'success', started_at: '2026-10-26T12:03:03Z', steps: [] },
  ];
  const withStale = decideStrandedRef({ tip: 'aaa', latestRun, jobs: jobs.slice(0, 2), now });
  const withBoth = decideStrandedRef({ tip: 'aaa', latestRun, jobs, now });
  // the stale cancelled-mid-landing job alone escalates; with the newer attempt listed it must not
  assert.equal(withStale.reason, 'land-cancelled-mid-flight');
  assert.notEqual(withBoth.reason, 'land-cancelled-mid-flight');
  assert.equal(withBoth.action, 'none');
});

test('BRO-6326: a refused re-run is skipped inside rerun() and never aborts or spends the sweep slot', () => {
  const src = readFileSync(new URL('../land-retry-cancelled.js', import.meta.url), 'utf8');
  assert.match(src, /isRerunRefused\(err\)/);
  assert.match(src, /return 'refused'/);
  assert.match(src, /if \(outcome === 'refused'\) continue;/);
  // any other rerun failure continues the sweep and fails the job at the end
  assert.match(src, /process\.exitCode = 1;\s*continue;/);
  // a refused targeted retry (--run=) goes red again instead of exiting 0 silently
  assert.match(src, /rerun\(runId, run\.run_attempt\) === 'refused'\) process\.exitCode = 1/);
});
