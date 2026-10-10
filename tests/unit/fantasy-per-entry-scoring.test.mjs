// Per-entry scoring rules for the Broadway Fantasy League (2026-27 relaunch).
// require()s the real functions from scripts/lib/fantasy-helpers.js
// (CLAUDE.md rule 15). The TS mirror in src/lib/data-fantasy.ts is checked
// against these same fixtures by tests/unit/fantasy-leaderboard-parity.test.ts.
//
// Run with: node --test tests/unit/fantasy-per-entry-scoring.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  nyDate,
  scoringFromDate,
  isScoreLockedForEntry,
  entryPickPoints,
  computeLeaderboard,
} = require('../../scripts/lib/fantasy-helpers.js');

// Fixed season so the tests don't drift when the real config moves.
const cfg = { scoringStart: '2026-10-05', earlyBirdCutoff: '2026-10-25' };

const score = {
  criticScorePoints: 20,
  audienceGradePoints: 16,
  boxOfficePoints: 9,
  awardsPoints: 5,
  totalPoints: 50,
  openingDate: '2026-10-18',
  weeklyBoxOffice: { '2026-10-11': 2, '2026-10-18': 3, '2026-11-01': 4 },
};

describe('nyDate', () => {
  test('converts UTC timestamps to the New York calendar date', () => {
    // 03:30 UTC on Oct 19 is still Oct 18 in New York (EDT, UTC-4).
    assert.equal(nyDate('2026-10-19T03:30:00Z'), '2026-10-18');
    assert.equal(nyDate('2026-10-19T04:30:00Z'), '2026-10-19');
  });
});

describe('scoringFromDate', () => {
  test('early-bird entries score from the season start', () => {
    assert.equal(scoringFromDate('2026-10-01T12:00:00Z', cfg), '2026-10-05');
    assert.equal(scoringFromDate('2026-10-25T23:00:00-04:00', cfg), '2026-10-05');
  });

  test('later entries score from the day they draft (NY time)', () => {
    assert.equal(scoringFromDate('2026-11-04T15:00:00Z', cfg), '2026-11-04');
    // 02:00 UTC Oct 26 is Oct 25 in New York, still an early bird.
    assert.equal(scoringFromDate('2026-10-26T02:00:00Z', cfg), '2026-10-05');
  });

  test('missing created_at falls back to the season start', () => {
    assert.equal(scoringFromDate(undefined, cfg), '2026-10-05');
  });
});

describe('isScoreLockedForEntry', () => {
  test('locked when the show opened on or before the draft day', () => {
    assert.equal(isScoreLockedForEntry('2026-10-18', '2026-10-18T23:30:00-04:00'), true, 'opening night, after reviews');
    assert.equal(isScoreLockedForEntry('2026-10-18', '2026-10-19T12:00:00Z'), true);
    assert.equal(isScoreLockedForEntry('2026-08-25', '2026-10-05T12:00:00Z'), true, 'already-open show');
  });

  test('open when the entry drafted before opening night', () => {
    assert.equal(isScoreLockedForEntry('2026-10-18', '2026-10-17T23:59:00-04:00'), false);
    assert.equal(isScoreLockedForEntry('2027-04-18', '2026-10-05T12:00:00Z'), false);
  });

  test('never locked without an opening date', () => {
    assert.equal(isScoreLockedForEntry(null, '2026-10-05T12:00:00Z'), false);
  });
});

describe('entryPickPoints', () => {
  test('early bird drafted before opening: full critic/audience, all season box office, awards', () => {
    const p = entryPickPoints(score, score.openingDate, '2026-10-02T12:00:00Z', cfg);
    assert.deepEqual(p, { critic: 20, audience: 16, boxOffice: 9, awards: 5, total: 50, locked: false });
  });

  test('drafted after opening: critic and audience locked, box office from that week, awards intact', () => {
    // Drafted Wed Oct 21 → scoring from 2026-10-21 → weeks ending Nov 1 only
    const p = entryPickPoints(score, score.openingDate, '2026-10-28T12:00:00Z', cfg);
    assert.equal(p.locked, true);
    assert.equal(p.critic, 0);
    assert.equal(p.audience, 0);
    assert.equal(p.boxOffice, 4);
    assert.equal(p.awards, 5);
    assert.equal(p.total, 9);
  });

  test('box office counts the grosses week that contains the draft day', () => {
    // Drafted Mon Oct 26 (late entry) → week ending Nov 1 counts, Oct 18 does not
    const p = entryPickPoints(score, '2027-04-18', '2026-10-26T15:00:00Z', cfg);
    assert.equal(p.boxOffice, 4);
    assert.equal(p.locked, false);
  });

  test('legacy score without weekly breakdown is all-or-nothing', () => {
    const legacy = { ...score, weeklyBoxOffice: undefined };
    assert.equal(entryPickPoints(legacy, '2027-04-18', '2026-10-02T12:00:00Z', cfg).boxOffice, 9);
    assert.equal(entryPickPoints(legacy, '2027-04-18', '2026-11-02T12:00:00Z', cfg).boxOffice, 0);
  });

  test('missing score contributes nothing', () => {
    assert.equal(entryPickPoints(null, '2026-10-18', '2026-10-02T12:00:00Z', cfg).total, 0);
  });
});

describe('computeLeaderboard (per-entry rules)', () => {
  const shows = {
    'opened-early': { title: 'Opened Early', price: 10, openingDate: '2026-08-25' },
    'opens-later': { title: 'Opens Later', price: 20, openingDate: '2026-11-15' },
  };
  const showScores = {
    'opened-early': { criticScorePoints: 0, audienceGradePoints: 0, boxOfficePoints: 10, awardsPoints: 0, totalPoints: 10, openingDate: '2026-08-25', weeklyBoxOffice: { '2026-10-11': 5, '2026-11-22': 5 } },
    'opens-later': { criticScorePoints: 30, audienceGradePoints: 20, boxOfficePoints: 6, awardsPoints: 0, totalPoints: 56, openingDate: '2026-11-15', weeklyBoxOffice: { '2026-11-22': 6 } },
  };

  test('an early bird outscores a late drafter with the same roster', () => {
    const entries = [
      { id: 'early', email: 'a@x.com', team_name: 'Early', picks: ['opened-early', 'opens-later'], created_at: '2026-10-03T12:00:00Z' },
      { id: 'late', email: 'b@x.com', team_name: 'Late', picks: ['opened-early', 'opens-later'], created_at: '2026-11-20T12:00:00Z' },
    ];
    const board = computeLeaderboard(entries, showScores, shows, cfg);
    const early = board.find(e => e.displayName === 'Early');
    const late = board.find(e => e.displayName === 'Late');
    assert.equal(early.totalPoints, 66, 'all box office + full critic/audience');
    assert.equal(early.scoringFrom, '2026-10-05');
    assert.equal(late.totalPoints, 11, 'only post-draft box office; critic/audience locked');
    assert.equal(late.scoringFrom, '2026-11-20');
    assert.equal(late.picks[1].scoreLocked, true);
    assert.equal(early.picks[1].scoreLocked, false);
    assert.equal(early.rank, 1);
    assert.equal(late.rank, 2);
  });

  test('pointBreakdown sums the per-pick pillars', () => {
    const entries = [{ id: 'e', email: 'a@x.com', team_name: null, picks: ['opens-later'], created_at: '2026-10-03T12:00:00Z' }];
    const [row] = computeLeaderboard(entries, showScores, shows, cfg);
    assert.deepEqual(row.pointBreakdown, { criticScore: 30, audienceGrade: 20, boxOffice: 6, awards: 0 });
  });
});
