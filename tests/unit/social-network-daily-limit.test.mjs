import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { limitDailyNetworks } = require('../../scripts/lib/social-network-daily-limit');
const channels = [{ key: 'instagram', service: 'instagram' }, { key: 'facebook', service: 'facebook' }];
const limits = { instagram: 1 };
const due = new Date('2026-11-20T16:30:00Z');

test('a scheduled Instagram post blocks another on the same New York day, but not Facebook', () => {
  const ledger = { posts: [{ dueAt: '2026-11-20T15:00:00Z', channels: { instagram: { postId: '1' } } }] };
  assert.deepEqual(limitDailyNetworks(channels, ledger, due, limits), [channels[1]]);
  assert.deepEqual(limitDailyNetworks(channels, ledger, new Date('2026-11-21T05:00:00Z'), limits), channels);
});

test('pending reservations and retry times count, excluding the entry being retried', () => {
  const entry = { dueAt: '2026-11-20T15:00:00Z', pending: { instagram: 'caption' } };
  const ledger = { posts: [entry] };
  assert.deepEqual(limitDailyNetworks(channels, ledger, due, limits), [channels[1]]);
  assert.deepEqual(limitDailyNetworks(channels, ledger, due, limits, entry), channels);
  ledger.posts.push({ dueAt: '2026-11-19T15:00:00Z', channels: { instagram: { postId: '2', dueAt: due.toISOString() } } });
  assert.deepEqual(limitDailyNetworks(channels, ledger, due, limits, entry), [channels[1]]);
});

test('different accounts, failed posts and New York midnight are handled separately', () => {
  const other = { key: 'instagram@west-end', service: 'instagram' };
  const ledger = { posts: [{ dueAt: '2026-11-21T04:30:00Z', channels: { instagram: { postId: '1' }, 'instagram@west-end': { result: 'error' } } }] };
  assert.deepEqual(limitDailyNetworks([channels[0], other], ledger, due, limits), [other]);
  assert.deepEqual(limitDailyNetworks(channels, ledger, new Date('2026-11-21T05:00:00Z'), limits), channels);
});
