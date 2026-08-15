import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  selectRecheckTargets, summarize, shouldExitShadow, describeResult, SHADOW_EXIT,
} = require('./autonomous-recheck-core.js');

const launch = (over = {}) => ({
  event: 'launch', taskId: '1', notionId: 'card-1', subject: 'Fix the thing',
  verifyCmd: 'node --test tests/unit/a.test.mjs', verifyReason: null, ts: '2026-07-24T00:00:00Z', ...over,
});
const done = (over = {}) => ({ id: 'card-1', name: 'Fix the thing', status: 'Done', ageDays: 0.5, ...over });

test('selects a recently-Done card that has a captured verify command', () => {
  const out = selectRecheckTargets({ doneCards: [done()], launchEntries: [launch()] });
  assert.deepEqual(out, [{ cardId: 'card-1', name: 'Fix the thing', verifyCmd: 'node --test tests/unit/a.test.mjs', reason: null, skip: null }]);
});

test('a card Done longer ago than the window is left alone', () => {
  assert.deepEqual(selectRecheckTargets({ doneCards: [done({ ageDays: 3 })], launchEntries: [launch()] }), []);
  assert.equal(selectRecheckTargets({ doneCards: [done({ ageDays: 3 })], launchEntries: [launch()], windowHours: 96 }).length, 1);
});

test('a card that never went through the dispatcher is not invented work', () => {
  assert.deepEqual(selectRecheckTargets({ doneCards: [done({ id: 'other' })], launchEntries: [launch()] }), []);
});

// The honest branch: prose acceptance criteria means the recheck REPORTS
// "no way to check this automatically", it never guesses a command.
test('a launch with no verifyCmd is reported as not machine-verifiable, with the captured reason', () => {
  const out = selectRecheckTargets({
    doneCards: [done()],
    launchEntries: [launch({ verifyCmd: null, verifyReason: 'acceptance criteria names no runnable command (prose only)' })],
  });
  assert.equal(out[0].verifyCmd, null);
  assert.match(out[0].reason, /prose only/);
});

test('a card someone is actively working right now is skipped, not re-checked', () => {
  const out = selectRecheckTargets({ doneCards: [done()], launchEntries: [launch()], isClaimed: id => id === 'card-1' });
  assert.equal(out[0].skip, 'someone is working this card right now');
  assert.equal(out[0].verifyCmd, null);
});

test('the LATEST dispatch of a card wins (a re-dispatch may change the command)', () => {
  const out = selectRecheckTargets({
    doneCards: [done()],
    launchEntries: [
      launch({ ts: '2026-07-20T00:00:00Z', verifyCmd: 'npx tsc --noEmit' }),
      launch({ ts: '2026-07-24T00:00:00Z', verifyCmd: 'npx next lint' }),
    ],
  });
  assert.equal(out[0].verifyCmd, 'npx next lint');
});

test('non-launch ledger events are ignored', () => {
  const out = selectRecheckTargets({
    doneCards: [done()],
    launchEntries: [{ event: 'dead', notionId: 'card-1', taskId: '1' }],
  });
  assert.deepEqual(out, []);
});

test('summarize counts each outcome class', () => {
  assert.deepEqual(
    summarize([{ status: 'pass' }, { status: 'fail' }, { status: 'unverifiable' }, { skip: 'x' }, { status: 'pass' }]),
    { pass: 2, fail: 1, unverifiable: 1, skipped: 1, noCriteria: 0 });
});

test('summarize carries the drop tally so a dropped class can never be zero-trace', () => {
  assert.deepEqual(
    summarize([{ status: 'pass' }], { noCriteria: 7 }),
    { pass: 1, fail: 0, unverifiable: 0, skipped: 0, noCriteria: 7 });
  assert.equal(summarize([], { noCriteria: 'nonsense' }).noCriteria, 0, 'garbage is 0, never NaN');
});

// ── Shadow exit (S3-T5): objective, and a single false reopen resets it ─────

test('shadow exit needs all three conditions', () => {
  assert.equal(shouldExitShadow({ days: 7, rechecks: 10, falsePositives: 0 }), true);
  assert.equal(shouldExitShadow({ days: 6, rechecks: 10, falsePositives: 0 }), false, 'not enough days');
  assert.equal(shouldExitShadow({ days: 7, rechecks: 9, falsePositives: 0 }), false, 'not enough rechecks');
  assert.equal(shouldExitShadow({ days: 30, rechecks: 100, falsePositives: 1 }), false, 'one false positive blocks it');
});

