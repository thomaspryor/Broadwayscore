/**
 * Unit tests for the Time Out SVG star reader in scripts/lib/score-extractors.js.
 * A 5/5 block has no _unfilledRating_ div, so it used to fall through to the
 * non-structural text-pattern source and could not supersede a cleared star (BRO-4490).
 *
 * Run: node --test tests/unit/timeout-svg-stars.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractScore } = require('../../scripts/lib/score-extractors.js');

const svg = '<svg viewBox="0 0 24 24"><path d="M1"/></svg>';
const block = (filled, unfilled, label) =>
  `<div class="_ratingStars_1ibww_1" data-testid="star-rating_testID">${svg.repeat(filled)}` +
  (unfilled ? `<div class="_unfilledRating_x">${svg.repeat(unfilled)}</div>` : '') +
  (label ? `<span class="sr-only">${label}</span>` : '') + '</div>';

describe('Time Out SVG stars', () => {
  test('5/5 block with no unfilled div reads as structural 5/5', () => {
    const r = extractScore(block(5, 0, '5 out of 5 stars'), '', 'timeout');
    assert.equal(r.originalScore, '5/5');
    assert.equal(r.source, 'timeout-svg-stars');
  });
  test('4/5 block with unfilled div still reads 4/5', () => {
    const r = extractScore(block(4, 1, '4 out of 5 stars'), '', 'timeout');
    assert.equal(r.originalScore, '4/5');
    assert.equal(r.source, 'timeout-svg-stars');
  });
  test('label that disagrees with the SVG count is not structural', () => {
    const r = extractScore(block(3, 0, '5 out of 5 stars'), '', 'timeout');
    assert.notEqual(r && r.source, 'timeout-svg-stars');
  });
  test('a label after other markup (another widget) is not structural', () => {
    const html = block(5, 0, '').replace('</div>', '</div><div class="related">') + '<span class="sr-only">5 out of 5 stars</span></div>';
    const r = extractScore(html, '', 'timeout');
    assert.notEqual(r && r.source, 'timeout-svg-stars');
  });
});
