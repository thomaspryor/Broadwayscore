// BRO-4436: isRevival and tags:'revival' must move together, because the site
// counts a show as a revival when either says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { syncRevivalTags } = require('../../scripts/lib/revival-tags.js');

test('clearing isRevival removes the revival tag and adds nothing', () => {
  const show = { id: 'degenerates-off-broadway-2026', isRevival: false, tags: ['revival'] };
  assert.deepEqual(syncRevivalTags(show).tags, []);
  const upcoming = { isRevival: false, tags: ['upcoming', 'revival'] };
  assert.deepEqual(syncRevivalTags(upcoming).tags, ['upcoming']);
});

test('setting isRevival drops a stale new tag and adds revival once', () => {
  const show = { isRevival: true, tags: ['new', 'upcoming'] };
  assert.deepEqual(syncRevivalTags(show).tags, ['upcoming', 'revival']);
  assert.deepEqual(syncRevivalTags(show).tags, ['upcoming', 'revival']);
});

test('missing tags array is created', () => {
  assert.deepEqual(syncRevivalTags({ isRevival: true }).tags, ['revival']);
});

test('a non-revival without a revival tag keeps its tags untouched', () => {
  const show = { isRevival: false, tags: ['return-engagement'] };
  assert.deepEqual(syncRevivalTags(show).tags, ['return-engagement']);
});

test('no boolean flag means no change', () => {
  const show = { tags: ['revival'] };
  assert.deepEqual(syncRevivalTags(show).tags, ['revival']);
});
