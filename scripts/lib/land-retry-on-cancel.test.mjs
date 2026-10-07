import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { decideLandRetry, MAX_ATTEMPTS, runGhWithFallback, isRefNotFound, decideCancelledWait } = require('./land-retry-on-cancel.js');

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
  // BRO-4653: every Land completion triggers a slot-aware sweep (not only cancels)
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

// BRO-4676: a busy slot must not starve a stranded run forever.
test('BRO-4676 aging: busy slot + stranded run past threshold → re-run; only young runs → wait', () => {
  const { decideSweep, AGED_RETRY_MINUTES } = require('./land-queue-backoff.js');
  const now = Date.parse('2026-10-05T05:30:00Z');
  const mk = (id, minAgo) => ({
    id, status: 'completed', conclusion: 'cancelled', run_attempt: 1, head_branch: `land/${id}`, head_sha: `s${id}`,
    created_at: new Date(now - 600 * 60000).toISOString(), updated_at: new Date(now - minAgo * 60000).toISOString(),
  });
  const busy = { busy: true, blockers: [{ id: 1, branch: 'land/x', status: 'in_progress', why: 'holds-slot' }] };
  const stale = mk(37259496468, AGED_RETRY_MINUTES + 60);
  const fresh = mk(2, 5);
  const refs = new Map([stale, fresh].map((r) => [r.head_branch, r.head_sha]));
  const aged = decideSweep({ slot: busy, cancelledRuns: [stale, fresh], refs, now });
  assert.equal(aged.action, 'inspect');
  assert.deepEqual(aged.candidates.map((r) => r.id), [37259496468]);
  assert.equal(decideSweep({ slot: busy, cancelledRuns: [fresh], refs, now }).action, 'wait');
});

test('BRO-4677: sustained traffic (a Land job always running, none pending) still selects the oldest stranded run', () => {
  const { decideSweep } = require('./land-queue-backoff.js');
  const now = Date.parse('2026-10-05T06:00:00Z');
  const mk = (id, minAgo) => ({
    id, status: 'completed', conclusion: 'cancelled', run_attempt: 1, head_branch: `land/b${id}`, head_sha: `s${id}`,
    created_at: new Date(now - (minAgo + 5) * 60000).toISOString(), updated_at: new Date(now - minAgo * 60000).toISOString(),
  });
  // evicted 6 and 12 minutes ago: far below the 30-min aging threshold
  const stranded = [mk(2, 6), mk(1, 12)];
  const refs = new Map(stranded.map((r) => [r.head_branch, r.head_sha]));
  const slot = { busy: true, pending: false, blockers: [{ id: 99, branch: 'land/live', status: 'in_progress', why: 'running' }] };
  const sweep = decideSweep({ slot, cancelledRuns: stranded, refs, now });
  assert.equal(sweep.action, 'inspect');
  assert.equal(sweep.candidates[0].id, 1, 'oldest stranded run goes first');
  const verdict = decideLandRetry({ run: sweep.candidates[0], jobs: jobs(), branchExists: true, branchTip: 's1' });
  assert.equal(verdict.retry, true);
  // the same traffic with a pending entrant keeps waiting (the re-run would evict it)
  assert.equal(decideSweep({ slot: { ...slot, pending: true }, cancelledRuns: stranded, refs, now }).action, 'wait');
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
