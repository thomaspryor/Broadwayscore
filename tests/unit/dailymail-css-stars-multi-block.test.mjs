// BRO-305: Daily Mail combined columns carry one mol-ratings block per show.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { extractScore } = createRequire(import.meta.url)('../../scripts/lib/score-extractors.js');

const block = (n) => `<div class="mol-ratings-solid"><p>${[1, 2, 3, 4, 5]
  .map(i => `<span class="rating-star${i <= n ? ' selected' : ''}"></span>`).join('')}</p></div>`;
const page = (...blocks) => `<html><body><article>${blocks.join('<p>review text</p>')}</article></body></html>`;

test('single block still extracts', () => {
  const r = extractScore(page(block(3)), 'review text', 'daily-mail', 'Elektra');
  assert.equal(r?.source, 'dailymail-css-stars');
  assert.equal(r.originalScore, '3/5 stars');
});

test('disagreeing blocks (combined column) extract no CSS stars', () => {
  const r = extractScore(page(block(1), block(3)), 'review text', 'daily-mail', 'Elektra');
  assert.notEqual(r?.source, 'dailymail-css-stars');
});