test('shadow exit refuses to judge on missing numbers', () => {
  assert.equal(shouldExitShadow({}), false);
  assert.equal(shouldExitShadow({ days: 7, rechecks: 10 }), false);
  assert.equal(shouldExitShadow(), false);
});

test('the bar is the documented one', () => {
  assert.deepEqual(SHADOW_EXIT, { minDays: 7, minRechecks: 10, maxFalsePositives: 0 });
});

test('describeResult speaks plainly, with no commands or ids', () => {
  assert.equal(describeResult({ name: 'Fix X', status: 'pass' }), 'Fix X: still works');
  assert.equal(describeResult({ name: 'Fix X', status: 'fail' }), 'Fix X: its own check does not pass any more');
  assert.equal(describeResult({ name: 'Fix X', status: 'unverifiable' }), 'Fix X: no way to check this automatically');
  assert.match(describeResult({ name: 'Fix X', skip: 'someone is working this card right now' }), /^Fix X: skipped, /);
});

// ── done-time selection (2026-07-26 incident) ───────────────────────────────
// The recheck matched 0 targets every night since it shipped — primary cause
// was the Priority-sorted Done listing (fixed via notion-brain --sort edited);
// selection now also keys on explicit completion stamps (completedDate /
// lastEditedAt) instead of the derived ageDays proxy, with ageDays only as a
// fallback when neither stamp exists.
const NOW = Date.parse('2026-07-26T12:00:00Z');
const { doneWithinWindow } = require('./autonomous-recheck-core.js');

test('an OLD card completed last night is selected (the 2026-07-26 miss)', () => {
  const card = done({ ageDays: 2.5, completedDate: '2026-07-26', lastEditedAt: '2026-07-26T05:51:00.000Z' });
  const out = selectRecheckTargets({ doneCards: [card], launchEntries: [launch()], now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].verifyCmd, 'node --test tests/unit/a.test.mjs');
});

test('a card completed outside the window is left alone even if edited recently is false', () => {
  const card = done({ ageDays: 9, completedDate: '2026-07-20', lastEditedAt: '2026-07-20T10:00:00.000Z' });
  assert.deepEqual(selectRecheckTargets({ doneCards: [card], launchEntries: [launch()], now: NOW }), []);
  assert.equal(selectRecheckTargets({ doneCards: [card], launchEntries: [launch()], now: NOW, windowHours: 24 * 7 }).length, 1);
});

test('freshest completion stamp decides: stale completedDate but a fresh Done-flip edit still qualifies', () => {
  const card = done({ ageDays: 5, completedDate: '2026-07-20', lastEditedAt: '2026-07-26T05:00:00.000Z' });
  assert.equal(selectRecheckTargets({ doneCards: [card], launchEntries: [launch()], now: NOW }).length, 1);
});

test('no completion stamps at all: falls back to creation age, still requiring a real number', () => {
  assert.equal(doneWithinWindow({ ageDays: 0.5 }, 24, NOW), true);
  assert.equal(doneWithinWindow({ ageDays: 3 }, 24, NOW), false);
  assert.equal(doneWithinWindow({ ageDays: null }, 24, NOW), false);
  assert.equal(doneWithinWindow({}, 24, NOW), false);
});

test('garbage timestamps do not crash and do not qualify', () => {
  assert.equal(doneWithinWindow({ completedDate: 'not-a-date', lastEditedAt: 'nope' }, 24, NOW), false);
});

// ── RECHECK-AFTER stamp (task #695): deferred-effect fixes ─────────────────

const { parseRecheckAfter } = require('./autonomous-recheck-core.js');

test('parseRecheckAfter reads the stamp, case-insensitively, ignoring garbage', () => {
  assert.equal(parseRecheckAfter('RECHECK-AFTER: 2026-08-08'), Date.parse('2026-08-08T00:00:00Z'));
  assert.equal(parseRecheckAfter('recheck-after: 2026-08-08\nmore notes'), Date.parse('2026-08-08T00:00:00Z'));
  assert.equal(parseRecheckAfter('no stamp here'), null);
  assert.equal(parseRecheckAfter(''), null);
  assert.equal(parseRecheckAfter(null), null);
});

