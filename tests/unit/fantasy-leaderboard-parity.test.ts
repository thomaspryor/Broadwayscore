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

import { entryPickPoints as tsEntryPickPoints } from '../../src/lib/data-fantasy';
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
    criticScorePoints: 12, audienceGradePoints: 6, boxOfficePoints: 0, awardsPoints: 4, totalPoints: 22,
    openingDate: null,
    breakdown: { criticTier: 'Worth Seeing', audienceGrade: 'B', boxOfficeWeeks: 0, boxOfficeTotal: '$0', awards: [] },
  },
];

const createdAts = [
  '2026-10-01T12:00:00Z',
  '2026-10-25T23:30:00-04:00',
  '2026-10-26T02:00:00Z',
  '2026-11-15T23:00:00-05:00',
  '2026-11-16T12:00:00Z',
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
