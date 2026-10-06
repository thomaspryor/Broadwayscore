import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { extractArticleText, extractArticleTextFromUrl } = require('../../scripts/lib/article-extractor');
const review = 'The staging brings Helen and her troubled family into sharp focus. The performances are compelling, but the pacing loses momentum in the final scene. '.repeat(3).trim();
const pension = 'The complete guide to accessing your pension. Our free Radio Times pension guide provided by Pense helps readers plan their retirement. '.repeat(3);
const url = 'https://www.radiotimes.com/going-out/going-out-reviews/bloodsport-after-helen-of-troy-review/';

test('Radio Times selects the full nested review body rather than the pension advert', () => {
  const html = `<article>${pension}</article><div class="post__content zephr-locked-content"><div><p>${review}</p><div class="photo"><div>Photo</div></div><p>The closing scene lands beautifully.</p></div></div>`;
  const text = extractArticleTextFromUrl(html, url);
  assert.ok(text.includes(review));
  assert.ok(text.endsWith('The closing scene lands beautifully.'));
  assert.ok(!text.includes('pension'));
});

test('existing Radio Times page fixture yields prose without navigation or promotions', () => {
  const html = readFileSync(new URL('../fixtures/star-ratings/radio-times.html', import.meta.url), 'utf8');
  const text = extractArticleText(html, 'www.radiotimes.com');
  assert.ok(text?.length > 3000);
  assert.ok(text.startsWith('On his journey to becoming a national symbol'));
  assert.ok(!text.includes('We may earn commission'));
  assert.ok(!text.includes('Subscribe for'));
});

test('Radio Times missing its body rejects an otherwise plausible advert', () => {
  assert.equal(extractArticleText(`<article>${pension}</article>`, 'radiotimes.com'), null);
});

for (const marker of [
  pension,
  'We may earn commission from links on this page.',
  'Subscribe for £1 per week.',
  'Subscribe now to read more.',
  'Sign up to our newsletter for daily recommendations.',
  'Subscribe to the weekly reviews newsletter.',
  'This site is protected by reCAPTCHA and the Google Privacy Policy applies.',
  'This page contains content provided by Google reCAPTCHA. We ask for your permission.',
  'reCAPTCHA Terms of Service apply.',
]) {
  for (const wrap of [
    (text) => `<article>${text}</article>`,
    (text) => `<main>${text}</main>`,
    (text) => `<div class="entry-content">${text}</div>`,
    (text) => `<div><p>${text}</p></div>`,
  ]) {
    test(`Radio Times rejects boilerplate through ${wrap.name || wrap(marker).split('>')[0]}: ${marker.slice(0, 50)}`, () => {
      assert.equal(extractArticleText(wrap(`${marker} ${review}`), 'radiotimes.com'), null);
    });
  }
}

test('guard also rejects contaminated dedicated outlet extraction', () => {
  const html = `<div class="post__content"><p>${review}</p><p>We may earn commission from links on this page.</p></div>`;
  assert.equal(extractArticleText(html, 'radiotimes.com'), null);
});

test('Time Out London fixture still extracts substantial review text', () => {
  const html = readFileSync(new URL('../fixtures/star-ratings/timeout-london.html', import.meta.url), 'utf8');
  const text = extractArticleText(html, 'www.timeout.com');
  assert.ok(text?.length > 5000, 'Time Out London review must survive unrelated promo checks');
});

test('Radio Times promo guard does not apply to unrelated hosts', () => {
  const prose = `${review} We may earn commission from links on this page.`;
  assert.equal(extractArticleText(`<article>${prose}</article>`, 'unknown.example'), prose);
  assert.equal(extractArticleText(`<article>${prose}</article>`, 'WWW.RADIOTIMES.COM'), null);
});

test('ordinary criticism mentioning newsletters, subscriptions or commissions survives', () => {
  // Ordinary vocabulary must not be enough to reject a review.
  const prose = `${review.trim()} Her newsletter chronicles the theatre's new commission. Characters subscribe to his philosophy and discuss their pension.`;
  assert.equal(extractArticleText(`<article>${prose}</article>`, 'unknown.example'), prose);
  assert.equal(extractArticleText('', 'unknown.example'), null);
  assert.equal(extractArticleText(null, 'unknown.example'), null);
});
