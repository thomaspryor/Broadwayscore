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

// Live shape: the scraper's plain text joins the venue straight onto the
// fraction ("A Walk On The Moon ** 1/2Laura Pels Theatre"). The half star
// used to be dropped there (2.5 read as 2).
test('venue glued onto the fraction keeps the half star', () => {
  assert.equal(footerStars('moon.\n\nA Walk On The Moon ** 1/2Laura Pels Theatre, 111', ['A Walk On The Moon']), '2.5/5 stars');
  assert.equal(footerStars('Cats ** 1/23 more', ['Cats']), '2/5 stars');
});

// Live shapes: "THE MUSIC MAN ****I/2" (typo for 1/2), and "Pretty Woman ***"
// with the half star in a separate element. A footer star count that differs
// from the title's still wins ("Home *****" titled, "Home ****" footer).
test('footer keeps the half star the title has; a real disagreement keeps the footer', () => {
  assert.equal(footerStars('MAN: THE MUSIC MAN ****I/2 venue', ['The Music Man']), '4.5/5 stars');
  assert.equal(resolveTheaterLifeStars({ title: 'Pretty Woman ***1/2', text: 'x\nPretty Woman ***\n' }).rating, '3.5/5 stars');
  assert.deepEqual(resolveTheaterLifeStars({ title: 'Home *****', text: 'x\nHome ****Todd Haimes Theatre' }),
    { cleanTitle: 'Home', rating: '4/5 stars', source: 'wp-api-footer' });
});

// Review findings (ship-check): raw HTML entities, another show's footer on a
// combined column, and a lone "*" inside prose.
test('entities decode; a combined column never lends another show its footer', () => {
  assert.equal(resolveTheaterLifeStars({ title: 'The Dinosaurs&nbsp;** 1/2', text: 'x The Dinosaurs&nbsp;** 1/2Playwrights' }).rating, '2.5/5 stars');
  assert.equal(resolveTheaterLifeStars({ title: 'Don&#8217;t Go ***', text: 'x\nDon&#8217;t Go ***Venue', showTitles: ['Don’t Go'] }).source, 'wp-api-footer');
  assert.equal(resolveTheaterLifeStars({ title: 'Romeo &amp; Juliet **', text: 'x\nRomeo &amp; Juliet **Venue' }).rating, '2/5 stars');
  // Post is about Birthright, this review is for Other's Play whose footer did not match.
  const r = resolveTheaterLifeStars({ title: 'Birthright *****', text: 'Birthright *****MCC\nOther Plays ** Venue', showTitles: ['Other’s Play'] });
  assert.notEqual(r.source, 'wp-api-footer');
  assert.equal(footerStars('like Cats * the original', ['Cats']), null);
});

test('accented show titles match their unaccented post title', () => {
  assert.equal(resolveTheaterLifeStars({ title: 'Therese Raquin ***', text: 'x\nTherese Raquin ***Venue', showTitles: ['Thérèse Raquin'] }).source, 'wp-api-footer');
});
