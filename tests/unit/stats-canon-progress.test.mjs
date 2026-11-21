/**
 * canonProgress — Best Musical / Best Play checklists and "Saw it before it won".
 *
 * Runs the REAL src/lib/stats/canon-progress.ts. Two traps: the comparison is
 * STRICT (seeing a show on ceremony day is not seeing it first), and the
 * ceremony date must be resolved through the season label rather than the
 * winner row's ceremony number, which is off by one upstream for ceremonies
 * ≥75 and would date every post-2021 winner a year late.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonProgress } from '../../src/lib/stats/canon-progress';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL = JSON.parse(readFileSync(join(ROOT, 'public/data/stats-canon.json'), 'utf8'));

const CANON = {
  ceremonies: [
    { ceremony: 73, date: '2019-06-09' },
    { ceremony: 74, date: '2021-09-26' },
    { ceremony: 75, date: '2022-06-12' },
    { ceremony: 76, date: '2023-06-11' },
  ],
  bestMusical: [
    { ceremony: 74, season: '2019-20', id: 'moulin-rouge-2019', t: 'Moulin Rouge!' },
    // Deliberately carries the upstream +1 ceremony number: A Strange Loop won
    // at the 75th (2022-06-12) but stats-canon.json tags it 76.
    { ceremony: 76, season: '2021-22', id: 'a-strange-loop-2022', t: 'A Strange Loop' },
  ],
  bestPlay: [{ ceremony: 76, season: '2021-22', id: 'the-lehman-trilogy-2021', t: 'The Lehman Trilogy' }],
};

const row = (show_id, date_seen) => ({ show_id, rating: '4.0', date_seen });

test('CEREMONY DATE: resolved via the season label, not the off-by-one ceremony number', () => {
  const r = canonProgress([], CANON);
  const loop = r.bestMusical.entries.find((e) => e.id === 'a-strange-loop-2022');
  assert.equal(loop.ceremonyDate, '2022-06-12', 'the 75th, not the 76th');
  const moulin = r.bestMusical.entries.find((e) => e.id === 'moulin-rouge-2019');
  assert.equal(moulin.ceremonyDate, '2021-09-26', 'the COVID-delayed 74th');
});

test('SAW IT BEFORE IT WON is strict — ceremony day itself does not count', () => {
  const before = canonProgress([row('a-strange-loop-2022', '2022-06-11')], CANON);
  assert.equal(before.bestMusical.entries.find((e) => e.id === 'a-strange-loop-2022').sawBeforeItWon, true);

  const onTheDay = canonProgress([row('a-strange-loop-2022', '2022-06-12')], CANON);
  assert.equal(
    onTheDay.bestMusical.entries.find((e) => e.id === 'a-strange-loop-2022').sawBeforeItWon,
    false
  );

  const after = canonProgress([row('a-strange-loop-2022', '2022-06-13')], CANON);
  assert.equal(after.bestMusical.entries.find((e) => e.id === 'a-strange-loop-2022').sawBeforeItWon, false);
});

test('the off-by-one would have been invisible: the 76th is a year later', () => {
  // If the reducer had trusted the winner row's ceremony number, this 2023
  // viewing would falsely read as "saw it before it won".
  const r = canonProgress([row('a-strange-loop-2022', '2023-01-01')], CANON);
  assert.equal(r.bestMusical.entries.find((e) => e.id === 'a-strange-loop-2022').sawBeforeItWon, false);
  assert.equal(r.totalSawBeforeItWon, 0);
});

test('a null date_seen can never count as seeing it first', () => {
  const r = canonProgress([row('a-strange-loop-2022', null)], CANON);
  const e = r.bestMusical.entries.find((x) => x.id === 'a-strange-loop-2022');
  assert.equal(e.seen, true, 'it is still seen');
  assert.equal(e.dateSeen, null);
  assert.equal(e.sawBeforeItWon, false);
});

test('repeat viewings use the EARLIEST date', () => {
  const rows = [row('a-strange-loop-2022', '2023-01-01'), row('a-strange-loop-2022', '2022-01-01')];
  const e = canonProgress(rows, CANON).bestMusical.entries.find((x) => x.id === 'a-strange-loop-2022');
  assert.equal(e.dateSeen, '2022-01-01');
  assert.equal(e.sawBeforeItWon, true);
});

test('completion counts and unseen lists', () => {
  const r = canonProgress([row('moulin-rouge-2019', '2020-01-01')], CANON);
  assert.equal(r.bestMusical.total, 2);
  assert.equal(r.bestMusical.seen, 1);
  assert.equal(r.bestMusical.completion, 0.5);
  assert.deepEqual(r.bestMusical.unseen.map((e) => e.id), ['a-strange-loop-2022']);
  assert.equal(r.bestPlay.seen, 0);
  assert.equal(r.bestPlay.completion, 0);
  assert.equal(r.totalSeen, 1);
  assert.equal(r.totalSawBeforeItWon, 1, 'seen Jan 2020, awarded Sept 2021');
});

test('entries come back newest ceremony first', () => {
  const r = canonProgress([], CANON);
  assert.deepEqual(r.bestMusical.entries.map((e) => e.ceremony), [76, 74]);
});

test('an empty diary and an empty canon both degrade cleanly', () => {
  const empty = canonProgress([], CANON);
  assert.equal(empty.totalSeen, 0);
  assert.equal(empty.bestMusical.sawBeforeItWon, 0);

  const nothing = canonProgress([], { ceremonies: [], bestMusical: [], bestPlay: [] });
  assert.equal(nothing.bestMusical.total, 0);
  assert.equal(nothing.bestMusical.completion, 0);
  assert.equal(nothing.totalSeen, 0);
});

test('real stats-canon: every winner gets a resolvable ceremony date', () => {
  const r = canonProgress([], REAL);
  const missing = [...r.bestMusical.entries, ...r.bestPlay.entries].filter((e) => !e.ceremonyDate);
  assert.deepEqual(missing.map((e) => e.id), [], 'a winner had no ceremony date');
  assert.ok(r.bestMusical.total >= 50, `expected ~53 Best Musical winners, got ${r.bestMusical.total}`);
  assert.ok(r.bestPlay.total >= 50, `expected ~51 Best Play winners, got ${r.bestPlay.total}`);
});

test('real stats-canon: resolved ceremony dates are consistent with their season', () => {
  // A season "YYYY-YY" must be awarded on or after that season's start year —
  // catches a silent regression back to the off-by-one ceremony-number join.
  const r = canonProgress([], REAL);
  const bad = [...r.bestMusical.entries, ...r.bestPlay.entries].filter((e) => {
    const startYear = parseInt(e.season.slice(0, 4), 10);
    const awardYear = parseInt(e.ceremonyDate.slice(0, 4), 10);
    return awardYear < startYear + 1 || awardYear > startYear + 2;
  });
  assert.deepEqual(
    bad.map((e) => `${e.id} season=${e.season} awarded=${e.ceremonyDate}`),
    []
  );
});

test('real stats-canon: a known viewing resolves correctly end to end', () => {
  // The Outsiders won Best Musical for 2023-24 at the 78th Tonys (2024-06-16).
  const r = canonProgress([row('the-outsiders-2024', '2024-05-01')], REAL);
  const e = r.bestMusical.entries.find((x) => x.id === 'the-outsiders-2024');
  assert.ok(e, 'The Outsiders should be a Best Musical winner in the canon');
  assert.equal(e.season, '2023-24');
  assert.equal(e.ceremonyDate, '2024-06-16');
  assert.equal(e.seen, true);
  assert.equal(e.sawBeforeItWon, true);
});
