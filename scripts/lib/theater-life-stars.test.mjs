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

// BRO-7928: the weekly recovery reads the footer star from the stored text,
// because theaterlife.com's WP API times out from GitHub runners.
test('footerRatingFromStoredText reads the footer star of a stored review file', () => {
  const { footerRatingFromStoredText } = require('./theater-life-stars.js');
  const fullText = "Daniel Fish's Elektra, on the other hand, has been drained of all its power.\n\nElektra **Theatre for a New Audience at Polonsky Shakespeare Center, 262 Ashland Place, Brooklyn.";
  assert.deepEqual(
    footerRatingFromStoredText({ outletId: 'theater-life', showTitle: 'Elektra', fullText }),
    { originalScore: '2/5 stars', normalizedScore: 40, source: 'wp-api-footer' },
  );
  assert.equal(footerRatingFromStoredText({ outletId: 'theater-life', showTitle: 'Elektra', fullText: 'Elektra is a play.' }), null);
  assert.equal(footerRatingFromStoredText({ outletId: 'guardian', showTitle: 'Elektra', fullText }), null, 'Theater Life only');
  assert.equal(footerRatingFromStoredText({ outletId: 'theater-life', showTitle: 'Oedipus', fullText }), null, "another show's footer line");
  assert.equal(footerRatingFromStoredText({ outletId: 'theater-life', fullText }), null, 'no title, no guess');
});

test('footerStars treats straight and curly apostrophes as the same (BRO-7928)', () => {
  assert.equal(footerStars("Photo credit.\nA Doll’s House, Part 2 *** 1/2 John Golden Theatre", ["A Doll's House, Part 2"]), '3.5/5 stars');
  assert.equal(footerStars("Photo credit.\nA Doll's House, Part 2 ** Golden", ['A Doll’s House, Part 2']), '2/5 stars');
});

test("a combined column's title star is read per show, not the last group (BRO-7928)", () => {
  // Live post title of the Time and the Conways review (2017). The end-of-title
  // match used to give all three reviews A Clockwork Orange's 2 stars.
  const title = 'Time and the Conways ***1/2 &#8211; Measure for Measure**1/2 &#8211; A Clockwork Orange **';
  const pick = (show) => resolveTheaterLifeStars({ title, text: '', showTitles: [show] }).rating;
  assert.equal(pick('Time and the Conways'), '3.5/5 stars');
  assert.equal(pick('Measure for Measure'), '2.5/5 stars');
  assert.equal(pick('A Clockwork Orange'), '2/5 stars');
  assert.equal(pick('Hamlet'), null, 'no segment names this show: no guess');
  assert.equal(resolveTheaterLifeStars({ title, text: '' }).rating, null, 'no show title: no guess');
  assert.equal(pick(''), null);
  // A single-show title is unchanged.
  assert.equal(resolveTheaterLifeStars({ title: 'Wish You Were Here ***1/2', text: '', showTitles: ['Wish You Were Here'] }).rating, '3.5/5 stars');
});

test('combined titles split by commas, with subtitles, and a one-show title with an extra segment (BRO-7928)', () => {
  const pick = (title, show) => resolveTheaterLifeStars({ title, text: '', showTitles: [show] }).rating;
  const lightning = 'Scotland, PA ***, Little Shop of Horrors ****, Forbidden Broadway: The Next Generation ***, The Lightning Thief: The Percy Jackson Musical **';
  assert.equal(pick(lightning, 'The Lightning Thief'), '2/5 stars');
  assert.equal(pick(lightning, 'Little Shop of Horrors'), '4/5 stars');
  assert.equal(pick(lightning, 'Scotland, PA'), '3/5 stars');
  assert.equal(pick('The Shark Is Broken ***, Back to the Future: The Musical ***', 'Back to the Future: The Musical'), '3/5 stars');
  assert.equal(pick('Sunday in the Park with George **** &#8211; Linda ***1/2', 'Sunday in the Park with George'), '4/5 stars');
  assert.equal(pick('Sunday in the Park with George **** &#8211; Linda ***1/2', 'Linda'), '3.5/5 stars');
  assert.equal(pick('Clara- Sex, Love and Classical Music *** – Mrs. Schumann Speaks Out', 'Clara: Sex, Love and Classical Music'), '3/5 stars');
});

test('title segments: "and" joiner, and an exact name beats a prefix one (BRO-7928 review)', () => {
  const pick = (title, show) => resolveTheaterLifeStars({ title, text: '', showTitles: [show] }).rating;
  const elephant = 'The Elephant Man  ***    and    A Delicate Balance ****';
  assert.equal(pick(elephant, 'The Elephant Man'), '3/5 stars');
  assert.equal(pick(elephant, 'A Delicate Balance'), '4/5 stars');
  assert.equal(pick('Fish ** &#8211; Fish in the Dark ****', 'Fish'), '2/5 stars');
  assert.equal(pick('Fish ** &#8211; Fish in the Dark ****', 'Fish in the Dark'), '4/5 stars');
  assert.equal(pick('Company ***1/2 &#8211; Company: The Musical **', 'Company'), '3.5/5 stars');
  const liaisons = 'Plenty** Love, Love, Love ** Les Liaisons Dangereuses**** Vietgone****';
  assert.equal(pick(liaisons, 'Les Liaisons Dangereuses'), '4/5 stars');
  assert.equal(pick(liaisons, 'Love, Love, Love'), '2/5 stars');
  assert.equal(pick('Good Time Charlie ***, Fish ****, Anon ***', 'ANON – a tempest at our kitchen table'), '3/5 stars');
});
