/**
 * alignCritics — Aisle Mates, nemesis, and Your Paper of Record.
 *
 * Runs the REAL src/lib/stats/align-critics.ts. Two behaviors are worth more
 * than the rest: the ≥15-shared volume floor (without it, six critics sharing
 * five shows outranked the owner's true best match) and the criticIdx -1
 * handling (byline-less reviews must be invisible per-critic but still count
 * toward their outlet's per-show mean).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALIGNMENT_WINDOW,
  NEMESIS_MIN_SHARED,
  RISING_MIN_SHARED,
  TOP_MATE_MIN_SHARED,
  alignCritics,
} from '../../src/lib/stats/align-critics';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL = JSON.parse(readFileSync(join(ROOT, 'public/data/stats-reviews.json'), 'utf8'));

const CRITICS = ['Perfect Match', 'Thin Sample', 'Nemesis', 'Middling'];
const OUTLETS = [
  ['The Paper', 1],
  ['The Blog', 3],
];

/** n shows where `critic` scores exactly `score` and the user rates 4★ (=80). */
function corpus(spec) {
  const shows = {};
  let n = 0;
  for (const { critic, outlet, score, count, criticIdx } of spec) {
    for (let i = 0; i < count; i++) {
      const id = `show-${n++}`;
      shows[id] = [[criticIdx ?? CRITICS.indexOf(critic), outlet ?? 0, score]];
    }
  }
  return { shows, ids: Object.keys(shows) };
}

const rate = (ids, stars = '4.0') => ids.map((id) => ({ show_id: id, rating: stars, date_seen: '2026-01-01' }));

test('alignment is the share of shared shows inside the ±12 window', () => {
  // User rates 4★ = 80. 80 vs 90 → 10 apart, aligned. 80 vs 95 → 15, not.
  const reviews = {
    critics: CRITICS,
    outlets: OUTLETS,
    shows: { a: [[0, 0, 90]], b: [[0, 0, 68]], c: [[0, 0, 95]], d: [[0, 0, 60]] },
  };
  const r = alignCritics(rate(['a', 'b', 'c', 'd']), reviews);
  const c = r.critics.find((x) => x.name === 'Perfect Match');
  assert.equal(c.shared, 4);
  assert.equal(c.aligned, 2, '90 and 68 are within 12 of 80; 95 and 60 are not');
  assert.equal(c.alignment, 0.5);
  assert.equal(ALIGNMENT_WINDOW, 12);
});

test('exactly 12 points apart still counts as agreement (boundary is inclusive)', () => {
  const reviews = { critics: CRITICS, outlets: OUTLETS, shows: { a: [[0, 0, 92]], b: [[0, 0, 68]], c: [[0, 0, 93]] } };
  const r = alignCritics(rate(['a', 'b', 'c']), reviews);
  assert.equal(r.critics[0].aligned, 2);
});

test('bias is signed: negative means they run colder than you', () => {
  const reviews = { critics: CRITICS, outlets: OUTLETS, shows: { a: [[0, 0, 74]], b: [[0, 0, 74]] } };
  const r = alignCritics(rate(['a', 'b']), reviews);
  assert.equal(r.critics[0].bias, -6);
});

test('VOLUME FLOOR: a 5-shared perfect scorer never outranks a 15-shared match', () => {
  const perfect = corpus([{ critic: 'Perfect Match', score: 80, count: 20 }]);
  const thin = corpus([{ critic: 'Thin Sample', score: 80, count: 5 }]);
  const shows = { ...perfect.shows };
  for (const [k, v] of Object.entries(thin.shows)) shows[`thin-${k}`] = v;
  const ids = [...perfect.ids, ...thin.ids.map((k) => `thin-${k}`)];

  // Make the high-volume critic imperfect so a raw sort would put the thin one first.
  shows[perfect.ids[0]] = [[0, 0, 30]];

  const r = alignCritics(rate(ids), { critics: CRITICS, outlets: OUTLETS, shows });
  assert.equal(r.topMates[0].name, 'Perfect Match');
  assert.equal(r.topMates.length, 1, 'only one critic clears the 15-shared floor');
  assert.equal(r.topMates[0].shared, 20);
  assert.ok(r.topMates[0].alignment < 1, 'and it is NOT the highest raw alignment');

  // The thin one is demoted to rising, never the headline.
  assert.equal(r.rising.length, 1);
  assert.equal(r.rising[0].name, 'Thin Sample');
  assert.equal(r.rising[0].alignment, 1);
  assert.equal(TOP_MATE_MIN_SHARED, 15);
  assert.equal(RISING_MIN_SHARED, 5);
});

