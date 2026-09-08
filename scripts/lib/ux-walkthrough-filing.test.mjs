// Colocated test for the nightly UX walkthrough's filing decision. It
// require()s the real module (CLAUDE.md rule 15) so a change to the policy
// fails here rather than drifting.
//
// The regression this exists to prevent has two halves, and the second is the
// dangerous one:
//   1. The walkthrough shelled out to notion-brain.js create, dead since the
//      2026-08-30 read-only flip — every finding logged one line and vanished.
//   2. Its dedup read ALSO shelled out to Notion, and caught its own failure
//      by returning [] — "no existing issues". Repointing only the create path
//      at Linear would have made every night refile every historical finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIORITY_HIGH,
  PRIORITY_NORMAL,
  MIN_AGREEMENT,
  DUPE_SIMILARITY,
  similarity,
  titleFor,
  priorityFor,
  planFilings,
} from './ux-walkthrough-filing.js';

const model = (summary, extra = {}) => ({ summary, agreementCount: MIN_AGREEMENT, models: ['a', 'b'], severity: 'medium', ...extra });
const okBoard = (titles = []) => ({ titles, ok: true });

test('a FAILED board read files nothing — it is not an empty board', () => {
  // The whole point. ok:false must never be treated as "nothing on the board".
  const findings = [model('Watchlist button does nothing on mobile'), model('Diary date wheel is unreadable')];
  for (const bad of [null, undefined, { titles: [], ok: false }, { titles: [] }, { ok: 'yes', titles: [] }]) {
    const plan = planFilings({ findings, existing: bad });
    assert.equal(plan.refused, true);
    assert.deepEqual(plan.toFile, []);
    assert.match(plan.reason, /refusing to file|duplicating/i);
  }
});

test('an EMPTY board that read successfully does file', () => {
  // The mirror of the case above: a genuinely empty board is not an error.
  const plan = planFilings({ findings: [model('Watchlist button does nothing on mobile')], existing: okBoard([]) });
  assert.equal(plan.refused, false);
  assert.equal(plan.toFile.length, 1);
});

test('a finding already on the board is skipped, not refiled', () => {
  const title = titleFor(model('Watchlist button does nothing on mobile'));
  const plan = planFilings({
    findings: [model('Watchlist button does nothing on mobile')],
    existing: okBoard([title]),
  });
  assert.equal(plan.toFile.length, 0);
  assert.deepEqual(plan.skippedDuplicate, [title]);
});

test('two near-identical findings in ONE run file only once', () => {
  // The board read cannot know about a title minted seconds ago, so the
  // in-run queue has to be part of the dedup set. Without this a model
  // finding and a deterministic detector describing the same defect both file.
  const plan = planFilings({
    findings: [
      model('Watchlist button does nothing when tapped on mobile'),
      model('Watchlist button does nothing when tapped on mobile', { deterministic: true, models: ['ux-walkthrough:dead-control'] }),
    ],
    existing: okBoard([]),
  });
  assert.equal(plan.toFile.length, 1);
  assert.equal(plan.skippedDuplicate.length, 1);
});

test('a single-model finding is dropped, a deterministic one is not', () => {
  const plan = planFilings({
    findings: [
      model('Only one model saw this hierarchy problem', { agreementCount: 1 }),
      { summary: 'Dead control on the diary sheet', deterministic: true, models: ['ux-walkthrough:dead-control'], severity: 'high' },
    ],
    existing: okBoard([]),
  });
  assert.equal(plan.toFile.length, 1);
  assert.equal(plan.toFile[0].title, 'UX audit: Dead control on the diary sheet');
  assert.equal(plan.skippedLowAgreement.length, 1);
});

test('priority is a Linear NUMBER, never a Notion priority string', () => {
  // notion-brain took "P1 Next"/"P2 Later"; linear-brain takes 0-4. Passing
  // the old strings through would be a silent no-op on the wrong field.
  assert.equal(priorityFor({ severity: 'high' }), PRIORITY_HIGH);
  assert.equal(priorityFor({ severity: 'medium' }), PRIORITY_NORMAL);
  assert.equal(priorityFor({}), PRIORITY_NORMAL);
  for (const p of [PRIORITY_HIGH, PRIORITY_NORMAL]) {
    assert.equal(typeof p, 'number');
    assert.ok(p >= 0 && p <= 4, `Linear priority out of range: ${p}`);
  }
  const plan = planFilings({ findings: [model('x y z alpha beta', { severity: 'high' })], existing: okBoard([]) });
  assert.equal(plan.toFile[0].priority, PRIORITY_HIGH);
});

test('titles are prefixed and length-capped', () => {
  const t = titleFor({ summary: 'q'.repeat(400) });
  assert.ok(t.startsWith('UX audit: '));
  assert.ok(t.length <= 120, t.length);
  assert.equal(titleFor({}), 'UX audit: ');
});

test('similarity is symmetric, bounded, and empty-safe', () => {
  assert.equal(similarity('', 'anything at all here'), 0);
  assert.equal(similarity('watchlist button broken mobile', 'watchlist button broken mobile'), 1);
  const a = similarity('watchlist button broken mobile', 'watchlist button broken desktop');
  assert.equal(a, similarity('watchlist button broken desktop', 'watchlist button broken mobile'));
  assert.ok(a > 0 && a < 1);
  assert.ok(DUPE_SIMILARITY > 0 && DUPE_SIMILARITY <= 1);
});

test('unrelated findings are not collapsed into one', () => {
  const plan = planFilings({
    findings: [model('Watchlist button does nothing on mobile'), model('Diary calendar wheel truncates the year')],
    existing: okBoard([]),
  });
  assert.equal(plan.toFile.length, 2);
  assert.equal(plan.skippedDuplicate.length, 0);
});

test('no findings is a clean empty plan, not a refusal', () => {
  const plan = planFilings({ findings: [], existing: okBoard(['UX audit: something old']) });
  assert.equal(plan.refused, false);
  assert.deepEqual(plan.toFile, []);
});

test('null entries in the findings list are ignored, not crashed on', () => {
  const plan = planFilings({ findings: [null, undefined, model('Watchlist button does nothing on mobile')], existing: okBoard([]) });
  assert.equal(plan.refused, false);
  assert.equal(plan.toFile.length, 1);
});
