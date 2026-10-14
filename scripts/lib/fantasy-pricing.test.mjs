// Unit tests for scripts/lib/fantasy-pricing.js — the pre-season EV model
// behind data/fantasy-league-frozen.json. Requires the real module (CLAUDE.md
// rule 15: no logic copied into tests).
//
// Run with: node --test scripts/lib/fantasy-pricing.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pricing = require('./fantasy-pricing.js');
const seasonConfig = require('../../src/config/fantasy-season.json');

const S = seasonConfig.scoring;
const base = {
  scoring: S,
  scoringStart: '2026-10-05',
  scoringEnd: '2027-06-13',
  weeklyGrossPriors: { 'musical-new': 830000, 'musical-revival': 1250000, 'play-new': 455000, 'play-revival': 870000 },
  getCriticLabel: (s) => (s >= 83 ? 'Critical Gold' : s >= 75 ? 'Recommended' : s >= 65 ? 'Worth Seeing' : s >= 55 ? 'Skippable' : 'Critical Miss'),
  criticScore: null,
  audienceGrade: null,
  criticLocked: false,
  trailingWeeklyGross: null,
  venueCapacity: null,
};

const newMusical = { id: 'm1', title: 'M1', type: 'musical', category: 'broadway', isRevival: false, openingDate: '2027-01-19', previewsStartDate: '2026-12-07', closingDate: null, status: 'upcoming' };
const newPlay = { id: 'p1', title: 'P1', type: 'play', category: 'broadway', isRevival: false, openingDate: '2026-11-15', previewsStartDate: '2026-10-17', closingDate: null, status: 'upcoming' };
const obPlay = { id: 'ob1', title: 'OB1', type: 'play', category: 'off-broadway', isRevival: false, openingDate: '2026-11-01', previewsStartDate: '2026-10-15', closingDate: null, status: 'upcoming' };

describe('tier priors', () => {
  test('every critic/audience prior row sums to 1', () => {
    for (const table of [pricing.CRITIC_TIER_PRIORS, pricing.AUDIENCE_GRADE_PRIORS]) {
      for (const [tier, row] of Object.entries(table)) {
        const sum = Object.values(row).reduce((a, b) => a + b, 0);
        assert.ok(Math.abs(sum - 1) < 1e-9, `tier ${tier} sums to ${sum}`);
      }
    }
  });

  test('prior labels match the scoring tables (no orphan tier names)', () => {
    for (const row of Object.values(pricing.CRITIC_TIER_PRIORS)) {
      for (const label of Object.keys(row)) assert.ok(label in S.criticScore, `unknown critic tier ${label}`);
    }
    for (const row of Object.values(pricing.AUDIENCE_GRADE_PRIORS)) {
      for (const label of Object.keys(row)) assert.ok(label in S.audienceGrade, `unknown grade ${label}`);
    }
  });

  test('clampTier defaults to 3 and clamps to 1..5', () => {
    assert.equal(pricing.clampTier(undefined), 3);
    assert.equal(pricing.clampTier(9), 5);
    assert.equal(pricing.clampTier(0), 1);
    assert.equal(pricing.clampTier('4'), 4);
  });
});

describe('boxOfficeWeeks', () => {
  test('counts from first performance to closing, clipped to the season', () => {
    const show = { ...newPlay, closingDate: '2027-01-10' };
    // 2026-10-17 → 2027-01-10 = 85 days = 12 full weeks
    assert.equal(pricing.boxOfficeWeeks(show, base), 12);
  });

  test('a play with no closing date assumes a limited run; a musical scales with its tier', () => {
    const playWeeks = pricing.boxOfficeWeeks(newPlay, base);
    assert.equal(playWeeks, 16);
    // tier 5: open-ended, 2026-12-07 → 2027-06-13 = 188 days = 26 weeks
    assert.equal(pricing.boxOfficeWeeks(newMusical, { ...base, tier: 5 }), 26);
    // tier 3 (default): 22-week run assumed
    assert.equal(pricing.boxOfficeWeeks(newMusical, base), 22);
    assert.equal(pricing.boxOfficeWeeks(newMusical, { ...base, tier: 1 }), 12);
  });

  test('priors.runWeeks overrides the default run length', () => {
    assert.equal(pricing.boxOfficeWeeks(newMusical, { ...base, runWeeks: 10 }), 10);
  });

  test('a show that closed before the season earns no weeks', () => {
    const closed = { ...newPlay, previewsStartDate: '2026-05-16', openingDate: '2026-05-18', closingDate: '2026-06-21' };
    assert.equal(pricing.boxOfficeWeeks(closed, base), 0);
  });
});

describe('weeklyGrossCeiling', () => {
  test('caps a small house below the type median', () => {
    const hayes = pricing.weeklyGrossCeiling(597, 'musical');
    assert.ok(hayes < 800000, `Hayes ceiling ${hayes} should be under the new-musical median`);
    assert.equal(pricing.weeklyGrossCeiling(null, 'play'), null);
  });
});

