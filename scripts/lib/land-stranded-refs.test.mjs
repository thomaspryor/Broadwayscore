import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  decideStrandedRef, strandedMarker, buildEscalationComment, escalationAction, isAbandonedRun, newestPerCard,
  STRANDED_RETRY_MINUTES, STRANDED_MAX_ATTEMPT, NO_RUN_GRACE_MINUTES, ABANDONED_AFTER_DAYS,
  REFUSAL_GRACE_MINUTES, CARD_IDLE_HOURS, HELD_CARD_DAYS,
} = require('./land-stranded-refs.js');

const NOW = Date.parse('2026-10-06T18:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const TIP = 'aa9cfe92f9cdf07209c7b8677c37594e6ea54c73';
const run = (o = {}) => ({ id: 37359729207, head_sha: TIP, status: 'completed', conclusion: 'cancelled', run_attempt: 2, created_at: ago(23 * 60), updated_at: ago(22 * 60), html_url: 'https://example/run', ...o });
const job = (name, conclusion, steps = []) => ({ name, status: 'completed', conclusion, steps });
const queuedLand = job('Land', 'cancelled', []); // cancelled while pending: no step ran
const checksOk = job('Checks', 'success');

test('BRO-1703 shape: evicted twice, then aged past the fast window -> full rerun', () => {
  const d = decideStrandedRef({ tip: TIP, latestRun: run({ created_at: ago(25 * 60) }), jobs: [checksOk, queuedLand], now: NOW });
  assert.deepEqual(d, { action: 'rerun', reason: 'evicted-past-fast-retry' });
});

test('BRO-3619 shape: six evictions in six minutes (attempts exhausted) -> full rerun even inside 24h', () => {
  const d = decideStrandedRef({ tip: TIP, latestRun: run({ run_attempt: 6, created_at: ago(120), updated_at: ago(90) }), jobs: [checksOk, queuedLand], now: NOW });
  assert.equal(d.action, 'rerun');
});

test('inside the fast window the existing sweep owns it', () => {
  const d = decideStrandedRef({ tip: TIP, latestRun: run({ run_attempt: 2, created_at: ago(60), updated_at: ago(50) }), jobs: [checksOk, queuedLand], now: NOW });
  assert.deepEqual(d, { action: 'none', reason: 'fast-retry-owns' });
});

test('Checks cancelled (not success) is outside the fast retry -> rerun', () => {
  const d = decideStrandedRef({ tip: TIP, latestRun: run({ created_at: ago(120), updated_at: ago(90) }), jobs: [job('Checks', 'cancelled')], now: NOW });
  assert.equal(d.action, 'rerun');
});

test('full reruns are spaced', () => {
  const d = decideStrandedRef({ tip: TIP, latestRun: run({ run_attempt: 8, updated_at: ago(STRANDED_RETRY_MINUTES - 1) }), jobs: [checksOk, queuedLand], now: NOW });
  assert.deepEqual(d, { action: 'wait', reason: 'spacing' });
});

test('budget spent -> escalate, not another rerun', () => {
  const d = decideStrandedRef({ tip: TIP, latestRun: run({ run_attempt: STRANDED_MAX_ATTEMPT }), jobs: [checksOk, queuedLand], now: NOW });
  assert.deepEqual(d, { action: 'escalate', reason: 'evicted-budget-exhausted' });
});

test('Land cancelled after it started landing is never replayed blindly', () => {
  const started = job('Land', 'cancelled', [{ name: 'Land the branch', conclusion: 'success' }]);
  const d = decideStrandedRef({ tip: TIP, latestRun: run(), jobs: [checksOk, started], now: NOW });
  assert.deepEqual(d, { action: 'escalate', reason: 'land-cancelled-mid-flight' });
});

test('BRO-934 / BRO-2358 shape: Land refused -> escalate land-refused', () => {
  const d = decideStrandedRef({ tip: TIP, latestRun: run({ conclusion: 'failure' }), jobs: [checksOk, job('Land', 'failure')], now: NOW });
  assert.deepEqual(d, { action: 'escalate', reason: 'land-refused' });
});

test('red Checks -> escalate checks-red', () => {
  const d = decideStrandedRef({ tip: TIP, latestRun: run({ conclusion: 'failure' }), jobs: [job('Checks', 'failure'), job('Land', 'skipped')], now: NOW });
  assert.deepEqual(d, { action: 'escalate', reason: 'checks-red' });
});

test('landed or in flight -> none', () => {
  assert.equal(decideStrandedRef({ tip: TIP, latestRun: run({ conclusion: 'success' }), now: NOW }).action, 'none');
  assert.equal(decideStrandedRef({ tip: TIP, latestRun: run({ status: 'in_progress', conclusion: null }), now: NOW }).action, 'none');
});

test('no run for the tip: wait out the grace period, then escalate (never silent)', () => {
  const stale = run({ head_sha: 'b'.repeat(40) });
  assert.deepEqual(decideStrandedRef({ tip: TIP, latestRun: stale, tipCommittedAt: ago(NO_RUN_GRACE_MINUTES - 5), now: NOW }), { action: 'wait', reason: 'no-run-yet' });
  assert.deepEqual(decideStrandedRef({ tip: TIP, latestRun: null, tipCommittedAt: ago(NO_RUN_GRACE_MINUTES + 5), now: NOW }), { action: 'escalate', reason: 'no-run-for-tip' });
  assert.deepEqual(decideStrandedRef({ tip: TIP, latestRun: null, tipCommittedAt: null, now: NOW }), { action: 'wait', reason: 'tip-age-unknown' });
  assert.equal(decideStrandedRef({ tip: TIP, latestRun: run({ head_sha: 'c'.repeat(40), status: 'queued', conclusion: null }), now: NOW }).action, 'wait');
});

test('marker is per run attempt, or per tip when no run fired', () => {
  const branch = 'land/job/linear-BRO-934-muvirs1i';
  assert.equal(strandedMarker({ branch, tip: TIP, latestRun: run(), reason: 'land-refused' }), `LAND-STRANDED: ${branch}@37359729207#2 land-refused`);
  assert.equal(strandedMarker({ branch, tip: TIP, latestRun: null, reason: 'no-run-for-tip' }), `LAND-STRANDED: ${branch}@${TIP.slice(0, 12)} no-run-for-tip`);
});

test('comment starts with the marker and says how to resume', () => {
  const branch = 'land/job/linear-BRO-2358-muutmo51';
  const body = buildEscalationComment({ branch, tip: TIP, latestRun: run({ conclusion: 'failure' }), reason: 'land-refused' });
  assert.ok(body.startsWith(strandedMarker({ branch, tip: TIP, latestRun: run({ conclusion: 'failure' }), reason: 'land-refused' })));
  assert.match(body, /NOT on main/);
  assert.match(body, /SAME land branch/);
});

test('card routing: reopen In Review and long-held cards only; wait on active cards; never twice', () => {
  const marker = 'LAND-STRANDED: land/x@1#1 land-refused';
  const idle = ago(CARD_IDLE_HOURS * 60 + 5);
  const base = { comments: [], marker, cardUpdatedAt: idle, now: NOW };
  assert.equal(escalationAction({ ...base, stateType: 'started', stateName: 'In Review' }), 'comment-and-reopen');
  assert.equal(escalationAction({ ...base, stateType: 'started', stateName: 'In Progress' }), 'comment-only');
  assert.equal(escalationAction({ ...base, stateType: 'started', stateName: 'In Progress', cardUpdatedAt: ago(HELD_CARD_DAYS * 1440 + 5) }), 'comment-and-reopen');
  assert.equal(escalationAction({ ...base, stateType: 'started', stateName: 'In Review', cardUpdatedAt: ago(30) }), 'wait');
  assert.equal(escalationAction({ ...base, stateType: 'completed', stateName: 'Done' }), 'comment-only');
  assert.equal(escalationAction({ ...base, stateType: 'backlog', stateName: 'Backlog' }), 'comment-only');
  assert.equal(escalationAction({ ...base, stateType: 'unstarted', stateName: 'Todo' }), 'comment-only');
  assert.equal(escalationAction({ ...base, stateType: 'canceled', stateName: 'Canceled' }), 'log-only');
  assert.equal(escalationAction({ ...base, stateType: 'started', stateName: 'In Review', comments: [{ body: `x\n${marker}\ny` }] }), 'skip-already-posted');
});

test('a fresh refusal gets the grace period before it becomes anyone else\'s work', () => {
  const fresh = run({ conclusion: 'failure', updated_at: ago(REFUSAL_GRACE_MINUTES - 5) });
  assert.deepEqual(decideStrandedRef({ tip: TIP, latestRun: fresh, jobs: [checksOk, job('Land', 'failure')], now: NOW }), { action: 'wait', reason: 'fresh-failure' });
});

test('timed-out or startup-failed runs are re-run, not escalated', () => {
  const d = decideStrandedRef({ tip: TIP, latestRun: run({ conclusion: 'timed_out', created_at: ago(300), updated_at: ago(200) }), jobs: [job('Checks', 'cancelled')], now: NOW });
  assert.equal(d.action, 'rerun');
});

test('one escalation per card: newest ref wins, card-less refs pass through', () => {
  const cardOf = (b) => { const m = /bro-(\d+)/i.exec(b); return m ? Number(m[1]) : null; };
  const it = (branch, updated) => ({ branch, latestRun: { updated_at: updated } });
  const out = newestPerCard([
    it('land/bro-4509-tour-serp', '2026-09-27T10:00:00Z'),
    it('land/bro-4509-tour-window-fix', '2026-09-27T12:00:00Z'),
    it('land/bro-4509-tour-window', '2026-09-27T11:00:00Z'),
    it('land/font-selfhost', '2026-09-28T00:00:00Z'),
    it('land/job/linear-BRO-934-muvirs1i', '2026-10-06T00:00:00Z'),
  ], cardOf);
  assert.deepEqual(out.map((x) => x.branch).sort(), ['land/bro-4509-tour-window-fix', 'land/font-selfhost', 'land/job/linear-BRO-934-muvirs1i']);
});

test('refs idle past the window are abandoned: counted, never routed or re-run', () => {
  const old = run({ conclusion: 'failure', updated_at: ago(ABANDONED_AFTER_DAYS * 1440 + 60) });
  assert.equal(isAbandonedRun(old, NOW), true);
  assert.deepEqual(decideStrandedRef({ tip: TIP, latestRun: old, jobs: null, now: NOW }), { action: 'none', reason: 'abandoned' });
  assert.equal(decideStrandedRef({ tip: TIP, latestRun: run({ created_at: ago(30 * 1440), updated_at: ago(ABANDONED_AFTER_DAYS * 1440 + 60) }), now: NOW }).reason, 'abandoned');
  assert.deepEqual(decideStrandedRef({ tip: TIP, latestRun: null, tipCommittedAt: ago(ABANDONED_AFTER_DAYS * 1440 + 60), now: NOW }), { action: 'none', reason: 'abandoned' });
  assert.equal(isAbandonedRun(run({ conclusion: 'success', updated_at: ago(40 * 1440) }), NOW), false);
});

test('a ref whose card later landed from another ref is a leftover, not stranded work', () => {
  const r = run({ conclusion: 'failure', updated_at: ago(300) });
  assert.deepEqual(decideStrandedRef({ tip: TIP, latestRun: r, jobs: [checksOk, job('Land', 'failure')], cardLandedAt: ago(60), now: NOW }), { action: 'none', reason: 'superseded' });
  // a landing OLDER than this ref's last run does not hide it
  assert.equal(decideStrandedRef({ tip: TIP, latestRun: r, jobs: [checksOk, job('Land', 'failure')], cardLandedAt: ago(400), now: NOW }).action, 'escalate');
  // never while this ref is itself landing
  assert.equal(decideStrandedRef({ tip: TIP, latestRun: run({ status: 'in_progress', conclusion: null, updated_at: ago(300) }), cardLandedAt: ago(60), now: NOW }).action, 'none');
  assert.equal(decideStrandedRef({ tip: TIP, latestRun: run({ status: 'in_progress', conclusion: null, updated_at: ago(300) }), cardLandedAt: ago(60), now: NOW }).reason, 'in-flight');
});
