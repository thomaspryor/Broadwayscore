/**
 * Tests for scripts/lib/tour-aggregate-rules.js and scripts/unlink-tour-aggregate.js (BRO-7192).
 * Gun & Powder's fake "national tour" is the failing fixture; Paranormal Activity's real one passes.
 *
 * Run: node --test scripts/lib/tour-aggregate-rules.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { tourAggregateProblems, directorsOf } = require('./tour-aggregate-rules.js');
const { planUnlink, applyUnlink } = require('../unlink-tour-aggregate.js');

const gpAgg = { id: 'gun-and-powder-regional-2020', slug: 'gun-and-powder-regional-2020', category: 'regional', tags: ['regional', 'national-tour'], transferredTo: 'wanted-2022' };
const gpSig = { id: 'gun-and-powder-signature-regional-2020', slug: 'gun-and-powder-signature-regional-2020', category: 'regional', tourParent: gpAgg.id, openingDate: '2020-02-05', creativeTeam: [{ name: 'Robert O’Hara', role: 'Director' }] };
const gpMill = { id: 'gun-and-powder-paper-mill-regional-2024', slug: 'gun-and-powder-paper-mill-regional-2024', category: 'regional', tourParent: gpAgg.id, openingDate: '2024-04-14', creativeTeam: [{ name: 'Stevie Walker-Webb', role: 'Director' }] };
const wanted = { id: 'wanted-2022', slug: 'wanted', category: 'broadway', transferOf: gpAgg.id };

const paAgg = { id: 'paranormal-activity-national-tour-regional-2025', category: 'regional' };
const paLeg = (id, opens) => ({ id, category: 'regional', tourParent: paAgg.id, openingDate: opens, creativeTeam: [{ name: 'Felix Barrett', role: 'Director' }] });
const paranormal = [paAgg, paLeg('pa-chicago', '2025-10-16'), paLeg('pa-la', '2025-11-14'), paLeg('pa-dc', '2026-01-28'), paLeg('pa-sf', '2026-02-24'), paLeg('pa-boston', '2026-07-15')];

test('a real tour (one director, legs months apart) is clean', () => {
  assert.deepEqual(tourAggregateProblems(paranormal), []);
});

test('Gun & Powder grouped as a tour is flagged for both reasons (red with the fix reverted)', () => {
  const problems = tourAggregateProblems([gpAgg, gpSig, gpMill, wanted]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /open 1530 days apart/);
  assert.match(problems[1], /different directors/);
});

test('after the fix (no tourParent) nothing is flagged', () => {
  const { tourParent: _a, ...sig } = gpSig;
  const { tourParent: _b, ...mill } = gpMill;
  assert.deepEqual(tourAggregateProblems([sig, mill, wanted]), []);
});

test('dangling, nested and one-leg roll-ups are flagged', () => {
  assert.match(tourAggregateProblems([{ id: 'a', category: 'regional', tourParent: 'missing' }])[0], /not in shows\.json/);
  const nested = [{ id: 'top', category: 'regional' }, { id: 'mid', category: 'regional', tourParent: 'top' }, { id: 'leg', category: 'regional', tourParent: 'mid' }];
  assert.ok(tourAggregateProblems(nested).some((p) => /do not nest/.test(p)));
  assert.ok(tourAggregateProblems([{ id: 'agg', category: 'regional' }, { id: 'one', category: 'regional', tourParent: 'agg' }]).some((p) => /at least two stops/.test(p)));
});

test('directorsOf ignores music directors and folds accents', () => {
  assert.deepEqual(directorsOf({ creativeTeam: [{ name: 'Zoë Ames', role: 'Director' }, { name: 'X Y', role: 'Music Director' }] }), ['zoe ames']);
});

const row = (showId, outletId, url) => ({ showId, outletId, url, publishDate: '2024-04-17' });
const reviews = [
  row(gpSig.id, 'washpost', 'https://wapo/a'),
  row(gpMill.id, 'nytimes', 'https://nyt/a'),
  row(gpMill.id, 'theatermania', 'https://tm/a'),
  row(gpAgg.id, 'washpost', 'https://wapo/a/'),
  row(gpAgg.id, 'nytimes', 'https://nyt/a?utm=1'),
];

test('planUnlink drops only copies, moves the transfer, and leaves every review on a leg', () => {
  const shows = structuredClone([gpAgg, gpSig, gpMill, wanted]);
  const input = { shows, reviews, aggregateId: gpAgg.id, transferLegId: gpMill.id };
  const plan = planUnlink(input);
  assert.equal(plan.ok, true);
  assert.equal(plan.dropRows.length, 2);
  const kept = applyUnlink(input, plan);
  assert.equal(kept.length, 3);
  assert.ok(kept.every((r) => r.showId !== gpAgg.id));
  const byId = Object.fromEntries(shows.map((s) => [s.id, s]));
  assert.equal(byId[gpSig.id].tourParent, undefined);
  assert.equal(byId[gpMill.id].tourParent, undefined);
  assert.equal(byId[gpMill.id].transferredTo, 'wanted-2022');
  assert.equal(byId['wanted-2022'].transferOf, gpMill.id);
  assert.equal(byId[gpAgg.id].transferredTo, undefined);
  assert.deepEqual(byId[gpMill.id].aliases, [gpAgg.id]);
  assert.deepEqual(tourAggregateProblems(shows), []);
});

test('planUnlink refuses a URL-less aggregate row and directorsOf ignores co-directors', () => {
  const blank = planUnlink({ shows: structuredClone([gpAgg, gpSig, gpMill, wanted]), reviews: [row(gpSig.id, 'variety', ''), row(gpAgg.id, 'variety', '')], aggregateId: gpAgg.id, transferLegId: gpMill.id });
  assert.equal(blank.ok, false);
  assert.deepEqual(directorsOf({ creativeTeam: [{ name: 'A B', role: 'Director' }, { name: 'C D', role: 'Co-Director' }] }), ['a b']);
});

test('planUnlink refuses a real tour, an orphan review row, and a bad transfer leg', () => {
  const real = planUnlink({ shows: structuredClone(paranormal), reviews: [], aggregateId: paAgg.id, transferLegId: 'pa-chicago' });
  assert.equal(real.ok, false);
  assert.match(real.reason, /real tour/);

  const orphan = planUnlink({ shows: structuredClone([gpAgg, gpSig, gpMill, wanted]), reviews: [...reviews, row(gpAgg.id, 'variety', 'https://variety/only-here')], aggregateId: gpAgg.id, transferLegId: gpMill.id });
  assert.equal(orphan.ok, false);
  assert.match(orphan.reason, /no twin/);

  const badLeg = planUnlink({ shows: structuredClone([gpAgg, gpSig, gpMill, wanted]), reviews, aggregateId: gpAgg.id, transferLegId: 'wanted-2022' });
  assert.equal(badLeg.ok, false);
});
