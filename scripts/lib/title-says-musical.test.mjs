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
    'Dog Man - The Musical', 'Show: A New Musical', 'Heathers the Musical']) {
    assert.equal(titleSaysMusical(t), true, t);
  }
  for (const t of ['The Musical Comedy Murders of 1940', 'Jimmy', 'Musical Chairs at Midnight', '', null]) {
    assert.equal(titleSaysMusical(t), false, String(t));
  }
});

test('showTypeFor: venue genre label first, then the title', () => {
  const { showTypeFor } = require('./title-says-musical.js');
  assert.equal(showTypeFor('The Pianist', 'Musicals'), 'musical');           // Park Theatre's Spektrix genre
  assert.equal(showTypeFor('Some Show', 'Musical - star casting'), 'musical'); // Young Vic
  assert.equal(showTypeFor('Some Show', 'Opera'), 'opera');
  assert.equal(showTypeFor('Jimmy', 'Drama'), 'play');
  assert.equal(showTypeFor('Father Christmas', "Christmas Shows; Children's Show"), 'play');
  assert.equal(showTypeFor('Death Note The Musical', null), 'musical');
  assert.equal(showTypeFor('The Musical Comedy Murders of 1940', undefined), 'play');
});
