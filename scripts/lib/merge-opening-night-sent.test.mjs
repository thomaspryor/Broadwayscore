import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeOpeningNightSent } from './merge-opening-night-sent.js';

test('mergeOpeningNightSent: unions remote-only keys', () => {
  const ours = { shows: { a: { sentAt: '2026-01-01' } } };
  const remote = { shows: { a: { sentAt: '2026-01-01' }, b: { sentAt: '2026-01-02' } } };
  const { merged, stats } = mergeOpeningNightSent(ours, remote);
  assert.deepEqual(Object.keys(merged.shows).sort(), ['a', 'b']);
  assert.equal(stats.added, 1);
});

test('mergeOpeningNightSent: keeps local-only key', () => {
  const ours = { shows: { a: { sentAt: '2026-01-01' } } };
  const remote = { shows: {} };
  const { merged } = mergeOpeningNightSent(ours, remote);
  assert.ok(merged.shows.a);
});

test('mergeOpeningNightSent: ours wins on a shared key', () => {
  const ours = { shows: { a: { sentAt: 'ours' } } };
  const remote = { shows: { a: { sentAt: 'remote' } } };
  const { merged } = mergeOpeningNightSent(ours, remote);
  assert.equal(merged.shows.a.sentAt, 'ours');
});

test('mergeOpeningNightSent: handles missing shows key on either side', () => {
  const { merged } = mergeOpeningNightSent(undefined, { shows: { a: {} } });
  assert.ok(merged.shows.a);
});
