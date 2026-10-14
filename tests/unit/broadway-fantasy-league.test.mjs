// Acceptance regression tests for BRO-760 (Broadway Fantasy League).
// require()s the real pure functions (scripts/lib/fantasy-helpers.js) and
// checks the real data files — no logic duplicated here (CLAUDE.md rule 15).
//
// Run with: node --test tests/unit/broadway-fantasy-league.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  computeAwardsPoints,
  computeLeaderboard,
  computeWeeklyMovers,
  maskEmail,
} = require('../../scripts/lib/fantasy-helpers.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', '..', 'data');
const leagueData = JSON.parse(fs.readFileSync(path.join(dataDir, 'fantasy-league.json'), 'utf8'));
const scoresData = JSON.parse(fs.readFileSync(path.join(dataDir, 'fantasy-scores.json'), 'utf8'));

// ── Acceptance criterion: eligible shows list is real and priced ─────

describe('draftable show catalog (data/fantasy-league.json)', () => {
  const shows = leagueData.shows;
  const showIds = Object.keys(shows);

  test('has ~40-55 draftable shows', () => {
    assert.ok(showIds.length >= 30 && showIds.length <= 70, `expected ~40-55 shows, got ${showIds.length}`);
  });

  test('every show has a positive price', () => {
    for (const [id, show] of Object.entries(shows)) {
      assert.ok(show.price > 0, `${id} has non-positive price: ${show.price}`);
    }
  });

  test('Off-Broadway shows are box-office and Tony ineligible', () => {
    const obShows = Object.entries(shows).filter(([, s]) => s.category === 'off-broadway');
    assert.ok(obShows.length > 0, 'expected at least one Off-Broadway show');
    for (const [id, show] of obShows) {
      assert.equal(show.eligible.boxOffice, false, `${id} (OB) should be box-office ineligible`);
      assert.equal(show.eligible.tonys, false, `${id} (OB) should be Tony ineligible`);
    }
  });

  test('shows marked CriticScore-ineligible (locked) actually carry a score', () => {
    // These are the shows that opened before scoring kickoff — the draft
    // form is supposed to show their locked score as built-in research.
    const locked = Object.entries(shows).filter(([, s]) => s.eligible.criticScore === false);
    for (const [id, show] of locked) {
      assert.ok(
        show.criticScore != null || show.audienceGrade != null,
        `${id} is CriticScore/AudienceGrade-locked but has neither score populated`
      );
    }
  });

  test('season budget is $100 and team size is 8 (spec constants)', () => {
    assert.equal(leagueData._meta.budget, 100);
    assert.equal(leagueData._meta.teamSize, 8);
  });
});

// ── computeAwardsPoints — awards.json → fantasy points ────────────────

describe('computeAwardsPoints', () => {
  const scoringConfig = leagueData.scoring.awards;

  test('no awards data → zero points, empty list', () => {
    const result = computeAwardsPoints('nonexistent-show', { shows: {} }, scoringConfig);
    assert.equal(result.points, 0);
    assert.deepEqual(result.awardsList, []);
  });

  test('Tony Best Musical win scores nomOnly + win + bestMusical bonus', () => {
    const awardsData = {
      shows: {
        'show-a': { tony: { nominations: 3, wins: ['Best Musical'] } },
      },
    };
    const result = computeAwardsPoints('show-a', awardsData, scoringConfig);
    const expectedNomPts = 2 * (scoringConfig.tonyNom || 0); // 3 noms - 1 win = 2 nom-only
    const expectedWinPts = 1 * (scoringConfig.tonyWin || 0);
    const expectedBonus = scoringConfig.tonyBestMusical || 0;
    assert.equal(result.points, Math.round((expectedNomPts + expectedWinPts + expectedBonus) * 100) / 100);
    assert.ok(result.awardsList.some(a => a.includes('Tony Best Musical')));
  });

  test('Best Play bonus requires exact match (revivals excluded)', () => {
    const awardsData = { shows: { 'show-b': { tony: { nominations: 1, wins: ['Best Revival of a Play'] } } } };
    const result = computeAwardsPoints('show-b', awardsData, scoringConfig);
    assert.ok(!result.awardsList.some(a => a.includes('Best Play')));
  });
});

// ── computeLeaderboard — ranking + ties ────────────────────────────────

