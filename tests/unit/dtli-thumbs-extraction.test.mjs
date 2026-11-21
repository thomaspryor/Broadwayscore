/**
 * BRO-725 — DTLI per-review thumbs not extractable (JS-rendered).
 *
 * Ticket premise (2026-04-07, Becky Shaw): DTLI's per-review thumb-up/meh/down
 * assignments only existed in the JS-rendered page, not the static HTML — only
 * the show-level summary image (thumb-12.png) was server-rendered, so
 * extractReviewsFromDTLI() couldn't recover per-critic thumbs from an archived
 * page fetched without JS execution.
 *
 * Verified 2026-08-21 against the live page: DTLI's current template renders
 * each review-item's `<img alt="BigThumbs_UP">` (etc.) directly into the
 * initial HTML — captured identically whether Playwright waits for
 * 'domcontentloaded' or executes to full JS settle (page.content() is
 * byte-identical post-JS since thumbs are already server-rendered). This test
 * fixture models a JS-settled page.content() snapshot (the shape
 * fetch-aggregator-pages.ts's fetchDtli() archives) and asserts the extractor
 * assigns dtliThumb per review, matching the real Becky Shaw markup structure
 * (review-item-header wrapping outlet img + thumb img + critic-name h2).
 *
 * Companion fix: fetch-aggregator-pages.ts now waits for a BigThumbs_* image
 * to attach before reading page.content() (see waitForDtliThumbs) rather than
 * a blind 500ms timeout — guards against a future regression where DTLI
 * delays thumb rendering past that window. That wait is a live-Playwright
 * concern (timing against a real browser tab) and isn't exercised here — this
 * file covers what IS unit-testable and was actually missing: whether
 * extractReviewsFromDTLI()'s regex correctly assigns dtliThumb once the page
 * content is in hand, regardless of how it was captured.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');
const { extractReviewsFromDTLI } = require(join(ROOT, 'scripts/extract-dtli-reviews.js'));

// Mirrors the real DTLI review-item-header markup (BRO-725 investigation):
// outlet attribution <img>, thumb <img alt="BigThumbs_*">, then critic-name h2
// — all inside <div class="review-item-header">, siblings of the date/paragraph.
function dtliReviewItem({ outlet, thumbAlt, criticBlock, text }) {
  return `
<div class="review-item">
  <div class="review-item-header">
    <img src="https://didtheylikeit.com/wp-content/uploads/outlet.png" loading="lazy" alt="${outlet}" aria-label="${outlet}" class="review-item-attribution">
    <img src="https://didtheylikeit.com/wp-content/themes/didthey/images/${thumbAlt}.png" loading="lazy" alt="${thumbAlt}" class="image-2">
    <h2 class="review-item-critic-name"><a href="/?s=x&searchfor=critics">${criticBlock}</a></h2>
  </div>
  <h3 class="review-item-date">April 6, 2026</h3>
  <p class="paragraph">${text}</p>
</div>`;
}

function buildPage(items) {
  return `<html><body><section class="section-review-page">${items.join('\n')}</section></body></html>`;
}

test('DTLI thumbs: Up/Meh/Down all extract per-review from JS-settled markup', () => {
  const html = buildPage([
    dtliReviewItem({
      outlet: 'NEW YORK TIMES',
      thumbAlt: 'BigThumbs_UP',
      criticBlock: 'Laura<br />Collins-Hughes',
      text: 'These characters aren’t likable at all, yet the production handles them with real care.',
    }),
    dtliReviewItem({
      outlet: 'THE GUARDIAN',
      thumbAlt: 'BigThumbs_MEH',
      criticBlock: 'Adrian<br />Horton',
      text: 'A competent revival that never quite finds the play’s bite or its comic snap.',
    }),
    dtliReviewItem({
      outlet: 'NY STAGE REVIEW',
      thumbAlt: 'BigThumbs_DOWN',
      criticBlock: 'Frank<br />Scheck',
      text: 'A misfire that mistakes cruelty for wit and never earns its own premise.',
    }),
  ]);

  const reviews = extractReviewsFromDTLI(html, 'becky-shaw-2026');
  assert.strictEqual(reviews.length, 3, 'all three review-item blocks should extract');

  const byOutlet = Object.fromEntries(reviews.map((r) => [r.outletId, r.dtliThumb]));
  assert.strictEqual(byOutlet.nytimes, 'Up');
  assert.strictEqual(byOutlet.guardian, 'Meh');
  assert.strictEqual(byOutlet.nysr, 'Down');
});

test('DTLI thumbs: per-review thumb count matches the show-level aggregate', () => {
  // Mirrors the ticket's own numbers: DTLI showed 12 up / 2 meh for Becky Shaw.
  const upItems = Array.from({ length: 12 }, (_, i) =>
    dtliReviewItem({
      outlet: `OUTLET ${i}`,
      thumbAlt: 'BigThumbs_UP',
      criticBlock: `Critic<br />Number${i}`,
      text: `A glowing enough notice to count as review number ${i} in this fixture.`,
    })
  );
  const mehItems = Array.from({ length: 2 }, (_, i) =>
    dtliReviewItem({
      outlet: `MIXED OUTLET ${i}`,
      thumbAlt: 'BigThumbs_MEH',
      criticBlock: `Mixed<br />Critic${i}`,
      text: `A mixed notice that counts as meh review number ${i} in this fixture.`,
    })
  );
  const html = buildPage([...upItems, ...mehItems]);

  const reviews = extractReviewsFromDTLI(html, 'becky-shaw-2026');
  assert.strictEqual(reviews.length, 14);
  assert.strictEqual(reviews.filter((r) => r.dtliThumb === 'Up').length, 12);
  assert.strictEqual(reviews.filter((r) => r.dtliThumb === 'Meh').length, 2);
});

test('DTLI thumbs: a review-item with no thumb image gets dtliThumb=null, not dropped', () => {
  const html = buildPage([
    `
<div class="review-item">
  <div class="review-item-header">
    <img src="https://didtheylikeit.com/wp-content/uploads/outlet.png" loading="lazy" alt="VULTURE" aria-label="VULTURE" class="review-item-attribution">
    <h2 class="review-item-critic-name"><a href="/?s=x&searchfor=critics">Sara<br />Holdren</a></h2>
  </div>
  <h3 class="review-item-date">April 6, 2026</h3>
  <p class="paragraph">A review with no thumb image at all — should still extract with a null thumb.</p>
</div>`,
  ]);

  const reviews = extractReviewsFromDTLI(html, 'becky-shaw-2026');
  assert.strictEqual(reviews.length, 1);
  assert.strictEqual(reviews[0].dtliThumb, null);
});

test('DTLI thumbs: poster-review-item variant (alternate DTLI template) still extracts thumbs', () => {
  const item = dtliReviewItem({
    outlet: 'DEADLINE',
    thumbAlt: 'BigThumbs_UP',
    criticBlock: 'Greg<br />Evans',
    text: 'A poster-layout review block that should parse the same as the standard template.',
  }).replace('<div class="review-item">', '<div class="poster-review-item">');
  const html = `<html><body>${item}</body></html>`;

  const reviews = extractReviewsFromDTLI(html, 'becky-shaw-2026');
  assert.strictEqual(reviews.length, 1);
  assert.strictEqual(reviews[0].dtliThumb, 'Up');
});
