/**
 * Seen without a rating (BRO-7628). A show logged without stars is stored as
 * rating 0. Locks:
 *  - the helpers treat 0 (and null/negative) as "not rated", never "0.0";
 *  - a signed-out "seen" save (rating 0) survives local storage parsing;
 *  - every place in src/ that prints a user rating with .toFixed() sits behind
 *    an isRated() / > 0 guard, so a 0 row can never render as "0.0".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isRated, formatUserRating, NOT_RATED_LABEL, UNRATED_RATING, selectUnratedLoggedEntries } from '../../src/lib/unrated';
import { parseLocalRatings, upsertRating } from '../../src/lib/local-ratings';

test('helpers: 0 is not rated, half-stars are', () => {
  assert.equal(UNRATED_RATING, 0);
  assert.equal(isRated(0), false);
  assert.equal(isRated(null), false);
  assert.equal(isRated(undefined), false);
  assert.equal(isRated(-1), false);
  assert.equal(isRated(Number.NaN), false);
  assert.equal(isRated(0.5), true);
  assert.equal(isRated(5), true);
  assert.equal(formatUserRating(0), NOT_RATED_LABEL);
  assert.equal(formatUserRating(4.5), '4.5');
});

test('local ratings: a seen-but-unrated save (0) is kept; junk still dropped', () => {
  const list = upsertRating([], { showId: 'hadestown-2019', rating: 0, dateSeen: '2019-06-14' }, 1);
  assert.equal(list.length, 1);
  assert.equal(list[0].rating, 0);
  const parsed = parseLocalRatings(JSON.stringify([
    { showId: 'a', rating: 0, savedAt: 1 },
    { showId: 'b', rating: 0.25, savedAt: 1 },
    { showId: 'c', rating: -1, savedAt: 1 },
    { showId: 'd', rating: 6, savedAt: 1 },
  ]));
  assert.deepEqual(parsed.map(e => e.showId), ['a']);
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

// Matched lines must sit behind an isRated()/>0/>=0.5 check within the 15
// lines above (or on the line itself), or a seen-but-unrated row renders
// "0.0" / five empty stars.
const GUARD = /unrated-ok:|isRated\(|[rR]ating\)?\s*>=?\s*0(\.5)?\b|\.rating\s*>\s*0/;
const PATTERNS: [string, RegExp][] = [
  ['rating.toFixed()', /\b\w*[rR]ating\)?\.toFixed\(/],
  ['read-only stars of a stored rating', /<(StarRating|MiniStars)\b[^>]*\brating=\{\w+\.rating\}/],
];

test('class guard: every displayed user rating is behind an isRated() check', () => {
  const offenders: string[] = [];
  for (const file of walk('src')) {
    if (file.endsWith('src/lib/unrated.ts')) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const [what, re] of PATTERNS) {
        if (!re.test(line)) continue;
        const window = lines.slice(Math.max(0, i - 15), i + 1).join('\n');
        if (GUARD.test(window)) continue;
        offenders.push(`${file}:${i + 1} [${what}]: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `Unguarded user rating display:\n${offenders.join('\n')}`);
});

test('To Be Rated: shows logged only without stars, newest row, past only', () => {
  const rows = [
    { id: 'r3', show_id: 'a', rating: 0, date_seen: '2019-06-14' },
    { id: 'r2', show_id: 'a', rating: 0, date_seen: '2018-01-01' },
    { id: 'r1', show_id: 'b', rating: 0, date_seen: null },
    { id: 'r0', show_id: 'b', rating: 4, date_seen: '2017-01-01' },
    { id: 'rf', show_id: 'c', rating: 0, date_seen: '2099-01-01' },
  ];
  assert.deepEqual(selectUnratedLoggedEntries(rows, '2026-11-16'), [
    { id: 'unrated-r3', show_id: 'a', planned_date: '2019-06-14', edit: true },
  ]);
});
