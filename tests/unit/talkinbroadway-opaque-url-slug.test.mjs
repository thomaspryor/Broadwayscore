/**
 * BRO-5106: talkinbroadway.com review urls are opaque ids, so their slug must
 * never read as "a different show" (it blocked the Mystic Pizza forum-link
 * recovery swap onto /regional/minn/minn1534.html).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { slugLooksLikeDifferentShow } = require('../../scripts/lib/review-normalization.js');

test('regional TB review url is not a different show', () => {
  assert.strictEqual(
    slugLooksLikeDifferentShow('https://www.talkinbroadway.com/regional/minn/minn1534.html', { showTitle: 'Mystic Pizza' }),
    false);
});

test('non-TB url with a different-show slug is still flagged', () => {
  assert.strictEqual(
    slugLooksLikeDifferentShow('https://example.com/reviews/equus-review', { showTitle: 'War Horse' }),
    true);
});
