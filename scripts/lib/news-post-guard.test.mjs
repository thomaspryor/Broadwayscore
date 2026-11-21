import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { classifyNewsPost } = require('./news-post-guard.js');

const short = 'The long-running Broadway revival will play its final performance on July 2. Tickets are on sale through then.';

test('the four Front Row Center announcements are news', () => {
  for (const u of [
    'https://thefrontrowcenter.com/2022/01/to-kill-a-mockingbird-sets-closing-and-opening-dates/',
    'https://thefrontrowcenter.com/2025/04/harry-potter-and-the-cursed-child-celebrates-7-years-on-broadway/',
    'https://thefrontrowcenter.com/2026/08/every-brilliant-thing-closing-august-9/',
    'https://thefrontrowcenter.com/2026/10/august-wilsons-seven-guitars-set-to-open/',
  ]) assert.equal(classifyNewsPost({ url: u, text: short }).news, true, u);
});

test('a review page is never refused: says review, is long, or has a review-shaped slug', () => {
  const u = 'https://thefrontrowcenter.com/2026/08/every-brilliant-thing-closing-august-9/';
  assert.equal(classifyNewsPost({ url: u, text: short + ' Our review: a joy.' }).news, false);
  assert.equal(classifyNewsPost({ url: u, text: 'x'.repeat(3500) }).news, false);
  // A title-only slug with a body that has no announcement phrases (BRO-7874: two phrases now refuse).
  assert.equal(classifyNewsPost({ url: 'https://thefrontrowcenter.com/2023/11/arcadia/', text: 'A clever, chilly revival that never quite warms.' }).news, false);
  // BRO-7874: no text is refused on an announcement slug alone, never on any other slug.
  assert.equal(classifyNewsPost({ url: u, text: '' }).news, true);
  assert.equal(classifyNewsPost({ url: u, text: null }).news, true);
  assert.equal(classifyNewsPost({ url: 'https://thefrontrowcenter.com/2023/11/arcadia/', text: null }).news, false);
});

test('review-headline slugs that contain news words are never refused', () => {
  // A neutral short body (no announcement phrases), so only the slug is under test.
  const neutral = 'The cast is game and the staging is brisk, though the second act sags.';
  for (const slug of ['extended-play', 'broadway-review-extends-its-reach', 'hamlet-to-open-old-wounds', 'the-closing-and-the-curtain', 'to-close-the-gap-review', 'macbeth-announces-itself']) {
    assert.equal(classifyNewsPost({ url: 'https://x.com/2026/05/' + slug + '/', text: neutral }).news, false, slug);
  }
  assert.equal(classifyNewsPost({ url: 'https://x.com/2026/05/celebrates-10th-anniversary/', text: short }).news, true);
});

test('ingest-urls.js calls the guard (class guard: reverting the wiring fails here)', () => {
  const src = fs.readFileSync(new URL('../ingest-urls.js', import.meta.url), 'utf8');
  assert.match(src, /classifyNewsPost\(/);
  assert.match(src, /if \(news\.news\) \{[\s\S]{0,400}continue;/);
  // BRO-7874: the guard is not gated on extracted text.
  assert.doesNotMatch(src, /if \(fullText\) \{\s*const news = classifyNewsPost/);
});
