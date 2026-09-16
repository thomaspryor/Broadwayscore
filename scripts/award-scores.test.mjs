import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeSiteAwardScore } = require('./snapshot-award-scores.js');

const ROOT = path.resolve(import.meta.dirname, '..');

test('computeSiteAwardScore: show with no awards entry is eligible/zero', () => {
  const result = computeSiteAwardScore('no-such-show', {}, 'broadway');
  assert.equal(result.displayScore, 0);
  assert.equal(result.rawPoints, 0);
  assert.equal(result.badge, 'eligible');
  assert.equal(result.inProgress, false);
});

test('computeSiteAwardScore: a single Tony S-tier win scores > 0 and badges "honored" or higher', () => {
  const awardsShows = {
    'show-a': {
      tony: { season: '2023-24', wins: ['Best Musical'], nominatedFor: [], nominations: 1 },
    },
  };
  const result = computeSiteAwardScore('show-a', awardsShows, 'broadway');
  assert.ok(result.rawPoints > 0, 'expected positive raw points for a Tony win');
  assert.ok(result.displayScore > 0, 'expected positive display score');
  assert.equal(result.tonyWins, 1);
  assert.notEqual(result.badge, 'eligible');
});

test('computeSiteAwardScore: revival discount reduces points vs an equivalent new production', () => {
  const newProduction = {
    tony: { season: '2023-24', wins: ['Best Musical'], nominatedFor: [], nominations: 1 },
  };
  const revival = {
    tony: { season: '2023-24', wins: ['Best Revival of a Musical'], nominatedFor: [], nominations: 1 },
  };
  const newResult = computeSiteAwardScore('new', { new: newProduction }, 'broadway');
  const revivalResult = computeSiteAwardScore('rev', { rev: revival }, 'broadway');
  assert.ok(revivalResult.rawPoints < newResult.rawPoints, 'revival discount should lower raw points');
});

test('computeSiteAwardScore: a nomination-only show is badged "nominated", never "eligible" once it has raw points', () => {
  const awardsShows = {
    'show-b': {
      tony: { season: '2025-26', wins: [], nominatedFor: ['Best Play'], nominations: 1 },
    },
  };
  const result = computeSiteAwardScore('show-b', awardsShows, 'broadway');
  assert.ok(result.rawPoints > 0);
  assert.equal(result.badge, 'nominated');
  assert.equal(result.tonyWins, 0);
});

test('computeSiteAwardScore: displayScore is always clamped to [0, 100]', () => {
  // Stack every ceremony's S-tier win onto one show — a pathological but
  // legal input shape (a show can't realistically win everything, but the
  // function must not produce a score outside the documented display range).
  const everyCeremonyWin = {
    tony: { season: '2023-24', wins: ['Best Musical'], nominatedFor: [], nominations: 1 },
    pulitzer: { wins: ['Drama'] },
    olivier: { wins: ['Best New Musical'], nominatedFor: [], nominations: 1 },
    nyDramaCritics: { wins: ['Best Musical'] },
    outerCriticsCircle: { wins: ['Outstanding New Musical'], nominatedFor: [], nominations: 1 },
    dramaLeague: { wins: ['Outstanding Revival'], nominatedFor: [] },
    dramadesk: { wins: ['Outstanding Musical'], nominatedFor: [], nominations: 1 },
    obie: { wins: ['Best New American Play'] },
    lortel: { wins: ['Outstanding Musical'], nominatedFor: [], nominations: 1 },
  };
  const result = computeSiteAwardScore('stacked', { stacked: everyCeremonyWin }, 'broadway');
  assert.ok(result.displayScore >= 0 && result.displayScore <= 100, `displayScore out of range: ${result.displayScore}`);
});

test('computeSiteAwardScore: real awards.json + shows.json data produces sane scores for every open Broadway show', () => {
  const awards = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'awards.json'), 'utf8'));
  const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const showsArr = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
  const openBroadway = showsArr.filter((s) => s.status === 'open' && s.category === 'broadway');
  assert.ok(openBroadway.length > 0, 'expected at least one open Broadway show in real data');

  for (const show of openBroadway) {
    const result = computeSiteAwardScore(show.id, awards.shows || {}, 'broadway');
    assert.ok(Number.isFinite(result.displayScore), `${show.id}: displayScore not finite`);
    assert.ok(result.displayScore >= 0 && result.displayScore <= 100, `${show.id}: displayScore out of range`);
    assert.ok(['eligible', 'nominated', 'honored', 'decorated', 'sweeper'].includes(result.badge), `${show.id}: unknown badge ${result.badge}`);
  }
});

