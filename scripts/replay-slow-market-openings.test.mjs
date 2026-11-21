// BRO-6687: pure parts of replay-slow-market-openings.js, required from the real module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('./replay-slow-market-openings.js');
const { gapUrlIdentity } = require('./audit-show-review-gap.js');

test('discoveryMode: an automatic source wins; bare submit-review-form is caller-unknown, never auto', () => {
  assert.equal(R.discoveryMode({ source: 'submit-review-form', sources: ['theatre-reviews'] }).mode, 'auto');
  assert.equal(R.discoveryMode({ source: 'submit-review-form' }).mode, 'caller-unknown');
  assert.equal(R.discoveryMode({ source: 'submit-review-form', ingestSource: 'audit-show-review-gap' }).mode, 'auto');
  assert.equal(R.discoveryMode({ source: 'submit-review-form', ingestSource: 'execute-approved-fix' }).mode, 'hand');
});

test('handSteps: gating approved fixes count, a criticName fix is cosmetic', () => {
  const h = R.handSteps({ approvedFixes: [{ field: 'wrongShow' }, { field: 'criticName' }], wrongProductionManualClear: true });
  assert.deepEqual(h.gating, ['approvedFix:wrongShow', 'wrongProductionManualClear']);
  assert.deepEqual(h.cosmetic, ['approvedFix:criticName']);
});

test('classifyFile: live split by hand; not live needs a reason', () => {
  const auto = { source: 'theatre-reviews' };
  assert.equal(R.classifyFile({ file: auto, live: true }).outcome, 'auto-live');
  assert.equal(R.classifyFile({ file: { ...auto, approvedFixes: [{ field: 'wrongShow' }] }, live: true }).outcome, 'live-by-hand');
  assert.equal(R.classifyFile({ file: { source: 'submit-review-form' }, live: true }).outcome, 'live-caller-unknown');
  const ex = R.classifyFile({ file: auto, live: false, guardReason: 'wrongProduction' });
  assert.deepEqual([ex.outcome, ex.reason], ['excluded', 'wrongProduction']);
  const nl = R.classifyFile({ file: auto, live: false, guardReason: null, scoreable: false });
  assert.deepEqual([nl.outcome, nl.reason], ['found-not-live', 'unscored']);
});

test('readyAt: measured beats estimate; estimate is never before first seen', () => {
  assert.deepEqual(R.readyAt({}, '2026-10-30T03:40:08.581Z'), { at: '2026-10-30T03:40:08.581Z', precision: 'measured' });
  const r = R.readyAt({ firstSeenAt: '2026-10-18T08:15:27Z', llmMetadata: { scoredAt: '2026-10-18T08:40:00Z' } });
  assert.equal(r.at, '2026-10-18T08:40:00.000Z');
  assert.equal(R.readyAt({ firstSeenAt: '2026-10-18T09:00:00Z', scoreRecoveredAt: '2026-10-18T08:00:00Z' }).at, '2026-10-18T09:00:00.000Z');
  assert.equal(R.readyAt({}).precision, 'unknown');
});

test('anchorMs: clock starts at the later of publish and opening', () => {
  assert.equal(R.anchorMs('2026-10-10', '2026-10-15'), Date.parse('2026-10-15'));
  assert.equal(R.anchorMs('2026-10-16', '2026-10-15'), Date.parse('2026-10-16'));
  assert.equal(R.anchorMs(null, '2026-10-15'), Date.parse('2026-10-15'));
});

test('matchLive: a live row is claimed once; the duplicate file is not live', () => {
  const loaded = [
    { name: 'dup.json', file: { url: 'https://x.com/r/', duplicateOf: 'a.json', outletId: 'x', criticName: 'A' } },
    { name: 'a.json', file: { url: 'http://www.x.com/r', outletId: 'x', criticName: 'A' } },
    { name: 'b.json', file: { url: 'https://y.com/other', outletId: 'y', criticName: 'B' } },
    { name: 'c.json', file: { url: 'https://z.com/gone', outletId: 'z', criticName: 'C' } },
  ];
  const live = [{ url: 'https://x.com/r', outletId: 'x', criticName: 'A' }, { url: 'https://y.com/moved', outletId: 'y', criticName: 'b' }];
  assert.deepEqual([...R.matchLive(loaded, live, gapUrlIdentity)].sort(), ['a.json', 'b.json']);
});

test('gradeOpening + checkReplay: windows, hand count, and over-claimed live is a problem', () => {
  const rows = [
    { outcome: 'auto-live', hoursToLive: 10, livePrecision: 'measured' },
    { outcome: 'live-by-hand', hoursToLive: 50, livePrecision: 'estimated-scored' },
    { outcome: 'excluded', reason: 'wrongShow' },
    { outcome: 'not-ingested', reason: 'serp-census' },
  ];
  const g = R.gradeOpening(rows);
  assert.deepEqual([g.live, g.neededHand, g.liveWithin['24h'], g.liveWithin['72h'], g.measured, g.notIngested], [2, 1, 1, 2, 1, 1]);
  assert.deepEqual(R.checkReplay({ openings: [{ showId: 's', reviews: rows, grade: g, liveInReviewsJson: 2 }] }), []);
  assert.equal(R.checkReplay({ openings: [{ showId: 's', reviews: rows, grade: g, liveInReviewsJson: 1 }] }).length, 1);
  assert.equal(R.checkReplay({ openings: [{ showId: 's', reviews: [{ outcome: 'found-not-live' }], grade: { live: 0 }, liveInReviewsJson: 0 }] }).length, 1);
});