test('below 5 shared shows a critic appears nowhere but the full list', () => {
  const { shows, ids } = corpus([{ critic: 'Thin Sample', score: 80, count: 4 }]);
  const r = alignCritics(rate(ids), { critics: CRITICS, outlets: OUTLETS, shows });
  assert.equal(r.topMates.length, 0);
  assert.equal(r.rising.length, 0);
  assert.equal(r.critics.length, 1, 'still visible in the raw list');
  assert.equal(r.critics[0].shared, 4);
});

test('NEMESIS: lowest alignment at ≥8 shared, and nothing below that floor qualifies', () => {
  const shows = {};
  for (let i = 0; i < 10; i++) shows[`n${i}`] = [[2, 0, 20]]; // Nemesis, way off
  for (let i = 0; i < 20; i++) shows[`p${i}`] = [[0, 0, 80]]; // Perfect Match
  for (let i = 0; i < 3; i++) shows[`t${i}`] = [[1, 0, 10]]; // worse, but only 3 shared
  const ids = Object.keys(shows);
  const r = alignCritics(rate(ids), { critics: CRITICS, outlets: OUTLETS, shows });
  assert.equal(r.nemesis.name, 'Nemesis');
  assert.equal(r.nemesis.shared, 10);
  assert.equal(r.nemesis.alignment, 0);
  assert.equal(NEMESIS_MIN_SHARED, 8);
});

test('HIGH-VOLUME NEMESIS: the most-shared low-aligner, not merely the worst', () => {
  const shows = {};
  // Nemesis: 8 shared, 0% aligned (the worst).
  for (let i = 0; i < 8; i++) shows[`n${i}`] = [[2, 0, 20]];
  // Middling: 40 shared, 25% aligned — a far better story.
  for (let i = 0; i < 40; i++) shows[`m${i}`] = [[3, 0, i < 10 ? 80 : 40]];
  const ids = Object.keys(shows);
  const r = alignCritics(rate(ids), { critics: CRITICS, outlets: OUTLETS, shows });
  assert.equal(r.nemesis.name, 'Nemesis', 'worst alignment');
  assert.equal(r.highVolumeNemesis.name, 'Middling', 'most shows among low-aligners');
  assert.equal(r.highVolumeNemesis.shared, 40);
});

test('no low-aligners means no high-volume nemesis (null, not a false accusation)', () => {
  const { shows, ids } = corpus([{ critic: 'Perfect Match', score: 80, count: 20 }]);
  const r = alignCritics(rate(ids), { critics: CRITICS, outlets: OUTLETS, shows });
  assert.equal(r.highVolumeNemesis, null);
  assert.equal(r.nemesis.name, 'Perfect Match', 'still the least-aligned of those who qualify');
});

test('CRITIC -1 ROWS: byline-less reviews are excluded from per-critic alignment', () => {
  const shows = {
    a: [[-1, 0, 20]],
    b: [[-1, 0, 20]],
    c: [[0, 0, 80]],
  };
  const r = alignCritics(rate(['a', 'b', 'c']), { critics: CRITICS, outlets: OUTLETS, shows });
  assert.equal(r.critics.length, 1, 'only the real byline produced a critic row');
  assert.equal(r.critics[0].name, 'Perfect Match');
  assert.equal(r.critics[0].shared, 1);
  // No phantom "critic:-1" entry.
  assert.equal(r.critics.filter((c) => c.index < 0).length, 0);
});