test('a RECHECK-AFTER stamp overrides the generic window entirely', () => {
  const future = { notes: 'RECHECK-AFTER: 2026-08-08', status: 'Paused' };
  assert.equal(doneWithinWindow(future, 24, Date.parse('2026-08-07T23:00:00Z')), false, 'not due yet');
  assert.equal(doneWithinWindow(future, 24, Date.parse('2026-08-08T00:00:00Z')), true, 'due the instant the day starts');
  assert.equal(doneWithinWindow(future, 24, Date.parse('2026-09-01T00:00:00Z')), true, 'stays due after, like the window does');
});

test('a Paused card with no RECHECK-AFTER stamp is never window-eligible', () => {
  const paused = { status: 'Paused', ageDays: 0.1, completedDate: null, lastEditedAt: new Date(NOW).toISOString() };
  assert.equal(doneWithinWindow(paused, 24, NOW), false);
});

test('a stamp written into OUTCOME only still arms the recheck (the 3-of-5-cards gap)', () => {
  const card = { status: 'Paused', notes: 'acceptance prose only', outcome: 'RECHECK-AFTER: 2026-08-08\nolder text' };
  assert.equal(doneWithinWindow(card, 24, Date.parse('2026-08-07T23:00:00Z')), false, 'not due yet');
  assert.equal(doneWithinWindow(card, 24, Date.parse('2026-08-08T00:00:00Z')), true, 'due off the outcome stamp');
});

test('when notes and outcome both carry a stamp, notes wins', () => {
  const card = { status: 'Paused', notes: 'RECHECK-AFTER: 2026-08-10', outcome: 'RECHECK-AFTER: 2026-08-01' };
  assert.equal(doneWithinWindow(card, 24, Date.parse('2026-08-05T00:00:00Z')), false, 'outcome stamp alone must not make it due');
  assert.equal(doneWithinWindow(card, 24, Date.parse('2026-08-10T00:00:00Z')), true);
});

test('null/missing outcome is safe', () => {
  assert.equal(doneWithinWindow({ status: 'Paused', notes: 'no stamp', outcome: null }, 24, NOW), false);
  assert.equal(doneWithinWindow({ status: 'Paused', notes: 'no stamp' }, 24, NOW), false);
});

test('selectRecheckTargets: Done cards with a RECHECK-AFTER stamp and no dispatch record still surface via the card notes fallback', () => {
  const card = {
    id: 'card-2', name: 'Scraping spend within thresholds', status: 'Paused',
    notes: 'RECHECK-AFTER: 2026-08-08\n\n## Acceptance criteria\n`node --test scripts/verify-provider-spend-streak.test.mjs` passes',
  };
  const now = Date.parse('2026-08-08T06:00:00Z');
  const out = selectRecheckTargets({ doneCards: [card], launchEntries: [], now });
  assert.deepEqual(out, [{
    cardId: 'card-2', name: 'Scraping spend within thresholds',
    verifyCmd: 'node --test scripts/verify-provider-spend-streak.test.mjs', reason: null, skip: null,
  }]);
});

// ── Coverage fallback (task #695): human-dispatched Done cards ─────────────

test('selectRecheckTargets: a Done card never dispatched through bsc-next is still recheckable via its own notes', () => {
  const card = {
    id: 'human-card', name: 'Manual fix', status: 'Done', ageDays: 0.2,
    notes: '## Acceptance criteria\n`npx tsc --noEmit` passes',
  };
  const out = selectRecheckTargets({ doneCards: [card], launchEntries: [], now: NOW });
  assert.deepEqual(out, [{ cardId: 'human-card', name: 'Manual fix', verifyCmd: 'npx tsc --noEmit', reason: null, skip: null }]);
});

test('selectRecheckTargets: a Done card with no dispatch record AND no runnable notes command is still not invented work', () => {
  const card = { id: 'no-cmd', name: 'Prose-only fix', status: 'Done', ageDays: 0.2, notes: 'this was fixed, trust me' };
  assert.deepEqual(selectRecheckTargets({ doneCards: [card], launchEntries: [], now: NOW }), []);
});

