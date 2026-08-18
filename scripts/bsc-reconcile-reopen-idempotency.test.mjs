import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { sweepUntrackedInProgress, stripOwnParkNote, UNTRACKED_MARKER, OUTCOME_PARK_MARKER } = require('./bsc-reconcile.js');

// Card #1796: sweepUntrackedInProgress's UNTRACKED_MARKER/OUTCOME_PARK_MARKER
// idempotency guards used to be bare `.includes()` checks on `description` —
// once a task was swept or parked ONCE, the marker (prepended, never
// cleared) blocked EVERY future genuine occurrence forever. Same bug class
// already fixed for reconcile-dead-completions.js's reopenTask() in card
// #1795 (lastReopenedForEventTs). These tests mirror that shape: a task
// carrying an old marker from a PRIOR event must still act on a genuinely
// NEW occurrence of the same condition.

const NOW = Date.parse('2026-08-18T12:00:00.000Z');
const tsAgo = (h) => new Date(NOW - h * 3600e3).toISOString();

function zombieHarness({ tasks, entries = [], workspaces = [], cards = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zombie-reopen-'));
  const statePath = path.join(dir, 'state.json');
  // The real flipFn/markOutcomeParkedFn (used below, unmocked) read/write
  // task files on disk — write each task out so those functions' re-read
  // succeeds, mirroring the real TASKS_DIR shape.
  for (const t of tasks) fs.writeFileSync(path.join(dir, `${t.id}.json`), JSON.stringify(t, null, 2));
  const flips = [];
  const cardCorrections = [];
  const outcomeParkMarks = [];
  return {
    flips, cardCorrections, outcomeParkMarks, dir, statePath,
    readTask(id) { return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')); },
    deps: {
      loadTasksFn: () => tasks,
      tasksDir: dir,
      readLedgerEntriesFn: () => entries,
      listWorkspacesFn: () => workspaces,
      readLeaseFn: () => null,
      fetchCardFn: (nid) => cards[nid] || null,
      // Use the REAL flipFn/markOutcomeParkedFn (writing real task files) so
      // the structured-field stamping under test isn't reimplemented here.
      correctCardFn: (nid) => { cardCorrections.push(nid); return true; },
      reportFn: () => {},
      nowFn: () => NOW,
      statePath,
    },
  };
}

const zTask = (id, over = {}) => ({
  id: String(id), status: 'in_progress', subject: `Zombie reopen card #${id}`,
  description: `[notion:aaaa${id}aaa-1111-2222-3333-444444444444] P1 Next`, metadata: {}, ...over,
});

// ── Flip branch: a second genuine zombie-sweep event ────────────────────────

test('flip branch: a task already carrying UNTRACKED_MARKER from an EARLIER event still flips on a genuinely NEW event', () => {
  const nid = 'aaaa9aaa-1111-2222-3333-444444444444';
  const priorNote = `${UNTRACKED_MARKER}2026-08-01] reopened — sat In progress 3d with no live session (task #1184 S2). Re-eligible for dispatch.\n\n`;
  const h = zombieHarness({
    tasks: [zTask(9, {
      description: priorNote + zTask(9).description,
      lastSweptForEventTs: tsAgo(200), // stamped for the FIRST (older, already-handled) event
    })],
    cards: { [nid]: { status: 'In progress', lastEditedAt: tsAgo(72), outcome: '' } }, // a NEW, DIFFERENT lastEditedAt
  });
  const r = sweepUntrackedInProgress({ deps: h.deps });
  assert.equal(r.ran, true);
  assert.deepEqual(r.flipped, ['9'], 'the old marker must not block a genuinely new occurrence');
  const after = h.readTask(9);
  assert.equal(after.status, 'pending');
  assert.equal(after.lastSweptForEventTs, tsAgo(72), 'stamp advances to the NEW event, not the stale one');
});

test('flip branch: the SAME event (identical lastEditedAt already recorded) is a true no-op', () => {
  const nid = 'aaaa9aaa-1111-2222-3333-444444444444';
  const sameTs = tsAgo(72);
  const priorNote = `${UNTRACKED_MARKER}2026-08-15] reopened — sat In progress 3d with no live session (task #1184 S2). Re-eligible for dispatch.\n\n`;
  const h = zombieHarness({
    tasks: [zTask(9, { description: priorNote + zTask(9).description, lastSweptForEventTs: sameTs })],
    cards: { [nid]: { status: 'In progress', lastEditedAt: sameTs, outcome: '' } },
  });
  const r = sweepUntrackedInProgress({ deps: h.deps });
  assert.deepEqual(r.flipped, [], 'identical event must stay a no-op');
  assert.ok(r.skipped.some(s => s.id === '9' && s.why === 'already-swept-this-event'));
});

// ── Park branch: a second genuine outcome-dispute event ─────────────────────

test('park branch: a task already carrying OUTCOME_PARK_MARKER from an EARLIER dispute still re-parks on a genuinely NEW outcome', () => {
  const nid = 'aaaa9aaa-1111-2222-3333-444444444444';
  const firstOutcome = 'Session 1: shipped the fix.';
  const priorParkNote = `${OUTCOME_PARK_MARKER}2026-08-01] parked — Notion card set to Paused, needs a human yes/no on the recorded Outcome (task #1272).\n\n`;
  // Simulate the OLD (pre-fix) marker present, plus a stamp from a PRIOR,
  // now-resolved dispute — the hash was computed over the FIRST outcome text.
  const priorHash = require('node:crypto').createHash('sha256').update(firstOutcome).digest('hex');
  const h = zombieHarness({
    tasks: [zTask(9, { description: priorParkNote + zTask(9).description, lastParkedOutcomeHash: priorHash })],
    // Card now carries a DIFFERENT, genuinely new outcome dispute (nothing to
    // do with our own auto-park note — a human resumed the card and it was
    // completed again with different content).
    cards: { [nid]: { status: 'In progress', lastEditedAt: tsAgo(72), outcome: 'Session 2: a completely different fix, disputed again.' } },
  });
  const r = sweepUntrackedInProgress({ deps: h.deps });
  assert.equal(h.cardCorrections.length, 1, 'a genuinely new outcome dispute must re-park, not no-op forever');
  const after = h.readTask(9);
  assert.notEqual(after.lastParkedOutcomeHash, priorHash, 'hash advances to the new dispute content');
});

test('park branch: re-running against the SAME (already-parked) outcome content is a true no-op, even though the note text embeds a changing day-count', () => {
  const nid = 'aaaa9aaa-1111-2222-3333-444444444444';
  const humanOutcome = 'Findings written up, 12 screenshots attached.';
  const h = zombieHarness({
    tasks: [zTask(9)],
    cards: { [nid]: { status: 'In progress', lastEditedAt: tsAgo(72), outcome: humanOutcome } },
  });
  const first = sweepUntrackedInProgress({ deps: h.deps });
  assert.equal(h.cardCorrections.length, 1, 'first park proceeds');
  const afterFirst = h.readTask(9);
  assert.ok(afterFirst.lastParkedOutcomeHash);

  // Second sweep run: the OWN auto-park note (with a park-time day-count that
  // would differ run to run) is now prepended to card.outcome, exactly as
  // notion-brain.js's --outcome update would leave it. This is the
  // self-invalidation scenario the first plan review caught — must NOT
  // re-park.
  const selfPrependedOutcome = `Auto-parked 2026-08-18 by bsc-reconcile zombie sweep: card sat In progress 72d with no live session, but already has a completed Outcome — needs a human yes/no, not an automatic reopen (task #1272). Resume dispatch with \`node scripts/bsc-next.js --id 9 --force\` once reviewed.\n\n---\n\n${humanOutcome}`;
  const h2 = zombieHarness({
    tasks: [afterFirst],
    cards: { [nid]: { status: 'Paused', lastEditedAt: tsAgo(96), outcome: selfPrependedOutcome } },
  });
  const second = sweepUntrackedInProgress({ deps: h2.deps });
  assert.equal(h2.cardCorrections.length, 0, 'own prior park note must not look like a new dispute');
  assert.ok(second.skipped.some(s => s.id === '9' && s.why === 'already-parked-this-outcome'));
});

// ── stripOwnParkNote unit coverage ───────────────────────────────────────────

test('stripOwnParkNote: strips exactly one leading auto-park note, leaving the human-authored core', () => {
  const core = 'Findings written up, 12 screenshots attached.';
  const wrapped = `Auto-parked 2026-08-18 by bsc-reconcile zombie sweep: card sat idle.\n\n---\n\n${core}`;
  assert.equal(stripOwnParkNote(wrapped), core);
});

test('stripOwnParkNote: leaves genuinely new human content untouched (no separator, or separator not preceded by our own note)', () => {
  assert.equal(stripOwnParkNote('Plain outcome, no separator at all.'), 'Plain outcome, no separator at all.');
  const humanPrepend = 'New dispute text.\n\n---\n\nOld content that happens to follow a separator.';
  assert.equal(stripOwnParkNote(humanPrepend), humanPrepend, 'only OUR OWN note is stripped, never a human one');
});

// Ship-check finding (task #1796): notion-brain.js's --outcome writer runs
// hoistRecheckAfterStamp() on the FULL combined text (scripts/notion-
// brain.js:972,979) — if the pre-existing human outcome mentions
// RECHECK-AFTER anywhere, that hoist pushes a canonical
// `RECHECK-AFTER: <date>\n\n` stamp in front of EVERYTHING, including our
// own auto-park note, which used to break the "our note is always the
// literal head" assumption and reintroduce the exact infinite-reparking bug
// this fix exists to close.
test('stripOwnParkNote: tolerates a RECHECK-AFTER stamp hoisted in front of our own note', () => {
  const core = 'Findings written up, 12 screenshots attached. RECHECK-AFTER: 2026-09-01 once the fee lands.';
  const ourNote = 'Auto-parked 2026-08-18 by bsc-reconcile zombie sweep: card sat idle.';
  const hoisted = `RECHECK-AFTER: 2026-09-01\n\n${ourNote}\n\n---\n\n${core}`;
  assert.equal(stripOwnParkNote(hoisted), core);
});

test('park branch: stays idempotent across two runs even when the outcome contains a RECHECK-AFTER mention (notion-brain.js hoist reproduced)', () => {
  const nid = 'aaaa9aaa-1111-2222-3333-444444444444';
  const humanOutcome = 'Shipped the fix. RECHECK-AFTER: 2026-09-01 to confirm the cron picked it up.';
  const h = zombieHarness({
    tasks: [zTask(9)],
    cards: { [nid]: { status: 'In progress', lastEditedAt: tsAgo(72), outcome: humanOutcome } },
  });
  sweepUntrackedInProgress({ deps: h.deps });
  const afterFirst = h.readTask(9);
  assert.ok(afterFirst.lastParkedOutcomeHash);

  // Second sweep run: reproduce notion-brain.js's real hoistRecheckAfterStamp
  // behavior — the RECHECK-AFTER mention buried in humanOutcome causes the
  // canonical stamp to land in FRONT of our own auto-park note, not behind it.
  const ourNote = 'Auto-parked 2026-08-18 by bsc-reconcile zombie sweep: card sat In progress 72d with no live session, but already has a completed Outcome — needs a human yes/no, not an automatic reopen (task #1272). Resume dispatch with `node scripts/bsc-next.js --id 9 --force` once reviewed.';
  const hoistedOutcome = `RECHECK-AFTER: 2026-09-01\n\n${ourNote}\n\n---\n\n${humanOutcome}`;
  const h2 = zombieHarness({
    tasks: [afterFirst],
    cards: { [nid]: { status: 'Paused', lastEditedAt: tsAgo(96), outcome: hoistedOutcome } },
  });
  const second = sweepUntrackedInProgress({ deps: h2.deps });
  assert.equal(h2.cardCorrections.length, 0, 'the hoisted RECHECK-AFTER stamp must not mask our own note and trigger a re-park');
  assert.ok(second.skipped.some(s => s.id === '9' && s.why === 'already-parked-this-outcome'));
});
