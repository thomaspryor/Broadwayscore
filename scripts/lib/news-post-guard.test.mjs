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
  assert.equal(classifyNewsPost({ url: 'https://thefrontrowcenter.com/2023/11/arcadia/', text: short }).news, false);
  assert.equal(classifyNewsPost({ url: u, text: '' }).news, false);
  assert.equal(classifyNewsPost({ url: u, text: null }).news, false);
});

test('ingest-urls.js calls the guard (class guard: reverting the wiring fails here)', () => {
  const src = fs.readFileSync(new URL('../ingest-urls.js', import.meta.url), 'utf8');
  assert.match(src, /classifyNewsPost\(/);
});
