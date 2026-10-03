import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickCloudCard, skipReason, IDLE_MS } = require('./cloud-worker-pick.js');

const NOW = Date.parse('2026-10-03T12:00:00Z');
const OLD = new Date(NOW - IDLE_MS - 60_000).toISOString();
const FRESH = new Date(NOW - 60_000).toISOString();
const SAFE_CMD = '`node --test scripts/lib/example.test.mjs`';
const BODY = `## Problem\nX broke.\n\n## Acceptance criteria\n${SAFE_CMD} passes.`;

function issue(over = {}) {
  return {
    identifier: 'BRO-100',
    title: 'Fix the thing',
    description: BODY,
    priority: 2,
    state: { name: 'Todo', type: 'unstarted' },
    updatedAt: OLD,
    ...over,
  };
}

test('picks highest priority first, then oldest issue number', () => {
  const { pick, eligible } = pickCloudCard([
    issue({ identifier: 'BRO-50', priority: 2 }),
    issue({ identifier: 'BRO-900', priority: 1 }),
    issue({ identifier: 'BRO-800', priority: 1 }),
  ], { nowMs: NOW });
  assert.equal(pick.identifier, 'BRO-800');
  assert.equal(eligible, 3);
});

test('skips P2+, started cards, recent activity, and cards without a safe VERIFY', () => {
  assert.equal(skipReason(issue({ priority: 3 }), NOW), 'not-p0-p1');
  assert.equal(skipReason(issue({ state: { name: 'In Progress', type: 'started' } }), NOW), 'state-started');
  assert.equal(skipReason(issue({ updatedAt: FRESH }), NOW), 'recent-activity');
  assert.equal(skipReason(issue({ description: '## Acceptance criteria\nLooks right.' }), NOW), 'no-safe-verify');
  assert.equal(skipReason(issue({ updatedAt: undefined }), NOW), 'no-updatedAt');
});

test('skips headless blockers: visual QA, owner decision, async wait', () => {
  assert.match(skipReason(issue({ description: `${BODY}\nTouches src/components/Foo.tsx` }), NOW), /^blocker-VISUAL_QA_GATE/);
  assert.equal(skipReason(issue({ description: `${BODY}\n\nDECISION NEEDED: owner picks the copy.` }), NOW), 'blocker-OWNER_DECISION_GATE');
  assert.equal(skipReason(issue({ description: `${BODY}\n\nRECHECK-AFTER: 2026-12-01` }), NOW), 'blocker-ASYNC_WAIT_GATE');
});

test('takes a technically parked P0/P1 session card, refuses an owner hold', () => {
  const tech = issue({ state: { name: 'Backlog', type: 'backlog' }, description: `PARKED: needs a rule-18 second-opinion before the edit\n\n${BODY}` });
  assert.equal(skipReason(tech, NOW), null);
  const hold = issue({ state: { name: 'Backlog', type: 'backlog' }, description: `PARKED: waiting on owner go-ahead\n\n${BODY}` });
  assert.equal(skipReason(hold, NOW), 'parked-or-backlog');
});

test('empty board returns no pick', () => {
  const { pick, eligible, skipped } = pickCloudCard([], { nowMs: NOW });
  assert.equal(pick, null);
  assert.equal(eligible, 0);
  assert.deepEqual(skipped, {});
});

// BRO-4565: a worker that ends its turn before Land finishes never comes back
// to a refused landing, because its card is In Progress. findResumeCard hands
// it back first.
const { findResumeCard, landRefCardNumber, STRANDED_MS, RESUME_WINDOW_MS } = require('./cloud-worker-pick.js');
const ago = (ms) => new Date(NOW - ms).toISOString();
const STARTED = { name: 'In Progress', type: 'started' };
function landRef(over = {}, run = {}) {
  return {
    ref: 'land/bro-100-fix',
    sha: 'aaa',
    lastRun: { id: 1, status: 'completed', conclusion: 'failure', headSha: 'aaa', updatedAt: ago(STRANDED_MS + 60_000), ...run },
    ...over,
  };
}
const startedCard = (over = {}) => issue({ state: STARTED, updatedAt: ago(IDLE_MS + 60_000), ...over });

test('landRefCardNumber reads bro-N anywhere in a land ref, case-insensitive', () => {
  assert.equal(landRefCardNumber('land/bro-2311-bypass-test'), 2311);
  assert.equal(landRefCardNumber('refs/heads/land/job/linear-BRO-4130-mug4'), 4130);
  assert.equal(landRefCardNumber('land/bro-4523'), 4523);
  assert.equal(landRefCardNumber('land/audit-inflight-gate'), null);
  assert.equal(landRefCardNumber('feature/bro-100'), null);
});

