import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeSocialPostHistory, keyOf } = require('../../scripts/lib/merge-social-post-history.js');

const post = (tweetId, extra = {}) => ({
  date: '2026-07-21T15:00:00Z',
  type: 'spotlight',
  showId: 'hamilton-2015',
  tweetId,
  tweetUrl: `https://x.com/status/${tweetId}`,
  text: 'text',
  ...extra,
});

test('acceptance: two racing runs each post about a different show — both survive', () => {
  const ours = { posts: [post('base1'), post('A', { showId: 'wicked-2003' })], _meta: { lastUpdated: '2026-07-21T15:00:00Z' } };
  const remote = { posts: [post('base1'), post('B', { showId: 'six-2021' })], _meta: { lastUpdated: '2026-07-21T15:05:00Z' } };

  const { merged, stats } = mergeSocialPostHistory(ours, remote);
  const ids = merged.posts.map((p) => p.tweetId).sort();
  assert.deepEqual(ids, ['A', 'B', 'base1']);
  assert.equal(stats.added, 1);
  assert.equal(stats.kept, 1);
});

test('remote-only entries are re-added (the drop this fixes)', () => {
  const ours = { posts: [post('x')] };
  const remote = { posts: [post('x'), post('y'), post('z')] };
  const { merged, stats } = mergeSocialPostHistory(ours, remote);
  assert.deepEqual(merged.posts.map((p) => p.tweetId), ['x', 'y', 'z']);
  assert.equal(stats.added, 2);
});

test('ours wins on a shared tweetId (matches -X ours)', () => {
  const ours = { posts: [post('x', { text: 'ours text' })] };
  const remote = { posts: [post('x', { text: 'remote text' })] };
  const { merged } = mergeSocialPostHistory(ours, remote);
  assert.equal(merged.posts.length, 1);
  assert.equal(merged.posts[0].text, 'ours text');
});

test('order is deterministic: ours first, remote-only appended', () => {
  const ours = { posts: [post('a'), post('b')] };
  const remote = { posts: [post('c'), post('b'), post('d')] };
  const { merged } = mergeSocialPostHistory(ours, remote);
  assert.deepEqual(merged.posts.map((p) => p.tweetId), ['a', 'b', 'c', 'd']);
});

test('falls back to date|type|showId when tweetId is absent', () => {
  const bare = { date: '2026-07-21T15:00:00Z', type: 'closing', showId: 'cats-1982' };
  assert.equal(keyOf(bare), 'fallback:2026-07-21T15:00:00Z|closing|cats-1982');
  assert.equal(keyOf({}), null);
});

test('_meta.lastUpdated takes the newer of the two timestamps', () => {
  const ours = { posts: [], _meta: { lastUpdated: '2026-07-21T15:00:00Z' } };
  const remote = { posts: [], _meta: { lastUpdated: '2026-07-21T16:00:00Z' } };
  const { merged } = mergeSocialPostHistory(ours, remote);
  assert.equal(merged._meta.lastUpdated, '2026-07-21T16:00:00Z');
});

test('handles missing/malformed input without throwing', () => {
  assert.doesNotThrow(() => mergeSocialPostHistory(null, undefined));
  assert.doesNotThrow(() => mergeSocialPostHistory({}, {}));
  const { merged } = mergeSocialPostHistory(null, { posts: [post('x')] });
  assert.equal(merged.posts.length, 1);
});

test('acceptance against real data/social-post-history.json shape', () => {
  const real = require('../../data/social-post-history.json');
  assert.doesNotThrow(() => mergeSocialPostHistory(real, real));
  const { merged, stats } = mergeSocialPostHistory(real, real);
  // Merging a file with itself is a no-op: every entry is a shared key.
  assert.equal(stats.added, 0);
  assert.equal(merged.posts.length, real.posts.length);
});

test('a post the writer pruned is not resurrected from the remote (BRO-5261)', () => {
  const { MAX_POSTS } = require('../../scripts/lib/merge-social-post-history.js');
  const day = (i) => new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString();
  const all = Array.from({ length: MAX_POSTS + 1 }, (_, i) => ({ tweetId: `t${i}`, date: day(i), type: 'x', showId: 's' }));
  const remote = { posts: all.slice(0, MAX_POSTS) };          // before the prune
  const ours = { posts: all.slice(1) };                        // writer added t365, pruned t0
  const { merged, stats } = mergeSocialPostHistory(ours, remote);
  assert.equal(merged.posts.length, MAX_POSTS);
  assert.equal(merged.posts.some((p) => p.tweetId === 't0'), false);
  assert.equal(stats.droppedOld, 1);
  // A concurrent run's new post still survives the cap.
  const racing = { posts: [...all.slice(1, MAX_POSTS), { tweetId: 'other', date: day(MAX_POSTS + 1), type: 'x', showId: 'o' }] };
  const r2 = mergeSocialPostHistory(ours, racing).merged.posts;
  assert.ok(r2.some((p) => p.tweetId === 'other') && r2.some((p) => p.tweetId === `t${MAX_POSTS}`));
  assert.equal(r2.length, MAX_POSTS);
});
