/** Owner 2026-11-04: critic standing is shown in plain words, ranked only among peers with 5+ reviews. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignPositivityRanks, positivityPhrase, volumePhrase } from '../../src/lib/critic-standing';

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
