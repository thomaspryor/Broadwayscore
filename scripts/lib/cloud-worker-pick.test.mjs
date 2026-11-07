import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// BRO-6303: codexCardFit defaults read the committed trust ladder; pin them to the pre-ladder baseline.
process.env.CODEX_TRUST_LADDER_DISABLED = '1';
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

test('skips headless blockers: owner decision, async wait (a UI card is no longer one, BRO-6241)', () => {
  assert.equal(skipReason(issue({ description: `${BODY}\nTouches src/components/Foo.tsx` }), NOW), null);
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

test('BRO-6234: the filer\'s daily re-comment does not reset the quiet timer; real activity does', () => {
  const { effectiveTouchMs } = require('./cloud-worker-pick.js');
  const stale = new Date(NOW - AUTOMATION_PARK_STALE_MS - 60 * 60_000).toISOString();
  const backlog = { name: 'Backlog', type: 'backlog' };
  const autofix = `PARKED: Auto-filed by digest-autofix; runAutofix dispatches via linear-next separately in the same pass.\n\n${BODY}`;
  const refresh = (createdAt) => ({ createdAt, body: `Auto-filed by the morning digest (Digest v3, owner mandate 2026-08-02: fix automatically, never ask; BRO-3427 row-family fold). These 3 rows shared one condition.\n\n${BODY}` });
  const reCommentedNow = new Date(NOW - 60_000).toISOString();
  const base = { state: backlog, description: autofix, createdAt: stale };
  // Only the filer's re-comment touched it: still ages out.
  const quiet = issue({ ...base, updatedAt: reCommentedNow, comments: { nodes: [refresh(reCommentedNow)] } });
  assert.equal(skipReason(quiet, NOW), null);
  assert.equal(effectiveTouchMs(quiet), Date.parse(stale));
  // Without comments loaded the old behaviour holds.
  assert.equal(skipReason(issue({ ...base, updatedAt: reCommentedNow }), NOW), 'parked-or-backlog');
  // A person's comment before the re-comment counts as the touch.
  const person = new Date(NOW - 60 * 60_000).toISOString();
  const touched = issue({ ...base, updatedAt: reCommentedNow, comments: { nodes: [{ createdAt: person, body: 'looking at this' }, refresh(reCommentedNow)] } });
  assert.equal(skipReason(touched, NOW), 'parked-or-backlog');
  // A description or state edit after the re-comment moves updatedAt away from it: kept.
  const edited = issue({ ...base, updatedAt: new Date(NOW - 30_000).toISOString(), comments: { nodes: [refresh(new Date(NOW - 10 * 60_000).toISOString())] } });
  assert.equal(effectiveTouchMs(edited), Date.parse(edited.updatedAt));
  // A person quoting the marker mid-comment is not the filer.
  const quoted = issue({ ...base, updatedAt: reCommentedNow, comments: { nodes: [{ createdAt: reCommentedNow, body: 'FYI this was Auto-filed by the morning digest, taking it' }] } });
  assert.equal(effectiveTouchMs(quoted), Date.parse(reCommentedNow));
  // A dispatch receipt is real activity, not a filer re-comment.
  const receipt = issue({ ...base, updatedAt: reCommentedNow, comments: { nodes: [{ createdAt: reCommentedNow, body: 'Dispatched abc123 to a headless worker' }] } });
  assert.equal(effectiveTouchMs(receipt), Date.parse(reCommentedNow));
});

test('BRO-6234: a later "not an owner decision" comment unblocks an owner-gated card', () => {
  const gated = issue({ description: `DECISION NEEDED: pick A or B.\n\n${BODY}`, updatedAt: OLD });
  assert.equal(skipReason(gated, NOW), 'blocker-OWNER_DECISION_GATE');
  const cleared = issue({ description: gated.description, updatedAt: OLD, comments: { nodes: [{ createdAt: OLD, body: 'Not an owner decision: A matches the spec.' }] } });
  assert.equal(skipReason(cleared, NOW), null);
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

test('a cancelled run (cancelled before any work) is not a refusal', () => {
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
const { pausedHistorySkipReason, findResumeCandidates, RECENT_PAUSE_MS, isMachineComment } = require('./cloud-worker-pick.js');
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
  // BRO-5370: owner-judgment is its own reason, so the no-safe-verify count is the armable pool.
  assert.equal(skipReason(judged, NOW), 'owner-judgment');
  assert.equal(skipReason(issue({ description: `${bare}\n\nVERIFY: owner-judgment` }), NOW), 'owner-judgment');
  const { startNowUnpickableReason } = require('./cloud-worker-pick.js');
  assert.match(startNowUnpickableReason({ title: 'x', description: 'START-NOW: now\n\nVERIFY: owner-judgment', priority: 2, mode: 'dispatch' }).hint, /person must judge/);
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

test('a claim comment after an owner-hold pause is not an owner answer (BRO-6092)', () => {
  const held = report('paused', 'Not landed: needs an owner decision on the prod flip.', 10 * 24 * 3600 * 1000);
  const claim = { body: 'Claimed by claude-session-abc at 2026-10-23T01:00:00Z\nWorker model: opus', createdAt: at(1000) };
  assert.equal(pausedHistorySkipReason([held, claim], NOW), 'awaiting-owner');
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

// BRO-5017: a START-NOW card filed with prose acceptance criteria was skipped
// as no-safe-verify every hour and never started. Create now refuses it.
test('startNowUnpickableReason: refuses a START-NOW card the picker would skip', () => {
  const { startNowUnpickableReason } = require('./cloud-worker-pick.js');
  const card = (over) => ({ title: 'Research hard cites', priority: 2, mode: 'dispatch', ...over });
  const prose = 'START-NOW: research handoff\n\n## Acceptance criteria\nRows land in pending review with hard cites.';
  assert.equal(startNowUnpickableReason(card({ description: prose })).reason, 'no-safe-verify');
  assert.match(startNowUnpickableReason(card({ description: prose })).hint, /VERIFY/);
  const safe = `START-NOW: research handoff\n\nVERIFY: ${SAFE_CMD.slice(1, -1)}`;
  assert.equal(startNowUnpickableReason(card({ description: safe })), null);
  assert.equal(startNowUnpickableReason(card({ description: safe, priority: 3 })).reason, 'not-p0-p1');
  assert.equal(startNowUnpickableReason(card({ description: safe, priority: undefined })).reason, 'not-p0-p1');
  assert.equal(startNowUnpickableReason(card({ description: safe, mode: 'park' })).reason, 'parked-or-backlog');
  // No START-NOW line: never refused, whatever else is wrong with the card.
  assert.equal(startNowUnpickableReason(card({ description: 'plain notes', priority: 4, mode: 'park' })), null);
  // Agrees with the picker on the same card.
  const issueLike = { identifier: 'BRO-1', title: 'Research hard cites', description: prose, priority: 2, state: { type: 'unstarted' }, updatedAt: OLD, createdAt: OLD };
  assert.equal(skipReason(issueLike, NOW), 'no-safe-verify');
});

test('createLinearIssue refuses an unpickable START-NOW card before any API call', async () => {
  const { createLinearIssue } = require('./linear-issue-create.js');
  await assert.rejects(
    createLinearIssue({ title: 'Research hard cites', description: 'START-NOW: go\n\nAcceptance: rows land.', dispatch: true, priority: 2, client: {}, reuseTwin: true }),
    (err) => err.startNowUnpickable === 'no-safe-verify' && /Nothing was filed/.test(err.message),
  );
});

// P2 fallback: once no P0/P1 card is eligible, P2 (Linear priority 3) Todo cards
// are picked under the same rules, always after every P0/P1 card.
const { TIER_P0P1, TIER_P2, isP2FallbackCandidate, pickModel, cloudPriorAttempts, mayTakeUnchecked, resumableCardsByNumber } = require('./cloud-worker-pick.js');

test('P2 fallback: an eligible P0/P1 card wins, P2 cards queue after it', () => {
  const res = pickCloudCard([
    issue({ identifier: 'BRO-5', priority: 3 }),
    issue({ identifier: 'BRO-900', priority: 2 }),
    issue({ identifier: 'BRO-6', priority: 3 }),
  ], { nowMs: NOW });
  assert.equal(res.pick.identifier, 'BRO-900');
  assert.equal(res.pickTier, TIER_P0P1);
  assert.deepEqual(res.ordered.map((i) => i.identifier), ['BRO-900']);
  assert.deepEqual(res.orderedP2.map((i) => i.identifier), ['BRO-5', 'BRO-6']);
  // The P0/P1 counters keep their meaning: P2 cards still count as not-p0-p1 there.
  assert.equal(res.eligible, 1);
  assert.equal(res.skipped['not-p0-p1'], 2);
  assert.equal(res.eligibleP2, 2);
});

test('P2 fallback: START-NOW does not apply to P2 (no idle skip, no queue jump)', () => {
  // Fresh START-NOW P2: waits out IDLE_MS like any P2 card.
  assert.equal(skipReason(startNowCard({ priority: 3 }), NOW, { tier: 'p2' }), 'recent-activity');
  // An idle START-NOW P2 is ordinary P2: oldest first, never ahead of a P0/P1 card.
  const res = pickCloudCard([
    startNowCard({ identifier: 'BRO-70', priority: 3, updatedAt: OLD }),
    issue({ identifier: 'BRO-60', priority: 3 }),
    issue({ identifier: 'BRO-900', priority: 2 }),
  ], { nowMs: NOW });
  assert.equal(res.pick.identifier, 'BRO-900');
  assert.deepEqual(res.orderedP2.map((i) => i.identifier), ['BRO-60', 'BRO-70']);
});

test('P2 fallback: past the history-check budget only P0/P1 entries are taken unchecked', () => {
  assert.equal(mayTakeUnchecked({ tier: TIER_P0P1 }), true);
  assert.equal(mayTakeUnchecked({ tier: TIER_P2 }), false);
  assert.equal(mayTakeUnchecked(null), false);
});

test('P2 fallback: a refused P2 landing is resumable only with includeP2; P3 never', () => {
  const p2 = startedCard({ priority: 3 });
  assert.equal(findResumeCard([p2], [landRef()], { nowMs: NOW }), null);
  assert.equal(findResumeCard([p2], [landRef()], { nowMs: NOW, includeP2: true }).issue.identifier, 'BRO-100');
  assert.equal(findResumeCard([startedCard({ priority: 4 })], [landRef()], { nowMs: NOW, includeP2: true }), null);
  assert.equal(resumableCardsByNumber([startedCard({ priority: 0 })], { includeP2: true }).size, 0);
  // P0/P1 resumes still rank ahead of P2 ones.
  const both = findResumeCandidates([p2, startedCard({ identifier: 'BRO-200', priority: 2 })],
    [landRef(), landRef({ ref: 'land/bro-200-x' })], { nowMs: NOW, includeP2: true });
  assert.deepEqual(both.map((c) => c.issue.identifier), ['BRO-200', 'BRO-100']);
});

test('P2 fallback: with no P0/P1 card eligible, the oldest P2 Todo card is picked', () => {
  const res = pickCloudCard([
    issue({ identifier: 'BRO-900', priority: 1, updatedAt: FRESH }), // recent-activity
    issue({ identifier: 'BRO-901', priority: 2, state: STARTED_STATE }),
    issue({ identifier: 'BRO-60', priority: 3 }),
    issue({ identifier: 'BRO-40', priority: 3 }),
  ], { nowMs: NOW });
  assert.equal(res.pick.identifier, 'BRO-40');
  assert.equal(res.pickTier, TIER_P2);
  assert.equal(res.eligible, 0);
  assert.deepEqual(res.orderedP2.map((i) => i.identifier), ['BRO-40', 'BRO-60']);
});

test('P2 fallback: no-priority cards are never picked; a P3 card only by the P3 tier', () => {
  const res = pickCloudCard([issue({ identifier: 'BRO-2', priority: 0 }), issue({ identifier: 'BRO-3', priority: undefined })], { nowMs: NOW });
  assert.equal(res.pick, null);
  assert.equal(res.pickTier, null);
  assert.deepEqual(res.ordered, []);
  assert.deepEqual(res.orderedP2, []);
  assert.deepEqual(res.orderedP3, []);
  const low = pickCloudCard([issue({ identifier: 'BRO-1', priority: 4 })], { nowMs: NOW });
  assert.deepEqual(low.orderedP2, []);
  assert.equal(low.pickTier, 'p3-fallback');
  assert.equal(skipReason(issue({ priority: 4 }), NOW, { tier: 'p2' }), 'not-p2');
  assert.equal(skipReason(issue({ priority: 0 }), NOW, { tier: 'p2' }), 'not-p2');
  assert.equal(skipReason(issue({ priority: 2 }), NOW, { tier: 'p2' }), 'not-p2');
  assert.equal(isP2FallbackCandidate(issue({ priority: 4 }), NOW), false);
});

test('P2 fallback: the same rules apply; owner-decision, parked and unfit P2 cards are skipped', () => {
  const p2 = (over) => issue({ priority: 3, ...over });
  assert.equal(skipReason(p2(), NOW, { tier: 'p2' }), null);
  assert.equal(skipReason(p2({ description: `${BODY}\n\nDECISION NEEDED: owner picks the copy.` }), NOW, { tier: 'p2' }), 'blocker-OWNER_DECISION_GATE');
  assert.equal(skipReason(p2({ description: `NO-DISPATCH: needs the owner first\n${BODY}` }), NOW, { tier: 'p2' }), 'no-dispatch-marker');
  assert.equal(skipReason(p2({ updatedAt: FRESH }), NOW, { tier: 'p2' }), 'recent-activity');
  assert.equal(skipReason(p2({ description: '## Acceptance criteria\nLooks right.' }), NOW, { tier: 'p2' }), 'no-safe-verify');
  assert.equal(skipReason(p2({ state: STARTED_STATE }), NOW, { tier: 'p2' }), 'state-started');
  // An owner-held P2 park stays parked (a technical one is taken since BRO-5369, see below).
  const parked = p2({ state: { name: 'Backlog', type: 'backlog' }, description: `PARKED: waiting on owner go-ahead\n\n${BODY}` });
  assert.equal(skipReason(parked, NOW, { tier: 'p2' }), 'parked-or-backlog');
  assert.equal(isP2FallbackCandidate(parked, NOW), false);
  // BRO-5360: a stale machine-filed P2 card is taken (the Mac drain that ran them is gone), after Todo cards.
  const stale = new Date(NOW - AUTOMATION_PARK_STALE_MS - 60_000).toISOString();
  const autofix = p2({ identifier: 'BRO-2', state: { name: 'Backlog', type: 'backlog' }, updatedAt: stale, description: `PARKED: Auto-filed by digest-autofix; runAutofix dispatches via linear-next separately in the same pass.\n\n${BODY}` });
  assert.equal(skipReason(autofix, NOW, { tier: 'p2' }), null);
  const res = pickCloudCard([p2({ identifier: 'BRO-1', description: `${BODY}\n\nDECISION NEEDED: owner picks.` }), parked, autofix], { nowMs: NOW });
  assert.equal(res.pick.identifier, 'BRO-2');
  assert.equal(res.skippedP2['blocker-OWNER_DECISION_GATE'], 1);
  assert.equal(res.skippedP2['parked-or-backlog'], 1);
  const ordered = pickCloudCard([autofix, p2({ identifier: 'BRO-9' })], { nowMs: NOW }).orderedP2.map((i) => i.identifier);
  assert.deepEqual(ordered, ['BRO-9', 'BRO-2']);
  // An owner-held pause in the comments still skips a P2 card (CLI history check).
  const held = [report('paused', 'DECISION NEEDED: owner picks the copy.', 60_000)];
  assert.equal(pausedHistorySkipReason(held, NOW), 'awaiting-owner');
  // A P2 Todo card that only a comment VERIFY arms is still a prefetch candidate.
  assert.equal(isP2FallbackCandidate(p2({ description: '## Acceptance criteria\nLooks right.' }), NOW), true);
});

test('model: same policy as linear-next (P0 and Model: Opus get Opus, the rest Sonnet)', () => {
  const opts = { nowMs: NOW, readEntries: () => [], env: {} };
  assert.equal(pickModel(issue({ priority: 1 }), opts).model, 'opus');
  assert.equal(pickModel(issue({ priority: 2, description: `${BODY}\n\nModel: Opus` }), opts).model, 'opus');
  assert.equal(pickModel(issue({ priority: 2 }), opts).model, 'sonnet');
  assert.equal(pickModel(issue({ priority: 3 }), opts).model, 'sonnet');
  assert.equal(pickModel(issue({ priority: 3, description: `${BODY}\n\nModel: Opus` }), opts).model, 'opus');
  assert.equal(pickModel(issue({ priority: 1, description: `${BODY}\n\nModel: Sonnet` }), opts).model, 'sonnet');
  // A retry (an earlier "Dispatched" comment) escalates whatever the card says.
  const retried = issue({ priority: 3, description: `${BODY}\n\nModel: Sonnet`, comments: { nodes: [{ body: 'Dispatched to workspace 1', createdAt: at(60_000) }] } });
  assert.equal(pickModel(retried, opts).model, 'opus');
  // A cloud worker's pause, or a Codex bounce, is a prior attempt too: the retry escalates.
  const paused = issue({ priority: 3, comments: { nodes: [report('paused', 'Ran out of time.', 60_000)] } });
  assert.equal(cloudPriorAttempts(paused), 1);
  assert.equal(pickModel(paused, opts).model, 'opus');
  const bounced = issue({ priority: 2, comments: { nodes: [{ body: `${require('./codex-runner.js').BOUNCED_MARKER}\nCodex could not land it.`, createdAt: at(60_000) }] } });
  assert.equal(pickModel(bounced, opts).model, 'opus');
  assert.equal(cloudPriorAttempts(issue({ comments: { nodes: [report('done', 'Closed.', 60_000), { body: 'a note', createdAt: at(1) }] } })), 0);
  // No Opus cap (BRO-6502): a P0, or an Opus card, keeps Opus with a full day of Opus launches or an unreadable ledger.
  const busy = Array.from({ length: 30 }, (_, i) => ({ event: 'launch', taskId: `linear:BRO-${900 + i}`, model: 'opus', ts: new Date(NOW - 3600_000).toISOString() }));
  assert.equal(pickModel(issue({ priority: 1 }), { ...opts, readEntries: () => busy }).model, 'opus');
  assert.equal(pickModel(issue({ priority: 1 }), { ...opts, readEntries: () => { throw new Error('EIO'); } }).model, 'opus');
  const opusP2 = issue({ priority: 2, description: `${BODY}\n\nModel: Opus` });
  assert.deepEqual(pickModel(opusP2, { ...opts, readEntries: () => busy }), { model: 'opus', reason: 'Model: opus on the card' });
  assert.equal(pickModel(opusP2, { ...opts, readEntries: () => { throw new Error('EIO'); } }).model, 'opus');
  // No dispatch ledger at all (a cloud container): the real reader returns [], so a P0 still gets Opus.
  assert.equal(pickModel(issue({ priority: 1 }), { nowMs: NOW, readEntries: () => require('./dispatch-ledger.js').readEntries('/nonexistent/dispatch-ledger.jsonl') }).model, 'opus');
});

test('P2 fallback: comments are read for P2 Todo and resumable P2 cards, never parked P2 or no-priority', () => {
  const { needsComments } = require('./cloud-worker-pick.js');
  assert.equal(needsComments(issue({ priority: 2 }), NOW), true);
  assert.equal(needsComments(issue({ priority: 3, description: '## Acceptance criteria\nLooks right.' }), NOW), true);
  assert.equal(needsComments(startedCard({ priority: 3 }), NOW), true);
  assert.equal(needsComments(issue({ priority: 3, state: { name: 'In Review', type: 'started' } }), NOW), false);
  assert.equal(needsComments(issue({ priority: 3, state: { name: 'Backlog', type: 'backlog' }, description: `PARKED: waiting on owner go-ahead\n\n${BODY}` }), NOW), false);
  // A paused Backlog P2 card (no PARKED line) needs its pause history read (BRO-5360).
  assert.equal(needsComments(issue({ priority: 3, state: { name: 'Backlog', type: 'backlog' } }), NOW), true);
  // P3 Todo is the next fallback tier (see the P3 tests below).
  assert.equal(needsComments(issue({ priority: 4 }), NOW), true);
  assert.equal(needsComments(issue({ priority: 0 }), NOW), false);
  assert.equal(needsComments(startedCard({ priority: 0 }), NOW), false);
  // A started P2 card armed only by a comment VERIFY is resumable once comments are read.
  const armed = startedCard({ priority: 3, description: '## Acceptance criteria\nLooks right.',
    comments: { nodes: [{ body: `VERIFY: ${SAFE_CMD}`, createdAt: at(60_000) }] } });
  assert.equal(findResumeCard([armed], [landRef()], { nowMs: NOW, includeP2: true }).issue.identifier, 'BRO-100');
});

test('P2 fallback: a pickable P2 card with a stale START-NOW line is not reported in startNowSkipped', () => {
  const { startNowSkipped, orderedP2 } = pickCloudCard([startNowCard({ identifier: 'BRO-70', priority: 3, updatedAt: OLD })], { nowMs: NOW });
  assert.deepEqual(orderedP2.map((i) => i.identifier), ['BRO-70']);
  assert.deepEqual(startNowSkipped, {});
  // One the fallback can't pick still says why.
  assert.equal(pickCloudCard([startNowCard({ identifier: 'BRO-71', priority: 3 })], { nowMs: NOW }).startNowSkipped['BRO-71'], 'not-p0-p1');
});

// P3 fallback: Low (Linear priority 4) Todo cards, one tier below P2, under the
// same rules, reached only when no P0/P1 and no P2 card is eligible.
const { TIER_P3, isP3FallbackCandidate, buildPickQueue } = require('./cloud-worker-pick.js');

test('P3 fallback: P0/P1 wins, then P2, then P3', () => {
  const res = pickCloudCard([
    issue({ identifier: 'BRO-3', priority: 4 }),
    issue({ identifier: 'BRO-5', priority: 3 }),
    issue({ identifier: 'BRO-900', priority: 2 }),
    issue({ identifier: 'BRO-1', priority: 4 }),
  ], { nowMs: NOW });
  assert.equal(TIER_P3, 'p3-fallback');
  assert.equal(res.pick.identifier, 'BRO-900');
  assert.equal(res.pickTier, TIER_P0P1);
  assert.deepEqual(res.orderedP2.map((i) => i.identifier), ['BRO-5']);
  assert.deepEqual(res.orderedP3.map((i) => i.identifier), ['BRO-1', 'BRO-3']);
  // P0/P1 and P2 counters keep their meaning: P3 cards are 'not-p0-p1' and absent from skippedP2.
  assert.equal(res.skipped['not-p0-p1'], 3);
  assert.deepEqual(res.skippedP2, {});
  assert.equal(res.eligibleP3, 2);
  const noUrgent = pickCloudCard([issue({ identifier: 'BRO-3', priority: 4 }), issue({ identifier: 'BRO-5', priority: 3 })], { nowMs: NOW });
  assert.equal(noUrgent.pick.identifier, 'BRO-5');
  assert.equal(noUrgent.pickTier, TIER_P2);
});

test('P3 fallback: with no P0/P1 or P2 card eligible, the oldest P3 Todo card is picked', () => {
  const res = pickCloudCard([
    issue({ identifier: 'BRO-900', priority: 1, updatedAt: FRESH }), // recent-activity
    issue({ identifier: 'BRO-50', priority: 3, description: `${BODY}\n\nDECISION NEEDED: owner picks.` }),
    issue({ identifier: 'BRO-60', priority: 4 }),
    issue({ identifier: 'BRO-40', priority: 4 }),
    issue({ identifier: 'BRO-30', priority: 0 }),
  ], { nowMs: NOW });
  assert.equal(res.pick.identifier, 'BRO-40');
  assert.equal(res.pickTier, TIER_P3);
  assert.equal(res.eligible, 0);
  assert.equal(res.eligibleP2, 0);
  assert.deepEqual(res.orderedP3.map((i) => i.identifier), ['BRO-40', 'BRO-60']);
});

test('P3 fallback: the same rules apply; owner-decision, parked, started and unfit P3 cards are skipped', () => {
  const p3 = (over) => issue({ priority: 4, ...over });
  assert.equal(skipReason(p3(), NOW, { tier: 'p3' }), null);
  assert.equal(skipReason(p3({ description: `${BODY}\n\nDECISION NEEDED: owner picks the copy.` }), NOW, { tier: 'p3' }), 'blocker-OWNER_DECISION_GATE');
  assert.equal(skipReason(p3({ description: `NO-DISPATCH: needs the owner first\n${BODY}` }), NOW, { tier: 'p3' }), 'no-dispatch-marker');
  assert.equal(skipReason(p3({ updatedAt: FRESH }), NOW, { tier: 'p3' }), 'recent-activity');
  assert.equal(skipReason(p3({ description: '## Acceptance criteria\nLooks right.' }), NOW, { tier: 'p3' }), 'no-safe-verify');
  assert.equal(skipReason(p3({ state: STARTED_STATE }), NOW, { tier: 'p3' }), 'state-started');
  assert.equal(skipReason(p3({ title: 'iOS: fix the tab bar' }), NOW, { tier: 'p3' }), 'ios-app-repo');
  // Tier membership: only priority 4 is P3, and P3 is not P2.
  assert.equal(skipReason(issue({ priority: 3 }), NOW, { tier: 'p3' }), 'not-p3');
  assert.equal(skipReason(issue({ priority: 0 }), NOW, { tier: 'p3' }), 'not-p3');
  assert.equal(skipReason(issue({ priority: 2 }), NOW, { tier: 'p3' }), 'not-p3');
  assert.equal(skipReason(p3(), NOW, { tier: 'p2' }), 'not-p2');
  assert.equal(isP3FallbackCandidate(issue({ priority: 3 }), NOW), false);
  // A parked P3 card stays parked; a stale machine-filed one is taken (BRO-5360).
  const parked = p3({ state: { name: 'Backlog', type: 'backlog' }, description: `PARKED: waiting on owner go-ahead\n\n${BODY}` });
  assert.equal(skipReason(parked, NOW, { tier: 'p3' }), 'parked-or-backlog');
  assert.equal(isP3FallbackCandidate(parked, NOW), false);
  const stale = new Date(NOW - AUTOMATION_PARK_STALE_MS - 60_000).toISOString();
  const autofix = p3({ identifier: 'BRO-2', state: { name: 'Backlog', type: 'backlog' }, updatedAt: stale, description: `PARKED: Auto-filed by digest-autofix; runAutofix dispatches via linear-next separately in the same pass.\n\n${BODY}` });
  assert.equal(skipReason(autofix, NOW, { tier: 'p3' }), null);
  const res = pickCloudCard([p3({ identifier: 'BRO-1', description: `${BODY}\n\nDECISION NEEDED: owner picks.` }), parked, autofix], { nowMs: NOW });
  assert.equal(res.pick.identifier, 'BRO-2');
  assert.equal(res.skippedP3['blocker-OWNER_DECISION_GATE'], 1);
  assert.equal(res.skippedP3['parked-or-backlog'], 1);
  // A P3 Todo card that only a comment VERIFY arms is still a prefetch candidate.
  assert.equal(isP3FallbackCandidate(p3({ description: '## Acceptance criteria\nLooks right.' }), NOW), true);
});

test('P3 fallback: START-NOW does not apply (fresh card waits, idle card is ordinary P3, not reported skipped)', () => {
  assert.equal(skipReason(startNowCard({ priority: 4 }), NOW, { tier: 'p3' }), 'recent-activity');
  const res = pickCloudCard([
    startNowCard({ identifier: 'BRO-70', priority: 4, updatedAt: OLD }),
    issue({ identifier: 'BRO-60', priority: 4 }),
    issue({ identifier: 'BRO-80', priority: 3 }),
  ], { nowMs: NOW });
  assert.equal(res.pick.identifier, 'BRO-80');
  assert.deepEqual(res.orderedP3.map((i) => i.identifier), ['BRO-60', 'BRO-70']);
  assert.deepEqual(res.startNowSkipped, {});
  assert.equal(pickCloudCard([startNowCard({ identifier: 'BRO-71', priority: 4 })], { nowMs: NOW }).startNowSkipped['BRO-71'], 'not-p0-p1');
});

test('P3 fallback: a refused P3 landing is resumable only with includeP3, ranked after P0/P1 and P2', () => {
  const p3 = startedCard({ priority: 4 });
  assert.equal(findResumeCard([p3], [landRef()], { nowMs: NOW, includeP2: true }), null);
  assert.equal(findResumeCard([p3], [landRef()], { nowMs: NOW, includeP3: true }).issue.identifier, 'BRO-100');
  // includeP3 alone does not admit P2.
  assert.equal(findResumeCard([startedCard({ priority: 3 })], [landRef()], { nowMs: NOW, includeP3: true }), null);
  assert.equal(resumableCardsByNumber([startedCard({ priority: 0 })], { includeP2: true, includeP3: true }).size, 0);
  const all = findResumeCandidates([
    p3, startedCard({ identifier: 'BRO-200', priority: 3 }), startedCard({ identifier: 'BRO-300', priority: 1 }),
  ], [landRef(), landRef({ ref: 'land/bro-200-x' }), landRef({ ref: 'land/bro-300-x' })], { nowMs: NOW, includeP2: true, includeP3: true });
  assert.deepEqual(all.map((c) => c.issue.identifier), ['BRO-300', 'BRO-200', 'BRO-100']);
});

test('P3 fallback: buildPickQueue orders P0/P1, P2, P3 (resumes first in each tier) and tags each entry', () => {
  const r = (identifier, priority) => ({ issue: issue({ identifier, priority }), ref: `land/${identifier.toLowerCase()}` });
  const q = buildPickQueue(
    [r('BRO-14', 4), r('BRO-13', 3), r('BRO-11', 1), r('BRO-19', 0)],
    { ordered: [issue({ identifier: 'BRO-21', priority: 2 })], orderedP2: [issue({ identifier: 'BRO-22', priority: 3 })], orderedP3: [issue({ identifier: 'BRO-23', priority: 4 })] },
  );
  assert.deepEqual(q.map((e) => [e.issue.identifier, e.tier, !!e.resume]), [
    ['BRO-11', TIER_P0P1, true], ['BRO-21', TIER_P0P1, false],
    ['BRO-13', TIER_P2, true], ['BRO-22', TIER_P2, false],
    ['BRO-14', TIER_P3, true], ['BRO-23', TIER_P3, false],
  ]);
  // A P3 resume is never in the P0/P1 block, so the history-check budget can't wave it through.
  assert.equal(q.filter((e) => mayTakeUnchecked(e)).some((e) => Number(e.issue.priority) === 4), false);
  assert.equal(mayTakeUnchecked({ tier: TIER_P3 }), false);
  assert.deepEqual(buildPickQueue([], {}), []);
});

test('P3 fallback: comments are read for P3 Todo and resumable P3 cards, never parked or In Review P3', () => {
  const { needsComments } = require('./cloud-worker-pick.js');
  assert.equal(needsComments(issue({ priority: 4, description: '## Acceptance criteria\nLooks right.' }), NOW), true);
  assert.equal(needsComments(startedCard({ priority: 4 }), NOW), true);
  assert.equal(needsComments(issue({ priority: 4, state: { name: 'In Review', type: 'started' } }), NOW), false);
  assert.equal(needsComments(issue({ priority: 4, state: { name: 'Backlog', type: 'backlog' }, description: `PARKED: waiting on owner go-ahead\n\n${BODY}` }), NOW), false);
  assert.equal(needsComments(issue({ priority: 4, state: { name: 'Backlog', type: 'backlog' } }), NOW), true);
  assert.equal(needsComments(issue({ priority: undefined }), NOW), false);
});

test('P3 fallback: model by pickLinearModel (Sonnet, Model: Opus honored, retry escalates)', () => {
  const opts = { nowMs: NOW, readEntries: () => [], env: {} };
  assert.equal(pickModel(issue({ priority: 4 }), opts).model, 'sonnet');
  assert.equal(pickModel(issue({ priority: 4, description: `${BODY}\n\nModel: Opus` }), opts).model, 'opus');
  assert.equal(pickModel(issue({ priority: 4, comments: { nodes: [report('paused', 'Ran out of time.', 60_000)] } }), opts).model, 'opus');
});

// BRO-5360: a pause report moves a card to Backlog; only the (dead) Mac drain moved it back.
const { isPausedBacklog, RECENT_PAUSE_URGENT_MS, MAX_PAUSES } = require('./cloud-worker-pick.js');
const BACKLOG = { name: 'Backlog', type: 'backlog' };

test('a paused Backlog card (no PARKED line) rejoins its tier; a PARKED line keeps it out', () => {
  const paused = issue({ state: BACKLOG });
  assert.equal(isPausedBacklog(paused), true);
  assert.equal(skipReason(paused, NOW), null);
  assert.equal(skipReason(issue({ state: BACKLOG, priority: 3 }), NOW, { tier: 'p2' }), null);
  assert.equal(skipReason(issue({ state: BACKLOG, priority: 4 }), NOW, { tier: 'p3' }), null);
  // Every other rule still applies.
  assert.equal(skipReason(issue({ state: BACKLOG, updatedAt: FRESH }), NOW), 'recent-activity');
  assert.equal(skipReason(issue({ state: BACKLOG, description: '## Acceptance criteria\nLooks right.' }), NOW), 'no-safe-verify');
  assert.equal(skipReason(issue({ state: BACKLOG, description: `${BODY}\n\nDECISION NEEDED: owner picks.` }), NOW), 'blocker-OWNER_DECISION_GATE');
  // Parked at filing or by a person: any PARKED line, owner hold or not, at any priority.
  for (const priority of [2, 3, 4]) {
    const tier = { 2: 'p0p1', 3: 'p2', 4: 'p3' }[priority];
    const held = issue({ state: BACKLOG, priority, description: `PARKED: waiting on owner go-ahead\n\n${BODY}` });
    assert.equal(isPausedBacklog(held), false);
    assert.equal(skipReason(held, NOW, { tier }), 'parked-or-backlog');
  }
  // A stale machine-filed P3 park is drained too, after the tier's other cards; a fresh one waits.
  const stale = new Date(NOW - AUTOMATION_PARK_STALE_MS - 60_000).toISOString();
  const autofix = issue({ identifier: 'BRO-3', state: BACKLOG, priority: 4, updatedAt: stale, description: `PARKED: Auto-filed by digest-autofix; x.\n\n${BODY}` });
  assert.equal(skipReason(autofix, NOW, { tier: 'p3' }), null);
  assert.equal(skipReason({ ...autofix, updatedAt: OLD }, NOW, { tier: 'p3' }), 'parked-or-backlog');
  assert.deepEqual(pickCloudCard([autofix, issue({ identifier: 'BRO-8', priority: 4 })], { nowMs: NOW }).orderedP3.map((i) => i.identifier), ['BRO-8', 'BRO-3']);
  // Todo and started cards are never "paused Backlog".
  assert.equal(isPausedBacklog(issue()), false);
  assert.equal(isPausedBacklog(issue({ state: STARTED_STATE })), false);
});

test('a paused Backlog card is never taken unchecked past the history budget', () => {
  assert.equal(mayTakeUnchecked({ issue: issue(), tier: TIER_P0P1 }), true);
  assert.equal(mayTakeUnchecked({ issue: issue({ state: BACKLOG }), tier: TIER_P0P1 }), false);
});

test('P0/P1 pauses cool down for RECENT_PAUSE_URGENT_MS, others for RECENT_PAUSE_MS', () => {
  const between = [report('paused', 'Ran out of time in this firing.', RECENT_PAUSE_URGENT_MS + 60_000)];
  assert.ok(RECENT_PAUSE_URGENT_MS < RECENT_PAUSE_MS);
  assert.equal(pausedHistorySkipReason(between, NOW, { priority: 1 }), null);
  assert.equal(pausedHistorySkipReason(between, NOW, { priority: 2 }), null);
  assert.equal(pausedHistorySkipReason(between, NOW, { priority: 3 }), 'recently-paused');
  assert.equal(pausedHistorySkipReason(between, NOW), 'recently-paused');
  const fresh = [report('paused', 'Ran out of time in this firing.', 60_000)];
  assert.equal(pausedHistorySkipReason(fresh, NOW, { priority: 2 }), 'recently-paused');
  // The owner-hold rule is unchanged for urgent cards.
  assert.equal(pausedHistorySkipReason([report('paused', 'DECISION NEEDED: owner picks.', RECENT_PAUSE_MS)], NOW, { priority: 2 }), 'awaiting-owner');
});

test(`after ${MAX_PAUSES} pauses with nobody answering, the card stays out until a person comments`, () => {
  const old = RECENT_PAUSE_MS + 60_000;
  const pauses = (n) => Array.from({ length: n }, (_, i) => report('paused', 'VERIFY times out.', old + i * 60_000));
  assert.equal(pausedHistorySkipReason(pauses(MAX_PAUSES - 1), NOW, { priority: 2 }), null);
  assert.equal(pausedHistorySkipReason(pauses(MAX_PAUSES), NOW, { priority: 2 }), 'paused-repeatedly');
  assert.equal(pausedHistorySkipReason(pauses(MAX_PAUSES), NOW, { priority: 3 }), 'paused-repeatedly');
  // A person's comment after the latest pause re-opens it.
  const answered = [...pauses(MAX_PAUSES), { body: 'Try the cached fixture instead.', createdAt: at(60_000) }];
  assert.equal(pausedHistorySkipReason(answered, NOW, { priority: 2 }), null);
  // A done report after the pauses ends the pause history.
  assert.equal(pausedHistorySkipReason([...pauses(MAX_PAUSES), report('done', 'Landed.', 60_000)], NOW, { priority: 2 }), null);
});

test('a paused Backlog card is taken only when a worker left a trace; one moved there by hand stays out', () => {
  const old = RECENT_PAUSE_MS + 60_000;
  const opts = { priority: 2, pausedBacklog: true };
  assert.equal(pausedHistorySkipReason([], NOW, opts), 'backlog-unexplained');
  assert.equal(pausedHistorySkipReason([{ body: 'Moving this aside for now.', createdAt: at(old) }], NOW, opts), 'backlog-unexplained');
  assert.equal(pausedHistorySkipReason([report('paused', 'Ran out of time.', old)], NOW, opts), null);
  assert.equal(pausedHistorySkipReason([report('blocked', 'Needs a fixture.', old)], NOW, opts), null);
  assert.equal(pausedHistorySkipReason([{ body: '## Codex runner: stopped mid-card\n\nBack to Todo.', createdAt: at(old) }], NOW, opts), null);
  assert.equal(pausedHistorySkipReason([{ body: '<!-- codex-runner-bounced -->\n## Codex runner: not landed', createdAt: at(old) }], NOW, opts), null);
  // A Todo card with no history is unaffected.
  assert.equal(pausedHistorySkipReason([], NOW, { priority: 2 }), null);
});

test('reclaim and Codex notes are machine comments; a reclaim to Backlog keeps the card out until a person answers', () => {
  const old = RECENT_PAUSE_MS + 60_000;
  const opts = { priority: 2, pausedBacklog: true };
  const reclaimTodo = { body: 'RECLAIMED-ABANDONED: 2026-10-10 (BRO-5100 hourly sweep)\n\nThis card sat In Progress...\nMoved back to Todo so the board workers can take it again.', createdAt: at(old - 10_000) };
  const reclaimBacklog = { body: 'RECLAIMED-ABANDONED: 2026-10-10 (BRO-5100 hourly sweep)\n\nThis card sat In Progress...\nIt has been reclaimed 3 times already, so it goes to Backlog instead of Todo: the sessions that take it keep dying.', createdAt: at(old - 20_000) };
  const pause = report('paused', 'DECISION NEEDED: owner picks the copy.', old);
  // Machine notes after an owner-held pause do not count as the owner's answer.
  for (const note of [reclaimTodo, { body: '<!-- codex-runner-bounced -->\n## Codex runner: not landed', createdAt: at(1000) }, { body: '## Codex runner: stopped mid-card', createdAt: at(1000) }]) {
    assert.equal(pausedHistorySkipReason([pause, note], NOW, opts), 'awaiting-owner', note.body.slice(0, 30));
  }
  // Reclaimed to Backlog after a pause: out, even past the cooldown.
  assert.equal(pausedHistorySkipReason([report('paused', 'Ran out of time.', old), reclaimBacklog], NOW, opts), 'reclaimed-to-backlog');
  assert.equal(pausedHistorySkipReason([reclaimBacklog], NOW, opts), 'backlog-unexplained');
  // A person's comment after the reclaim re-opens it; a worker report after it means someone took it on since.
  assert.equal(pausedHistorySkipReason([report('paused', 'Ran out of time.', old), reclaimBacklog, { body: 'Fixture is in place now, retry.', createdAt: at(old - 30_000) }], NOW, opts), null);
  assert.equal(pausedHistorySkipReason([reclaimBacklog, report('paused', 'Ran out of time.', old - 30_000)], NOW, opts), null);
  // On a Todo card the reclaim rule does not apply.
  assert.equal(pausedHistorySkipReason([report('paused', 'Ran out of time.', old), reclaimBacklog], NOW, { priority: 2 }), null);
});

// BRO-5369: technical session parks at the fallback tiers.
test('P2/P3 technical parks are taken, after Todo; "later" wording, owner holds and other gates keep them out', () => {
  const { isFallbackTechnicalPark } = require('./cloud-worker-pick.js');
  const drain = require('./linear-drain-parked.js');
  const BACKLOG = { name: 'Backlog', type: 'backlog' };
  const tech = (priority, reason = 'needs a rule-18 second-opinion before the edit', extra = '') =>
    issue({ identifier: `BRO-${priority}0`, priority, state: BACKLOG, description: `PARKED: ${reason}\n\n${BODY}${extra}` });
  assert.equal(skipReason(tech(3), NOW, { tier: 'p2' }), null);
  assert.equal(skipReason(tech(4), NOW, { tier: 'p3' }), null);
  assert.equal(isFallbackTechnicalPark(tech(3)), true);
  // Tier mismatch.
  assert.equal(skipReason(tech(3), NOW, { tier: 'p3' }), 'not-p3');
  // "Later" wording that TECHNICAL_PARK_RE alone would accept stays parked at P2/P3.
  for (const reason of ['low impact, small follow-up for next session', 'second-opinion: risky migration of prod data, irreversible', 'wait for next pass of cron to verify']) {
    assert.equal(skipReason(tech(3, reason), NOW, { tier: 'p2' }), 'parked-or-backlog', reason);
  }
  // Owner holds and other headless gates still refuse.
  assert.equal(skipReason(tech(3, 'waiting on owner go-ahead'), NOW, { tier: 'p2' }), 'parked-or-backlog');
  // Another headless gate on the card means it is not drainable at all (same as P0/P1): it stays parked.
  assert.equal(skipReason(tech(3, undefined, '\n\nDECISION NEEDED: owner picks.'), NOW, { tier: 'p2' }), 'parked-or-backlog');
  assert.equal(skipReason(tech(4, undefined, '\n\nRECHECK-AFTER: 2026-12-01'), NOW, { tier: 'p3' }), 'parked-or-backlog');
  // The Mac drain's default scope is unchanged: P0/P1 only.
  assert.equal(drain.isSessionParkedDrainable(tech(4)), false);
  assert.equal(drain.isSessionParkedDrainable(tech(4), { priorities: new Set([4]) }), true);
  assert.equal(drain.isSessionParkedDrainable(tech(2)), true);
  // Order within a fallback tier: Todo, then technical parks, then stale machine parks.
  const stale = new Date(NOW - AUTOMATION_PARK_STALE_MS - 60_000).toISOString();
  const machine = issue({ identifier: 'BRO-1', priority: 3, state: BACKLOG, updatedAt: stale, description: `PARKED: Auto-filed by digest-autofix; x.\n\n${BODY}` });
  const todo = issue({ identifier: 'BRO-999', priority: 3 });
  const techCard = issue({ identifier: 'BRO-5', priority: 3, state: BACKLOG, description: `PARKED: needs a worktree\n\n${BODY}` });
  assert.deepEqual(pickCloudCard([machine, techCard, todo], { nowMs: NOW }).orderedP2.map((i) => i.identifier), ['BRO-999', 'BRO-5', 'BRO-1']);
});

test('a Codex fix round carried to the next run skips the 6 h idle wait for Codex only (BRO-5384)', () => {
  const { swfCarryBody } = require('./codex-runner.js');
  const carry = { body: swfCarryBody({ attempt: 1, patch: 'diff --git a/x b/x\n', summary: 'findings' }), createdAt: FRESH };
  const carried = issue({ updatedAt: FRESH, comments: { nodes: [carry] } });
  assert.equal(skipReason(carried, NOW, { codex: true }), null);
  // The Claude lane keeps the wait, so it does not redo the card without Codex's carried change.
  assert.equal(skipReason(carried, NOW), 'recent-activity');
  assert.equal(pickCloudCard([carried], { nowMs: NOW }).pick, null);
  assert.equal(pickCloudCard([carried], { nowMs: NOW, codex: true }).pick.identifier, 'BRO-100');
  // Someone commented after the carry note: their activity counts again.
  const later = { body: 'I am looking at this', createdAt: new Date(NOW - 30_000).toISOString() };
  assert.equal(skipReason(issue({ updatedAt: FRESH, comments: { nodes: [carry, later] } }), NOW, { codex: true }), 'recent-activity');
  assert.equal(skipReason(issue({ updatedAt: FRESH, comments: { nodes: [{ body: '## Codex runner: not landed', createdAt: FRESH }] } }), NOW, { codex: true }), 'recent-activity');
});

test('a Codex retry note (BRO-6260) lifts an earlier bounce and skips the idle wait for Codex only', () => {
  const { retryBody, BOUNCED_MARKER } = require('./codex-runner.js');
  const bounce = { body: `${BOUNCED_MARKER}\n## Codex runner: not landed, left for the Claude worker\n\nREJECT`, createdAt: new Date(NOW - 3 * 24 * 3600_000).toISOString() };
  const retry = { body: retryBody({ findings: 'Add the test.' }), createdAt: FRESH };
  const card = issue({ updatedAt: FRESH, comments: { nodes: [bounce, retry] } });
  assert.equal(skipReason(card, NOW, { codex: true }), null);
  assert.equal(skipReason(card, NOW), 'recent-activity');
  assert.equal(pickCloudCard([card], { nowMs: NOW, codex: true }).pick.identifier, 'BRO-100');
});

test('leaveCodexCards: the Claude queue leaves one Codex firing of fit cards to Codex, never resumes, Urgent or unfit ones (BRO-5384)', () => {
  const { leaveCodexCards } = require('./cloud-worker-pick.js');
  const card = (n, over = {}) => issue({ identifier: `BRO-${n}`, title: `Parser drops field ${n}`, description: BODY, ...over });
  const q = (iss, tier = 'p0p1', extra = {}) => ({ issue: { comments: { nodes: [] }, ...iss }, tier, ...extra });
  const verifyOf = () => 'node --test scripts/lib/example.test.mjs';
  const queue = [
    q(card(1)), q(card(2, { priority: 1 })), q(card(3, { description: `Then edit .github/workflows/land.yml.\n${BODY}` })),
    q(card(4), 'p0p1', { resume: { ref: 'land/bro-4-x' } }), q(card(5)), q(card(6), 'p2-fallback'), q(card(7)),
  ];
  const { queue: claude, left } = leaveCodexCards(queue, { nowMs: NOW, verifyOf, cap: 2 });
  // Codex's order: tier first, so BRO-1, BRO-5, BRO-7 (P0/P1) before BRO-6 (P2); the cap keeps 2.
  assert.deepEqual(left, ['BRO-1', 'BRO-5']);
  assert.deepEqual(claude.map((x) => x.issue.identifier), ['BRO-2', 'BRO-3', 'BRO-4', 'BRO-6', 'BRO-7']);
  assert.deepEqual(leaveCodexCards(queue, { nowMs: NOW, verifyOf, cap: 0 }).left, []);
  assert.equal(leaveCodexCards(queue, { nowMs: NOW, verifyOf, cap: 9 }).left.length, 4, 'BRO-1, 5, 6, 7');
});

test('leaveCodexCards never leaves a card Codex would skip for its pause history or unread comments; the cap backfills (BRO-5407)', () => {
  const { leaveCodexCards, historySkipReason } = require('./cloud-worker-pick.js');
  const card = (n, over = {}) => issue({ identifier: `BRO-${n}`, title: `Parser drops field ${n}`, description: BODY, ...over });
  const q = (iss, nodes = []) => ({ issue: { comments: { nodes }, ...iss }, tier: 'p0p1' });
  const verifyOf = () => 'node --test scripts/lib/example.test.mjs';
  const pausedAgo = (ms) => [report('paused', 'Stopped half way.', ms)];
  const H = 3_600_000;
  // BRO-1: P1 (priority 2) paused 1h ago, inside the urgent cooldown: Codex skips it, so it stays.
  // BRO-2: P1 paused 30h ago, past RECENT_PAUSE_URGENT_MS: takeable, so it can be left.
  // BRO-3: P2 (priority 3) paused 30h ago, inside RECENT_PAUSE_MS: stays.
  // BRO-4: comments never read: stays with Claude (Codex would fetch them itself).
  const queue = [
    q(card(1), pausedAgo(H)), q(card(2), pausedAgo(30 * H)), q(card(3, { priority: 3 }), pausedAgo(30 * H)),
    { issue: card(4), tier: 'p0p1' }, q(card(5)), q(card(6)),
  ];
  assert.ok(RECENT_PAUSE_URGENT_MS < 30 * H && RECENT_PAUSE_MS > 30 * H, 'fixture assumes 24h urgent / 72h normal cooldowns');
  assert.equal(historySkipReason(queue[0].issue, queue[0].issue.comments.nodes, NOW), 'recently-paused');
  assert.equal(historySkipReason(queue[1].issue, queue[1].issue.comments.nodes, NOW), null);
  const { queue: claude, left } = leaveCodexCards(queue, { nowMs: NOW, verifyOf, cap: 2 });
  assert.deepEqual(left, ['BRO-2', 'BRO-5'], 'cap backfills past the history-blocked BRO-1');
  assert.deepEqual(claude.map((x) => x.issue.identifier), ['BRO-1', 'BRO-3', 'BRO-4', 'BRO-6']);
  assert.deepEqual(leaveCodexCards(queue, { nowMs: NOW, verifyOf, cap: 9 }).left, ['BRO-2', 'BRO-5', 'BRO-6']);
});

test('a card whose newest RECHECK-AFTER date is ahead waits for the recheck (BRO-5384)', () => {
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const ahead = day(NOW + 3 * 86_400_000);
  const past = day(NOW - 2 * 86_400_000);
  const paused = report('paused', `Landed; holds after a day of runs.\nRECHECK-AFTER: ${ahead}`, 8 * RECENT_PAUSE_MS);
  assert.equal(pausedHistorySkipReason([paused], NOW), 'recheck-pending');
  // A stamp in an Outcome or triage comment counts the same as one in the session report.
  assert.equal(pausedHistorySkipReason([{ body: `## Outcome\nRECHECK-AFTER ${ahead}`, createdAt: at(1000) }], NOW), 'recheck-pending');
  // The newest stamp wins: an older future date is superseded by a newer past one.
  const older = { body: `RECHECK-AFTER: ${ahead}`, createdAt: at(10 * RECENT_PAUSE_MS) };
  assert.equal(pausedHistorySkipReason([older, report('paused', `RECHECK-AFTER: ${past}`, 9 * RECENT_PAUSE_MS)], NOW), null);
  // Machine notes after the stamp (a Codex bounce) keep the hold; a person's comment releases it.
  const bounce = { body: '<!-- codex-runner-bounced -->\n## Codex runner: not landed', createdAt: at(5 * RECENT_PAUSE_MS) };
  assert.equal(pausedHistorySkipReason([paused, bounce], NOW), 'recheck-pending');
  const human = { body: 'Checked by hand, the fix holds; close it.', createdAt: at(2 * RECENT_PAUSE_MS) };
  assert.equal(pausedHistorySkipReason([paused, bounce, human], NOW), null);
  // From midnight UTC of the stamped day the card is pickable.
  assert.equal(pausedHistorySkipReason([report('paused', `RECHECK-AFTER: ${day(NOW)}`, 8 * RECENT_PAUSE_MS)], NOW), null);
});

test('opusClaimEntries: only "Worker model: opus" claim comments become Opus launch rows (BRO-5730)', () => {
  const { opusClaimEntries } = require('./cloud-worker-pick.js');
  const rows = opusClaimEntries([
    { body: 'Claimed by cloud session x\nWorker model: opus', createdAt: FRESH, issue: { identifier: 'BRO-7' } },
    { body: 'Claimed by cloud session y\nWorker model: sonnet', createdAt: FRESH, issue: { identifier: 'BRO-8' } },
    { body: 'quoting Worker model: opus mid-line', createdAt: FRESH, issue: { identifier: 'BRO-9' } },
    { body: 'Worker model: opus', createdAt: FRESH, issue: null },
  ]);
  assert.deepEqual(rows, [{ event: 'launch', source: 'cloud-claim', taskId: 'linear:BRO-7', model: 'opus', ts: FRESH }]);
  assert.deepEqual(opusClaimEntries(null), []);
});

test('modelPicker: Opus cards stay Opus however many cloud Opus claims exist; no cap note (BRO-6502)', () => {
  const { modelPicker } = require('./cloud-worker-pick.js');
  const opusCard = issue({ identifier: 'BRO-555', priority: 2, description: `${BODY}\n\nModel: Opus` });
  const m = modelPicker()(opusCard);
  assert.equal(m.model, 'opus');
  assert.doesNotMatch(m.reason, /cap/i);
});

test('noDispatchHold: a NO-DISPATCH line in the description holds the card; a quoting comment or a lifted line does not (BRO-6502)', () => {
  const { noDispatchHold } = require('./cloud-worker-pick.js');
  assert.equal(noDispatchHold(issue({ description: `${BODY}\n\nNO-DISPATCH: coordinator freeze until 2026-10-30` })), 'no-dispatch-marker');
  assert.equal(noDispatchHold(issue({ description: `${BODY}\n\n- **NO-DISPATCH**: frozen` })), 'no-dispatch-marker');
  assert.equal(noDispatchHold(issue({ description: BODY, comments: { nodes: [{ body: 'NO-DISPATCH: quoted' }] } })), null);
  assert.equal(noDispatchHold(issue({ description: `${BODY} mentions NO-DISPATCH: mid-sentence` })), null);
  assert.equal(noDispatchHold(null), null);
});

test('withCloudOpusClaims: a claim within the hour of a ledger launch of the card is not counted twice (BRO-5730)', () => {
  const { withCloudOpusClaims } = require('./cloud-worker-pick.js');
  const ledger = [{ event: 'launch', taskId: 'linear:BRO-1', model: 'opus', ts: '2026-10-20T10:00:00Z' }];
  const claims = [
    { event: 'launch', taskId: 'linear:BRO-1', model: 'opus', ts: '2026-10-20T10:05:00Z' },
    { event: 'launch', taskId: 'linear:BRO-2', model: 'opus', ts: '2026-10-20T10:05:00Z' },
    { event: 'launch', taskId: 'linear:BRO-1', model: 'opus', ts: '2026-10-20T15:00:00Z' },
  ];
  const out = withCloudOpusClaims(ledger, claims);
  assert.deepEqual(out.map((e) => `${e.taskId}@${e.ts}`), ['linear:BRO-1@2026-10-20T10:00:00Z', 'linear:BRO-2@2026-10-20T10:05:00Z', 'linear:BRO-1@2026-10-20T15:00:00Z']);
  assert.equal(withCloudOpusClaims(null, null).length, 0);
});

test('cloud claim rows count toward the Opus usage count but not as prior launches of the card (BRO-5730)', () => {
  const { withCloudOpusClaims, opusClaimEntries } = require('./cloud-worker-pick.js');
  const { countPriorLaunches, countRecentLinearOpusLaunches } = require('./bsc-next-model.js');
  const now = Date.parse('2026-10-20T16:00:00Z');
  const claims = opusClaimEntries([{ body: 'Worker model: opus', createdAt: '2026-10-20T12:00:00Z', issue: { identifier: 'BRO-7' } }]);
  const ledger = [
    { event: 'launch', taskId: 'linear:BRO-1', model: 'opus', ts: '2026-10-20T10:00:00Z' },
    { event: 'launch', taskId: 'linear:BRO-1', model: 'opus', ts: '2026-10-20T15:00:00Z' },
  ];
  const macClaims = [
    { event: 'launch', source: 'cloud-claim', taskId: 'linear:BRO-1', model: 'opus', ts: '2026-10-20T10:05:00Z' },
    { event: 'launch', source: 'cloud-claim', taskId: 'linear:BRO-1', model: 'opus', ts: '2026-10-20T15:05:00Z' },
  ];
  const merged = withCloudOpusClaims(ledger, [...claims, ...macClaims]);
  assert.equal(countRecentLinearOpusLaunches(merged, now), 3);
  assert.equal(countPriorLaunches(merged, 'linear:BRO-7'), 0);
  assert.equal(countPriorLaunches(merged, 'linear:BRO-1'), 2);
});

// BRO-6080: a card filed for the Mac (label or MAC-ONLY line) is skipped by every
// cloud lane and taken by the Mac's parked drain.
test('BRO-6080: a mac-only card is skipped by the cloud picker and selected by the Mac drain', () => {
  const drain = require('./linear-drain-parked.js');
  const VERIFY_BODY = `${BODY}\n\nVERIFY: \`node --test scripts/lib/example.test.mjs\``;
  const byLabel = issue({ identifier: 'BRO-6100', description: VERIFY_BODY, labels: { nodes: [{ name: 'mac-only' }] } });
  const byLine = issue({ identifier: 'BRO-6101', priority: 4, description: `MAC-ONLY: needs the Mac's launchd agent\n\n${VERIFY_BODY}` });
  const plain = issue({ identifier: 'BRO-6102', description: VERIFY_BODY });
  for (const card of [byLabel, byLine]) {
    assert.equal(skipReason(card, NOW), Number(card.priority) === 4 ? 'not-p0-p1' : 'mac-only');
    assert.equal(skipReason(card, NOW, { tier: 'p3' }), Number(card.priority) === 4 ? 'mac-only' : 'not-p3');
    assert.equal(skipReason(card, NOW, { codex: true }), Number(card.priority) === 4 ? 'not-p0-p1' : 'mac-only');
  }
  const { pick, orderedP3 } = pickCloudCard([byLabel, byLine], { nowMs: NOW });
  assert.equal(pick, null);
  assert.deepEqual(orderedP3, []);
  assert.equal(pickCloudCard([byLabel, plain], { nowMs: NOW }).pick.identifier, 'BRO-6102');
  // The Mac drain takes the card --mac-only filed (MAC-ONLY line; any triaged priority,
  // no idle wait), headless on the Mac. A label alone may mean hands-on GUI work: the
  // cloud leaves it, and so does the unattended drain.
  const fresh = (c) => ({ ...c, updatedAt: FRESH });
  const filed = { ...byLine, labels: { nodes: [{ name: 'mac-only' }] } };
  assert.deepEqual(drain.selectDrainCandidates([fresh(filed), fresh(byLabel), fresh(plain)]).map((i) => i.identifier), ['BRO-6101']);
  assert.deepEqual(drain.drainDispatchOpts(filed), { macHeadless: true });
  // Not unparked for the cloud either.
  const parked = { ...byLabel, state: { type: 'backlog' }, description: `PARKED: needs a rule-18 review first\n\n${VERIFY_BODY}` };
  assert.equal(drain.unparkSkipReason(parked), 'mac-only');
});

test('BRO-6080: a START-NOW mac-only card is refused at filing with a hint', () => {
  const { startNowUnpickableReason } = require('./cloud-worker-pick.js');
  const r = startNowUnpickableReason({ title: 'x', description: `START-NOW: go\nMAC-ONLY: needs the Mac keychain\n${BODY}`, priority: 2, mode: 'dispatch' });
  assert.equal(r.reason, 'mac-only');
  assert.match(r.hint, /Mac drain/);
});

// BRO-6262: digest-autofix's daily notes refresh is the filer's, not an owner answer.
// The body below is the real shape found on BRO-5489 (starts "## Problem\nThe daily health check ...").
const { laneUnworkableReason, LANE_UNWORKABLE_MAX_MS } = require('./cloud-worker-pick.js');
const { FILER_REFRESH_MARKER, isFilerRefreshComment } = require('./filer-refresh-marker.js');
const REFRESH_BODY = '## Problem\nThe daily health check (`node scripts/health-check.js`) reports "Review gaps" on 10 shows:\n- Review gap ...';

test('BRO-6262: a filer notes-refresh (marked or legacy) does not count as an answer to a pause', () => {
  const D = 24 * 3600_000;
  for (const body of [`${FILER_REFRESH_MARKER}\n${REFRESH_BODY}`, REFRESH_BODY]) {
    assert.equal(isMachineComment(body), true);
    // Three pauses, the filer refreshing after each: still out of the pick.
    const comments = [
      report('paused', 'x', 9 * D), { body, createdAt: at(8.5 * D) },
      report('paused', 'x', 6 * D), { body, createdAt: at(5.5 * D) },
      report('paused', 'x', 4 * D), { body, createdAt: at(3.5 * D) },
    ];
    assert.equal(pausedHistorySkipReason(comments, NOW), 'paused-repeatedly');
  }
  // A person's own structured "## Problem" note is NOT the filer.
  assert.equal(isFilerRefreshComment('## Problem\nI found that the cron skips Sundays'), false);
  assert.equal(isMachineComment('## Problem\nI found that the cron skips Sundays'), false);
});

test('BRO-6262: a pause that says the cloud lane cannot do the work keeps the card out until a person comments or 14d pass', () => {
  const D = 24 * 3600_000;
  const lane = report('paused', 'Not workable from the cloud lane: data/review-texts is not attached.', 5 * D);
  assert.equal(laneUnworkableReason(lane.body), true);
  assert.equal(pausedHistorySkipReason([lane], NOW, { cloudLane: true }), 'lane-unworkable');
  // The Codex runner links review-texts: it never skips on this reason.
  assert.equal(pausedHistorySkipReason([lane], NOW), null);
  assert.equal(pausedHistorySkipReason([lane, { body: FILER_REFRESH_MARKER + '\n' + REFRESH_BODY, createdAt: at(1 * D) }], NOW, { cloudLane: true }), 'lane-unworkable');
  // A person answered after the pause: back to the normal idle rule.
  assert.equal(pausedHistorySkipReason([lane, { body: 'attached it, go', createdAt: at(1 * D) }], NOW, { cloudLane: true }), null);
  // Old enough that the lane may have changed.
  const old = report('paused', 'not workable from the cloud lane', LANE_UNWORKABLE_MAX_MS + D);
  assert.equal(pausedHistorySkipReason([old], NOW, { cloudLane: true }), null);
  // A report that only mentions review-texts in passing is not lane-unworkable.
  assert.equal(laneUnworkableReason('Fixed; verified with cloud-run-script --review-texts audit.'), false);
});

test('BRO-6262: digest-autofix posts its notes refresh with the marker the picker reads as machine output', () => {
  const src = fs.readFileSync(new URL('./digest-autofix.js', import.meta.url), 'utf8');
  assert.match(src, /'--comment', `\$\{FILER_REFRESH_MARKER\}\\n\$\{notes\}`/);
});
