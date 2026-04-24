/**
 * Unit test for scripts/audit-bww-rr-critic-mismatches.js extractor.
 *
 * The script's value is detecting authorName mismatches in BWW JSON-LD. The
 * extractor has to parse the same 3 authorName formats that gather-reviews'
 * extractBWWRoundupReviews Method 1 handles:
 *   - "Outlet - Critic"
 *   - "Critic, Outlet"
 *   - "Outlet: Critic"
 *
 * If this extractor drifts from the real extractor, the audit will miss
 * mismatches silently. These tests lock the format handling.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { extractAuthorPairs } = require('../../scripts/audit-bww-rr-critic-mismatches.js');

function mkHtml(author, headline = 'Test headline') {
  return `<script type="application/ld+json">
{
  "@type": "BlogPosting",
  "author": {"name": ${JSON.stringify(author)}},
  "headline": ${JSON.stringify(headline)},
  "articleBody": "test body"
}
</script>`;
}

describe('extractAuthorPairs — author format recognition', () => {
  test('"Outlet - Critic" → outletId + criticName', () => {
    const r = extractAuthorPairs(mkHtml('The New York Times - Helen Shaw'));
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].outletId, 'nytimes');
    assert.strictEqual(r[0].criticName, 'Helen Shaw');
  });

  test('"Critic, Outlet" (comma) — canonical BWW format', () => {
    const r = extractAuthorPairs(mkHtml('David Finkle, Cote Notices'));
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].outletId, 'cote-notices');
    assert.strictEqual(r[0].criticName, 'David Finkle');
  });

  test('"Outlet: Critic" (colon)', () => {
    const r = extractAuthorPairs(mkHtml('NY Post: Johnny Oleksinski'));
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].outletId, 'nypost');
    assert.strictEqual(r[0].criticName, 'Johnny Oleksinski');
  });

  test('author name with no recognizable separator returns no pair', () => {
    const r = extractAuthorPairs(mkHtml('Just A Name'));
    assert.strictEqual(r.length, 0);
  });

  test('author name with comma but neither side is a registered outlet → no pair (ambiguous)', () => {
    const r = extractAuthorPairs(mkHtml('John Doe, Jane Smith'));
    assert.strictEqual(r.length, 0);
  });

  test('LiveBlogPosting with nested BlogPosting entries', () => {
    const html = `<script type="application/ld+json">
{
  "@type": "LiveBlogPosting",
  "liveBlogUpdate": [
    {"@type": "BlogPosting", "author": {"name": "The New York Times - Jesse Green"}, "articleBody": "a"},
    {"@type": "BlogPosting", "author": {"name": "Variety - Marilyn Stasio"}, "articleBody": "b"}
  ]
}
</script>`;
    const r = extractAuthorPairs(html);
    assert.strictEqual(r.length, 2);
    assert.strictEqual(r[0].outletId, 'nytimes');
    assert.strictEqual(r[0].criticName, 'Jesse Green');
    assert.strictEqual(r[1].outletId, 'variety');
    assert.strictEqual(r[1].criticName, 'Marilyn Stasio');
  });

  test('ignores non-BlogPosting JSON-LD', () => {
    const html = `<script type="application/ld+json">
{"@type": "Organization", "name": "BWW"}
</script>`;
    const r = extractAuthorPairs(html);
    assert.strictEqual(r.length, 0);
  });
});
