import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickCloudCard, skipReason, IDLE_MS, AUTOMATION_PARK_STALE_MS } = require('./cloud-worker-pick.js');

const NOW = Date.parse('2026-10-03T12:00:00Z');
const OLD = new Date(NOW - IDLE_MS - 60_000).toISOString();
const FRESH = new Date(NOW - 60_000).toISOString();
const SAFE_CMD = '`node --test scripts/lib/example.test.mjs`';
const STARTED_STATE = { name: 'In Progress', type: 'started' };
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

// BRO-4664: a session that would have called create_session files a START-NOW card.
const { isStartNow, START_NOW_MIN_AGE_MS, START_NOW_MAX_AGE_MS } = require('./cloud-worker-pick.js');
const FILED_OK = new Date(NOW - START_NOW_MIN_AGE_MS - 60_000).toISOString();
const startNowCard = (over = {}) => issue({ identifier: 'BRO-4999', priority: 2, updatedAt: FRESH, createdAt: FILED_OK, description: `START-NOW: owner asked for it\n${BODY}`, ...over });

test('START-NOW card goes first and skips the idle wait', () => {
  const startNow = startNowCard();
  assert.equal(skipReason(startNow, NOW), null);
  const { pick, startNowSkipped } = pickCloudCard([issue({ identifier: 'BRO-10', priority: 1 }), startNow], { nowMs: NOW });
  assert.equal(pick.identifier, 'BRO-4999');
  assert.deepEqual(startNowSkipped, {});
});

test('START-NOW only applies inside its age window and to Todo cards', () => {
  assert.equal(isStartNow(startNowCard(), NOW), true);
  // Filed under 10 minutes ago: the filing session may still be editing it.
  const tooNew = startNowCard({ createdAt: new Date(NOW - 60_000).toISOString() });
  assert.equal(isStartNow(tooNew, NOW), false);
  assert.equal(skipReason(tooNew, NOW), 'recent-activity');
  // Older than 48 hours: the marker is stale, normal idle rules apply.
  const tooOld = startNowCard({ createdAt: new Date(NOW - START_NOW_MAX_AGE_MS - 60_000).toISOString() });
  assert.equal(isStartNow(tooOld, NOW), false);
  assert.equal(skipReason(tooOld, NOW), 'recent-activity');
  // No createdAt at all fails closed.
  assert.equal(isStartNow(startNowCard({ createdAt: undefined }), NOW), false);
  // Backlog (parked) cards are not started early.
  assert.equal(isStartNow(startNowCard({ state: { name: 'Backlog', type: 'backlog' } }), NOW), false);
  // Marker on any line, any case.
  assert.equal(isStartNow(startNowCard({ description: `## Problem\nx\nstart-now: soon\n${BODY}` }), NOW), true);
});

test('START-NOW cards that cannot run are reported in startNowSkipped', () => {
  const tooNew = startNowCard({ identifier: 'BRO-5001', createdAt: new Date(NOW - 60_000).toISOString() });
  const noVerify = startNowCard({ identifier: 'BRO-5002', description: 'START-NOW: x\nno command here' });
  const ok = startNowCard({ identifier: 'BRO-5003' });
  const { pick, startNowSkipped } = pickCloudCard([tooNew, noVerify, ok], { nowMs: NOW });
  assert.equal(pick.identifier, 'BRO-5003');
  assert.equal(startNowSkipped['BRO-5001'], 'recent-activity');
  assert.equal(startNowSkipped['BRO-5002'], 'no-safe-verify');
  assert.equal('BRO-5003' in startNowSkipped, false);
});

test('START-NOW does not override other skips', () => {
  const body = `START-NOW: x\n${BODY}`;
  assert.equal(skipReason(startNowCard({ description: body, state: STARTED_STATE }), NOW), 'state-started');
  assert.equal(skipReason(startNowCard({ description: body, priority: 3 }), NOW), 'not-p0-p1');
  assert.equal(skipReason(startNowCard({ description: 'START-NOW: x\nno command here' }), NOW), 'no-safe-verify');
  // Mentioned mid-line is not the marker.
  assert.equal(skipReason(startNowCard({ description: `see START-NOW: docs\n${BODY}` }), NOW), 'recent-activity');
});

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