test('selectRecheckTargets: the fallback path still respects isClaimed', () => {
  const card = {
    id: 'claimed-card', name: 'In-flight fix', status: 'Done', ageDays: 0.2,
    notes: '## Acceptance criteria\n`npx tsc --noEmit` passes',
  };
  const out = selectRecheckTargets({
    doneCards: [card], launchEntries: [], now: NOW, isClaimed: (id) => id === 'claimed-card',
  });
  assert.deepEqual(out, [{ cardId: 'claimed-card', name: 'In-flight fix', verifyCmd: null, reason: null, skip: 'someone is working this card right now' }]);
});

test('selectRecheckTargets: a dispatch-ledger launch entry still takes priority over the notes fallback', () => {
  const card = {
    id: 'card-1', name: 'Fix the thing', status: 'Done', ageDays: 0.2,
    notes: '## Acceptance criteria\n`npx next lint` passes',
  };
  const out = selectRecheckTargets({ doneCards: [card], launchEntries: [launch()], now: NOW });
  assert.equal(out[0].verifyCmd, 'node --test tests/unit/a.test.mjs');
});

// ── Starvation guard (Codex ship-check finding, task #695) ─────────────────
// A RECHECK-AFTER stamp stays due forever once its date passes; with a fixed
// run limit downstream (the CLI's .slice(0, limit)) the same permanently-due
// cards would win the slot every single night, starving any card newly due
// after the limit fills. Never-yet-rechecked cards must sort first; among
// already-rechecked cards, the longest-neglected goes next.

test('selectRecheckTargets: a never-rechecked card sorts before an already-rechecked one, regardless of doneCards order', () => {
  const stale = { id: 'stale-card', name: 'Rechecked ages ago', status: 'Paused', notes: 'RECHECK-AFTER: 2026-01-01' };
  const fresh = { id: 'fresh-card', name: 'Never rechecked yet', status: 'Paused', notes: 'RECHECK-AFTER: 2026-01-01' };
  const out = selectRecheckTargets({
    doneCards: [stale, fresh], // stale listed FIRST — sort must still put fresh first
    launchEntries: [launch({ notionId: 'stale-card' }), launch({ notionId: 'fresh-card' })],
    now: Date.parse('2026-06-01T00:00:00Z'),
    lastRecheckedAt: (id) => (id === 'stale-card' ? Date.parse('2026-05-01T00:00:00Z') : null),
  });
  assert.deepEqual(out.map(t => t.cardId), ['fresh-card', 'stale-card']);
});

test('selectRecheckTargets: among already-rechecked cards, the longest-neglected sorts first', () => {
  const recentlyChecked = { id: 'recent-card', name: 'Checked yesterday', status: 'Paused', notes: 'RECHECK-AFTER: 2026-01-01' };
  const longNeglected = { id: 'old-card', name: 'Checked a month ago', status: 'Paused', notes: 'RECHECK-AFTER: 2026-01-01' };
  const now = Date.parse('2026-06-01T00:00:00Z');
  const out = selectRecheckTargets({
    doneCards: [recentlyChecked, longNeglected],
    launchEntries: [launch({ notionId: 'recent-card' }), launch({ notionId: 'old-card' })],
    now,
    lastRecheckedAt: (id) => (id === 'recent-card' ? now - 24 * 3600 * 1000 : now - 30 * 24 * 3600 * 1000),
  });
  assert.deepEqual(out.map(t => t.cardId), ['old-card', 'recent-card']);
});

// ── Truncated notes (2026-08-14): the defect that disabled the whole thing ──
//
// notion-brain caps a card property at 1800 chars and puts the tail in the
// page body. `## Acceptance criteria` is written LAST on this repo's cards,
// so on a long card it is exactly what falls past the cut — and `list
// --include-notes`, which this recheck reads, returns the raw preview. The
// recheck saw prose, found no command, and dropped the card without a word.
// 14 of 18 RECHECK-AFTER-stamped cards on the live board were in this state.

const { needsOverflowHydration, verifiabilityForCard } = require('./autonomous-recheck-core.js');
// Imported, never re-declared: a local copy of the marker here would be the
// very duplicate overflow-marker.js exists to eliminate, and this fixture
// would then keep "passing" against a string the writer no longer emits.
const { OVERFLOW_NOTE } = require('./overflow-marker.js');
const CRITERIA = '\n\n## Acceptance criteria\n`node --test scripts/lib/thing.test.mjs` passes';
// What the card really says: a stamp, a long body, then the criteria at the end.
const FULL_NOTES = `RECHECK-AFTER: 2026-08-08\n\n## Problem\n${'context. '.repeat(250)}${CRITERIA}`;
// What `list --include-notes` hands back: the first 1800 chars plus a marker.
// The stamp survives (notion-brain hoists it to the front on write); the
// criteria do not.
const TRUNCATED_NOTES = FULL_NOTES.slice(0, 1740) + OVERFLOW_NOTE;

