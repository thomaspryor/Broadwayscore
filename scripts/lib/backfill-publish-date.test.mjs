import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveBackfillPublishDate } = require('./backfill-publish-date.js');

test('text dateline beats URL digits (Albany Times Union article id)', () => {
  const r = resolveBackfillPublishDate({ url: 'https://www.timesunion.com/news/life-of-pi-review-20161207.php', fullText: 'Feb 19, 2025\n\nLife of Pi review' });
  assert.deepEqual(r, { date: '2025-02-19', source: 'text-dateline' });
});
test('URL date is the last resort when the text prints none', () => {
  const r = resolveBackfillPublishDate({ url: 'https://example.com/2024/03/05/show-review/', fullText: 'No date here.' });
  assert.equal(r.date, '2024-03-05');
  assert.equal(r.source, 'url-ymd');
});
test('no source -> null (never the opening date)', () => {
  assert.equal(resolveBackfillPublishDate({ url: 'https://example.com/review', fullText: 'x' }), null);
  assert.equal(resolveBackfillPublishDate({}), null);
});