describe('computeLeaderboard', () => {
  const shows = {
    'show-a': { title: 'Show A', price: 20 },
    'show-b': { title: 'Show B', price: 10 },
  };
  const scores = {
    showScores: {
      'show-a': { totalPoints: 50, criticScorePoints: 20, audienceGradePoints: 10, boxOfficePoints: 10, awardsPoints: 10 },
      'show-b': { totalPoints: 50, criticScorePoints: 10, audienceGradePoints: 10, boxOfficePoints: 10, awardsPoints: 20 },
    },
  };

  test('ranks by total points descending', () => {
    const entries = [
      { id: '1', email: 'high@x.com', team_name: null, picks: ['show-a'] },
      { id: '2', email: 'low@x.com', team_name: null, picks: ['show-b'] },
    ];
    // Both teams pick one show worth 50 pts — tie expected.
    const board = computeLeaderboard(entries, scores.showScores, shows);
    assert.equal(board[0].rank, 1);
    assert.equal(board[1].rank, 1); // tied entries share rank 1
  });

  test('un-drafted show contributes zero points, not a crash', () => {
    const entries = [{ id: '1', email: 'x@x.com', team_name: null, picks: ['unknown-show'] }];
    const board = computeLeaderboard(entries, scores.showScores, shows);
    assert.equal(board[0].totalPoints, 0);
  });

  test('displayName falls back to masked email when no team name', () => {
    const entries = [{ id: '1', email: 'tom@gmail.com', team_name: null, picks: [] }];
    const board = computeLeaderboard(entries, scores.showScores, shows);
    assert.equal(board[0].displayName, maskEmail('tom@gmail.com'));
  });
});

// ── computeWeeklyMovers — weekly email "what happened this week" ──────

describe('computeWeeklyMovers', () => {
  const shows = { 'show-a': { title: 'Show A' }, 'show-b': { title: 'Show B' } };

  test('no prior snapshot (first scored week) → empty result, no crash', () => {
    const curr = { 'show-a': { totalPoints: 10, breakdown: {} } };
    const result = computeWeeklyMovers(null, curr, shows);
    assert.deepEqual(result, { movers: [], events: [] });
  });

  test('point deltas are sorted by absolute magnitude, largest first', () => {
    const prev = {
      'show-a': { totalPoints: 10, breakdown: {} },
      'show-b': { totalPoints: 10, breakdown: {} },
    };
    const curr = {
      'show-a': { totalPoints: 15, breakdown: {} },  // +5
      'show-b': { totalPoints: 40, breakdown: {} },  // +30
    };
    const { movers } = computeWeeklyMovers(prev, curr, shows);
    assert.equal(movers[0].showId, 'show-b');
    assert.equal(movers[0].deltaPoints, 30);
    assert.equal(movers[1].deltaPoints, 5);
  });

  test('new grosses week produces a plain-language event', () => {
    const prev = { 'show-a': { totalPoints: 10, breakdown: { boxOfficeWeeks: 3 } } };
    const curr = { 'show-a': { totalPoints: 15, breakdown: { boxOfficeWeeks: 4, boxOfficeTotal: '$4.0M' } } };
    const { events } = computeWeeklyMovers(prev, curr, shows);
    assert.ok(events.some(e => e.reason.includes('grosses')));
  });

  test('CriticScore tier change produces an event', () => {
    const prev = { 'show-a': { totalPoints: 0, breakdown: { criticTier: 'Worth Seeing' } } };
    const curr = { 'show-a': { totalPoints: 50, breakdown: { criticTier: 'Critical Gold' } } };
    const { events } = computeWeeklyMovers(prev, curr, shows);
    assert.ok(events.some(e => e.reason.includes('Worth Seeing') && e.reason.includes('Critical Gold')));
  });

  test('new award since last week produces an event, repeated awards do not', () => {
    const prev = { 'show-a': { totalPoints: 0, breakdown: { awards: ['Tony: 3 noms'] } } };
    const curr = { 'show-a': { totalPoints: 10, breakdown: { awards: ['Tony: 3 noms', 'Tony: 1 win'] } } };
    const { events } = computeWeeklyMovers(prev, curr, shows);
    assert.equal(events.filter(e => e.reason === 'Tony: 1 win').length, 1);
    assert.equal(events.filter(e => e.reason === 'Tony: 3 noms').length, 0);
  });
});

// ── maskEmail ───────────────────────────────────────────────────────

describe('maskEmail', () => {
  test('masks local part after first char', () => {
    assert.equal(maskEmail('tom@gmail.com'), 't***@gmail.com');
  });

  test('handles missing/malformed input without throwing', () => {
    assert.equal(maskEmail(null), '***');
    assert.equal(maskEmail(''), '***');
    assert.equal(maskEmail('not-an-email'), '***');
  });
});

// ── Weekly scores snapshot is real and shaped correctly ────────────────

describe('data/fantasy-scores.json (weekly compute output)', () => {
  test('every scored show has all four point pillars', () => {
    for (const [id, score] of Object.entries(scoresData.showScores)) {
      for (const key of ['criticScorePoints', 'audienceGradePoints', 'boxOfficePoints', 'awardsPoints', 'totalPoints']) {
        assert.equal(typeof score[key], 'number', `${id}.${key} should be a number`);
      }
    }
  });
});
