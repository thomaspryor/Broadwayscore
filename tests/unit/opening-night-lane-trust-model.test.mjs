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

test('admitLaneCandidate: aggregator-cited needs no date; an outlet-index find needs opening night +/- 1 calendar day in the market time zone', () => {
  assert.deepEqual(tm.admitLaneCandidate({ source: 'aggregator', aggregatorCited: true, night: NIGHT }), { admit: true, reason: 'aggregator-cited' });
  assert.equal(tm.admitLaneCandidate({ source: 'aggregator', aggregatorCited: false, night: NIGHT }).admit, false);
  const at = (publishDate, extra = {}) => tm.admitLaneCandidate({ source: 'outlet-index', publishDate, night: NIGHT, ...extra });
  // Broadway: America/New_York (EDT, UTC-4 in October).
  assert.equal(at('2026-10-17T04:00:00Z').admit, true, 'ET midnight starting the day before');
  assert.equal(at('2026-10-17T03:59:00Z').admit, false, 'one minute earlier is still two days before in ET');
  assert.equal(at('2026-10-18').admit, true, 'a date-only value is that calendar date');
  assert.equal(at('2026-10-17').admit, true);
  assert.equal(at('2026-10-19').admit, true);
  assert.equal(at('2026-10-20').admit, false);
  assert.equal(at('2026-10-20T03:59:00Z').admit, true, '23:59 ET the day after');
  assert.equal(at('2026-10-20T04:00:00Z').admit, false, 'midnight ET, two days after');
  assert.equal(at('2026-10-19T21:00:00-04:00').admit, true, '9pm ET the day after, written with an offset');
  // West End: the same instants judged in London.
  assert.equal(at('2026-10-19T23:30:00Z', { timeZone: 'Europe/London' }).admit, false, '00:30 BST on the 20th is two days after');
  assert.equal(at('2026-10-19T23:30:00Z').admit, true, 'the same instant is 7:30pm ET on the 19th');
  assert.equal(at(new Date('2026-10-19T03:00:00Z')).admit, true, 'a Date object is an instant: 23:00 ET on the night itself');
  assert.deepEqual(at(new Date('nope')), { admit: false, reason: 'no-publish-date' });
  // Anything whose calendar date would depend on the server's zone is refused.
  assert.deepEqual(at('2026-10-19T21:00:00'), { admit: false, reason: 'no-publish-date' });
  assert.deepEqual(at(null), { admit: false, reason: 'no-publish-date' });
  assert.deepEqual(at('not a date'), { admit: false, reason: 'no-publish-date' });
  assert.deepEqual(at('2026-13-45'), { admit: false, reason: 'no-publish-date' });
  assert.equal(tm.admitLaneCandidate({ source: 'serp', night: NIGHT }).reason, 'unknown-source');
  assert.throws(() => tm.admitLaneCandidate({ source: 'aggregator', night: 'x' }), /bad night/);
});

test('isLaneReview: showId is required, seenAt must be plausible for the night, and openingDate (when given) must match the night', () => {
  const lane = tm.buildLaneReview({ ...base, fullText: longText });
  const noShowId = { ...lane }; delete noShowId.showId;
  assert.equal(tm.isLaneReview(noShowId), false, 'with no showId the stamp cannot be tied to a show');
  const gone = { ...lane, openingNightLane: { ...lane.openingNightLane, night: '1999-01-01', seenAt: '1999-01-01T12:00:00Z' } };
  assert.equal(tm.isLaneReview(gone), true, 'self-consistent on its own: the structure alone cannot know the show\'s real opening night');
  assert.equal(tm.isLaneReview(gone, { openingDate: '2026-10-18' }), false, 'which is why every guard-wiring caller must pass the show\'s openingDate');
  const stale = { ...lane, openingNightLane: { ...lane.openingNightLane, seenAt: '2026-01-01T00:00:00Z' } };
  assert.equal(tm.isLaneReview(stale), false, 'seen nine months before the night it claims');
  const late = { ...lane, openingNightLane: { ...lane.openingNightLane, seenAt: '2026-10-23T00:00:00Z' } };
  assert.equal(tm.isLaneReview(late), false, 'seen five days after');
  assert.equal(tm.isLaneReview({ ...lane, openingNightLane: { ...lane.openingNightLane, seenAt: '2026-10-21T23:59:00Z' } }), true, 'seen up to the end of night + 3 days is fine');
  assert.equal(tm.isLaneReview(lane, { openingDate: '2026-10-18' }), true);
  assert.equal(tm.isLaneReview(lane, { openingDate: '2026-10-18T00:00:00-04:00' }), true, 'only the date part of openingDate counts');
  assert.equal(tm.isLaneReview(lane, { openingDate: '2026-10-25' }), false, 'a stamp for a night that is not this show\'s opening night');
  assert.equal(tm.laneBypasses(lane, 'nonReview', { openingDate: '2026-10-25' }), false, 'laneBypasses forwards the ctx');
  assert.equal(tm.laneBypasses(lane, 'nonReview', { openingDate: '2026-10-18' }), true);
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

test('laneReviewFilename: stays idempotent once versioned, and accepts file records as well as url strings', () => {
  const args = { outletId: 'nytimes', criticName: 'Jesse Green', night: NIGHT };
  const url1 = 'https://www.nytimes.com/2026/10/19/theater/one.html';
  const url2 = 'https://www.nytimes.com/2026/10/19/theater/two.html';
  const plain = tm.laneReviewFilename({ ...args, url: url1 }).filename;
  const second = tm.laneReviewFilename({ ...args, url: url2, existing: { [plain]: { url: url1 } } });
  assert.equal(second.reuse, false);
  const existing = { [plain]: { url: url1 }, [second.filename]: { url: url2 } };
  assert.deepEqual(tm.laneReviewFilename({ ...args, url: url2, existing }), { filename: second.filename, reuse: true }, 'the third write of the same URL finds its versioned file');
  assert.deepEqual(tm.laneReviewFilename({ ...args, url: url1, existing }), { filename: plain, reuse: true });
  const third = tm.laneReviewFilename({ ...args, url: 'https://www.nytimes.com/2026/10/19/theater/three.html', existing });
  assert.equal(third.reuse, false);
  assert.notEqual(third.filename, second.filename);
  assert.notEqual(third.filename, plain);
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

test('paywallFallbackScore: blank, zero or non-numeric stars never become a score; numeric strings do', () => {
  for (const junk of ['', ' ', 0, '0', false, true, NaN, '4 stars', 'four', {}, [], -1, 5.5]) {
    assert.equal(tm.paywallFallbackScore({ stars: junk }), null, `stars ${JSON.stringify(junk)}`);
  }
  assert.deepEqual(tm.paywallFallbackScore({ stars: '4' }), { assignedScore: 80, scoreSource: 'lane-aggregator-stars' });
  assert.deepEqual(tm.paywallFallbackScore({ stars: ' 3.5 ' }), { assignedScore: 70, scoreSource: 'lane-aggregator-stars' });
  // Every legal half-star stays inside the CLAUDE.md bands: 2/5 31-50, 3/5 51-70, 4/5 71-90, 5/5 91-100.
  const band = { 2: [31, 50], 3: [51, 70], 4: [71, 90], 5: [91, 100] };
  for (const n of [2, 3, 4, 5]) {
    const v = tm.paywallFallbackScore({ stars: n }).assignedScore;
    assert.ok(v >= band[n][0] && v <= band[n][1], `${n} stars -> ${v}`);
  }
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