const truncatedCard = () => ({ id: 'trunc-card', name: 'Deferred-effect fix', status: 'Paused', notes: TRUNCATED_NOTES });
const DUE = Date.parse('2026-08-09T00:00:00Z');

test('the fixture is the real shape: stamp survives truncation, acceptance criteria do not', () => {
  assert.ok(FULL_NOTES.length > 1800, 'the criteria genuinely sit past the property cap');
  assert.ok(TRUNCATED_NOTES.includes('RECHECK-AFTER: 2026-08-08'));
  assert.ok(!TRUNCATED_NOTES.includes('## Acceptance criteria'));
});

test('a stamped card whose notes are a truncated preview is flagged for re-reading through `get`', () => {
  assert.equal(needsOverflowHydration(truncatedCard()), true);
  assert.equal(needsOverflowHydration({ ...truncatedCard(), notes: FULL_NOTES }), false, 'complete notes need no second fetch');
  assert.equal(needsOverflowHydration({ id: 'x', notes: 'long prose' + OVERFLOW_NOTE }), false,
    'an unstamped long card is NOT worth a per-card fetch — that is the cost this bound exists to avoid');
  assert.equal(needsOverflowHydration({ id: 'x', outcome: 'RECHECK-AFTER: 2026-08-08' + OVERFLOW_NOTE }), true,
    'the overflow can be in outcome too');
  assert.equal(needsOverflowHydration(null), false);
});

test('THE FIX: a card whose acceptance criteria sit past 1800 chars yields a runnable command once hydrated', () => {
  // Before hydration: no command anywhere in the preview.
  const beforeHydration = selectRecheckTargets({ doneCards: [truncatedCard()], launchEntries: [], now: DUE });
  assert.equal(beforeHydration[0].verifyCmd, null);

  // After hydration (what autonomous-acceptance-recheck.js's hydrateOverflowCards
  // does: re-read the card through notion-brain `get`, which stitches the page
  // body back) the very same card is runnable.
  const hydrated = { ...truncatedCard(), notes: FULL_NOTES };
  const out = selectRecheckTargets({ doneCards: [hydrated], launchEntries: [], now: DUE });
  assert.deepEqual(out, [{
    cardId: 'trunc-card', name: 'Deferred-effect fix',
    verifyCmd: 'node --test scripts/lib/thing.test.mjs', reason: null, skip: null,
  }]);
});

// ── The silent drop, ended ────────────────────────────────────────────────

test('THE FIX: a stamped card with nothing runnable is REPORTED, not dropped', () => {
  const out = selectRecheckTargets({ doneCards: [truncatedCard()], launchEntries: [], now: DUE });
  assert.equal(out.length, 1, 'it must reach the results, not vanish');
  assert.equal(out[0].cardId, 'trunc-card');
  assert.equal(out[0].verifyCmd, null);
  assert.equal(out[0].skip, null);
  assert.match(out[0].reason, /RECHECK-AFTER stamp is due but/);
  // And it lands in the counts the morning email renders.
  assert.equal(summarize([{ ...out[0], status: 'unverifiable' }]).unverifiable, 1);
});

test('a stamped-but-unrunnable card that someone is working right now is skipped, not double-reported', () => {
  const out = selectRecheckTargets({
    doneCards: [truncatedCard()], launchEntries: [], now: DUE, isClaimed: id => id === 'trunc-card',
  });
  assert.equal(out[0].skip, 'someone is working this card right now');
});

test('an UNSTAMPED window card with no criteria stays out of the results but is handed to onDrop', () => {
  const card = { id: 'no-cmd', name: 'Prose-only fix', status: 'Done', ageDays: 0.2, notes: 'this was fixed, trust me' };
  const drops = [];
  const out = selectRecheckTargets({ doneCards: [card], launchEntries: [], now: NOW, onDrop: d => drops.push(d) });
  assert.deepEqual(out, [], 'the nightly 10-card budget is not spent naming every prose card the brain closed today');
  assert.equal(drops.length, 1);
  assert.equal(drops[0].cardId, 'no-cmd');
  assert.ok(drops[0].reason, 'a drop always states why');
  // Counted in the same summary shape the digest already renders.
  assert.equal(summarize([], { noCriteria: drops.length }).noCriteria, 1);
});

