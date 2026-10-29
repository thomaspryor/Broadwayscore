// BRO-5505: the analyst's % recouped history on the show card (step chart)
// and the season page's recoupment headline. Real functions from
// src/lib/recoup-story.ts (CLAUDE.md section 15); runs in the tsx batch.
// Run: npx tsx --test tests/unit/analyst-recoup-history.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAnalystRecoupTrend, getSeasonRecoupHeadline, MIN_FLAT_TREND_DAYS } from '../../src/lib/recoup-story.ts';
import { toPublicShowCommercial } from '../../src/lib/commercial-display.ts';

// maybe-happy-ending's series as the scraper's dry run read it (2026-10-29).
const MHE = [
  { asOf: '2026-04-14', pct: [30, 50], postId: 'e' },
  { asOf: '2025-10-14', pct: [0, 20], postId: 'a' },
  { asOf: '2025-10-28', pct: [10, 30], postId: 'b' },
  { asOf: '2025-12-09', pct: [20, 30], postId: 'c' },
  { asOf: '2026-01-27', pct: [20, 40], postId: 'd' },
];

test('steps run oldest first, each to the next change, the last to the newest post', () => {
  const t = getAnalystRecoupTrend(MHE, '2026-10-27');
  assert.equal(t.start, '2025-10-14');
  assert.equal(t.end, '2026-10-27');
  assert.deepEqual(t.steps.map((s) => [s.from, s.to, s.low, s.high]), [
    ['2025-10-14', '2025-10-28', 0, 20],
    ['2025-10-28', '2025-12-09', 10, 30],
    ['2025-12-09', '2026-01-27', 20, 30],
    ['2026-01-27', '2026-04-14', 20, 40],
    ['2026-04-14', '2026-10-27', 30, 50],
  ]);
  assert.equal(t.summary, '0-20% in Oct 2025, 30-50% since Apr 2026');
});

test('one figure that has stood a year still charts (the-great-gatsby); a new one does not', () => {
  const gatsby = getAnalystRecoupTrend([{ asOf: '2025-10-14', pct: [10, 30], postId: 'g' }], '2026-10-27');
  assert.equal(gatsby.summary, '10-30% since Oct 2025');
  assert.equal(gatsby.steps.length, 1);
  const fresh = new Date(Date.parse('2026-10-20') + (MIN_FLAT_TREND_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  assert.equal(getAnalystRecoupTrend([{ asOf: '2026-10-20', pct: [0, 0] }], fresh), null);
});

test('no history, malformed anchors, or a stale end date', () => {
  assert.equal(getAnalystRecoupTrend(undefined, '2026-10-27'), null);
  assert.equal(getAnalystRecoupTrend([], '2026-10-27'), null);
  assert.equal(getAnalystRecoupTrend([{ asOf: 'Oct', pct: [1, 2] }, { asOf: '2026-01-01', pct: [5] }], null), null);
  // An end date older than the last anchor never runs a step backwards.
  const t = getAnalystRecoupTrend(MHE, '2020-01-01');
  assert.equal(t.end, '2026-04-14');
  assert.ok(t.steps.every((s) => s.to >= s.from));
  // A point figure reads as one number.
  assert.equal(getAnalystRecoupTrend([{ asOf: '2026-01-01', pct: [50, 50] }, { asOf: '2026-05-01', pct: [83, 83] }]).summary, '50% in Jan 2026, 83% since May 2026');
});

test('season headline: counts and ranges from the % Recouped cells, no dollar figure', () => {
  const h = getSeasonRecoupHeadline([
    { kind: 'recouped' },
    { kind: 'analyst', range: [30, 50], withModel: false, asOf: '2026-10-27', url: null, ours: false },
    { kind: 'analyst', range: [0, 0], withModel: false, asOf: '2026-10-27', url: null, ours: false },
    { kind: 'model', pct: [-10, 20, 140] },
    { kind: 'loss', text: 'Closed at a loss' },
    { kind: 'reported', lo: 55, hi: 60, outlet: 'Broadway Journal', asOf: null },
    { kind: 'reason', text: 'Budget not disclosed' },
    { kind: 'reason', text: 'Not applicable: nonprofit' },
  ]);
  assert.deepEqual(
    [h.total, h.recouped, h.estimated, h.estimateSpan, h.closedShort, h.noFigure],
    [7, 1, 3, [0, 100], 2, 1],
  );
  assert.equal(h.text, 'Recoupment: 1 recouped, 3 estimated between 0% and 100% recouped, 2 closed without recouping, 1 with no estimate yet.');
  assert.doesNotMatch(h.text, /\$/);
});

test('season headline leaves out empty groups, and is null with nothing to count', () => {
  assert.equal(getSeasonRecoupHeadline([{ kind: 'recouped' }, { kind: 'recouped' }]).text, 'Recoupment: 2 recouped.');
  assert.equal(
    getSeasonRecoupHeadline([{ kind: 'analyst', range: [20, 20], withModel: false, asOf: null, url: null, ours: true }]).text,
    'Recoupment: 0 recouped, 1 estimated about 20% recouped.',
  );
  assert.equal(getSeasonRecoupHeadline([]), null);
  assert.equal(getSeasonRecoupHeadline([{ kind: 'reason', text: 'Not applicable: tour stop' }]), null);
});

test('the show page payload carries the history (dates and ranges only) beside the analyst figure', () => {
  const base = { designation: 'TBD', recouped: false, capitalization: 25_000_000 };
  const pub = toPublicShowCommercial({ ...base, analystRecoupPct: [30, 50], analystRecoupAsOf: '2026-10-27', analystRecoupUrl: null, analystRecoupHistory: MHE });
  assert.deepEqual(pub.analystRecoupHistory[0], { asOf: '2026-04-14', pct: [30, 50] });
  assert.equal(pub.analystRecoupHistory.length, 5);
  // No analyst figure on the record: no history either.
  assert.equal(toPublicShowCommercial({ ...base, analystRecoupHistory: MHE }).analystRecoupHistory, undefined);
});
