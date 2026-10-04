/**
 * Tests for scripts/lib/commercial-entry-action.js (BRO-4623)
 * Run: node --test scripts/lib/commercial-entry-action.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { applyAddCommercialEntry, commercialConsistencyProblems } = require('./commercial-entry-action.js');

const shows = [
  { id: 'gutenberg-2023', slug: 'gutenberg', title: 'Gutenberg! The Musical!', category: 'broadway' },
  { id: 'grey-house-2023', slug: 'grey-house', title: 'Grey House', category: 'broadway' },
  { id: 'x-off-broadway-2024', slug: 'x-off-broadway-2024', title: 'X', category: 'off-broadway' },
];
const fresh = () => ({ _meta: {}, shows: { hamilton: { designation: 'Miracle', recouped: true, recoupedDate: '2016-03' } } });
const src = [{ type: 'trade', url: 'https://playbill.com/article/example', date: '2024-01-02' }];
const win = () => ({ designation: 'Easy Winner', recouped: true, recoupedDate: '2023-12', recoupedSource: 'Playbill (Dec 2023)', sources: src });

test('adds a slug-keyed entry, canonicalizes designation, stamps review lock', () => {
  const c = fresh();
  const r = applyAddCommercialEntry(c, shows, { slug: 'gutenberg', entry: { ...win(), designation: 'easy winner' } }, '2026-10-04T00:00:00.000Z');
  assert.equal(r.ok, true, r.reason);
  assert.equal(c.shows.gutenberg.designation, 'Easy Winner');
  assert.equal(c.shows.gutenberg.humanReviewedDesignation, true);
  assert.equal(c.shows.gutenberg.firstAdded, '2026-10-04');
});

test('refuses a show id when the show has a slug (the ID-key duplicate class)', () => {
  const c = fresh();
  const r = applyAddCommercialEntry(c, shows, { slug: 'gutenberg-2023', entry: win() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /key by its slug "gutenberg"/);
  assert.equal(c.shows['gutenberg-2023'], undefined);
});

test('refuses existing entries, unknown shows, non-Broadway shows', () => {
  assert.equal(applyAddCommercialEntry(fresh(), [...shows, { id: 'hamilton-2015', slug: 'hamilton', category: 'broadway' }], { slug: 'hamilton', entry: win() }).ok, false);
  assert.equal(applyAddCommercialEntry(fresh(), shows, { slug: 'nope', entry: win() }).ok, false);
  assert.equal(applyAddCommercialEntry(fresh(), shows, { slug: 'x-off-broadway-2024', entry: win() }).ok, false);
});

test('win designations need a dated, sourced recoupment; losses need recouped=false', () => {
  assert.equal(applyAddCommercialEntry(fresh(), shows, { slug: 'gutenberg', entry: { ...win(), recoupedSource: undefined } }).ok, false);
  assert.equal(applyAddCommercialEntry(fresh(), shows, { slug: 'gutenberg', entry: { ...win(), recoupedDate: '12/2023' } }).ok, false);
  assert.equal(applyAddCommercialEntry(fresh(), shows, { slug: 'grey-house', entry: { designation: 'Flop', recouped: null, sources: src } }).ok, false);
  assert.equal(applyAddCommercialEntry(fresh(), shows, { slug: 'grey-house', entry: { designation: 'Flop', recouped: false, sources: src } }).ok, true);
});

test('refuses unsourced entries, bad source types, unknown fields, bad numbers', () => {
  assert.equal(applyAddCommercialEntry(fresh(), shows, { slug: 'grey-house', entry: { designation: 'TBD', sources: [] } }).ok, false);
  assert.equal(applyAddCommercialEntry(fresh(), shows, { slug: 'grey-house', entry: { designation: 'TBD', sources: [{ type: 'website', url: 'https://a.b' }] } }).ok, false);
  assert.equal(applyAddCommercialEntry(fresh(), shows, { slug: 'grey-house', entry: { designation: 'TBD', sources: src, modelRecouped: true } }).ok, false);
  assert.equal(applyAddCommercialEntry(fresh(), shows, { slug: 'grey-house', entry: { designation: 'TBD', sources: src, capitalization: '5M' } }).ok, false);
});

test('consistency check flags what validate-data.js would fail the build on', () => {
  assert.deepEqual(commercialConsistencyProblems(fresh()), []);
  const bad = { shows: {
    a: { designation: 'Windfall', recouped: null },
    b: { designation: 'Flop', recouped: true, recoupedDate: '2024-01' },
    c: { designation: 'TBD', recouped: true },
    d: { designation: 'flop', recouped: false },
    e: { designation: 'TBD', sources: [{ type: 'other', url: 'https://x.y' }] },
  } };
  const p = commercialConsistencyProblems(bad);
  for (const k of ['a:', 'b:', 'c:', 'd:', 'e:']) assert.ok(p.some(x => x.startsWith(k)), `expected a problem for ${k} in ${JSON.stringify(p)}`);
});
