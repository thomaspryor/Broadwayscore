import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pendingShows, emptyShows, formatUrlsInput, queueHasRoom, DEFAULT_MAX_ACTIVE } = require('./ingest-batch-pacing.js');

test('pendingShows skips checkpointed and empty shows, keeps plan order; emptyShows names the empties', () => {
  const plan = { a: [{ url: 'https://x/1', outlet: 'o' }], b: [], c: [{ url: 'https://x/2', outlet: 'o' }], d: [{ url: 'https://x/3', outlet: 'o' }] };
  assert.deepEqual(pendingShows(plan, ['c']), ['a', 'd']);
  assert.deepEqual(pendingShows(plan, new Set()), ['a', 'c', 'd']);
  assert.deepEqual(pendingShows({}, []), []);
  assert.deepEqual(emptyShows(plan), ['b']);
});

test('formatUrlsInput writes "url outlet" lines, drops duplicate urls, refuses bad entries', () => {
  const s = formatUrlsInput([
    { url: 'https://a.com/r', outlet: 'talkinbroadway' },
    { url: 'https://a.com/r', outlet: 'talkinbroadway' },
    { url: 'https://b.com/r', outlet: 'theatrely' },
  ]);
  assert.equal(s, 'https://a.com/r talkinbroadway\nhttps://b.com/r theatrely');
  assert.throws(() => formatUrlsInput([{ url: 'a.com/r', outlet: 'x' }]), /bad entry/);
  assert.throws(() => formatUrlsInput([{ url: 'https://a.com/r', outlet: '' }]), /bad entry/);
  // ingest-urls.js splits on whitespace: a space would make the second word the outlet.
  assert.throws(() => formatUrlsInput([{ url: 'https://a.com/r', outlet: 'front row' }]), /bad entry/);
  assert.throws(() => formatUrlsInput([{ url: 'https://a.com/a b', outlet: 'x' }]), /bad entry/);
});

test('formatUrlsInput refuses an outlet missing from the registry set', () => {
  const known = new Set(['theatrely']);
  assert.equal(formatUrlsInput([{ url: 'https://b.com/r', outlet: 'theatrely' }], known), 'https://b.com/r theatrely');
  assert.throws(() => formatUrlsInput([{ url: 'https://b.com/r', outlet: 'theatrly' }], known), /not in the outlet registry/);
});

test('queueHasRoom waits at the cap and when the count is unknown', () => {
  assert.equal(queueHasRoom(0), true);
  assert.equal(queueHasRoom(DEFAULT_MAX_ACTIVE - 1), true);
  assert.equal(queueHasRoom(DEFAULT_MAX_ACTIVE), false);
  assert.equal(queueHasRoom(318, 15), false);
  assert.equal(queueHasRoom(NaN), false);
  assert.equal(queueHasRoom(undefined), false);
});
