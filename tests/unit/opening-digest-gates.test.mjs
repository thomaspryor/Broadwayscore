// Tests the live-site parity DISPLAY gates in send-opening-digest.js:
//   - critic score: getMarketMinReviews() → West End / Broadway = 5,
//     Off-West End / Off-Broadway = 3 (canonical, mirror of score-buckets.ts)
//   - audience grade: MIN_AUDIENCE_REVIEWS = 15
// Requires the REAL functions (CLAUDE.md rule 15) — no copied logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { minReviewsToShowScore, getAudience, MIN_AUDIENCE_REVIEWS, computeCriticScore, setOutletRegistryForTest } =
  require('../../scripts/send-opening-digest.js');
const { computeCriticScore: canonicalComputeCriticScore } = require('../../scripts/lib/compute-critic-score.js');

test('critic-score gate matches getMarketMinReviews', () => {
  assert.equal(minReviewsToShowScore('broadway'), 5);
  assert.equal(minReviewsToShowScore('off-broadway'), 3);
  assert.equal(minReviewsToShowScore('west-end'), 5); // canonical: WE matches Broadway
  assert.equal(minReviewsToShowScore('off-west-end'), 3);
  assert.equal(minReviewsToShowScore(undefined), 5); // unknown → Broadway floor
});

test('MIN_AUDIENCE_REVIEWS mirrors the site (15)', () => {
  assert.equal(MIN_AUDIENCE_REVIEWS, 15);
});

const buzz = (n) => ({
  shows: { x: { combinedScore: 42, designation: 'Mixed', sources: { a: { reviewCount: n } } } },
});

test('audience grade suppressed below 15 reviews', () => {
  for (const n of [0, 1, 14]) {
    const a = getAudience(buzz(n), 'x');
    assert.equal(a.score, null, `n=${n} should yield null score`);
    assert.equal(a.designation, null, `n=${n} should yield null designation`);
    assert.equal(a.reviewCount, n, 'reviewCount still reported');
  }
});

test('audience grade shown at >= 15 reviews', () => {
  for (const n of [15, 40]) {
    const a = getAudience(buzz(n), 'x');
    assert.equal(a.score, 42, `n=${n} should show score`);
    assert.equal(a.designation, 'Mixed');
  }
});

test('unknown show → null audience (no crash)', () => {
  assert.equal(getAudience(buzz(20), 'missing'), null);
});

// Regression for #1245: The Pass showed 73 in the digest email vs 70 on the
// live site. Root cause: send-opening-digest.js reimplemented tier-weighting
// locally and double-counted a multi-critic outlet's weight (two Theater
// Scene bylines on one show). The fix delegates to the canonical scorer
// (scripts/lib/compute-critic-score.js) — assert the digest's score can
// never drift from it, using the exact shape that triggered the bug.
test('digest critic score matches canonical scorer on a multi-critic outlet (The Pass shape)', () => {
  setOutletRegistryForTest({});
  const reviews = [
    { showId: 'x', outletId: 'theater-scene', criticName: 'Archive', assignedScore: 90, publishDate: '2026-08-08' },
    { showId: 'x', outletId: 'theater-scene', criticName: 'Darryl Reilly', assignedScore: 90, publishDate: '2026-08-03' },
    { showId: 'x', outletId: 'theatrely', criticName: 'Juan A. Ramirez', assignedScore: 78, publishDate: '2026-08-03' },
    { showId: 'x', outletId: 'theatermania', criticName: 'Unknown', assignedScore: 74, publishDate: '2026-08-04' },
    { showId: 'x', outletId: 'nyt-theater', criticName: 'Jonathan Mandell', assignedScore: 59, publishDate: '2026-08-04' },
    { showId: 'x', outletId: 'one-minute-critic', criticName: 'Jerry Portwood', assignedScore: 57, publishDate: '2026-08-04' },
    { showId: 'x', outletId: 'culturesauce', criticName: 'Unknown', assignedScore: 39, publishDate: '2026-08-03' },
  ];
  const canonical = canonicalComputeCriticScore(reviews, {}, 'off-broadway');
  const digestScore = computeCriticScore(reviews, 'off-broadway');
  assert.equal(digestScore, Math.round(canonical.s), 'digest score must equal the canonical (live-site) score, not a locally re-derived one');
  assert.equal(digestScore, 70, 'The Pass\'s real 7-review set canonically rounds to 70, not the 73 the pre-fix digest showed');
});

test('overdue broadcast lands in needsHelp with the gap, even when otherwise fine', async () => {
  const { isBroadcastOverdue, classifyRows } = require('../../scripts/send-opening-digest.js');
  const sentData = { shows: { 'overdue-alert:a': { sentAt: '2026-10-10T11:54:25Z' } } };
  assert.equal(isBroadcastOverdue(sentData, 'a'), true);
  assert.equal(isBroadcastOverdue(sentData, 'b'), false);
  assert.equal(isBroadcastOverdue(undefined, 'a'), false);
  const base = { daysFromToday: -2, excluded: false, important: true, broadcastEligible: true,
    qualifies: false, broadcastSent: false, broadcastDiscarded: false, reviewCount: 19, expected: 20, t1Count: 1 };
  const out = classifyRows([
    { ...base, id: 'a', broadcastOverdue: true, qualifyGap: 'T1 1/3' },
    { ...base, id: 'b', broadcastOverdue: false },
  ]);
  assert.deepEqual(out.needsHelp.map(r => r.id), ['a']);
  assert.deepEqual(out.needsHelp[0].helpReasons, ['broadcast overdue', 'short: T1 1/3']);
  assert.ok(!out.needsHelp.some(r => r.id === 'b'));
});