test('onDrop is optional — omitting it must not throw (every existing caller)', () => {
  const card = { id: 'no-cmd', name: 'Prose-only fix', status: 'Done', ageDays: 0.2, notes: 'no criteria' };
  assert.deepEqual(selectRecheckTargets({ doneCards: [card], launchEntries: [], now: NOW }), []);
});

// ── Acceptance command in OUTCOME (inert by construction) ─────────────────
// parseRecheckAfterFromCard already scans outcome for the stamp DATE, because
// sessions write their wrap-up there. It never scanned it for the COMMAND, so
// a card stamped in outcome was selected as due and then instantly dropped
// for having no command — with the command sitting in the field the date came
// from.

test('THE FIX: a card whose stamp AND command both live in outcome is runnable', () => {
  const card = {
    id: 'outcome-card', name: 'Wrap-up-stamped fix', status: 'Paused',
    notes: '## Problem\nprose only, no criteria',
    outcome: 'RECHECK-AFTER: 2026-08-08\n\n## Acceptance criteria\n`node --test scripts/lib/outcome.test.mjs` passes',
  };
  const out = selectRecheckTargets({ doneCards: [card], launchEntries: [], now: DUE });
  assert.equal(out[0].verifyCmd, 'node --test scripts/lib/outcome.test.mjs');
});

test('notes still win over outcome for the command', () => {
  const card = {
    id: 'both-card', name: 'Both', status: 'Paused',
    notes: 'RECHECK-AFTER: 2026-08-08\n\n## Acceptance criteria\n`node --test scripts/lib/a.test.mjs` passes',
    outcome: '## Acceptance criteria\n`node --test scripts/lib/b.test.mjs` passes',
  };
  assert.equal(verifiabilityForCard(card).cmd, 'node --test scripts/lib/a.test.mjs');
  assert.equal(verifiabilityForCard(card).source, 'notes');
  assert.equal(verifiabilityForCard({ notes: 'prose', outcome: 'prose' }).cmd, null);
  assert.equal(verifiabilityForCard(null).cmd, null);
});

// Outcome is scanned by extractVerifyCmd's rules, not scraped for backticks:
// a wrap-up full of backticked file paths must not become an executed command.
test('a backtick in a prose outcome is not mistaken for an acceptance command', () => {
  const card = {
    id: 'prose-card', name: 'Prose wrap-up', status: 'Paused',
    notes: 'RECHECK-AFTER: 2026-08-08',
    outcome: 'Changed `scripts/lib/foo.js` and `rm -rf /tmp/x`. Looks good.',
  };
  const out = selectRecheckTargets({ doneCards: [card], launchEntries: [], now: DUE });
  assert.equal(out[0].verifyCmd, null, 'no acceptance-criteria section means no command');
});

// ── Ledger keying: Linear-sourced launches ────────────────────────────────

test('a launch keyed by linearId (notionId null) is matched, not skipped', () => {
  const card = { id: 'lin-1', name: 'Linear-sourced fix', status: 'Done', ageDays: 0.2 };
  const out = selectRecheckTargets({
    doneCards: [card],
    launchEntries: [launch({ notionId: null, linearId: 'lin-1', verifyCmd: 'node --test l.test.mjs' })],
    now: NOW,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].verifyCmd, 'node --test l.test.mjs');
});

test('a launch with neither id is still unmatchable (nothing to key it on)', () => {
  const card = { id: 'card-1', name: 'Fix the thing', status: 'Done', ageDays: 0.2 };
  const { notionId, ...noId } = launch();
  assert.deepEqual(selectRecheckTargets({ doneCards: [card], launchEntries: [noId], now: NOW }), []);
});

test('selectRecheckTargets: without a lastRecheckedAt lookup (the default), order is unaffected — every existing single-card caller stays correct', () => {
  const card = { id: 'card-1', name: 'Fix the thing', status: 'Done', ageDays: 0.2, notes: '## Acceptance criteria\n`npx next lint` passes' };
  const out = selectRecheckTargets({ doneCards: [card], launchEntries: [launch()], now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].cardId, 'card-1');
});