test('CRITIC -1 ROWS: byline-less reviews DO count toward the outlet mean', () => {
  // Outlet 0 has two reviews on show a: one bylined (100) and one not (60).
  // Mean is 80, which exactly matches the user's 4★ — so the outlet aligns
  // even though neither individual review does.
  const shows = { a: [[0, 0, 100], [-1, 0, 60]] };
  const r = alignCritics(rate(['a']), { critics: CRITICS, outlets: OUTLETS, shows });
  const outlet = r.outlets.find((o) => o.name === 'The Paper');
  assert.equal(outlet.shared, 1);
  assert.equal(outlet.aligned, 1, 'the mean of 100 and 60 is 80, dead on');
  assert.equal(outlet.tier, 1);
  // The bylined critic alone is 20 points off and does NOT align.
  assert.equal(r.critics[0].aligned, 0);
});

test('a critic filing twice for one show counts once, at their mean', () => {
  const shows = { a: [[0, 0, 100], [0, 0, 60]] };
  const r = alignCritics(rate(['a']), { critics: CRITICS, outlets: OUTLETS, shows });
  assert.equal(r.critics[0].shared, 1);
  assert.equal(r.critics[0].aligned, 1);
});

test('unrated rows are excluded; shows absent from the artifact are counted separately', () => {
  const shows = { a: [[0, 0, 80]] };
  const rows = [
    { show_id: 'a', rating: '4.0', date_seen: '2026-01-01' },
    { show_id: 'a-unrated', rating: null, date_seen: '2026-01-01' },
    { show_id: 'not-in-artifact', rating: '4.0', date_seen: '2026-01-01' },
  ];
  const r = alignCritics(rows, { critics: CRITICS, outlets: OUTLETS, shows });
  assert.equal(r.sharedShowCount, 1);
  assert.equal(r.unmatchedShowCount, 1, 'only the RATED unknown show counts');
  assert.equal(r.critics[0].shared, 1);
});

test('repeat viewings of one show average into a single data point', () => {
  const shows = { a: [[0, 0, 80]] };
  const rows = [
    { show_id: 'a', rating: '5.0', date_seen: '2024-01-01' },
    { show_id: 'a', rating: '3.0', date_seen: '2026-01-01' },
  ];
  const r = alignCritics(rows, { critics: CRITICS, outlets: OUTLETS, shows });
  assert.equal(r.critics[0].shared, 1, 'one show, not two');
  assert.equal(r.critics[0].aligned, 1, 'mean of 5★ and 3★ is 4★ = 80');
});

test('an empty diary produces empty results, not a crash', () => {
  const r = alignCritics([], REAL);
  assert.deepEqual(r.critics, []);
  assert.deepEqual(r.topMates, []);
  assert.equal(r.nemesis, null);
  assert.equal(r.nemesisOutlet, null);
  assert.equal(r.sharedShowCount, 0);
});

test('real stats-reviews.json: a synthetic diary produces sane, ranked output', () => {
  const ids = Object.keys(REAL.shows).slice(0, 400);
  const rows = ids.map((id, i) => ({
    show_id: id,
    rating: String(3 + (i % 5) * 0.5),
    date_seen: '2026-01-01',
  }));
  const r = alignCritics(rows, REAL);
  assert.ok(r.sharedShowCount > 0, 'the artifact ids must join');
  assert.ok(r.critics.length > 0);
  for (const c of r.critics) {
    assert.ok(c.alignment >= 0 && c.alignment <= 1, `${c.name} alignment out of range`);
    assert.ok(c.aligned <= c.shared);
    assert.ok(typeof c.name === 'string' && !c.name.startsWith('critic:'), `unnamed critic ${c.index}`);
  }
  // Ranked best-first, and every headline mate clears the floor.
  for (let i = 1; i < r.critics.length; i++) {
    assert.ok(r.critics[i - 1].alignment >= r.critics[i].alignment, 'critics not sorted');
  }
  for (const m of r.topMates) assert.ok(m.shared >= TOP_MATE_MIN_SHARED);
  for (const m of r.rising) assert.ok(m.shared >= RISING_MIN_SHARED && m.shared < TOP_MATE_MIN_SHARED);
  for (const o of r.topOutlets) assert.ok(o.tier >= 1, `${o.name} has no tier`);
});
