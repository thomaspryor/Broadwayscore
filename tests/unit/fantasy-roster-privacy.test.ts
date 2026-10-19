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
import { rostersPublic, hiddenStandings } from '../../src/lib/fantasy-roster-privacy';

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
    assert.ok(stamps.length >= 4, 'both functions gate picks and the price snapshot');
    for (const s of stamps) {
      assert.equal(new Date(s).getTime(), deadline.getTime(), `SQL deadline ${s} must equal draftDeadline ${seasonConfig.draftDeadline}`);
    }
  });
});
