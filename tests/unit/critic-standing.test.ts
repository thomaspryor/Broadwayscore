/** Owner 2026-11-04: critic standing is shown in plain words, ranked only among peers with 5+ reviews. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignPositivityRanks, positivityPhrase, volumePhrase, compareToConsensus, againstTheCrowd, signedGap, CONSENSUS_MIN_REVIEWS, CONSENSUS_IN_LINE_BAND } from '../../src/lib/critic-standing';

const mk = (reviewCount: number, avgScore: number) => ({ reviewCount, avgScore, generosityRank: -1 } as { reviewCount: number; avgScore: number; generosityRank: number; generosityPool?: number; peerMedianAvg?: number });

test('low-review critics are not ranked and get no phrase', () => {
  const ps = [mk(1, 99), mk(2, 95), ...Array.from({ length: 10 }, (_, i) => mk(20, 60 + i * 2))];
  assignPositivityRanks(ps);
  assert.equal(ps[0].generosityRank, 0);
  assert.equal(positivityPhrase(ps[0], 'critics'), null);
  assert.equal(ps[2].generosityPool, 10);
});

test('phrases run from most to least positive with the typical average', () => {
  const ps = Array.from({ length: 11 }, (_, i) => mk(30, 50 + i * 3)); // 50..80, median 65
  assignPositivityRanks(ps);
  assert.equal(positivityPhrase(ps[10], 'critics'), 'Among the most positive critics (typical average: 65)');
  assert.equal(positivityPhrase(ps[5], 'critics'), 'About as positive as most critics (typical average: 65)');
  assert.equal(positivityPhrase(ps[2], 'critics'), 'Less positive than most critics (typical average: 65)');
  assert.equal(positivityPhrase(ps[0], 'critics'), 'Among the least positive critics (typical average: 65)');
  for (const p of ps) assert.doesNotMatch(positivityPhrase(p, 'critics') || '', /scor|generous|\d+(st|nd|rd|th)/);
});

test('volume is only shown as a compliment', () => {
  assert.equal(volumePhrase(1, 'critic', 'critics'), 'Most reviews of any critic on the site');
  assert.equal(volumePhrase(7, 'critic', 'critics'), 'Top 10 critics by number of reviews');
  assert.equal(volumePhrase(42, 'outlet', 'outlets'), 'Top 50 outlets by number of reviews');
  assert.equal(volumePhrase(51, 'critic', 'critics'), null);
  assert.equal(volumePhrase(0, 'critic', 'critics'), null);
});

test('tied averages get the same words', () => {
  const ps = [...Array.from({ length: 10 }, (_, i) => mk(30, 50 + i)), mk(30, 70), mk(30, 70), mk(30, 70)];
  assignPositivityRanks(ps);
  const tied = ps.slice(10).map(p => positivityPhrase(p, 'critics'));
  assert.equal(new Set(tied).size, 1);
  assert.equal(ps[10].generosityRank, ps[12].generosityRank);
});

test('extreme tiers need 10+ reviews', () => {
  const ps = [mk(6, 95), mk(6, 20), ...Array.from({ length: 10 }, (_, i) => mk(30, 55 + i))];
  assignPositivityRanks(ps);
  assert.match(positivityPhrase(ps[0], 'critics')!, /^More positive than most/);
  assert.match(positivityPhrase(ps[1], 'critics')!, /^Less positive than most/);
});

// ---- BRO-6984: you vs. the consensus ----

test('consensus line: above, below and in line, using the rounded Critic Score', () => {
  assert.equal(compareToConsensus(83, { score: 71, reviewCount: 20 })?.phrase, "12 points above the show's Critic Score (71)");
  assert.equal(compareToConsensus(65, { score: 80, reviewCount: 20 })?.phrase, "15 points below the show's Critic Score (80)");
  assert.equal(compareToConsensus(70, { score: 67.6, reviewCount: 20 })?.phrase, "In line with the show's Critic Score (68)");
  assert.equal(compareToConsensus(68, { score: 68, reviewCount: 20 })?.diff, 0);
});

test('consensus band edges: exactly the band is in line, one more is not', () => {
  const c = { score: 70, reviewCount: 9 };
  assert.equal(compareToConsensus(70 + CONSENSUS_IN_LINE_BAND, c)?.phrase, "In line with the show's Critic Score (70)");
  assert.equal(compareToConsensus(70 - CONSENSUS_IN_LINE_BAND, c)?.phrase, "In line with the show's Critic Score (70)");
  assert.equal(compareToConsensus(70 + CONSENSUS_IN_LINE_BAND + 1, c)?.phrase, "6 points above the show's Critic Score (70)");
  assert.equal(compareToConsensus(63.6, c)?.phrase, "6 points below the show's Critic Score (70)"); // 64 vs 70 as displayed
});

test('consensus line is hidden with too few reviews or no score', () => {
  assert.equal(compareToConsensus(90, { score: 60, reviewCount: CONSENSUS_MIN_REVIEWS - 1 }), null);
  assert.ok(compareToConsensus(90, { score: 60, reviewCount: CONSENSUS_MIN_REVIEWS }));
  assert.equal(compareToConsensus(90, undefined), null);
  assert.equal(compareToConsensus(90, null), null);
  assert.equal(compareToConsensus(90, { score: NaN, reviewCount: 30 }), null);
});

test('never calls critics "scorers"', () => {
  for (const s of [40, 70, 100]) assert.ok(!/scorer/i.test(compareToConsensus(s, { score: 70, reviewCount: 10 })!.phrase));
});

test('against the crowd: biggest gaps first, one per show, needs 5 compared reviews and a 10-point gap', () => {
  const cons = {
    a: { score: 70, reviewCount: 10 }, b: { score: 60, reviewCount: 10 }, c: { score: 80, reviewCount: 10 },
    d: { score: 75, reviewCount: 10 }, e: { score: 50, reviewCount: 10 }, thin: { score: 50, reviewCount: 2 },
  };
  const reviews = [
    { showSlug: 'a', showTitle: 'A', reviewScore: 88 }, // +18
    { showSlug: 'b', showTitle: 'B', reviewScore: 38 }, // -22
    { showSlug: 'c', showTitle: 'C', reviewScore: 82 }, // +2
    { showSlug: 'd', showTitle: 'D', reviewScore: 66 }, // -9, under the gap
    { showSlug: 'e', showTitle: 'E', reviewScore: 61 }, // +11
    { showSlug: 'thin', showTitle: 'Thin', reviewScore: 100 }, // not comparable
  ];
  assert.deepEqual(againstTheCrowd(reviews, cons), [
    { showSlug: 'b', showTitle: 'B', diff: -22 },
    { showSlug: 'a', showTitle: 'A', diff: 18 },
  ]);
  assert.deepEqual(againstTheCrowd(reviews.slice(0, 4), cons), []); // only 4 comparable
  // two reviews of one show count as one show toward the floor
  assert.deepEqual(againstTheCrowd([...reviews.slice(0, 4), { showSlug: 'a', showTitle: 'A', reviewScore: 50 }], cons), []);
  assert.equal(signedGap(18), '+18');
  assert.equal(signedGap(-22), '−22');
});
