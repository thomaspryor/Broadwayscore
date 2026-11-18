#!/usr/bin/env node
/**
 * BRO-7739 regression: titleMatchesShow / urlSlugMatchesShow accept the MAIN title of a
 * subtitled show ("Blue Man Group “A New Holiday Surprise”" -> "Blue Man Group") when
 * the main title is distinctive and no other current show shares it.
 * Requires the real functions (CLAUDE.md §15). Fails with the main-title fallback reverted.
 */
const assert = require('assert');
const { titleMatchesShow, urlSlugMatchesShow, mainTitleOf, mainTitleIsUnique } = require('./lib/rss-discovery');

const BMG = 'Blue Man Group “A New Holiday Surprise”';
const BMG_HEADLINE = 'Review: Blue Man Group’s Broadway Christmas Show Is a Lump of Coal';
const BMG_URL = 'https://www.theatermania.com/news/review-blue-man-groups-broadway-christmas-show-is-a-lump-of-coal_1860029/';

// ALL show titles the uniqueness check sees (explicit so the test needs no data/).
const all = [BMG, 'Blue Mantis Live', 'Stranger Things: The First Shadow', 'Death Note: The Musical', 'Derren Brown: Only Human',
  'Heated Rivalry: The Unauthorized Musical Parody', 'Hamilton', 'Orlando: A Pornobiography',
  'Cirque “Alpha Show”', 'Cirque “Beta Show”', 'Cirque du Soleil'];
const on = { fuzzy: true, mainTitle: true, allShowTitles: all };

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('mainTitleOf splits quoted, colon and dash subtitles (BRO-7778), never a 1-word main', () => {
  assert.strictEqual(mainTitleOf(BMG), 'Blue Man Group');
  assert.strictEqual(mainTitleOf('Stranger Things: The First Shadow'), 'Stranger Things');
  assert.strictEqual(mainTitleOf('Adriana Mater - English National Opera'), 'Adriana Mater');
  assert.strictEqual(mainTitleOf('August: Osage County'), null);
  assert.strictEqual(mainTitleOf('Dolly: A True Original Musical'), null);
  assert.strictEqual(mainTitleOf('Hamilton'), null);
  assert.strictEqual(mainTitleOf('Charles Dickens’ “A Christmas Carol”'), null); // author credit (dry-run false positive)
  assert.strictEqual(mainTitleOf("Julia Sweeney's God Said \"Ha!\""), null);
  assert.strictEqual(mainTitleOf('Orlando “A Pornobiography”'), null); // one significant word
});
t('Blue Man Group headline matches by main title (opt-in)', () => assert.ok(titleMatchesShow(BMG_HEADLINE, BMG, on)));
t('URL slug with the plain main title matches', () =>
  assert.ok(urlSlugMatchesShow('https://example.com/review-blue-man-group-christmas-show/', BMG, on)));
t('the exact TheaterMania URL slug matches (possessive slug "groups")', () => assert.ok(urlSlugMatchesShow(BMG_URL, BMG, on)));
t('without opts.mainTitle: no match (old behaviour)', () => {
  assert.ok(!titleMatchesShow(BMG_HEADLINE, BMG, { fuzzy: true, allShowTitles: all }));
  assert.ok(!titleMatchesShow(BMG_HEADLINE, BMG, { fuzzy: true }));
});
t('no allShowTitles (or empty): fails closed', () => {
  assert.ok(!titleMatchesShow(BMG_HEADLINE, BMG, { fuzzy: true, mainTitle: true }));
  assert.ok(!titleMatchesShow(BMG_HEADLINE, BMG, { fuzzy: true, mainTitle: true, allShowTitles: [] }));
});
t('main title shared by another show does NOT match', () =>
  assert.ok(!titleMatchesShow('Review: Cirque Returns With Style', 'Cirque “Alpha Show”', on)));
t('uniqueness needs a word boundary: Blue Mantis does not block Blue Man', () => {
  assert.ok(mainTitleIsUnique('Blue Man Group “X”', 'Blue Man', ['Blue Mantis Live']));
  assert.ok(!mainTitleIsUnique('Blue Man Group “X”', 'Blue Man', ['Blue Man Live']));
});
t('false positives: TV / anime / person stories never match', () => {
  assert.ok(!titleMatchesShow('Heated Rivalry season 2 casting revealed', 'Heated Rivalry: The Unauthorized Musical Parody', on));
  assert.ok(!titleMatchesShow('Stranger Things finale breaks Netflix records', 'Stranger Things: The First Shadow', on));
  assert.ok(!titleMatchesShow('Derren Brown announces new TV special', 'Derren Brown: Only Human', on));
  assert.ok(!titleMatchesShow('Death Note anime returns', 'Death Note: The Musical', on));
});
t('a colon/dash main title matches only beside a review cue (BRO-7778)', () => {
  const IAWL = 'It’s A Wonderful Life: A Live Radio Play';
  const all2 = [...all, IAWL];
  const o = { fuzzy: true, mainTitle: true, allShowTitles: all2, pressNames: false };
  assert.ok(titleMatchesShow("Review: It's a Wonderful Life", IAWL, o));
  assert.ok(titleMatchesShow('‘It’s a Wonderful Life’ on Broadway, reviewed', IAWL, o));
  assert.ok(urlSlugMatchesShow('https://www.theatermania.com/news/review-its-a-wonderful-life-broadway_1861000/', IAWL, o));
  assert.ok(!titleMatchesShow('It’s a Wonderful Life returns to cinemas for 80th anniversary', IAWL, o));
  assert.ok(titleMatchesShow('Stranger Things: The First Shadow? No, Stranger Things review', 'Stranger Things: The First Shadow', o));
});
t('unrelated headlines still rejected', () => {
  assert.ok(!titleMatchesShow('Review: A Blue Whale Visits Broadway', BMG, on));
  assert.ok(!titleMatchesShow('Man Group earnings beat as Blue chips rally', BMG, on));
});
t('full title still matches as before', () =>
  assert.ok(titleMatchesShow('Review: Blue Man Group “A New Holiday Surprise”', BMG, { fuzzy: true })));

console.log(`\n${n} passed`);
