// extractPublishDate must give the publisher-local date for UTC og:published_time stamps (BRO-5499)
// and keep the old date-part behaviour for odd-but-prefixed stamps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { extractPublishDate } = require('./article-extractor');
const meta = (t) => `<html><head><meta property="article:published_time" content="${t}"></head></html>`;

test('UTC og stamp after midnight is the previous evening for a US publisher', () => {
  assert.equal(extractPublishDate(meta('2026-10-16T02:26:00+00:00'), 'https://nystagereview.com/2026/10/15/x/'), '2026-10-15');
});
test('explicit local offset and date-only stamps are taken as written', () => {
  assert.equal(extractPublishDate(meta('2026-10-15T21:30:00-04:00'), 'https://x.com/a'), '2026-10-15');
  assert.equal(extractPublishDate(meta('2026-10-15'), 'https://x.com/a'), '2026-10-15');
});
test('a UK publisher keeps London time', () => {
  assert.equal(extractPublishDate(meta('2026-10-15T23:30:00Z'), 'https://www.whatsonstage.com/r'), '2026-10-16');
});
test('lenient stamps (+00, single-digit hour) still resolve instead of returning null', () => {
  assert.equal(extractPublishDate(meta('2026-05-27T02:00:00+00'), 'https://x.com/a'), '2026-05-26');
  assert.equal(extractPublishDate(meta('2026-05-27T25:61:00Z'), 'https://x.com/a'), '2026-05-27');
});
