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
  nominationCount,
  fantasyJobWindow,
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
    // These are the shows that opened before the draft opened — the draft
    // form is supposed to show their locked score as built-in research.
    // A show locked because it opens in the last days before the draft has
    // no reviews yet; give the review pipeline a week after opening night.
    // Anchored to the catalog's own snapshot time (the frozen catalog is not
    // re-scored), not Date.now(), so the test doesn't decay as the clock moves.
    const snapshotMs = Date.parse(leagueData._meta.generatedAt);
    assert.ok(Number.isFinite(snapshotMs), '_meta.generatedAt must be a valid timestamp');
    const weekAgo = new Date(snapshotMs - 7 * 86400000).toISOString().slice(0, 10);
    const locked = Object.entries(shows).filter(([, s]) => s.eligible.criticScore === false && (!s.openingDate || s.openingDate <= weekAgo));
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

  test('a drafted show with no score yet contributes zero points, not a crash', () => {
    const entries = [{ id: '1', email: 'x@x.com', team_name: null, picks: ['show-b'] }];
    const board = computeLeaderboard(entries, {}, shows);
    assert.equal(board[0].totalPoints, 0);
  });

  test('entries the draft route would refuse are left out of the standings', () => {
    // The public anon key can insert rows straight into Supabase.
    const entries = [
      { id: 'ok', email: 'a@x.com', team_name: 'OK', picks: ['show-a'] },
      { id: 'unknown', email: 'b@x.com', team_name: null, picks: ['unknown-show'] },
      { id: 'empty', email: 'c@x.com', team_name: null, picks: [] },
      { id: 'dupe', email: 'd@x.com', team_name: null, picks: ['show-a', 'show-a'] },
      { id: 'nested', email: 'e@x.com', team_name: null, picks: [['show-a']] },
      { id: 'proto', email: 'f@x.com', team_name: null, picks: ['constructor'] },
      { id: 'late', email: 'g@x.com', team_name: null, picks: ['show-b'], created_at: '2030-01-01T00:00:00Z' },
    ];
    const board = computeLeaderboard(entries, scores.showScores, shows, { budget: 25 });
    assert.deepEqual(board.map(e => e.id), ['ok']);
    const overBudget = computeLeaderboard([{ id: 'x', email: 'h@x.com', picks: ['show-a', 'show-b'] }], scores.showScores, shows, { budget: 25 });
    assert.equal(overBudget.length, 0, '$30 roster on a $25 budget is refused');
  });

  test('displayName falls back to masked email when no team name', () => {
    const entries = [{ id: '1', email: 'tom@gmail.com', team_name: null, picks: ['show-b'] }];
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

// ── Awards data shapes the precursor scrapers actually write (BRO-5424) ──

describe('computeAwardsPoints on scraper-shaped records', () => {
  const sc = leagueData.scoring.awards;

  test('nominatedFor without a nominations count still scores nominations', () => {
    const awardsData = { shows: { s: { dramadesk: { season: '2026-27', wins: ['Outstanding Revival of a Play'], nominatedFor: ['Outstanding Revival of a Play', 'Outstanding Director of a Play', 'Outstanding Lead Performance in a Play'] } } } };
    const r = computeAwardsPoints('s', awardsData, sc);
    assert.equal(r.points, 2 * sc.dramaDeskNom + 1 * sc.dramaDeskWin);
  });

  test('a category nominated twice (two performers) counts twice; a win missing from nominatedFor counts', () => {
    assert.equal(nominationCount({ nominatedFor: ['Featured Actor', 'Featured Actor', 'Book'] }), 3);
    assert.equal(nominationCount({ nominatedFor: ['Book'], wins: ['Score'] }), 2);
    assert.equal(nominationCount({ nominations: 16, nominatedFor: ['A', 'B'] }), 16);
    // An explicit count wins over lists whose win names are worded differently.
    assert.equal(nominationCount({ nominations: 3, nominatedFor: ['Lighting Design for a Musical', 'Book', 'Score'], wins: ['Lighting Design of a Musical'] }), 3);
  });

  test('NY Drama Critics Circle wins score from the nyDramaCritics key', () => {
    const awardsData = { shows: { s: { nyDramaCritics: { season: '2026-27', wins: ['Best Musical'], nominatedFor: [] } } } };
    assert.equal(computeAwardsPoints('s', awardsData, sc).points, sc.nydccWin);
  });

  test('records from another season do not score when a season is given', () => {
    const awardsData = { shows: { s: { lortel: { season: '2025-26', wins: ['Outstanding Play'], nominatedFor: ['Outstanding Play'] }, tony: { season: '2026-27', nominations: 1, wins: [] } } } };
    const r = computeAwardsPoints('s', awardsData, sc, { season: '2026-27' });
    assert.equal(r.points, sc.tonyNom);
  });

  test('a record with no season does not score when a season is given (BRO-5548)', () => {
    const awardsData = { shows: { s: { lortel: { wins: ['Outstanding Play'], nominatedFor: ['Outstanding Play'] }, tony: { season: '2026-27', nominations: 1, wins: [] } } } };
    assert.equal(computeAwardsPoints('s', awardsData, sc, { season: '2026-27' }).points, sc.tonyNom);
    assert.ok(computeAwardsPoints('s', awardsData, sc).points > sc.tonyNom, 'without a season filter the record still scores');
  });

  test('every precursor ceremony in real awards.json scores its nominations', () => {
    const real = JSON.parse(fs.readFileSync(path.join(dataDir, 'awards.json'), 'utf8'));
    const [id] = Object.entries(real.shows).find(([, a]) => a.dramadesk && a.dramadesk.nominations == null && (a.dramadesk.nominatedFor || []).length > (a.dramadesk.wins || []).length) || [];
    assert.ok(id, 'awards.json has a Drama Desk record with nominatedFor only');
    const r = computeAwardsPoints(id, { shows: { [id]: { dramadesk: real.shows[id].dramadesk } } }, sc);
    assert.ok(r.awardsList.some(a => /Drama Desk: \d+ nom/.test(a)), `${id}: ${JSON.stringify(r.awardsList)}`);
  });
});

describe('fantasyJobWindow', () => {
  const cfg = { draftOpens: '2026-10-30', scoringEnd: '2027-06-13' };
  test('runs from two weeks before the draft opens through two weeks after Tony night', () => {
    assert.equal(fantasyJobWindow('2026-10-15', cfg).run, false);
    assert.equal(fantasyJobWindow('2026-10-16', cfg).run, true);
    assert.equal(fantasyJobWindow('2027-06-16', cfg).run, true, 'the Wednesday after Tony night scores the ceremony');
    assert.equal(fantasyJobWindow('2027-06-27', cfg).run, true);
    assert.equal(fantasyJobWindow('2027-06-28', cfg).run, false);
  });
  test('prices are provisional until the day before the draft opens', () => {
    assert.equal(fantasyJobWindow('2026-10-28', cfg).pricesProvisional, true);
    assert.equal(fantasyJobWindow('2026-10-29', cfg).pricesProvisional, false, 'last reprice deploys before the first entry');
    assert.equal(fantasyJobWindow('2026-10-30', cfg).pricesProvisional, false);
  });
});
