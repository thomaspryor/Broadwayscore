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
const { wetPostTitleMatchesShow } = require('./wet-roundup-discover.js');

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
