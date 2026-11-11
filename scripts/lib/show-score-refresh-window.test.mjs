// BRO-7372: the Show Score refresh must also pick up a show whose critics publish before its
// opening window. require()s the real selector (CLAUDE.md §15); fixed clock, no new Date().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { selectRefreshShows } = require('./show-score-refresh-window.js');
const NOW = Date.parse('2026-11-11T03:45:00Z');
const show = (id, over) => ({ id, status: 'previews', previewsStartDate: '2026-10-21', ...over });
const rv = (showId, publishDate) => ({ showId, publishDate });
const pick = (shows, reviews, opts) => selectRefreshShows(shows, reviews, { nowMs: NOW, ...opts });

test('rule (a): a show opening inside [now-2d, now+2d] is picked, without reviews', () => {
  assert.deepEqual(pick([show('a', { openingDate: '2026-11-12' }), show('b', { openingDate: '2026-11-10' })], []), ['a', 'b']);
});
test('rule (b): the ripple shape, opening in 7 days with reviews since previews began', () => {
  const ripple = show('ripple', { openingDate: '2026-11-18' });
  assert.deepEqual(pick([ripple], [rv('ripple', '2026-11-10'), rv('ripple', '2026-11-10')]), ['ripple']);
  // five days after the wave began still counts (a 3-day recency check would have dropped it)
  assert.deepEqual(pick([ripple], [rv('ripple', '2026-11-06')]), ['ripple']);
});
test('rule (b) needs a review: a future show with none, or only an older production, is not picked', () => {
  const s = show('x', { openingDate: '2026-11-18' });
  assert.deepEqual(pick([s], []), []);
  assert.deepEqual(pick([s], [rv('x', '2023-01-24'), rv('x', '2026-11'), rv('x', null)]), []);
});
test('rule (b) is bounded: a show opening beyond 14 days is not picked', () => {
  assert.deepEqual(pick([show('far', { openingDate: '2026-12-01' })], [rv('far', '2026-11-10')]), []);
});
test('an ordinal publishDate counts like ISO (BRO-2836)', () => {
  assert.deepEqual(pick([show('o', { openingDate: '2026-11-18' })], [rv('o', 'November 10th, 2026')]), ['o']);
});
test('boundaries: now+2d is rule (a), now+2d+1ms is not, and nothing is counted twice', () => {
  const edge = new Date(NOW + 2 * 86400000).toISOString();
  const over = new Date(NOW + 2 * 86400000 + 1).toISOString();
  assert.deepEqual(pick([show('e', { openingDate: edge })], [rv('e', '2026-11-10')]), ['e']);
  assert.deepEqual(pick([show('o', { openingDate: over })], []), []);
  assert.deepEqual(pick([show('d', { openingDate: '2026-11-12' })], [rv('d', '2026-11-10'), rv('d', '2026-11-11')]), ['d']);
});
test('closed shows, and shows with no or unparseable openingDate, are never picked', () => {
  const reviews = [rv('c', '2026-11-10'), rv('n', '2026-11-10'), rv('u', '2026-11-10')];
  assert.deepEqual(pick([show('c', { openingDate: '2026-11-12', status: 'closed' }), show('n', {}), show('u', { openingDate: 'TBD' })], reviews), []);
});
