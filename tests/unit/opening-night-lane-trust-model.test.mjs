// BRO-4782 (epic BRO-4210): the opening-night lane's trust-model contract. Real functions only (CLAUDE.md section 15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tm = require('../../scripts/lib/opening-night-lane/trust-model.js');

const SHOW = 'other-desert-cities-2026';
const NIGHT = '2026-10-18';
const SEEN = '2026-10-18T23:41:00Z';
const base = { showId: SHOW, night: NIGHT, source: 'aggregator', seenAt: SEEN, outletId: 'nytimes', outlet: 'The New York Times', criticName: 'Jesse Green', url: 'https://www.nytimes.com/2026/10/19/theater/odc-review.html', publishDate: '2026-10-19' };
const longText = 'The play lands with real force. '.repeat(20);

test('buildLaneProvenance: well formed, normalised, and strict about every field', () => {
  assert.deepEqual(tm.buildLaneProvenance({ show: SHOW, night: NIGHT, source: 'outlet-index', seenAt: '2026-10-18T23:41:00+00:00' }),
    { show: SHOW, night: NIGHT, source: 'outlet-index', seenAt: '2026-10-18T23:41:00.000Z' });
  assert.throws(() => tm.buildLaneProvenance({ show: 'Bad Show', night: NIGHT, source: 'aggregator', seenAt: SEEN }), /bad show/);
  assert.throws(() => tm.buildLaneProvenance({ show: SHOW, night: '10/18/2026', source: 'aggregator', seenAt: SEEN }), /bad night/);
  assert.throws(() => tm.buildLaneProvenance({ show: SHOW, night: '2026-13-45', source: 'aggregator', seenAt: SEEN }), /bad night/);
  assert.throws(() => tm.buildLaneProvenance({ show: SHOW, night: NIGHT, source: 'serp', seenAt: SEEN }), /source must be/);
  assert.throws(() => tm.buildLaneProvenance({ show: SHOW, night: NIGHT, source: 'aggregator', seenAt: 'later' }), /bad seenAt/);
});

test('isLaneReview: needs BOTH the provenance block and the aggregator stamp, and the right show', () => {
  const lane = tm.buildLaneReview({ ...base, fullText: longText });
  assert.equal(tm.isLaneReview(lane), true);
  assert.equal(tm.isLaneReview({ ...lane, productionVerified: undefined }), false, 'provenance without the stamp is an ordinary review');
  assert.equal(tm.isLaneReview({ ...lane, productionVerified: 'manual' }), false);
  const noProv = { ...lane }; delete noProv.openingNightLane;
  assert.equal(tm.isLaneReview(noProv), false, 'the stamp alone earns nothing');
  assert.equal(tm.isLaneReview({ ...lane, openingNightLane: { ...lane.openingNightLane, source: 'serp' } }), false);
  assert.equal(tm.isLaneReview({ ...lane, openingNightLane: { ...lane.openingNightLane, night: 'tonight' } }), false);
  assert.equal(tm.isLaneReview({ ...lane, showId: 'cats-2026' }), false, 'a stamp copied onto another show\'s file earns nothing');
  assert.equal(tm.isLaneReview(null), false);
  assert.equal(tm.isLaneReview('review'), false);
  assert.equal(tm.isLaneReview({}), false);
});

test('laneBypasses: each of the six guards stands down for a lane review and for nothing else; unknown names throw', () => {
  const lane = tm.buildLaneReview({ ...base, fullText: longText });
  const ordinary = { showId: SHOW, outletId: 'nytimes', url: base.url, fullText: longText };
  assert.deepEqual([...tm.LANE_BYPASSED_GUARDS], ['wrongProduction', 'nonReview', 'headlineBackstop', 'scraperGarbage', 'tourCrossMarket', 'roundupUrlSwap']);
  for (const guard of tm.LANE_BYPASSED_GUARDS) {
    assert.equal(tm.laneBypasses(lane, guard), true, `${guard} stands down for a lane review`);
    assert.equal(tm.laneBypasses(ordinary, guard), false, `${guard} still applies to an ordinary review`);
  }
  assert.throws(() => tm.laneBypasses(lane, 'wrongProdcution'), /unknown guard/, 'a typo must not read as "not bypassed"');
  assert.throws(() => tm.laneBypasses(lane, 'humanLock'), /unknown guard/, 'the bypass cannot be widened by name');
});

test('admitLaneCandidate: aggregator-cited needs no date; an outlet-index find needs opening night +/- 1 day', () => {
  assert.deepEqual(tm.admitLaneCandidate({ source: 'aggregator', aggregatorCited: true, night: NIGHT }), { admit: true, reason: 'aggregator-cited' });
  assert.equal(tm.admitLaneCandidate({ source: 'aggregator', aggregatorCited: false, night: NIGHT }).admit, false);
  const at = (publishDate) => tm.admitLaneCandidate({ source: 'outlet-index', publishDate, night: NIGHT });
  assert.equal(at('2026-10-17T00:00:00Z').admit, true, 'the day before');
  assert.equal(at('2026-10-17T23:59:00Z').admit, true);
  assert.equal(at('2026-10-18').admit, true, 'the night itself');
  assert.equal(at('2026-10-19T23:59:00Z').admit, true, 'the day after, to the last minute');
  assert.equal(at('2026-10-20T00:00:00Z').admit, false, 'two days after');
  assert.equal(at('2026-10-16T23:59:00Z').admit, false, 'two days before');
  assert.deepEqual(at(null), { admit: false, reason: 'no-publish-date' });
  assert.deepEqual(at('not a date'), { admit: false, reason: 'no-publish-date' });
  assert.equal(tm.admitLaneCandidate({ source: 'serp', night: NIGHT }).reason, 'unknown-source');
  assert.throws(() => tm.admitLaneCandidate({ source: 'aggregator', night: 'x' }), /bad night/);
});