test('snapshot-award-scores.js CLI: --stdout writes a well-formed snapshot for real data', () => {
  const out = execFileSync('node', ['scripts/snapshot-award-scores.js', '--date=2026-05-23', '--stdout'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const snapshot = JSON.parse(out);
  assert.equal(snapshot.snapshotDate, '2026-05-23');
  assert.equal(snapshot.market, 'broadway');
  assert.ok(snapshot.showCount > 0);
  assert.equal(Object.keys(snapshot.shows).length, snapshot.showCount);
});

// The next two tests use an isolated temp directory (via AWARD_SCORE_HISTORY_DIR)
// rather than the real data/award-score-history/ — ship-check review (BRO-1226)
// flagged that fixtures written into the real dir either collide with a future
// real snapshot's filename, or (for the "only one snapshot" case) silently
// start failing the day the fixed cron commits a genuine second snapshot.
// Both scripts fall back to the real dir when this env var is unset.

function withTempHistoryDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'award-score-history-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('award-score-movers.js CLI: single available snapshot returns an empty, non-erroring movers list', () => {
  withTempHistoryDir((dir) => {
    fs.writeFileSync(
      path.join(dir, '2026-05-23.json'),
      JSON.stringify({ snapshotDate: '2026-05-23', market: 'broadway', shows: { a: { title: 'A', displayScore: 10 } } })
    );
    const out = execFileSync('node', ['scripts/award-score-movers.js', '--week-start=2026-05-23'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, AWARD_SCORE_HISTORY_DIR: dir },
    });
    const result = JSON.parse(out);
    assert.equal(result.weekStart, '2026-05-23');
    assert.deepEqual(result.movers, []);
    assert.ok('note' in result);
  });
});

test('award-score-movers.js CLI: diffs two snapshots and ranks movers by absolute delta, exact order', () => {
  withTempHistoryDir((dir) => {
    fs.writeFileSync(
      path.join(dir, '2026-05-23.json'),
      JSON.stringify({
        snapshotDate: '2026-05-23',
        market: 'broadway',
        shows: {
          'big-mover': { title: 'Big Mover', displayScore: 10 },
          'small-mover': { title: 'Small Mover', displayScore: 20 },
          unchanged: { title: 'Unchanged', displayScore: 50 },
          closed: { title: 'Closed Show', displayScore: 30 },
        },
      })
    );
    fs.writeFileSync(
      path.join(dir, '2026-05-30.json'),
      JSON.stringify({
        snapshotDate: '2026-05-30',
        market: 'broadway',
        shows: {
          'big-mover': { title: 'Big Mover', displayScore: 40 }, // +30
          'small-mover': { title: 'Small Mover', displayScore: 25 }, // +5
          unchanged: { title: 'Unchanged', displayScore: 50 }, // 0, excluded
          'new-show': { title: 'New Show', displayScore: 15 }, // +15 (absent before)
          // closed dropped from the snapshot entirely: -30
        },
      })
    );
    const out = execFileSync(
      'node',
      ['scripts/award-score-movers.js', '--week-start=2026-05-23', '--end=2026-05-30', '--top=3'],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, AWARD_SCORE_HISTORY_DIR: dir } }
    );
    const result = JSON.parse(out);
    assert.equal(result.weekStart, '2026-05-23');
    assert.equal(result.weekEnd, '2026-05-30');
    assert.equal(result.movers.length, 3, 'unchanged show must be excluded, leaving exactly 3 movers');
    assert.deepEqual(
      result.movers.map((m) => m.showId),
      ['big-mover', 'closed', 'new-show'],
      'must rank by descending absolute delta: +30, -30 (tie broken by insertion order), +15'
    );
    assert.equal(result.movers[0].delta, 30);
    assert.equal(result.movers[1].delta, -30);
    assert.equal(result.movers[1].presentAfter, false, 'closed show should be marked absent after');
    assert.equal(result.movers[2].delta, 15);
    assert.equal(result.movers[2].presentBefore, false, 'new show should be marked absent before');
  });
});
