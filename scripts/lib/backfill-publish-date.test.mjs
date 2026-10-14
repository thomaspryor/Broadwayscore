import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveBackfillPublishDate } = require('./backfill-publish-date.js');

test('compact-URL article id loses to a later text date (Albany Times Union)', () => {
  const r = resolveBackfillPublishDate({ url: 'https://www.timesunion.com/news/life-of-pi-review-20161207.php', fullText: 'Life of Pi review\nFebruary 19, 2025\n\nBody', textFetchedAt: '2025-03-01T00:00:00Z' });
  assert.deepEqual(r, { date: '2025-02-19', source: 'text-over-url-compact' });
});
test('earlier text date (past production/event) never overrides a compact URL date', () => {
  const r = resolveBackfillPublishDate({ url: 'https://bww.com/review-20231110', fullText: 'The original production closed up shop on March 10, 2020.' });
  assert.deepEqual(r, { date: '2023-11-10', source: 'url-compact' });
});
test('text date after the fetch time is ignored; precise url-ymd is never overridden', () => {
  assert.equal(resolveBackfillPublishDate({ url: 'https://x.com/a-20240101', fullText: 'Opens March 5, 2027', textFetchedAt: '2024-02-01T00:00:00Z' }).date, '2024-01-01');
  assert.equal(resolveBackfillPublishDate({ url: 'https://example.com/2024/03/05/r/', fullText: 'June 1, 2025' }).date, '2024-03-05');
});
test('URL date is the last resort; no URL date -> null even if text has one', () => {
  assert.equal(resolveBackfillPublishDate({ url: 'https://example.com/2024/03/05/show-review/', fullText: 'No date.' }).source, 'url-ymd');
  assert.equal(resolveBackfillPublishDate({ url: 'https://example.com/review', fullText: 'March 5, 2024 review' }), null);
  assert.equal(resolveBackfillPublishDate({}), null);
});
