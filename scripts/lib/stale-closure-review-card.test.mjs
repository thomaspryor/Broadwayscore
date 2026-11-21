// BRO-3490: stale-closure human-review rows -> Linear issue specs.
// Requires the real builders and the notifier's real planReportItems.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const card = require('./stale-closure-review-card.js');
const { planReportItems } = require('../notify-pending-commercial-linear.js');
const { evaluateVerifiability } = require('./verify-gate.js');
const { staleClosuresNeedingResearch } = require('./commercial-queue.js');
const { classifyStaleClosure } = require('./classify-stale-closure.js');

const NOW = Date.parse('2026-10-13T00:00:00Z');
const bucket = [
  { show: { slug: 'beaches', title: 'Beaches, A New Musical', closingDate: '2026-05-24' }, result: { reason: 'late-recoupment-signal: rss' } },
  { show: { slug: 'never', title: 'Never Researched', closingDate: '2026-05-24' }, result: { reason: 'closed 142d ago but deep-research never ran', needsResearch: true } },
  { show: { slug: 'lct-show', title: 'LCT Show', closingDate: 'bad' }, result: { reason: 'enhancement-deal closure needs producer-list review' } },
  { show: {}, result: { reason: 'no slug, dropped' } },
];

test('buildClosureReviewItems maps judgment rows and leaves never-researched rows to deep research', () => {
  const rows = card.buildClosureReviewItems(bucket, NOW);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { slug: 'beaches', title: 'Beaches, A New Musical', closingDate: '2026-05-24', daysClosed: 142, reason: bucket[0].result.reason, kind: 'late-signal' });
  assert.equal(rows[1].kind, 'enhancement');
  assert.ok(!rows.some((r) => r.slug === 'never'));
  assert.equal(rows[1].daysClosed, null);
});

test('title is stable per slug + reason kind and carries the dedup key', () => {
  assert.equal(card.buildClosureReviewTitle('beaches', 'enhancement'), card.buildClosureReviewTitle('beaches', 'enhancement'));
  assert.notEqual(card.buildClosureReviewTitle('beaches', 'enhancement'), card.buildClosureReviewTitle('beaches', 'late-signal'));
  assert.match(card.buildClosureReviewTitle('beaches', 'late-signal'), /stale-closure-review-beaches-late-signal/);
  assert.notEqual(card.buildClosureReviewTitle('hamlet'), card.buildClosureReviewTitle('hamlet-revival'));
});

test('notes carry a runnable VERIFY a worker can take, never a bare owner-judgment marker (BRO-5371)', () => {
  const [a] = card.buildClosureReviewItems(bucket, NOW);
  const notes = card.buildClosureReviewNotes(a);
  assert.match(notes, /humanReviewedDesignation/);
  const v = evaluateVerifiability(notes);
  assert.equal(v.cmd, `node scripts/check-review-item-resolved.js --closure=${a.slug}`, JSON.stringify(v));
  assert.doesNotMatch(notes, /VERIFY:\s*owner-judgment/);
});

test('the classifier marks needsResearch only for a never-researched TBD entry', () => {
  const show = { slug: 'x', status: 'closed', closingDate: '2026-05-01', category: 'broadway', productionType: 'original' };
  const now = Date.parse('2026-10-13T00:00:00Z');
  const tbd = classifyStaleClosure({ show, entry: { designation: 'TBD' }, now });
  assert.equal(tbd.action, 'human-review');
  assert.equal(tbd.needsResearch, true);
  const none = classifyStaleClosure({ show, entry: undefined, now });
  assert.equal(none.action, 'human-review');
  assert.equal(none.needsResearch, false, 'no entry stays a judgment card');
  assert.equal(card.buildClosureReviewItems([{ show, result: none }], now)[0].kind, 'unresearched');
});

test('staleClosuresNeedingResearch: recent, never-researched TBD entries only (no grace, age-capped)', () => {
  const now = Date.parse('2026-10-13T00:00:00Z');
  const base = { status: 'closed', category: 'broadway', closingDate: '2026-06-01' };
  const shows = [
    { ...base, slug: 'tbd-unresearched' },
    { ...base, slug: 'fresh-close', closingDate: '2026-10-10' },
    { ...base, slug: 'no-entry' },
    { ...base, slug: 'researched' },
    { ...base, slug: 'too-old', closingDate: '2022-01-01' },
    { ...base, slug: 'still-open', status: 'open' },
    { ...base, slug: 'off-bway', category: 'off-broadway' },
  ];
  const comm = {
    'tbd-unresearched': { designation: 'TBD' },
    'fresh-close': { designation: 'TBD' },
    researched: { designation: 'TBD', researchAttempts: 1 },
    'too-old': { designation: 'TBD' },
    'still-open': { designation: 'TBD' },
    'off-bway': { designation: 'TBD' },
  };
  assert.deepEqual(staleClosuresNeedingResearch(shows, comm, now), ['tbd-unresearched', 'fresh-close']);
});

test('planReportItems: closure rows become non-commenting specs; claims keep commenting', () => {
  const report = {
    recoupedClaims: [{ slug: 'hit-show' }],
    staleClosureReviews: card.buildClosureReviewItems(bucket, NOW),
  };
  const { specs, overflow } = planReportItems(report, 25);
  assert.equal(overflow, 0);
  assert.deepEqual(specs.map((s) => [s.kind, s.slug, s.commentOnExisting]), [
    ['recouped-claim', 'hit-show', true],
    ['stale-closure-review', 'beaches', false],
    ['stale-closure-review', 'lct-show', false],
  ]);
  assert.equal(specs[1].title, card.buildClosureReviewTitle('beaches', 'late-signal'));
});

test('planReportItems: cap keeps recouped claims first and counts overflow', () => {
  const report = { recoupedClaims: [{ slug: 'a' }, { slug: 'b' }], staleClosureReviews: [{ slug: 'c', reason: 'r' }, { slug: 'd', reason: 'r' }] };
  const { specs, overflow } = planReportItems(report, 3);
  assert.deepEqual(specs.map((s) => s.slug), ['a', 'b', 'c']);
  assert.equal(overflow, 1);
});

test('planReportItems: a report with only closure rows (classifier report) works', () => {
  const { specs } = planReportItems({ staleClosureReviews: [{ slug: 'x', reason: 'r' }] }, 25);
  assert.equal(specs.length, 1);
});

test('every human-review branch of the classifier maps to a specific reasonKind (rewording guard)', () => {
  // reasonKind keys off the classifier's reason prefixes, and the kind is part
  // of the dedup title. If a branch's wording changes, this fails instead of
  // the card silently falling into the generic 'review' bucket.
  const now = Date.parse('2026-10-13T00:00:00Z');
  const show = { slug: 'x', status: 'closed', closingDate: '2026-05-01', category: 'broadway' };
  const researched = { designation: 'TBD', researchAttempts: 1 };
  const cases = {
    enhancement: classifyStaleClosure({ show, entry: { ...researched, productionType: 'enhancement' }, now }),
    'late-signal': classifyStaleClosure({ show, entry: researched, now,
      pending: { recouped: true, detectedBy: 'rss', detectedAt: '2026-10-10T00:00:00Z' } }),
    unresearched: classifyStaleClosure({ show, entry: undefined, now }),
  };
  for (const [kind, result] of Object.entries(cases)) {
    assert.equal(result.action, 'human-review', `${kind}: ${JSON.stringify(result)}`);
    assert.equal(card.reasonKind(result.reason), kind, `reason "${result.reason}" no longer maps to ${kind}`);
  }
});
