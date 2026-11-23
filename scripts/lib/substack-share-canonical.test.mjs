// BRO-8204: a Substack share link (substack.com/home/post/p-<id>) must be
// swapped for the publication's canonical URL so the outlet resolves to the
// publication, not a generic "substack" outlet the misattribution guard holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { substackShareCanonicalUrl, isSubstackShareUrl } = require('./non-review-url-patterns.js');

const page = (href) => `<html><head><link rel="canonical" href="${href}" /></head><body>x</body></html>`;

test('home/post share link adopts the publication canonical (issue #1198)', () => {
  assert.equal(
    substackShareCanonicalUrl('https://substack.com/home/post/p-218072386', page('https://stephenkearley.substack.com/p/stephen-kearley-reviews-falls-for')),
    'https://stephenkearley.substack.com/p/stephen-kearley-reviews-falls-for');
});

test('@profile share link adopts a custom-domain canonical', () => {
  assert.equal(
    substackShareCanonicalUrl('https://substack.com/@someone/p-123', page('https://www.example-blog.com/p/review')),
    'https://www.example-blog.com/p/review');
});

test('non-share URLs and unusable canonicals are left alone', () => {
  assert.equal(substackShareCanonicalUrl('https://stephenkearley.substack.com/p/x', page('https://other.substack.com/p/y')), null);
  assert.equal(substackShareCanonicalUrl('https://substack.com/home/post/p-1', page('https://substack.com/home/post/p-1')), null);
  assert.equal(substackShareCanonicalUrl('https://substack.com/home/post/p-1', '<html>no canonical</html>'), null);
  assert.equal(substackShareCanonicalUrl('https://substack.com/home/post/p-1', page('javascript:alert(1)')), null);
  assert.equal(isSubstackShareUrl('https://substack.com/browse'), false);
  assert.equal(isSubstackShareUrl('https://www.substack.com/home/post/p-9'), true);
});