describe('buildCategoryField + expectedAwardsPoints', () => {
  const shows = [
    { id: 'a', type: 'musical', category: 'broadway', isRevival: false },
    { id: 'b', type: 'musical', category: 'broadway', isRevival: false },
    { id: 'c', type: 'musical', category: 'broadway', isRevival: false },
    { id: 'd', type: 'musical', category: 'broadway', isRevival: false },
    { id: 'e', type: 'musical', category: 'broadway', isRevival: false },
    { id: 'special', type: 'play', category: 'broadway', isRevival: false },
  ];
  const priors = { a: { tier: 5 }, b: { tier: 3 }, c: { tier: 3 }, d: { tier: 3 }, e: { tier: 1 }, special: { tier: 3, awardsEligible: false } };
  const field = pricing.buildCategoryField(shows, priors, { 'Best Musical': 4 });

  test('special events are excluded from the field', () => {
    assert.equal(field['Best Play'], undefined);
    assert.equal(field['Best Musical'].contenders.length, 5);
    assert.equal(field['Best Musical'].slots, 4);
  });

  test('nomination probability is capped and ordered by tier', () => {
    const a = pricing.expectedAwardsPoints(shows[0], priors.a, field, S.awards);
    const e = pricing.expectedAwardsPoints(shows[4], priors.e, field, S.awards);
    assert.ok(a.pTopNom <= 0.92);
    assert.ok(a.pTopNom > e.pTopNom);
    assert.ok(a.points > e.points);
  });

  test('a special event earns only a token awards expectation', () => {
    const sp = pricing.expectedAwardsPoints(shows[5], priors.special, field, S.awards);
    assert.ok(sp.points < 5);
    assert.equal(sp.pTopNom, 0);
  });
});

describe('projectShowPoints', () => {
  const field = pricing.buildCategoryField([newMusical, newPlay], { m1: { tier: 4 }, p1: { tier: 3 } });

  test('a locked (already opened) show earns no critic or audience points', () => {
    const locked = pricing.projectShowPoints(
      { ...newPlay, openingDate: '2026-08-25', previewsStartDate: '2026-08-14', closingDate: '2027-01-03', status: 'open' },
      { ...base, priors: { tier: 3 }, categoryField: field, criticLocked: true, criticScore: 77.6, audienceGrade: 'A-', trailingWeeklyGross: 780000 },
    );
    assert.equal(locked.criticScorePoints, 0);
    assert.equal(locked.audienceGradePoints, 0);
    assert.ok(locked.boxOfficePoints > 0, 'still earns box office');
    assert.ok(locked.breakdown.notes.some(n => /already public/.test(n)));
  });

  test('a higher tier projects more points, all else equal', () => {
    const lo = pricing.projectShowPoints(newMusical, { ...base, priors: { tier: 2 }, categoryField: field });
    const hi = pricing.projectShowPoints(newMusical, { ...base, priors: { tier: 5 }, categoryField: field });
    assert.ok(hi.totalPoints > lo.totalPoints);
    assert.ok(hi.criticScorePoints > lo.criticScorePoints);
    assert.ok(hi.boxOfficePoints > lo.boxOfficePoints);
  });

  test('Off-Broadway shows earn no box office and only small awards expectation', () => {
    const ob = pricing.projectShowPoints(obPlay, { ...base, priors: { tier: 3 }, categoryField: field });
    assert.equal(ob.boxOfficePoints, 0);
    assert.ok(ob.awardsPoints > 0 && ob.awardsPoints < 15);
    assert.ok(ob.totalPoints < 60);
  });

  test('a known CriticScore (opened after season start) is used verbatim', () => {
    const p = pricing.projectShowPoints(newPlay, { ...base, priors: { tier: 3 }, categoryField: field, criticScore: 90 });
    assert.equal(p.criticScorePoints, S.criticScore['Critical Gold']);
  });
});

describe('priceFromEV / calibrateK', () => {
  test('top-3 average lands on the target price', () => {
    const evs = [200, 180, 160, 100, 50, 10];
    const k = pricing.calibrateK(evs, { targetTopPrice: 33, topN: 3 });
    const top3 = evs.slice(0, 3).map(ev => ev * k);
    const avg = top3.reduce((a, b) => a + b, 0) / 3;
    assert.ok(Math.abs(avg - 33) < 1e-9);
    assert.equal(pricing.priceFromEV(evs[5], k), 5, 'floor at $5');
    assert.equal(pricing.priceFromEV(1000, k), 35, 'ceiling at $35');
    assert.equal(pricing.priceFromEV(NaN, k), 5);
  });

  test('calibrateK returns null without usable EVs', () => {
    assert.equal(pricing.calibrateK([]), null);
    assert.equal(pricing.calibrateK([0, 0]), null);
  });
});
