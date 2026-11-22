// Tests for scripts/lib/show-refresh/{inputs,slice}.js (BRO-8056 phase 1b).
// Run: node --test scripts/lib/show-refresh/slice.test.mjs
// Real-data check run when this landed: computeOneShow from each slice
// (JSON round-tripped) == getAllShows() for all 6079 shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildShowInputs, computableShows } = require('./inputs.js');
const { SLICE_VERSION, indexForSlices, sliceFor, sliceHash, coverageInputsFromSlice } = require('./slice.js');

const row = (id, o = {}) => ({ id, title: id, slug: id, venue: 'V', status: 'open', category: 'broadway', openingDate: '2026-01-01', ...o });
const raw = () => ({
  showsData: { shows: [row('a'), row('b'), row('dev', { _devOnly: true }), { id: 'broken' }] },
  reviews: [{ showId: 'a', outletId: 'nytimes', assignedScore: 80 }, { showId: 'b', outletId: 'x', assignedScore: 60 }, { showId: 'a', outletId: 'y', assignedScore: 70 }],
  blogReviews: [{ showId: 'a', outletId: 'blog', assignedScore: 90 }],
  audience: [{ showId: 'a', platform: 'showScore', averageRating: 80 }],
  buzz: [{ showId: 'b', platform: 'reddit', upvotes: 3 }],
});
const cfi = () => ({
  covByShowId: new Map([['a', { state: 'complete', liveCount: 3, candidateCount: 3, computedAt: null }]]),
  scorePublicSinceByShowId: new Map([['a', '2026-01-02T00:00:00Z']]),
  coverageAckedShowIds: new Set(['b']),
});
const index = (r = raw()) => indexForSlices(buildShowInputs(r), {
  consensusById: { a: { text: 'Raves.' } }, audienceBuzzById: { b: { designation: 'Loving' } }, coverageFloorInputs: cfi(),
});

test('buildShowInputs drops malformed rows and keeps review order per show', () => {
  const inputs = buildShowInputs(raw());
  assert.deepEqual(inputs.shows.map(s => s.id), ['a', 'b', 'dev']);
  assert.deepEqual(inputs.skipped.map(s => s.id), ['broken']);
  assert.deepEqual(computableShows(inputs).map(s => s.id), ['a', 'b']);
  assert.deepEqual(inputs.reviewsByShowId.get('a').map(r => r.outletId), ['nytimes', 'y']);
});

test('a slice holds only its own show', () => {
  const s = sliceFor('a', index());
  assert.equal(s.sliceVersion, SLICE_VERSION);
  assert.deepEqual(s.reviews.map(r => r.outletId), ['nytimes', 'y']);
  assert.deepEqual(s.blogReviews.map(r => r.outletId), ['blog']);
  assert.equal(s.audience.length, 1);
  assert.deepEqual(s.buzz, []);
  assert.deepEqual(s.consensus, { text: 'Raves.' });
  assert.equal(s.audienceBuzz, null);
  assert.deepEqual(s.coverage, { cov: { state: 'complete', liveCount: 3, candidateCount: 3, computedAt: null }, scorePublicSince: '2026-01-02T00:00:00Z', acked: false });
  assert.equal(sliceFor('nope', index()), null);
});

test('hash ignores key order, changes with any field of this show, not with other shows', () => {
  const h = sliceHash(sliceFor('a', index()));
  const reordered = JSON.parse(JSON.stringify(sliceFor('a', index())), (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v));
  assert.equal(sliceHash(reordered), h);
  const otherChanged = raw(); otherChanged.reviews[1].assignedScore = 10;
  assert.equal(sliceHash(sliceFor('a', index(otherChanged))), h);
  const mineChanged = raw(); mineChanged.reviews[0].assignedScore = 81;
  assert.notEqual(sliceHash(sliceFor('a', index(mineChanged))), h);
  const rowChanged = raw(); rowChanged.showsData.shows[0].synopsis = 'new';
  assert.notEqual(sliceHash(sliceFor('a', index(rowChanged))), h);
});

test('golden hash: bump SLICE_VERSION when the slice shape or hash changes', () => {
  assert.equal(SLICE_VERSION, 1);
  assert.equal(sliceHash(sliceFor('a', index())), '60f42ff145a8e39c');
});

test('coverageInputsFromSlice rebuilds the three maps for this show only', () => {
  const c = coverageInputsFromSlice(sliceFor('b', index()));
  assert.equal(c.covByShowId.size, 0);
  assert.equal(c.scorePublicSinceByShowId.size, 0);
  assert.deepEqual([...c.coverageAckedShowIds], ['b']);
});

test('no slice for a _devOnly row or an unknown id; prototype keys never leak in', () => {
  const ix = index();
  assert.equal(sliceFor('dev', ix), null);
  assert.equal(sliceFor('nope', ix), null);
  const ix2 = indexForSlices(buildShowInputs({ ...raw(), showsData: { shows: [row('constructor')] } }), { coverageFloorInputs: cfi() });
  const s = sliceFor('constructor', ix2);
  assert.equal(s.consensus, null);
  assert.equal(s.audienceBuzz, null);
});

test('COVERAGE_GATE_DISABLED empties the coverage inputs rebuilt from a slice', () => {
  const s = sliceFor('a', index());
  assert.equal(coverageInputsFromSlice(s, {}).covByShowId.size, 1);
  const off = coverageInputsFromSlice(s, { COVERAGE_GATE_DISABLED: '1' });
  assert.equal(off.covByShowId.size + off.scorePublicSinceByShowId.size + off.coverageAckedShowIds.size, 0);
});
