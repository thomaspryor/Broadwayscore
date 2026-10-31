/**
 * Regression test for Tony attribution fixes shipped 2026-05-17.
 *
 * Pins three classes of invariant. Generic drift (any future show with
 * tony.season > 1y off openingDate, or any West End show with a tony block,
 * or any season+category with multiple unconfirmed winners) is caught by
 * scripts/validate-data.js. This file pins the SPECIFIC fixes that lived in
 * stale data and could regress via re-scrape OR silent merge clobber.
 *
 * Root cause:
 *   - Pre-2005 awards.json data was bootstrapped via title-only matching
 *     and got attached to wrong show IDs. scripts/scrape-tony-awards.js
 *     only covers 2005+, so pre-2005 misattributions persist.
 *   - Parallel sessions can silently revert single-commit fixes
 *     (see memory/feedback_silent_merge_loss_on_reformat.md).
 *
 * Run: node --test tests/unit/tony-attribution-canary.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const AWARDS_FILE = path.join(__dirname, '..', '..', 'data', 'awards.json');
const SHOWS_FILE = path.join(__dirname, '..', '..', 'data', 'shows.json');

const awards = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
const shows = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8')).shows || [];
const showsById = new Map(shows.map(s => [s.id, s]));

describe('Tony attribution canary (2026-05-17 fixes)', () => {
  it('the-boy-from-oz-2003 must be tagged 2003-04 (Hugh Jackman 2004 Tony, not 1969-70)', () => {
    const t = awards.shows['the-boy-from-oz-2003']?.tony;
    assert.ok(t, 'tony block missing — fix regressed via deletion or merge clobber');
    assert.strictEqual(t.season, '2003-04', 'season regressed to pre-fix value');
    assert.strictEqual(t.ceremony, '58th');
    assert.deepStrictEqual(t.wins, ['Best Actor in a Musical'],
      'wins changed — Hugh Jackman was the only winner from this show; verify against 2003-04 Tonys.');
  });

  it('red-2010 must be tagged 2009-10 with the 2010 Tony sweep (6 wins)', () => {
    const t = awards.shows['red-2010']?.tony;
    assert.ok(t, 'tony block missing — fix regressed via deletion or merge clobber');
    assert.strictEqual(t.season, '2009-10', 'season regressed to pre-fix value');
    assert.strictEqual(t.ceremony, '64th');
    const expectedWins = new Set([
      'Best Play',
      'Best Featured Actor in a Play',
      'Best Direction of a Play',
      'Best Scenic Design of a Play',
      'Best Lighting Design of a Play',
      'Best Sound Design of a Play',
    ]);
    const actualWins = new Set(t.wins || []);
    assert.deepStrictEqual(actualWins, expectedWins,
      `wins changed — verify against 2010 Tonys. Got: ${JSON.stringify([...actualWins])}`);
  });

  it('No non-Broadway show has a tony block (Tonys are Broadway-only)', () => {
    // Gate on category, not market — Off-Broadway shows have market='broadway'.
    const offenders = [];
    for (const [id, a] of Object.entries(awards.shows)) {
      if (!a.tony) continue;
      const sh = showsById.get(id);
      if (sh && sh.category && sh.category !== 'broadway') offenders.push(`${id} (${sh.category})`);
    }
    assert.deepStrictEqual(offenders, [],
      `Non-Broadway shows must not have tony blocks: ${offenders.join(', ')}`);
  });

  it('Pre-2005 misattributed shows have no tony block (scrape-tony-awards.js skips pre-2005)', () => {
    // These were deleted because their stored data belonged to a different
    // production. scrape-tony-awards.js only covers 2005+, so for these
    // pre-2005 shows a tony block reappearing means a silent merge clobber.
    const PRE_2005_DELETIONS = [
      'grease-1994',
      'fiddler-on-the-roof-1976',
      'out-cry-1973',
      'play-on-1997',
      'purlie-1972',
      'a-day-in-the-death-of-joe-egg-2003',  // 2003-04 is the boundary; scrape covers 2005+ only
    ];
    const reverted = [];
    for (const id of PRE_2005_DELETIONS) {
      if (awards.shows[id]?.tony) reverted.push(id);
    }
    assert.deepStrictEqual(reverted, [],
      `Pre-2005 misattributions reappeared (silent merge clobber?): ${reverted.join(', ')}`);
  });

  it('Removed dup-winner attributions stay removed', () => {
    const stillWrong = [];
    const removed = {
      'porgy-and-bess-1976': 'Best Actress in a Musical',
      'the-cherry-orchard-1977': 'Best Costume Design',
      'talleys-folly-1980': 'Best Scenic Design',
      'little-me-1982': 'Best Actor in a Musical',
      'you-cant-take-it-with-you-1983': 'Best Actress in a Play',
    };
    for (const [id, wrongWin] of Object.entries(removed)) {
      const wins = awards.shows[id]?.tony?.wins || [];
      if (wins.includes(wrongWin)) stillWrong.push(`${id}: ${wrongWin}`);
    }
    const cab = awards.shows['cabaret-1987']?.tony?.wins || [];
    for (const wrongWin of ['Best Actor in a Musical', 'Best Actress in a Musical', 'Best Featured Actor in a Musical']) {
      if (cab.includes(wrongWin)) stillWrong.push(`cabaret-1987: ${wrongWin}`);
    }
    assert.deepStrictEqual(stillWrong, [],
      `Wrongly-attributed Tony wins re-introduced: ${stillWrong.join(', ')}`);
  });
});
