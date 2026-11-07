/**
 * Parity test: the site's per-entry scoring (src/lib/data-fantasy.ts +
 * src/config/fantasy.ts) must agree with the weekly pipeline's port
 * (scripts/lib/fantasy-helpers.js) on the same inputs. Both read the same
 * season config, so a rule change in one place without the other fails here.
 *
 * Run with: npx tsx --test tests/unit/fantasy-leaderboard-parity.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

import { entryPickPoints as tsEntryPickPoints, isValidLeaderboardEntry as tsValidEntry, getFantasyShows } from '../../src/lib/data-fantasy';
import { scoringFromDate as tsScoringFrom, isScoreLockedForEntry as tsLocked, nyDate as tsNyDate } from '../../src/config/fantasy';
import type { FantasyShowScore } from '../../src/config/fantasy';

const require = createRequire(import.meta.url);
const js = require('../../scripts/lib/fantasy-helpers.js');

const scores: FantasyShowScore[] = [
  {
    criticScorePoints: 30, audienceGradePoints: 25, boxOfficePoints: 12.5, awardsPoints: 40, totalPoints: 107.5,
    openingDate: '2026-11-15',
    weeklyBoxOffice: { '2026-10-11': 2.5, '2026-10-25': 3, '2026-11-01': 3, '2026-11-22': 4 },
    breakdown: { criticTier: 'Critical Gold', audienceGrade: 'A+', boxOfficeWeeks: 4, boxOfficeTotal: '$4.2M', awards: [] },
  },
  {
    criticScorePoints: 0, audienceGradePoints: 0, boxOfficePoints: 7, awardsPoints: 0, totalPoints: 7,
    openingDate: '2026-08-25',
    weeklyBoxOffice: { '2026-10-11': 7 },
    breakdown: { criticTier: 'Recommended (locked)', audienceGrade: 'A-', boxOfficeWeeks: 1, boxOfficeTotal: '$0.8M', awards: [] },
  },
  {
    // Audience grade public in previews (Nov 2) before a Nov 20 opening.
    criticScorePoints: 20, audienceGradePoints: 16, boxOfficePoints: 0, awardsPoints: 0, totalPoints: 36,
    openingDate: '2026-11-20',
    audienceGradeSince: '2026-11-02',
    weeklyBoxOffice: {},
    breakdown: { criticTier: 'Recommended', audienceGrade: 'A-', boxOfficeWeeks: 0, boxOfficeTotal: '$0', awards: [] },
  },
  {
    criticScorePoints: 12, audienceGradePoints: 6, boxOfficePoints: 0, awardsPoints: 4, totalPoints: 22,
    openingDate: null,
    breakdown: { criticTier: 'Worth Seeing', audienceGrade: 'B', boxOfficeWeeks: 0, boxOfficeTotal: '$0', awards: [] },
  },
];

const createdAts = [
  '2026-10-01T12:00:00Z',
  '2026-11-01T23:30:00-04:00',
  '2026-11-02T12:00:00Z',
  '2026-10-25T23:30:00-04:00',
  '2026-10-26T02:00:00Z',
  '2026-11-15T23:00:00-05:00',
  '2026-11-16T12:00:00Z',
  // Inside the deadline grace: stamped 12:00:30am ET Nov 30, counts as Nov 29.
  '2026-11-30T05:00:30Z',
  '2027-03-31T23:00:00-04:00',
];

describe('TS ↔ JS parity: per-entry scoring', () => {
  for (const createdAt of createdAts) {
    test(`scoringFromDate / nyDate agree for ${createdAt}`, () => {
      assert.equal(tsScoringFrom(createdAt), js.scoringFromDate(createdAt));
      assert.equal(tsNyDate(createdAt), js.nyDate(createdAt));
    });

    for (let i = 0; i < scores.length; i++) {
      const score = scores[i];
      test(`entryPickPoints agree for score #${i} drafted ${createdAt}`, () => {
        const ts = tsEntryPickPoints(score, score.openingDate, createdAt);
        const port = js.entryPickPoints(score, score.openingDate, createdAt);
        assert.deepEqual(ts, port);
        assert.equal(tsLocked(score.openingDate, createdAt), js.isScoreLockedForEntry(score.openingDate, createdAt));
      });
    }
  }
});

describe('TS ↔ JS parity: which entries count', () => {
  // Real catalog, so budget/roster/ids come from the same data the site uses.
  const shows = getFantasyShows();
  const ids = Object.keys(shows).sort((a, b) => shows[a].price - shows[b].price);
  const cheap = ids.slice(0, 2);
  const priciest = ids.slice(-8);
  const cases: Array<{ name: string; picks: unknown[]; created_at?: string }> = [
    { name: 'two cheap shows', picks: cheap },
    { name: 'eight most expensive (over budget)', picks: priciest },
    { name: 'unknown id', picks: ['no-such-show'] },
    { name: 'nested array', picks: [[cheap[0]]] },
    { name: 'prototype key', picks: ['constructor'] },
    { name: 'duplicate', picks: [cheap[0], cheap[0]] },
    { name: 'empty', picks: [] },
    { name: 'nine picks', picks: ids.slice(0, 9) },
    { name: 'after the deadline', picks: cheap, created_at: '2030-01-01T00:00:00Z' },
    { name: 'just before the deadline', picks: cheap, created_at: '2026-11-30T04:59:00Z' },
  ];
  for (const c of cases) {
    test(`isValidLeaderboardEntry agrees: ${c.name}`, () => {
      const entry = { picks: c.picks as string[], created_at: c.created_at ?? '2026-11-01T12:00:00Z' };
      assert.equal(tsValidEntry(entry), js.isValidLeaderboardEntry(entry, shows));
    });
  }
  test('the valid and invalid cases really split', () => {
    assert.equal(tsValidEntry({ picks: cheap, created_at: '2026-11-01T12:00:00Z' }), true);
    assert.equal(tsValidEntry({ picks: priciest, created_at: '2026-11-01T12:00:00Z' }), false);
  });
});

describe('audience grade public in previews', () => {
  const preview = scores[2];
  test('drafted the day before the grade appeared: audience points count', () => {
    assert.equal(tsEntryPickPoints(preview, preview.openingDate, '2026-11-01T23:30:00-04:00').audience, 16);
  });
  test('drafted once the grade was public: no audience points, critic points still count', () => {
    const p = tsEntryPickPoints(preview, preview.openingDate, '2026-11-02T12:00:00Z');
    assert.equal(p.audience, 0);
    assert.equal(p.critic, 20);
  });
});
