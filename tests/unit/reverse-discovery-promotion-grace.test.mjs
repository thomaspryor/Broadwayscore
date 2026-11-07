/**
 * BRO-6611: the "reviewed shows missing from shows.json" digest row flagged
 * "Middlemarch" (Guardian review, RSC) at "missing 0d", hours before the daily
 * promoter catalogued it by itself. Guardian reviews an automated promoter
 * stages get one promotion cycle (RD_PROMOTION_GRACE_HOURS) before they count;
 * everything else, and anything still missing after the grace, is reported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  isAutoPromotable,
  isAwaitingFirstPromotion,
  RD_PROMOTION_GRACE_HOURS,
} = require('../../scripts/lib/reverse-discovery-backlog.js');
const { candidateKey } = require('../../scripts/lib/reverse-discovery.js');
const { reverseDiscoveryBacklogResults } = require('../../scripts/health-check.js');

const NAME = 'Data: reviewed shows missing from shows.json';
const NOW = new Date('2026-10-30T08:29:00Z');
const H = 3600000;

const ukRsc = {
  title: 'Zzqx Regional Novel Play',
  source: 'guardian-review',
  market: 'uk-regional',
  venue: 'Royal Shakespeare Theatre, Stratford-upon-Avon',
  url: 'https://www.theguardian.com/stage/2026/oct/29/zzqx-regional-novel-play-review-royal-shakespeare-theatre-stratford',
  date: '2026-10-29T20:00:00Z',
};
const weAlmeida = {
  title: 'Zzqx London Play',
  source: 'guardian-review',
  market: 'west-end',
  url: 'https://www.theguardian.com/stage/2026/oct/29/zzqx-london-play-review-almeida-theatre-london',
  date: '2026-10-29T20:00:00Z',
};
const weNoHouse = { ...weAlmeida, title: 'Zzqx Other Play', url: 'https://www.theguardian.com/stage/2026/oct/29/zzqx-other-play-review-somewhere-unknown-london' };
const bww = { title: 'Zzqx Broadway Play', source: 'bww-roundup', market: 'nyc', url: 'https://www.broadwayworld.com/x' };

const stateSeen = (cands, iso) => Object.fromEntries(cands.map((c) => [candidateKey(c), { firstSeen: iso, title: c.title, source: c.source }]));
const report = (cands) => ({ generatedAt: new Date(NOW.getTime() - 2 * H).toISOString(), candidates: cands });

test('isAutoPromotable: only Guardian reviews a daily promoter stages', () => {
  assert.equal(isAutoPromotable(ukRsc), true);
  assert.equal(isAutoPromotable(weAlmeida), true);
  assert.equal(isAutoPromotable(weNoHouse), false, 'no curated Off-West End house: no promoter picks it up');
  assert.equal(isAutoPromotable({ ...ukRsc, venue: 'Some Village Hall' }), false);
  assert.equal(isAutoPromotable(bww), false);
  assert.equal(isAutoPromotable(null), false);
});

test('isAwaitingFirstPromotion: inside the grace only, with a known firstSeen', () => {
  const nowMs = NOW.getTime();
  const fresh = stateSeen([ukRsc], new Date(nowMs - 11 * H).toISOString());
  assert.equal(isAwaitingFirstPromotion(ukRsc, fresh, nowMs), true);
  const old = stateSeen([ukRsc], new Date(nowMs - (RD_PROMOTION_GRACE_HOURS + 1) * H).toISOString());
  assert.equal(isAwaitingFirstPromotion(ukRsc, old, nowMs), false);
  assert.equal(isAwaitingFirstPromotion(ukRsc, {}, nowMs), false, 'unknown age is never hidden');
  const future = stateSeen([ukRsc], new Date(nowMs + H).toISOString());
  assert.equal(isAwaitingFirstPromotion(ukRsc, future, nowMs), false);
  assert.equal(isAwaitingFirstPromotion(bww, stateSeen([bww], new Date(nowMs - H).toISOString()), nowMs), false);
});

test('reverseDiscoveryBacklogResults: a fresh auto-promotable Guardian review does not raise the row (Middlemarch replay)', () => {
  const firstSeen = '2026-10-29T21:15:29.647Z'; // Middlemarch's real firstSeen
  const rows = reverseDiscoveryBacklogResults(report([ukRsc, weAlmeida]), stateSeen([ukRsc, weAlmeida], firstSeen), NOW);
  const row = rows.find((r) => r.name === NAME);
  assert.ok(row, 'fresh report still emits the pass row');
  assert.equal(row.status, 'pass');
  assert.match(row.message, /2 new Guardian-reviewed show\(s\) awaiting the daily promotion run/);
});

test('reverseDiscoveryBacklogResults: still missing after the grace, or not auto-promotable, still warns', () => {
  const later = new Date('2026-10-31T08:29:00Z');
  const stale = reverseDiscoveryBacklogResults(report([ukRsc]), stateSeen([ukRsc], '2026-10-29T21:15:29.647Z'), later);
  assert.equal(stale.find((r) => r.name === NAME).status, 'warn');
  const mixed = reverseDiscoveryBacklogResults(report([ukRsc, weNoHouse, bww]), stateSeen([ukRsc, weNoHouse, bww], '2026-10-29T21:15:29.647Z'), NOW);
  const row = mixed.find((r) => r.name === NAME);
  assert.equal(row.status, 'warn');
  assert.match(row.message, /^2 aggregator-reviewed/);
  assert.doesNotMatch(row.message, /Zzqx Regional Novel Play/);
});
