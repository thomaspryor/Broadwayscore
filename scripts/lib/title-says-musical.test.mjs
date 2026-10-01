// The shared "title names a musical" rule (BRO-4398 follow-up). Real catalog
// titles: the six that were typed play, plus the play that must stay a play.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { titleSaysMusical } = require('./title-says-musical.js');

test('titles ending in "musical" are musicals; a leading "Musical" is not', () => {
  for (const t of ['Death Note The Musical', 'Trainspotting the musical', 'GOD IS A WOMAN THE MUSICAL', 'Copperfield! The New Musical',
    'Shamilton! The Improvised Hip-Hop Musical', "We've Been Here Before: A One Woman Musical", 'Monsters A Killer New Musical Comedy',
    'Dog Man - The Musical', 'Show: A New Musical', 'Heathers the Musical', 'Singfeld! A Musical About Nothing',
    'Friends The Musical Parody', 'Kinky Boots The Musical - UK Tour', 'Death Note The Musical in Concert', 'Musical',
    'Musical Hell: A New Musical', 'The Musical of Musicals (The Musical!)', 'Our Sinatra: A Musical Celebration',
    'Midnight - A New Original Musical by Todrick Hall', 'Heated Rivalry: The Unauthorized Musical Parody', 'Grayson the Musical: A First Look',
    'Dog Man - The Musical Live', 'Hadestown: A Musical Experience']) {
    assert.equal(titleSaysMusical(t), true, t);
  }
  for (const t of ['The Musical Comedy Murders of 1940', 'Jimmy', 'Musical Chairs at Midnight', 'An Evening of Musical Theatre',
    'The Best of Musical Theatre', 'A West End Musical Christmas', 'Murder at the Musical Society',
    'Twelfth Night, with Musical Interludes', '', null]) {
    assert.equal(titleSaysMusical(t), false, String(t));
  }
});

test('showTypeFor: venue genre label first, then the title', () => {
  const { showTypeFor } = require('./title-says-musical.js');
  assert.equal(showTypeFor('The Pianist', 'Musicals'), 'musical');           // Park Theatre's Spektrix genre
  assert.equal(showTypeFor('Some Show', 'Musical - star casting'), 'musical'); // Young Vic
  assert.equal(showTypeFor('Some Show', 'Opera'), 'play', 'opera labels are not mapped');
  assert.equal(showTypeFor('Jimmy', 'Drama'), 'play');
  assert.equal(showTypeFor('Father Christmas', "Christmas Shows; Children's Show"), 'play');
  assert.equal(showTypeFor('Death Note The Musical', null), 'musical');
  assert.equal(showTypeFor('The Musical Comedy Murders of 1940', undefined), 'play');
  assert.equal(showTypeFor('X', 'Non-musical drama'), 'play');
  assert.equal(showTypeFor('X', 'Non musical drama'), 'play');
  const { knownShowType } = require('./title-says-musical.js');
  assert.equal(knownShowType('Broom Play', undefined), null, 'no signal: leave the type empty');
  assert.equal(knownShowType('Broom Play', 'Drama'), 'play');
  assert.equal(knownShowType('Copperfield! The New Musical', undefined), 'musical');
  assert.equal(knownShowType('X', 'Opera'), null);
  assert.equal(knownShowType('X', 'Dance'), null);
  assert.equal(knownShowType('X', "Children's Show"), null);
  assert.equal(knownShowType('X', 'Theatre'), null, 'a bare Theatre category is not a play signal');
  assert.equal(knownShowType('Swan Lake', 'Dance; Theatre'), null);
  assert.equal(knownShowType('X', 'Opera; Theatre'), null);
  assert.equal(knownShowType('X', 'Drama; Plays/Drama'), 'play');
  assert.equal(knownShowType('X', 'Musicals'), 'musical');
});