test('laneReviewFilename: never the plain slot, idempotent for the same URL, versioned for a different one', () => {
  const args = { outletId: 'nytimes', criticName: 'Jesse Green', night: NIGHT, url: base.url };
  const first = tm.laneReviewFilename(args);
  assert.deepEqual(first, { filename: 'nytimes--jesse-green--on-2026-10-18.json', reuse: false });
  assert.notEqual(first.filename, 'nytimes--jesse-green.json', 'the plain slot may hold an older flagged review of another production');
  const again = tm.laneReviewFilename({ ...args, existing: new Map([[first.filename, base.url + '/']]) });
  assert.deepEqual(again, { filename: first.filename, reuse: true }, 'same URL (trailing slash aside) reuses its file');
  const other = tm.laneReviewFilename({ ...args, url: 'https://www.nytimes.com/2026/10/19/theater/another.html', existing: { [first.filename]: base.url } });
  assert.equal(other.reuse, false);
  assert.match(other.filename, /^nytimes--jesse-green--on-2026-10-18-[0-9a-f]{6}\.json$/);
  assert.equal(tm.laneReviewFilename({ outletId: 'nytimes', night: NIGHT, url: base.url }).filename, 'nytimes--unknown--on-2026-10-18.json', 'a missing byline still gets a stable name');
  assert.throws(() => tm.laneReviewFilename({ ...args, url: '' }), /url is required/);
});

test('buildLaneReview: a text-bearing review is a full lane review with no score yet', () => {
  const r = tm.buildLaneReview({ ...base, fullText: longText });
  assert.equal(r.source, 'opening-night-lane');
  assert.equal(r.productionVerified, 'aggregator');
  assert.deepEqual(r.openingNightLane, { show: SHOW, night: NIGHT, source: 'aggregator', seenAt: '2026-10-18T23:41:00.000Z' });
  assert.equal(r.isFullReview, true);
  assert.equal(r.needsRecollection, false);
  assert.equal(r.assignedScore, undefined, 'scoring is the inline scorer\'s job');
  assert.equal(r.fullText, longText.trim());
});

test('buildLaneReview: a paywalled review is written, scored from the aggregator at low confidence, and queued for re-collection, never rejected', () => {
  const thumb = tm.buildLaneReview({ ...base, fullText: '', aggregator: { thumb: 'Up', excerpt: 'A tough, funny, deeply felt revival.' } });
  assert.equal(thumb.needsRecollection, true);
  assert.equal(thumb.textStatus, 'paywalled-awaiting-recollection');
  assert.equal(thumb.assignedScore, 80);
  assert.equal(thumb.scoreSource, 'lane-aggregator-thumb');
  assert.equal(thumb.scoreConfidence, 'low');
  assert.equal(thumb.showScoreExcerpt, 'A tough, funny, deeply felt revival.');
  assert.equal(tm.isLaneReview(thumb), true, 'still a lane review: the guards stand down for it');
  const stars = tm.buildLaneReview({ ...base, fullText: 'short blurb', aggregator: { stars: 4 } });
  assert.equal(stars.assignedScore, 80);
  assert.equal(stars.scoreSource, 'lane-aggregator-stars');
  assert.equal(tm.buildLaneReview({ ...base, aggregator: { stars: 2 } }).assignedScore, 40, '2/5 lands in the 31-50 band');
  assert.equal(tm.buildLaneReview({ ...base, aggregator: { stars: 3 } }).assignedScore, 60, '3/5 lands in the 51-70 band');
  const bare = tm.buildLaneReview({ ...base, fullText: '', aggregator: {} });
  assert.equal(bare.needsRecollection, true);
  assert.equal(bare.assignedScore, undefined, 'no thumb or stars: no invented score');
  assert.equal(bare.scoreConfidence, undefined);
});

test('paywallFallbackScore: thumbs and stars map to the shared tables; junk gives null, not a guess', () => {
  assert.deepEqual(tm.paywallFallbackScore({ thumb: 'Down' }), { assignedScore: 35, scoreSource: 'lane-aggregator-thumb' });
  assert.deepEqual(tm.paywallFallbackScore({ thumb: 'Flat' }), { assignedScore: 60, scoreSource: 'lane-aggregator-thumb' });
  assert.equal(tm.paywallFallbackScore({ thumb: 'Sideways' }), null);
  assert.equal(tm.paywallFallbackScore({ stars: 6 }), null);
  assert.equal(tm.paywallFallbackScore({ stars: 'lots' }), null);
  assert.equal(tm.paywallFallbackScore({}), null);
  assert.equal(tm.paywallFallbackScore(), null);
});

test('buildLaneReview: refuses a missing url, outlet or a bad provenance instead of writing a half-stamped file', () => {
  assert.throws(() => tm.buildLaneReview({ ...base, url: '' }), /url is required/);
  assert.throws(() => tm.buildLaneReview({ ...base, outletId: '' }), /outletId is required/);
  assert.throws(() => tm.buildLaneReview({ ...base, source: 'serp' }), /source must be/);
});
