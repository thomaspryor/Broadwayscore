import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findPostponedShows } = require('./postponed-production-audit.js');

const now = new Date('2026-10-11T12:00:00Z');
const mk = () => ({ shows: [
  { id: 'a', title: 'A', status: 'open', openingDate: '2026-10-08' },
  { id: 'b', title: 'B', status: 'open', openingDate: '2026-10-08' },
  { id: 'c', title: 'C', status: 'open', openingDate: '2026-10-10' },
] });
const reviewsData = { reviews: [{ showId: 'b' }] };
const page = async () => 'Coming to NYC January 28, 2027';

test('flags only 0-review shows past grace; demote mutates', async () => {
  const d = mk();
  const r = await findPostponedShows(d, { now, reviewsData, getPageText: page, demote: true });
  assert.deepEqual(r.postponed.map(p => p.id), ['a']);
  assert.equal(d.shows[0].status, 'upcoming');
  assert.equal(d.shows[0].openingDate, '2027-01-28');
  assert.equal(d.shows[1].status, 'open');
});
test('no demote → no mutation', async () => {
  const d = mk();
  await findPostponedShows(d, { now, reviewsData, getPageText: page });
  assert.equal(d.shows[0].status, 'open');
});
test('unreadable reviews → fail closed, never fetches', async () => {
  let called = 0;
  const r = await findPostponedShows(mk(), { now, reviewsData: null, getPageText: async () => { called++; return null; } });
  assert.equal(called, 0);
  assert.match(r.skipped, /fail closed/);
});
test('fetch errors counted, not thrown', async () => {
  const r = await findPostponedShows(mk(), { now, reviewsData, getPageText: async () => { throw new Error('x'); } });
  assert.equal(r.fetchFailures, 1);
  assert.deepEqual(r.postponed, []);
});
