/**
 * Regression test for the WestEndTheatre post-title matcher.
 *
 * The old inline check was `wpTitle.includes(word)` over the show's >2-char
 * words (duplicates counted twice). "Man to Man" became ["man","man"] and
 * matched the Fences roundup ("...Ray Fearon's perforMANce...") and The
 * Children roundup ("...woMAN..."), so The Stage's Fences review replaced the
 * real Man to Man review URL on the live page (reader report 2026-09-26).
 * Twenty cached WET archives were attached to the wrong show the same way.
 * Per CLAUDE.md rule 15 this require()s the real predicate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { wetPostTitleMatchesShow, parseWetRenderedBlocks } = require('./wet-roundup-discover.js');
const { extractSectionReviews } = require('../scrape-westendtheatre-roundups.js');

test('substring collisions no longer match (the Man to Man incident)', () => {
  assert.equal(wetPostTitleMatchesShow(
    'Fences Reviews: critics enjoyed Ray Fearon’s performance, but are split on whether the pacing pays off',
    'Man to Man'), false);
  assert.equal(wetPostTitleMatchesShow('The Children reviews: a woman at the end of the world', 'Man to Man'), false);
});

test('wrong-show roundups found cached in the WET archive are rejected', () => {
  const cases = [
    ['Shadowlands reviews starring Hugh Bonneville', 'SIX'],
    ['Shadowlands reviews starring Hugh Bonneville', 'The Lion King'],
    ['Guess How Much I Love You reviews', 'Back to the Future'],
    ['American Psycho reviews 2026', 'Operation Mincemeat'],
    ['American Psycho reviews 2026', 'Burlesque'],
    ['Reviews of Oh, Mary! starring Mason Alexander Park at the Trafalgar Theatre London', 'Mass'],
    ['A Midsummer Night’s Dream Globe reviews', 'Hamilton'],
    ['Avenue Q reviews round-up at Shaftesbury Theatre in London', 'Mamma Mia!'],
  ];
  for (const [wp, show] of cases) {
    assert.equal(wetPostTitleMatchesShow(wp, show), false, `${show} <- ${wp}`);
  }
});

test('real roundups for the show still match', () => {
  const cases = [
    ['Man to Man reviews: Tilda Swinton at the Royal Court', 'Man to Man'],
    ['Oliver! reviews round-up', 'Oliver!'],
    ['Six reviews round-up', 'SIX'],
    ['& Juliet reviews round-up at the Shaftesbury Theatre in London', '& Juliet'],
    ['Orlando Reviews starring Emma Corrin', 'Orlando: A Pornobiography'],
    ['Bacchae reviews at the National Theatre', 'The Bacchae'],
    ['A Moon for the Misbegotten reviews round-up Almeida Theatre', 'A Moon for the Misbegotten'],
  ];
  for (const [wp, show] of cases) {
    assert.equal(wetPostTitleMatchesShow(wp, show), true, `${show} <- ${wp}`);
  }
});

test('long titles still accept a >=60% whole-word match', () => {
  assert.equal(wetPostTitleMatchesShow('Unlikely Pilgrimage of Harold Fry West End reviews', 'The Unlikely Pilgrimage of Harold Fry'), true);
  // Stopwords don't count toward the 60%: only "house" would be shared here.
  assert.equal(wetPostTitleMatchesShow('The House with the Chicken Legs reviews', 'The House of Bernarda Alba'), false);
});

test('generic title words do not make two shows match (ship-check on #940)', () => {
  const cases = [
    ['Amélie, A New Musical reviews', 'Beaches, A New Musical'],
    ['King Richard III reviews', 'King Charles III'],
    ['You Never Can Tell reviews', 'Catch Me If You Can'],
    ['Tosca - English National Opera reviews', 'La Boheme - English National Opera'],
    ['Collected Stories reviews', 'STORIES – The Tap Dance Sensation'],
    ['Jack and the Beanstalk reviews', 'Jack: A Night on the Town'],
  ];
  for (const [wp, show] of cases) {
    assert.equal(wetPostTitleMatchesShow(wp, show), false, `${show} <- ${wp}`);
  }
});

test('a one-word main title before a subtitle still matches its own posts', () => {
  for (const wp of ['Doubt review', 'Review: Doubt at the Donmar', 'Doubt Reviews: critics praise the cast']) {
    assert.equal(wetPostTitleMatchesShow(wp, 'Doubt: A Parable'), true, wp);
  }
  assert.equal(wetPostTitleMatchesShow('King Charles III review', 'King Charles III'), true);
});

test('an "&"-led title does not match inside another title', () => {
  assert.equal(wetPostTitleMatchesShow('Romeo and Juliet reviews at the Harold Pinter', '& Juliet'), false);
  assert.equal(wetPostTitleMatchesShow('& Juliet reviews round-up at the Shaftesbury Theatre in London', '& Juliet'), true);
  assert.equal(wetPostTitleMatchesShow('Review: & Juliet at the Shaftesbury', '& Juliet'), true);
});

// --- Rendered-page block scoping (BRO-4851) ---------------------------------
// The FT block has no byline and no link. Before the fix, unbounded nextAll()
// gave it the Guardian's critic and the Guardian's URL.
const BLEED_HTML = `
  <div>
    <p class="reviewnewpubhead">Financial Times</p>
    <p class="reviewnewstars">★★★</p>
    <p class="reviewnewquote">"A handsome but chilly revival"</p>
    <p class="reviewnewpubhead">The Guardian</p>
    <p class="reviewnewstars">★★★★</p>
    <p class="reviewnewquote">"Mark Rylance is magnificent"</p>
    <p class="reviewnewauthor">Arifa Akbar</p>
    <a href="https://www.theguardian.com/stage/2024/oct/07/juno-and-the-paycock-review">read</a>
  </div>`;

test("parseWetRenderedBlocks: a block without byline/link does not borrow the next outlet's", () => {
  const rows = parseWetRenderedBlocks(BLEED_HTML);
  assert.deepEqual(rows, [
    { outlet: 'Financial Times', stars: 3, critic: 'Unknown', url: '' },
    { outlet: 'The Guardian', stars: 4, critic: 'Arifa Akbar', url: 'https://www.theguardian.com/stage/2024/oct/07/juno-and-the-paycock-review' },
  ]);
});

test('parseWetRenderedBlocks: a link cited inside the quote is not the review URL', () => {
  const rows = parseWetRenderedBlocks(`<div>
    <p class="reviewnewpubhead">The Telegraph</p>
    <p class="reviewnewstars">★★★</p>
    <p class="reviewnewquote">"Echoes <a href="https://en.wikipedia.org/wiki/Oedipus">the myth</a> well"</p>
    <p class="reviewnewauthor">Claire Allfree</p>
    <a href="https://www.telegraph.co.uk/theatre/oedipus-review/">read</a>
  </div>`);
  assert.equal(rows[0].url, 'https://www.telegraph.co.uk/theatre/oedipus-review/');
});

test('extractSectionReviews (scrape-westendtheatre-roundups): same block scoping for critic, quote and URL', () => {
  const rows = extractSectionReviews(BLEED_HTML);
  const ft = rows.find(r => r.outlet === 'Financial Times');
  const g = rows.find(r => r.outlet === 'The Guardian');
  assert.equal(ft.critic, null);
  assert.equal(ft.reviewUrl, null);
  assert.match(ft.excerpt, /chilly/);
  assert.equal(g.critic, 'Arifa Akbar');
  assert.equal(g.reviewUrl, 'https://www.theguardian.com/stage/2024/oct/07/juno-and-the-paycock-review');
  assert.match(g.excerpt, /Rylance/);
});
