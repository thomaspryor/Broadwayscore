/**
 * DTLI critic-name regex regression test.
 *
 * Bucket B (discovery misses): Schmigadoon opening night 2026-04-20 silently
 * mismatched every DTLI review because the critic-name regex assumed the
 * format `First<br/>Last` and used `[^<]+` which truncates at any `<`. Shows
 * with single-name critics (Madonna, mononyms), three-part names split by one
 * `<br/>`, or no `<br/>` at all got `criticName = null` → collapsed to 'unknown'
 * files → wrong-file writes.
 *
 * Fix mirrors scripts/scrape-dtli.js:292 — lazy-match to the closing tag, then
 * strip `<br/>` variants and inner HTML tags. See also
 * memory/feedback_dtli_br_tag_critic_name.md.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const ROOT = join(import.meta.dirname, '..', '..');
const { extractReviewsFromDTLI } = require(
  join(ROOT, 'scripts/extract-dtli-reviews.js')
);

// Minimal DTLI HTML fixture — one review-item per case. DTLI's real structure
// uses <div class="review-item"> containing a review_image div, a critic-name
// h2, a date h3, and a paragraph. The extractor only needs the critic-name
// block + an outlet signal + a paragraph to produce a record.
function dtliReviewHtml({ outlet, criticBlock }) {
  return `
<div class="review-item">
  <div class="review_image"><div>${outlet}</div></div>
  <div>
    <img alt="BigThumbs_Up.png">
    <h2 class="review-item-critic-name">${criticBlock}</h2>
    <h3 class="review-item-date">April 20, 2026</h3>
    <p class="paragraph">A well-crafted test fixture that satisfies the minimum extraction requirements.</p>
  </div>
</div>`;
}

function buildPage(reviewBlocks) {
  return `<html><body>${reviewBlocks.join('\n')}</body></html>`;
}

test('DTLI critic name: First<br/>Last format (most common) captures full name', () => {
  const html = buildPage([
    dtliReviewHtml({ outlet: 'Test Outlet', criticBlock: '<a href="/x">Patrick<br />Gomez</a>' }),
  ]);
  const reviews = extractReviewsFromDTLI(html, 'test-show');
  assert.strictEqual(reviews.length, 1);
  assert.strictEqual(
    reviews[0].criticName,
    'Patrick Gomez',
    'Two-part name split by <br/> must capture both halves. ' +
      'Regression signal: old regex truncated to "Patrick".'
  );
});

test('DTLI critic name: single-name critic (no <br/>) captures full name', () => {
  const html = buildPage([
    dtliReviewHtml({ outlet: 'Test Outlet', criticBlock: '<a href="/x">Madonna</a>' }),
  ]);
  const reviews = extractReviewsFromDTLI(html, 'test-show');
  assert.strictEqual(reviews.length, 1);
  assert.strictEqual(
    reviews[0].criticName,
    'Madonna',
    'Single-name critic must capture as-is. ' +
      'Regression signal: old regex required <br/> and set criticName=null.'
  );
});

test('DTLI critic name: three-part name with one <br/> captures all parts', () => {
  const html = buildPage([
    dtliReviewHtml({
      outlet: 'Test Outlet',
      criticBlock: '<a href="/x">Helen Shaw<br />Collins-Hughes</a>',
    }),
  ]);
  const reviews = extractReviewsFromDTLI(html, 'test-show');
  assert.strictEqual(reviews.length, 1);
  assert.strictEqual(
    reviews[0].criticName,
    'Helen Shaw Collins-Hughes',
    'Three-part name must preserve all whitespace-separated parts.'
  );
});

test('DTLI critic name: double <br/> (multi-line) collapses to single-spaced name', () => {
  const html = buildPage([
    dtliReviewHtml({
      outlet: 'Test Outlet',
      criticBlock: '<a href="/x">Maria<br />de la<br />Renta</a>',
    }),
  ]);
  const reviews = extractReviewsFromDTLI(html, 'test-show');
  assert.strictEqual(reviews.length, 1);
  assert.strictEqual(reviews[0].criticName, 'Maria de la Renta');
});

test('DTLI critic name: extra whitespace is collapsed', () => {
  const html = buildPage([
    dtliReviewHtml({
      outlet: 'Test Outlet',
      criticBlock: '<a href="/x">  Ben   Brantley  </a>',
    }),
  ]);
  const reviews = extractReviewsFromDTLI(html, 'test-show');
  assert.strictEqual(reviews.length, 1);
  assert.strictEqual(reviews[0].criticName, 'Ben Brantley');
});
