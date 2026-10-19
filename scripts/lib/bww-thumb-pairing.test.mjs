// Tests for scripts/lib/bww-thumb-pairing.js (BRO-5674). Requires the real module.
// Run: node --test scripts/lib/bww-thumb-pairing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldPairBwwThumbs } = require('./bww-thumb-pairing.js');

test('pairs only when every review has exactly one icon', () => {
  assert.equal(shouldPairBwwThumbs(19, 19), true);
  assert.equal(shouldPairBwwThumbs(20, 19), false); // ODC 2026: one stray icon
  assert.equal(shouldPairBwwThumbs(5, 19), false);
  assert.equal(shouldPairBwwThumbs(0, 0), false);
  assert.equal(shouldPairBwwThumbs(0, 7), false);
});

test('gather-reviews gates its positional pairing on the guard', () => {
  const src = fs.readFileSync(new URL('../gather-reviews.js', import.meta.url), 'utf8');
  const guard = src.indexOf('shouldPairBwwThumbs(thumbMatches.length, reviews.length)');
  const pairing = src.indexOf('reviews[i].bwwThumb = thumbMatches[i]');
  assert.ok(guard > 0 && pairing > guard, 'guard must precede the positional assignment');
});

test('one thumb per <img>, srcset repeats collapse', async () => {
  const { extractBwwThumbIcons } = require('./bww-thumb-pairing.js');
  const img = (f) => `<p><img alt="x" src="https://cloudimages.broadwayworld.com/${f}?width=800" srcset="https://c/${f}?w=400 400w, https://c/${f}?w=800 800w, https://c/${f}?w=1200 1200w" style="float:left"></p>`;
  const html = img('uptrans2.png') + '<p>text</p>' + img('middletrans2.png') + img('downtrans.png') + '<img src="/BigThumbs_MEH.gif">' + '<img src="/logo.png">';
  assert.deepEqual(extractBwwThumbIcons(html), ['Up', 'Meh', 'Down', 'Meh']);
  assert.deepEqual(extractBwwThumbIcons(''), []);
});