test('takes a machine-filed parked card only once it has sat quiet for AUTOMATION_PARK_STALE_MS', () => {
  const stale = new Date(NOW - AUTOMATION_PARK_STALE_MS - 60_000).toISOString();
  const recent = new Date(NOW - AUTOMATION_PARK_STALE_MS + 60 * 60_000).toISOString();
  const backlog = { name: 'Backlog', type: 'backlog' };
  const autofix = `PARKED: Auto-filed by digest-autofix; runAutofix dispatches via linear-next separately in the same pass.\n\n${BODY}`;
  const router = `PARKED: Auto-filed by owner-alert-router (condition: backstop:some-show); parked for triage.\n\n${BODY}`;
  assert.equal(skipReason(issue({ state: backlog, description: autofix, updatedAt: stale }), NOW), null);
  assert.equal(skipReason(issue({ state: backlog, description: router, updatedAt: stale }), NOW), null);
  assert.equal(skipReason(issue({ state: backlog, description: autofix, updatedAt: recent }), NOW), 'parked-or-backlog');
  assert.equal(skipReason(issue({ state: backlog, description: autofix, updatedAt: stale, priority: 3 }), NOW), 'not-p0-p1');
  assert.equal(skipReason(issue({ state: backlog, description: autofix.replace(SAFE_CMD, 'it looks right'), updatedAt: stale }), NOW), 'no-safe-verify');
  assert.equal(skipReason(issue({ state: backlog, description: `${autofix}\n\nDECISION NEEDED: owner picks.`, updatedAt: stale }), NOW), 'blocker-OWNER_DECISION_GATE');
  // A hand-written owner hold stays parked however old it is.
  assert.equal(skipReason(issue({ state: backlog, description: `PARKED: waiting on owner go-ahead\n\n${BODY}`, updatedAt: stale }), NOW), 'parked-or-backlog');
  // An owner hold added on a later PARKED line under the machine line wins.
  assert.equal(skipReason(issue({ state: backlog, description: autofix.replace('\n\n', '\nPARKED: waiting on owner go-ahead\n\n'), updatedAt: stale }), NOW), 'parked-or-backlog');
  // A later hold line that quotes the machine marker is still a hold.
  assert.equal(skipReason(issue({ state: backlog, description: autofix.replace('\n\n', '\nPARKED: owner hold, leave Auto-filed by digest-autofix cards alone\n\n'), updatedAt: stale }), NOW), 'parked-or-backlog');
  // A later technical PARKED line does not block it.
  assert.equal(skipReason(issue({ state: backlog, description: autofix.replace('\n\n', '\nPARKED: needs a worktree\n\n'), updatedAt: stale }), NOW), null);
  // Exact boundary: quiet for exactly AUTOMATION_PARK_STALE_MS counts.
  assert.equal(skipReason(issue({ state: backlog, description: autofix, updatedAt: new Date(NOW - AUTOMATION_PARK_STALE_MS).toISOString() }), NOW), null);
  // A started card is never treated as parked-drainable.
  assert.equal(skipReason(issue({ state: STARTED_STATE, description: autofix, updatedAt: stale }), NOW), 'state-started');
  // The router marker quoted in the body, with no leading PARKED line naming it, is a person's park.
  assert.equal(skipReason(issue({ state: backlog, description: `PARKED: owner to decide\n\nSee Auto-filed by owner-alert-router cards.\n\n${BODY}`, updatedAt: stale }), NOW), 'parked-or-backlog');
});

