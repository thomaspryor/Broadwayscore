import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { reconcilePending } = createRequire(import.meta.url)('./pending-commercial-reconcile.js');

const shows = { shows: [
  { id: 'a-2026', slug: 'a', status: 'open' },
  { id: 'up', slug: 'up', status: 'upcoming' },
  { id: 'b', slug: 'b', status: 'closed' },
  { id: 'c', slug: 'c', status: 'closed' },
] };
const src = [{ type: 'trade', url: 'https://x.test/a' }];
const commercial = {
  a: { capitalization: 10, weeklyRunningCost: 5, designation: 'TBD', recouped: false, sources: src },
  up: { capitalization: 9, designation: 'TBD', sources: src },
  b: { capitalization: 7, designation: 'Fizzle', sources: [] },
  c: { capitalization: 8, designation: 'TBD', recouped: false, sources: src },
};

test('id-keyed pending entry covered by cited slug record is dropped', () => {
  const r = reconcilePending({ 'a-2026': { capitalization: 10, weeklyRunningCost: 5, designation: 'TBD', recouped: false } }, commercial, shows);
  assert.deepEqual(r.drop, ['a-2026']);
});
test('upcoming shows stay held even with a record', () => {
  const r = reconcilePending({ up: { designation: 'TBD' } }, commercial, shows);
  assert.equal(r.drop.length, 0);
});
test('uncited record, missing record, differing figure all stay pending', () => {
  const r = reconcilePending({
    b: { capitalization: 7, designation: 'Fizzle' },
    zzz: { designation: 'TBD' },
    c: { capitalization: 9 },
  }, commercial, shows);
  assert.equal(r.drop.length, 0);
  assert.match(r.keep.find((k) => k.key === 'c').reason, /capitalization differs/);
});
test('recouped:true claim is never treated as covered unless the record says so', () => {
  const r = reconcilePending({ c: { capitalization: 8, recouped: true } }, commercial, shows);
  assert.equal(r.drop.length, 0);
});

test('entries held for a person, unresolved keys and claim-less entries stay pending', () => {
  const r = reconcilePending({
    c: { capitalization: 8, requiresHumanReview: true },
    nope: { capitalization: 8 },
  }, commercial, shows);
  assert.equal(r.drop.length, 0);
  const r2 = reconcilePending({ c: { designation: 'TBD' } }, commercial, shows);
  assert.equal(r2.drop.length, 0);
});
test('recouped claim with a different year stays pending', () => {
  const rec = { ...commercial, a: { ...commercial.a, recouped: true, recoupedDate: '2019-05', sources: src } };
  const r = reconcilePending({ a: { recouped: true, recoupedDate: '2023-02' } }, rec, shows);
  assert.equal(r.drop.length, 0);
  assert.match(r.keep[0].reason, /year differs/);
});
