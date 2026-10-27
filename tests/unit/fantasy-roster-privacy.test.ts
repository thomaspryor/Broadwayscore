/**
 * Other teams' picks stay hidden until the draft closes (owner decision
 * 2026-10-19: the game is guessing, not copying).
 * Run: npx tsx --test tests/unit/fantasy-roster-privacy.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import seasonConfig from '../../src/config/fantasy-season.json';
import { createRequire } from 'node:module';
import { rostersPublic, hiddenStandings, isHiddenRoster, HIDDEN_PICK } from '../../src/lib/fantasy-roster-privacy';
import { isValidLeaderboardEntry, computeLeaderboard } from '../../src/lib/data-fantasy';

const require = createRequire(import.meta.url);
const js = require('../../scripts/lib/fantasy-helpers.js');
const leagueShows = require('../../data/fantasy-league.json').shows as Record<string, unknown>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const deadline = new Date(seasonConfig.draftDeadline);

describe('roster privacy', () => {
  test('rosters are hidden while the draft is open and public once it closes', () => {
    assert.equal(rostersPublic(new Date(deadline.getTime() - 1000)), false);
    assert.equal(rostersPublic(new Date(deadline.getTime() + 1000)), true);
    assert.equal(rostersPublic(new Date('2026-10-19T12:00:00Z')), false, 'before the draft opens');
  });

  test('the hidden response carries team names and counts but no picks or points', () => {
    const body = hiddenStandings({ teams: ['Dolly Fans', 'a***@gmail.com'], totalEntries: 2, season: '2026-2027' });
    assert.deepEqual(body.entries, []);
    assert.deepEqual(body.teams, ['Dolly Fans', 'a***@gmail.com']);
    assert.equal(body.meta.picksHidden, true);
    assert.equal(body.meta.revealsOn, '2026-11-29');
    const json = JSON.stringify(body);
    assert.ok(!/picks"|points|rank/i.test(json.replace('picksHidden', '')), 'no pick, point or rank fields');
  });

  test('the database hides picks until the same deadline as the app', () => {
    const migrationsDir = path.join(__dirname, '../../supabase/migrations');
    const sql = fs.readdirSync(migrationsDir)
      .filter(f => /fantasy.*hide_rosters|hide_rosters.*fantasy/.test(f))
      .map(f => fs.readFileSync(path.join(migrationsDir, f), 'utf-8'))
      .join('\n');
    assert.ok(sql.length > 0, 'roster-hiding migration is missing');
    const stamps = [...sql.matchAll(/timestamptz '([^']+)'/g)].map(m => m[1]);
    assert.ok(stamps.length >= 6, 'both functions gate picks, the price snapshot and total_cost');
    assert.ok(sql.includes("'hidden'::text"), 'hidden rosters keep their size as placeholders');
    for (const s of stamps) {
      assert.equal(new Date(s).getTime(), deadline.getTime(), `SQL deadline ${s} must equal draftDeadline ${seasonConfig.draftDeadline}`);
    }
  });

  describe('teams the database hid still count', () => {
    const when = '2026-11-10T15:00:00Z';
    const during = new Date('2026-11-12T00:00:00Z'); // draft open
    const hidden = (n: number) => ({ picks: Array(n).fill(HIDDEN_PICK) as string[], created_at: when });

    test('an all-placeholder roster is valid in the site and the weekly pipeline, and stays in step', () => {
      for (const n of [1, 4, 8]) {
        assert.equal(isValidLeaderboardEntry(hidden(n), during), true, `site, ${n} picks`);
        assert.equal(js.isValidLeaderboardEntry(hidden(n), leagueShows, undefined, during.getTime()), true, `pipeline, ${n} picks`);
      }
    });

    test('placeholders do not open a loophole', () => {
      assert.equal(isHiddenRoster([]), false, 'no picks is not a roster');
      assert.equal(isHiddenRoster([HIDDEN_PICK, 'some-show']), false, 'mixed is not hidden');
      for (const bad of [hidden(0), hidden(9), { picks: [HIDDEN_PICK, 'not-a-show'], created_at: when }, { ...hidden(3), created_at: '2026-12-15T00:00:00Z' }, { ...hidden(3), created_at: '2026-09-01T00:00:00Z' }]) {
        assert.equal(isValidLeaderboardEntry(bad, during), false, `site rejects ${JSON.stringify(bad).slice(0, 60)}`);
        assert.equal(js.isValidLeaderboardEntry(bad, leagueShows, undefined, during.getTime()), false, `pipeline rejects ${JSON.stringify(bad).slice(0, 60)}`);
      }
    });

    test('after the reveal a placeholder roster is not a team (it cannot be inserted to fake one)', () => {
      const after = new Date(deadline.getTime() + 60_000);
      assert.equal(isValidLeaderboardEntry({ picks: [HIDDEN_PICK], created_at: '2026-11-10T15:00:00Z' }, after), false, 'site');
      assert.equal(js.isValidLeaderboardEntry({ picks: [HIDDEN_PICK], created_at: '2026-11-10T15:00:00Z' }, leagueShows, undefined, after.getTime()), false, 'pipeline');
    });

    test('the standings code keeps team names and counts for hidden rosters', () => {
      const entries = [
        { id: 'a', email: 'x***@gmail.com', team_name: 'Dolly Fans', league_name: 'friends', picks: Array(5).fill(HIDDEN_PICK), total_cost: null as unknown as number, season: '2026-2027', created_at: '2026-11-10T15:00:00Z' },
        { id: 'b', email: 'y***@gmail.com', team_name: null, league_name: 'friends', picks: Array(8).fill(HIDDEN_PICK), total_cost: null as unknown as number, season: '2026-2027', created_at: '2026-11-11T15:00:00Z' },
      ];
      const board = computeLeaderboard(entries, during);
      assert.equal(board.length, 2, 'both teams counted, so a league is not 404 and a search finds its team');
      assert.deepEqual(board.map(e => e.displayName).sort(), ['Dolly Fans', board.find(e => e.id === 'b')!.displayName].sort());
    });
  });
});
