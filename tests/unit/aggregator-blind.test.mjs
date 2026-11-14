// BRO-6910: a gap audit that found no Verdict/BWW article for a NYC opening
// that should have one is BLIND, never PASS. Requires the real functions (§15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isAggregatorBlind, roundupExpected, countMajorOutlets, majorOutletCountFor } = require('../../scripts/lib/aggregator-blind.js');
const { gradeShow, hasGap } = require('../../scripts/slow-market-grade.js');
const { freshnessMsFor, SLOW_MARKET_DAILY_FRESHNESS_MS } = require('../../scripts/lib/gap-audit-freshness.js');

const DAY = 86400000;
const NOW = Date.parse('2026-11-03T20:00:00Z');
const LEFTY = { id: 'clifford-odets-waiting-for-lefty-off-broadway-2026', category: 'off-broadway', status: 'open', openingDate: '2026-11-02' };
const BWAY = { ...LEFTY, id: 'some-broadway-show', category: 'broadway' };
const VERDICT = ['https://playbill.com/article/what-do-reviews-think-of-waiting-for-lefty-at-classic-stage-company'];
const REG = { vulture: { tier: 1 }, nysr: { tier: 2 }, nytg: { tier: 2 }, 'blog-x': { tier: 4 } };
// The live Lefty row on 2026-11-03: clean, no aggregator article found, audited 42.5h after the opening date.
const blindRow = { showId: LEFTY.id, aggregatorArticles: [], missing: [], flaggedMisses: [], dirOnly: [], computedAt: '2026-11-03T18:34:49Z' };

test('roundupExpected: every Broadway show; off-Broadway only with 2+ major outlets', () => {
  assert.equal(roundupExpected(BWAY), true);
  assert.equal(roundupExpected(LEFTY, 1), false);
  assert.equal(roundupExpected(LEFTY, 2), true);
  assert.equal(roundupExpected({ ...LEFTY, category: 'west-end' }, 9), false);
  assert.equal(roundupExpected(null, 9), false);
});

test('majorOutletCountFor: live reviews plus cross-show guard drops, tier 1-2 only, distinct', () => {
  // Lefty on prod: NYTG + NYSR + a blog live, Vulture dropped by the guard.
  const reviews = [{ showId: LEFTY.id, outletId: 'nysr' }, { showId: LEFTY.id, outletId: 'blog-x' }, { showId: 'other', outletId: 'nytg' }];
  const ledgerRows = [{ showId: LEFTY.id, outletId: 'vulture' }, { showId: LEFTY.id, outletId: 'nysr' }];
  assert.equal(majorOutletCountFor(LEFTY.id, { reviews, ledgerRows, registryOutlets: REG }), 2);
  assert.equal(majorOutletCountFor(LEFTY.id, { reviews, registryOutlets: REG }), 1, 'without the ledger only NYSR counts');
  assert.equal(countMajorOutlets(['unknown', null, 'blog-x'], REG), 0);
});

test('isAggregatorBlind: window is 36h to 30 days after opening, judged at audit time', () => {
  const opened = Date.parse('2026-11-02T00:00:00Z');
  assert.equal(isAggregatorBlind(BWAY, [], opened + 35 * 3600000), false, 'opening night ET: roundups not up yet');
  assert.equal(isAggregatorBlind(BWAY, [], opened + 37 * 3600000), true);
  assert.equal(isAggregatorBlind(BWAY, [], opened + 31 * DAY), false, 'past the 30-day Verdict search window');
  assert.equal(isAggregatorBlind(BWAY, undefined, NOW), true, 'a row with no article list proves nothing');
  assert.equal(isAggregatorBlind(BWAY, VERDICT, NOW), false);
  assert.equal(isAggregatorBlind({ ...BWAY, openingDate: null }, [], NOW), false);
});

test('isAggregatorBlind: off-Broadway is blind only when a roundup was expected', () => {
  assert.equal(isAggregatorBlind(LEFTY, [], NOW), false, 'no known majors: Verdict may never cover it');
  assert.equal(isAggregatorBlind(LEFTY, [], NOW, { majorOutletCount: 1 }), false);
  assert.equal(isAggregatorBlind(LEFTY, [], NOW, { majorOutletCount: 2 }), true);
});

test('gradeShow: the Lefty row grades BLIND and fails --check-gaps, and stays BLIND as it ages', () => {
  const g = gradeShow(blindRow, 3, LEFTY, NOW, { majorOutletCount: 2 });
  assert.equal(g.grade, 'BLIND');
  assert.equal(hasGap([{ grade: g.grade }]), true);
  // graded 40 days later, the row is still judged at its own audit time
  assert.equal(gradeShow(blindRow, 3, LEFTY, NOW + 40 * DAY, { majorOutletCount: 2 }).grade, 'BLIND');
  // the same row with the Verdict found and nothing missing is a real PASS
  const seen = gradeShow({ ...blindRow, aggregatorArticles: VERDICT }, 3, LEFTY, NOW, { majorOutletCount: 2 });
  assert.equal(seen.grade, 'PASS');
  assert.equal(hasGap([{ grade: seen.grade }]), false);
  // an off-Broadway show with under 2 majors stays PASS; old callers keep the old behaviour
  assert.equal(gradeShow(blindRow, 3, LEFTY, NOW, { majorOutletCount: 1 }).grade, 'PASS');
  assert.equal(gradeShow(blindRow, 3).grade, 'PASS');
});

test('freshness: a blind checkpoint entry is not clean, so it keeps the shorter re-audit', () => {
  const show = { ...LEFTY, openingDate: new Date(NOW - 10 * DAY).toISOString().slice(0, 10) };
  const clean = { at: new Date(NOW - DAY).toISOString(), gaps: 0, uncollected: 0, slowMarketResidual: 0 };
  assert.equal(freshnessMsFor(show, clean, { now: NOW }), SLOW_MARKET_DAILY_FRESHNESS_MS);
  assert.ok(freshnessMsFor(show, { ...clean, aggregatorBlind: true }, { now: NOW }) < SLOW_MARKET_DAILY_FRESHNESS_MS);
});
