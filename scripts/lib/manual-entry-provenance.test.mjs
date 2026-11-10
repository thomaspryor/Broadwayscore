// BRO-7291 class 5: hand-entered reviews.json rows outranked the pipeline forever. Replays the real BRO-7257 case:
// Arts Fuse "Wonder" carried a hand row (Robert Israel, 40) over the pipeline's row for the same url (byline in the
// text: Martin Copenhaver, scored 71), surviving every rebuild because mergeManualEntries let ANY manual row win.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { mergeManualEntries, manualEntryKey, hasManualProvenance } = require('./manual-entry-merge.js');
const { unprovenancedRows } = require('../check-manual-entry-provenance.js');

const URL = 'https://artsfuse.org/322533/theater-review-the-limits-of-wonder/';
const norm = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').toLowerCase();
const pipeline = () => ({ showId: 'wonder-regional-2026', outletId: 'artsfuse', outlet: 'The Arts Fuse', criticName: 'Martin Copenhaver', assignedScore: 71, scoreSource: 'llmScore', url: URL, tier: 3 });
const hand = (extra = {}) => ({ showId: 'wonder-regional-2026', outletId: 'artsfuse', outlet: 'The Arts Fuse', criticName: 'Robert Israel', assignedScore: 40, scoreSource: 'human-review', url: URL, tier: 3, manualEntry: true, ...extra });
const run = (manual, baseline) => { const reviews = [pipeline()]; const r = mergeManualEntries(reviews, [manual], norm, { baseline }); return { reviews, r }; };

test('replay Arts Fuse Wonder: an unexplained, non-grandfathered hand row loses to the scored pipeline row', () => {
  const { reviews, r } = run(hand(), new Set());
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].criticName, 'Martin Copenhaver');
  assert.equal(reviews[0].assignedScore, 71);
  assert.deepEqual(r.unprovenanced, ['wonder-regional-2026|artsfuse|' + manualEntryKey(hand()).split('|')[2]]);
});

test('a grandfathered hand row still wins (existing 100 rows are not silently dropped)', () => {
  const { reviews, r } = run(hand(), new Set([manualEntryKey(hand())]));
  assert.equal(reviews[0].assignedScore, 40);
  assert.deepEqual(r.unprovenanced, []);
});

test('a hand row with a recorded reason wins', () => {
  const m = hand({ manualEntryReason: 'pipeline scored the roundup; critic page says 2/5', manualEntryBy: 'owner' });
  assert.equal(hasManualProvenance(m), true);
  const { reviews } = run(m, new Set());
  assert.equal(reviews[0].assignedScore, 40);
});

test('no baseline file (legacy callers): behaviour unchanged, hand row wins', () => {
  const { reviews } = run(hand(), null);
  assert.equal(reviews[0].assignedScore, 40);
});

test('an unexplained hand row with no pipeline twin is kept but still reported', () => {
  const m = hand({ url: 'https://artsfuse.org/1/other/', criticName: 'Someone Else' });
  const reviews = [pipeline()];
  const r = mergeManualEntries(reviews, [m], norm, { baseline: new Set() });
  assert.equal(reviews.length, 2);
  assert.equal(r.unprovenanced.length, 1);
});

test('the CI check flags exactly the unexplained, non-grandfathered rows', () => {
  const rows = [hand(), hand({ criticName: 'A B', manualEntryReason: 'critic page says 3/5 stars' }), pipeline()];
  assert.deepEqual(unprovenancedRows(rows, []), [manualEntryKey(hand())]);
  assert.deepEqual(unprovenancedRows(rows, [manualEntryKey(hand())]), []);
});

// BRO-7319 (b): a displaced hand row is held (full row), carried across rebuilds, and never lost or duplicated.
test('the displaced hand row is returned in full as held', () => {
  const { reviews, r } = run(hand(), new Set());
  assert.equal(reviews.length, 1);
  assert.equal(r.held.length, 1);
  assert.equal(r.held[0].criticName, 'Robert Israel');
  assert.equal(r.held[0].assignedScore, 40);
});
test('a prior held row is re-evaluated on the next rebuild and held again (not lost when reviews.json lost it)', () => {
  const reviews = [pipeline()];
  const r = mergeManualEntries(reviews, [], norm, { baseline: new Set(), priorHeld: [hand()] });
  assert.equal(r.held.length, 1);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].criticName, 'Martin Copenhaver');
});
test('a held row re-entered with a reason supersedes its held copy: restored once, not held again, not duplicated', () => {
  const reentered = hand({ manualEntryReason: 'Critic byline confirmed from the print edition' });
  const reviews = [pipeline()];
  const r = mergeManualEntries(reviews, [reentered], norm, { baseline: new Set(), priorHeld: [hand()] });
  assert.equal(r.held.length, 0);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].criticName, 'Robert Israel');
});
test('a held row whose pipeline twin is gone is appended once (no duplicate with later rebuilds)', () => {
  const reviews = [];
  const r = mergeManualEntries(reviews, [], norm, { baseline: new Set(), priorHeld: [hand()] });
  assert.equal(reviews.length, 1);
  assert.equal(r.held.length, 0);
});
test('legacy path (no baseline) holds nothing and drops nothing', () => {
  const reviews = [pipeline()];
  const r = mergeManualEntries(reviews, [hand()], norm, {});
  assert.deepEqual(r.held, []);
});
