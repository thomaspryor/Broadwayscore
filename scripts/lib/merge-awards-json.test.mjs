import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAwardsJson } from './merge-awards-json.js';

test('mergeAwardsJson: unions remote-only slugs', () => {
  const ours = { shows: { a: { tony: { wins: ['Best Actor'] } } } };
  const remote = { shows: { a: { tony: { wins: ['Best Actor'] } }, b: { olivier: { wins: ['Best Show'] } } } };
  const { merged, stats } = mergeAwardsJson(ours, remote);
  assert.deepEqual(Object.keys(merged.shows).sort(), ['a', 'b']);
  assert.equal(stats.added, 1);
});

test('mergeAwardsJson: deep-unions ceremony keys on a shared slug', () => {
  const ours = { shows: { a: { tony: { wins: ['Best Actor'] } } } };
  const remote = { shows: { a: { olivier: { wins: ['Best Show'] } } } };
  const { merged, stats } = mergeAwardsJson(ours, remote);
  assert.deepEqual(Object.keys(merged.shows.a).sort(), ['olivier', 'tony']);
  assert.equal(stats.ceremoniesAdded, 1);
});

test('mergeAwardsJson: ours wins on a shared ceremony key', () => {
  const ours = { shows: { a: { tony: { wins: ['Ours'] } } } };
  const remote = { shows: { a: { tony: { wins: ['Remote'] } } } };
  const { merged } = mergeAwardsJson(ours, remote);
  assert.deepEqual(merged.shows.a.tony.wins, ['Ours']);
});

test('mergeAwardsJson: keeps a local-only slug untouched', () => {
  const ours = { shows: { a: { tony: {} } } };
  const remote = { shows: {} };
  const { merged, stats } = mergeAwardsJson(ours, remote);
  assert.ok(merged.shows.a);
  assert.equal(stats.kept, 1);
});

test('mergeAwardsJson: handles missing shows key on either side', () => {
  const { merged } = mergeAwardsJson(undefined, { shows: { a: { tony: {} } } });
  assert.ok(merged.shows.a);
  const { merged: merged2 } = mergeAwardsJson({ shows: { a: { tony: {} } } }, undefined);
  assert.ok(merged2.shows.a);
});

test('mergeAwardsJson: _meta.lastUpdated picks the newer timestamp', () => {
  const ours = { shows: {}, _meta: { lastUpdated: '2026-01-01T00:00:00.000Z' } };
  const remote = { shows: {}, _meta: { lastUpdated: '2026-06-01T00:00:00.000Z' } };
  const { merged } = mergeAwardsJson(ours, remote);
  assert.equal(merged._meta.lastUpdated, '2026-06-01T00:00:00.000Z');
});
