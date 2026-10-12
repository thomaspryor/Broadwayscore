// BRO-305: Theater Life star rating — footer line beats the WP post title.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseTitleStars, footerStars, resolveTheaterLifeStars } = require('./theater-life-stars.js');

test('parseTitleStars reads trailing title stars, with half star', () => {
  assert.deepEqual(parseTitleStars('The Dinosaurs ****'), { cleanTitle: 'The Dinosaurs', rating: '4/5 stars' });
  assert.deepEqual(parseTitleStars('Show Name *** 1/2'), { cleanTitle: 'Show Name', rating: '3.5/5 stars' });
  assert.deepEqual(parseTitleStars('No Stars Here'), { cleanTitle: 'No Stars Here', rating: null });
});

// Footer line under the photo is the per-show copy of the rating.
test('footer rating wins over a disagreeing title rating', () => {
  const r = resolveTheaterLifeStars({ title: 'The Dinosaurs ****', text: 'Review body ends here.\nThe Dinosaurs ** 1/2\nTheater info', showTitles: ['The Dinosaurs'] });
  assert.deepEqual(r, { cleanTitle: 'The Dinosaurs', rating: '2.5/5 stars', source: 'wp-api-footer' });
});

// Combined column (card #396 shape): one footer per show; only this show's counts.
test('combined column: picks the footer naming this show, not the other one', () => {
  const text = 'First review ...\nBirthright *****\nSecond review ...\nOther Play **';
  assert.equal(footerStars(text, ['Birthright']), '5/5 stars');
  assert.equal(footerStars(text, ['Other Play']), '2/5 stars');
});

test('no footer: title star is a corroboration-gated fallback', () => {
  const r = resolveTheaterLifeStars({ title: 'Cats ***', text: 'No footer line in this one.' });
  assert.deepEqual(r, { cleanTitle: 'Cats', rating: '3/5 stars', source: 'wp-api-title' });
});

test('conflicting footers for the same title -> no footer rating', () => {
  assert.equal(footerStars('Cats ***\nlater\nCats *', ['Cats']), null);
});

test('a title word inside a longer name does not match', () => {
  assert.equal(footerStars('TheCats ***', ['Cats']), null);
});

// Live shapes (theaterlife.com WP API, 2026-10-12): a tag split inside the
// footer stars ("War Paint * **1/2") and a quarter star ("Sets **** 1/4").
test('stars split by a space, and quarter stars', () => {
  assert.equal(footerStars('joyfully.\n War Paint * **1/2 \nNederlander', ['War Paint']), '3.5/5 stars');
  assert.deepEqual(parseTitleStars('Sets **** 1/4'), { cleanTitle: 'Sets', rating: '4.25/5 stars' });
  assert.equal(footerStars('Sets **** 1/4 Venue', ['Sets']), '4.25/5 stars');
});
