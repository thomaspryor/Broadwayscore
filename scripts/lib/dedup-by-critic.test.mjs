import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { dedupByCritic } = require('./dedup-by-critic.js');

test('keeps distinct critics from the same outlet (NYSR Finkle + Sommers)', () => {
  const out = dedupByCritic([
    { outletId: 'nysr', criticName: 'David Finkle', assignedScore: 60 },
    { outletId: 'nysr', criticName: 'Michael Sommers', assignedScore: 40 },
  ]);
  assert.equal(out.length, 2, 'two critics at one outlet are NOT collapsed');
});

test('collapses the same (outlet,critic) to one, keeping most recent publishDate', () => {
  const out = dedupByCritic([
    { outletId: 'guardian', criticName: 'Arifa Akbar', assignedScore: 60, publishDate: '2026-01-01' },
    { outletId: 'guardian', criticName: 'Arifa Akbar', assignedScore: 80, publishDate: '2026-01-05' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].assignedScore, 80, 'newer publishDate wins');
});

test('is case-insensitive and falls back outletId→outlet, criticName→unknown', () => {
  const out = dedupByCritic([
    { outlet: 'The Guardian', criticName: 'A. Akbar', assignedScore: 70 },
    { outlet: 'the guardian', criticName: 'a. akbar', assignedScore: 75 },
  ]);
  assert.equal(out.length, 1, 'same outlet+critic in different case collapse');
});

// The whole point: a multi-row-per-(outlet,critic) show must dedup to the SAME
// count the prod rv builder produces — else verify-opening-night-live alerts forever.
test('deduped scored count matches "1 per (outlet,critic)" — the prod rv contract', () => {
  const raw = [
    { outletId: 'nysr', criticName: 'Finkle', assignedScore: 60, publishDate: '2026-01-02' },
    { outletId: 'nysr', criticName: 'Finkle', assignedScore: 60, publishDate: '2026-01-01' }, // dup row
    { outletId: 'nysr', criticName: 'Sommers', assignedScore: 40 },
    { outletId: 'guardian', criticName: 'Akbar', assignedScore: null }, // unscored → excluded after filter
  ];
  const liveCount = dedupByCritic(raw).filter((r) => r.assignedScore != null).length;
  assert.equal(liveCount, 2, 'Finkle(once) + Sommers; unscored Akbar excluded');
});