test('resumes a started P0/P1 card whose land ref was refused and left alone', () => {
  const r = findResumeCard([startedCard()], [landRef()], { nowMs: NOW });
  assert.equal(r.issue.identifier, 'BRO-100');
  assert.equal(r.ref, 'land/bro-100-fix');
  assert.equal(r.lastRun.id, 1);
});

test('no resume while a landing is still in flight or just refused', () => {
  const none = (refs, cards = [startedCard()]) => assert.equal(findResumeCard(cards, refs, { nowMs: NOW }), null);
  none([landRef({}, { status: 'in_progress', conclusion: null })]);
  none([landRef({ sha: 'bbb' })]); // tip pushed after the last run: its run hasn't started
  none([landRef({}, { updatedAt: ago(STRANDED_MS - 60_000) })]); // refusal too fresh
  none([landRef()], [startedCard({ updatedAt: ago(IDLE_MS - 60_000) })]); // card touched recently: someone may be on it
  none([landRef(), landRef({ ref: 'land/bro-100-retry', sha: 'ccc' }, { headSha: 'ccc', status: 'queued', conclusion: null })]);
});

test('no resume for successful, ancient, unstarted, P2, or unrelated refs', () => {
  const none = (refs, cards = [startedCard()]) => assert.equal(findResumeCard(cards, refs, { nowMs: NOW }), null);
  none([landRef({}, { conclusion: 'success' })]);
  none([landRef({}, { updatedAt: ago(RESUME_WINDOW_MS + 60_000) })]);
  none([landRef({ lastRun: null })]);
  none([landRef()], [issue()]); // Todo: the normal pick handles it
  none([landRef()], [startedCard({ priority: 3 })]);
  none([landRef()], [startedCard({ state: { name: 'In Review', type: 'started' } })]); // the closer owns it
  none([landRef({ ref: 'land/bro-999-other' })]);
  none([landRef({ ref: 'land/audit-x' })]);
});

test('no resume for a card a headless worker cannot finish', () => {
  const none = (cards) => assert.equal(findResumeCard(cards, [landRef()], { nowMs: NOW }), null);
  none([startedCard({ description: '## Acceptance criteria\nLooks right.' })]);
  none([startedCard({ description: `${BODY}\nTouches src/components/Foo.tsx` })]);
  none([startedCard({ description: `${BODY}\n\nDECISION NEEDED: owner picks the copy.` })]);
});

test('resume prefers higher priority, then older card, and the newest refusal per card', () => {
  const r = findResumeCard([
    startedCard({ identifier: 'BRO-300', priority: 2 }),
    startedCard({ identifier: 'BRO-500', priority: 1 }),
    startedCard({ identifier: 'BRO-400', priority: 1 }),
  ], [
    landRef({ ref: 'land/bro-300-a' }),
    landRef({ ref: 'land/bro-500-a' }),
    landRef({ ref: 'land/bro-400-old' }, { id: 7, updatedAt: ago(2 * STRANDED_MS) }),
    landRef({ ref: 'land/bro-400-new' }, { id: 8 }),
  ], { nowMs: NOW });
  assert.equal(r.issue.identifier, 'BRO-400');
  assert.equal(r.ref, 'land/bro-400-new');
});

test('a cancelled run is an eviction from the landing slot, not a refusal', () => {
  assert.equal(findResumeCard([startedCard()], [landRef()], { nowMs: NOW }).kind, 'refused');
  assert.equal(findResumeCard([startedCard()], [landRef({}, { conclusion: 'cancelled' })], { nowMs: NOW }).kind, 'evicted');
});

test('stops resuming a ref after MAX_LAND_RUNS runs, and while a dispatched Land run is in flight', () => {
  const { MAX_LAND_RUNS } = require('./cloud-worker-pick.js');
  assert.equal(findResumeCard([startedCard()], [landRef({}, { attempts: MAX_LAND_RUNS })], { nowMs: NOW }), null);
  assert.equal(findResumeCard([startedCard()], [landRef({}, { attempts: MAX_LAND_RUNS - 1 })], { nowMs: NOW }).ref, 'land/bro-100-fix');
  assert.equal(findResumeCard([startedCard()], [landRef({}, { conclusion: 'cancelled', runAttempt: MAX_LAND_RUNS })], { nowMs: NOW }), null);
  assert.equal(findResumeCard([startedCard()], [landRef()], { nowMs: NOW, landDispatchInFlight: true }), null);
});

test('a sibling ref with no Land run yet blocks resume for that card', () => {
  assert.equal(findResumeCard([startedCard()], [landRef(), landRef({ ref: 'land/bro-100-new', sha: 'ddd', lastRun: null })], { nowMs: NOW }), null);
});
