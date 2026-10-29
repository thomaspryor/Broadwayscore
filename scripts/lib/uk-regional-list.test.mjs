import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { hubFor, titleSlug, buildList } = createRequire(import.meta.url)('./uk-regional-list.js');

test('hub assignment', () => {
  assert.equal(hubFor('king-lear-review-royal-exchange-theatre-manchester'), 'manchester');
  assert.equal(hubFor('the-crucible-theatre-sheffield'), 'yorkshire');
  assert.equal(hubFor('lanny-review-bristol-old-vic'), 'bristol-bath');
  assert.equal(hubFor('turandot-review-theatre-royal-glasgow'), 'scotland');
  assert.equal(hubFor('gianni-schicchi-review-theatr-clwyd-mold'), 'uk-regional');
});
test('title extraction', () => {
  assert.equal(titleSlug('twelfth-night-at-the-crucible-theatre-review'), 'twelfth-night');
  assert.equal(titleSlug('a-tidy-boy-review-swansea-grand-theatre'), 'a-tidy-boy');
});
test('buildList groups reviews, drops Edinburgh and pre-2024', () => {
  const mk = (outlet, url, publishDate) => ({ outlet, url, publishDate });
  const l = buildList([
    mk('thestage', 'https://x/reviews/a-tidy-boy-review-swansea', '2026-10-21'),
    mk('whatsonstage', 'https://x/news/a-tidy-boy-at-swansea-review_1', '2026-10-22'),
    mk('thestage', 'https://x/reviews/foo-review-edinburgh-fringe', '2025-08-01'),
    mk('thestage', 'https://x/reviews/old-review-leeds', '2023-05-01'),
  ]);
  assert.equal(l.length, 1);
  assert.equal(l[0].reviews.length, 2);
});