test('within a priority, stale machine-filed cards go after Todo and session-parked cards', () => {
  const stale = new Date(NOW - AUTOMATION_PARK_STALE_MS - 60_000).toISOString();
  const backlog = { name: 'Backlog', type: 'backlog' };
  const autofix = `PARKED: Auto-filed by digest-autofix; runAutofix dispatches via linear-next separately in the same pass.\n\n${BODY}`;
  const { ordered } = pickCloudCard([
    issue({ identifier: 'BRO-10', state: backlog, description: autofix, updatedAt: stale }),
    issue({ identifier: 'BRO-900' }),
    issue({ identifier: 'BRO-800', state: backlog, description: `PARKED: needs a rule-18 second-opinion before the edit\n\n${BODY}` }),
    issue({ identifier: 'BRO-20', priority: 1, state: backlog, description: autofix, updatedAt: stale }),
  ], { nowMs: NOW });
  assert.deepEqual(ordered.map((i) => i.identifier), ['BRO-20', 'BRO-800', 'BRO-900', 'BRO-10']);
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

// Pause memory (BRO-4574): the first two live firings each took a card an
// earlier worker had already paused on (one with a VERIFY the cloud can't run,
// one held for an owner decision), so both would have won every firing.
const { pausedHistorySkipReason, findResumeCandidates, RECENT_PAUSE_MS } = require('./cloud-worker-pick.js');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const report = (status, text, msAgo) => ({ body: `**Session report (${status})**\n\n${text}`, createdAt: at(msAgo) });

test('a VERIFY that runs the whole unit suite is not cloud-runnable', () => {
  const desc = '## Acceptance criteria\n`node scripts/run-unit-tests.js` passes.';
  assert.equal(skipReason(issue({ description: desc }), NOW), 'verify-not-cloud-runnable');
  const { pick, skipped } = pickCloudCard([issue({ description: desc }), issue({ identifier: 'BRO-200' })], { nowMs: NOW });
  assert.equal(pick.identifier, 'BRO-200');
  assert.equal(skipped['verify-not-cloud-runnable'], 1);
});

test('a VERIFY posted as a comment arms the card, newest arming comment wins (BRO-4642)', () => {
  const { verifyCommand } = require('./linear-drain-parked.js');
  const bare = '## Acceptance criteria\nLooks right.';
  const withComments = (...bodies) => issue({
    description: bare,
    comments: { nodes: bodies.map((body, i) => ({ body, createdAt: at((bodies.length - i) * 60_000) })).reverse() },
  });
  assert.equal(skipReason(withComments(`VERIFY: ${SAFE_CMD}`), NOW), null);
  assert.equal(verifyCommand(withComments(`VERIFY: ${SAFE_CMD}`)), 'node --test scripts/lib/example.test.mjs');
  assert.equal(verifyCommand(withComments(`VERIFY: ${SAFE_CMD}`, 'VERIFY: `node --test scripts/lib/newer.test.mjs`')),
    'node --test scripts/lib/newer.test.mjs');
  assert.equal(skipReason(withComments('VERIFY: `node scripts/run-unit-tests.js`'), NOW), 'verify-not-cloud-runnable');
  assert.equal(skipReason(withComments('Looked at it, no command yet.'), NOW), 'no-safe-verify');
  assert.equal(skipReason(issue({ description: bare, comments: { nodes: [] } }), NOW), 'no-safe-verify');
  // A newer comment corrects the description's command, either way.
  const unrunnable = '## Acceptance criteria\n`node scripts/run-unit-tests.js` passes.';
  const fixed = issue({ description: unrunnable, comments: { nodes: [{ body: `VERIFY: ${SAFE_CMD}`, createdAt: at(60_000) }] } });
  assert.equal(skipReason(fixed, NOW), null);
  const broken = issue({ comments: { nodes: [{ body: 'VERIFY: `node scripts/run-unit-tests.js`', createdAt: at(60_000) }] } });
  assert.equal(skipReason(broken, NOW), 'verify-not-cloud-runnable');
  const judged = issue({ comments: { nodes: [{ body: 'VERIFY: owner-judgment, needs a product call', createdAt: at(60_000) }] } });
  assert.equal(skipReason(judged, NOW), 'no-safe-verify');
  const parkedBare = issue({ state: { name: 'Backlog', type: 'backlog' },
    description: `PARKED: needs a rule-18 second-opinion before the edit\n\n${bare}`,
    comments: { nodes: [{ body: `VERIFY: ${SAFE_CMD}`, createdAt: at(60_000) }] } });
  assert.equal(skipReason(parkedBare, NOW), null);
});

test('pickCloudCard returns every eligible card in pick order', () => {
  const { ordered } = pickCloudCard([
    issue({ identifier: 'BRO-50', priority: 2 }),
    issue({ identifier: 'BRO-900', priority: 1 }),
    issue({ identifier: 'BRO-60', priority: 3 }),
  ], { nowMs: NOW });
  assert.deepEqual(ordered.map((i) => i.identifier), ['BRO-900', 'BRO-50']);
});

test('a pause waiting on the owner holds the card until someone comments after it', () => {
  const held = report('paused', 'Not landed: needs an owner decision on the prod flip.', 10 * 24 * 3600 * 1000);
  assert.equal(pausedHistorySkipReason([held], NOW), 'awaiting-owner');
  assert.equal(pausedHistorySkipReason([report('paused', 'Held for owner sign-off.', 1000)], NOW), 'awaiting-owner');
  // Machine comments after it are not an answer.
  const receipt = { body: 'Dispatched e391967e to linear:BRO-1 at x (headless)', createdAt: at(1000) };
  const fixer = { body: 'Auto-corrected 2026-10-04 by the stuck-card closer', createdAt: at(900) };
  assert.equal(pausedHistorySkipReason([receipt, held, fixer], NOW), 'awaiting-owner');
  // A human reply after it releases the hold; an old pause then counts for nothing.
  const reply = { body: 'Approved, go ahead and flip it.', createdAt: at(1000) };
  assert.equal(pausedHistorySkipReason([held, reply], NOW), null);
});

test('any pause younger than RECENT_PAUSE_MS skips the card; older ones and other reports do not', () => {
  const recent = report('paused', 'VERIFY times out in the cloud.', RECENT_PAUSE_MS - 60_000);
  assert.equal(pausedHistorySkipReason([recent], NOW), 'recently-paused');
  assert.equal(pausedHistorySkipReason([report('paused', 'VERIFY times out.', RECENT_PAUSE_MS + 60_000)], NOW), null);
  // Only the latest report counts, whatever order the comments arrive in.
  assert.equal(pausedHistorySkipReason([report('done', 'Landed.', 1000), recent], NOW), null);
  assert.equal(pausedHistorySkipReason([report('in-review', 'Landed.', 5 * RECENT_PAUSE_MS), recent], NOW), 'recently-paused');
  assert.equal(pausedHistorySkipReason([], NOW), null);
  assert.equal(pausedHistorySkipReason(undefined, NOW), null);
  // Quoting a report mid-comment is not a report.
  assert.equal(pausedHistorySkipReason([{ body: 'see **Session report (paused)** above', createdAt: at(1000) }], NOW), null);
});

test('findResumeCandidates lists every resumable card, best first; findResumeCard is its head', () => {
  const cards = [startedCard({ identifier: 'BRO-300' }), startedCard({ identifier: 'BRO-100' })];
  const refs = [landRef(), landRef({ ref: 'land/bro-300-fix', sha: 'eee' }, { headSha: 'eee' })];
  assert.deepEqual(findResumeCandidates(cards, refs, { nowMs: NOW }).map((c) => c.issue.identifier), ['BRO-100', 'BRO-300']);
  assert.equal(findResumeCard(cards, refs, { nowMs: NOW }).issue.identifier, 'BRO-100');
  assert.deepEqual(findResumeCandidates(cards, refs, { nowMs: NOW, landDispatchInFlight: true }), []);
});

test('owner hold: DECISION NEEDED and named-owner wording hold, negated mentions do not', () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const hold = (text) => pausedHistorySkipReason([report('paused', text, WEEK)], NOW);
  assert.equal(hold('DECISION NEEDED: flip the prod flag? Option A ...'), 'awaiting-owner');
  assert.equal(hold('Paused pending the owner.'), 'awaiting-owner');
  assert.equal(hold('Waiting on Thomas to approve.'), 'awaiting-owner');
  // A week-old pause that says the owner is NOT the blocker falls to the 72h rule (expired).
  assert.equal(hold('Paused: CI flaky. Owner decision not required.'), null);
  assert.equal(hold('Not an owner decision; technical blocker.'), null);
  assert.equal(hold('No DECISION NEEDED here, retry later.'), null);
  // One negated and one real mention: the real one holds.
  assert.equal(hold('Not an owner call on the CSS. But DECISION NEEDED: go live?'), 'awaiting-owner');
});

test('owner hold expires after AWAITING_OWNER_MAX_MS', () => {
  const { AWAITING_OWNER_MAX_MS } = require('./cloud-worker-pick.js');
  const text = 'Blocked on owner decision.';
  assert.equal(pausedHistorySkipReason([report('paused', text, AWAITING_OWNER_MAX_MS - 60_000)], NOW), 'awaiting-owner');
  assert.equal(pausedHistorySkipReason([report('paused', text, AWAITING_OWNER_MAX_MS + 60_000)], NOW), null);
});

test('machine comments after a pause do not release an owner hold; a human checkbox reply does', () => {
  const held = report('paused', 'Blocked on owner decision.', 10_000);
  const after = (body) => ({ body, createdAt: at(1000) });
  for (const body of [
    '[auto-fix-attempted:fail]\n\ndetails',
    '**Re-arm (auto, BRO-3395):** the existing acceptance-criteria command was vacuous.',
    'Dispatched to linear:BRO-1 at 2026-10-03T00:00:00Z (headless)',
    'Dispatched e391967e to linear:BRO-1 at 2026-10-03T00:00:00Z',
    '[red-first follow-up] filed',
  ]) assert.equal(pausedHistorySkipReason([held, after(body)], NOW), 'awaiting-owner', body);
  for (const body of ['[x] done, approved', '[Approved] go ahead', '[the fix](https://example.com) looks right', '[follow-up](https://example.com) is fine, ship it']) {
    assert.equal(pausedHistorySkipReason([held, after(body)], NOW), 'recently-paused', body);
  }
});

test("a possessive owner mention (the owner's Mac) is not an owner hold", () => {
  for (const text of ["Paused: needs the owner's Mac for keychain access.", "Blocked on the owner's machine (no VERCEL_TOKEN in cloud)."]) {
    assert.equal(pausedHistorySkipReason([report('paused', text, 10_000)], NOW), 'recently-paused', text);
  }
  for (const text of ["Waiting on the owner's approval.", 'Needs the owner to confirm the flip.', 'Pending owner.']) {
    assert.equal(pausedHistorySkipReason([report('paused', text, 10_000)], NOW), 'awaiting-owner', text);
  }
});

test('iOS app cards are skipped: the cloud worker has no checkout of the app repo', () => {
  assert.equal(skipReason(issue({ title: 'iOS P1: London market excludes OB shows' }), NOW), 'ios-app-repo');
  assert.equal(skipReason(issue({ title: '[iOS] swipe gesture swallows scroll' }), NOW), 'ios-app-repo');
  assert.equal(skipReason(issue({ title: 'Fix iOS Safari layout on web' }), NOW), null);
  assert.equal(skipReason(issue({ title: 'iOS Safari: hero overflows on /show' }), NOW), null);
  const { pick } = pickCloudCard([issue({ identifier: 'BRO-1', title: 'iOS: app bug' }), issue({ identifier: 'BRO-2' })], { nowMs: NOW });
  assert.equal(pick.identifier, 'BRO-2');
});

test('BRO-2204: a card carrying the NO-DISPATCH marker is never picked or resumed', () => {
  const marked = issue({ identifier: 'BRO-2204', description: `NO-DISPATCH: needs the owner's answer first\n${BODY}` });
  assert.equal(skipReason(marked, NOW), 'no-dispatch-marker');
  const { pick, skipped } = pickCloudCard([marked], { nowMs: NOW });
  assert.equal(pick, null);
  assert.equal(skipped['no-dispatch-marker'], 1);
  // Checked before VERIFY parsing: a marked card with no VERIFY still reports the marker.
  assert.equal(skipReason(issue({ description: 'NO-DISPATCH: owner first\n\n## Problem\nX.' }), NOW), 'no-dispatch-marker');
  // The same card without the marker is still picked.
  assert.equal(skipReason(issue({ identifier: 'BRO-2204' }), NOW), null);
  // A stranded land ref for a marked card is not resumed either.
  const markedStarted = startedCard({ identifier: 'BRO-100', description: `NO-DISPATCH: owner first\n${BODY}` });
  assert.deepEqual(findResumeCandidates([markedStarted], [landRef()], { nowMs: NOW }), []);
  // Only the description counts: a comment quoting the marker is not a hold.
  assert.equal(skipReason(issue({ comments: { nodes: [{ body: 'NO-DISPATCH: quoted', createdAt: FRESH }] } }), NOW), null);
});
