// BRO-7291 class 4: title typos copied from listings. Replays hangman-regional-2026 (staged "Hangman" from the
// theatreinla listing; the reviews print "Hangmen", McDonagh's play) with short headline/credit lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { titleSpellingFinding } = require('./title-spelling-check.js');

const KNOWN = ['Hangmen', 'Hamlet', 'Hairspray', 'Rent', 'Company'];
const texts = [
  'Review: HANGMEN at Long Beach Playhouse. Hangmen, by Martin McDonagh. Hangmen runs through Nov. 15. The hangman of the title, Harry, retired.',
  'Hangmen | Long Beach Playhouse. In Hangmen the last hangman in England holds court. Hangmen plays Fridays.',
];

test('replay hangman-regional-2026: staged "Hangman", reviews print "Hangmen"', () => {
  const r = titleSpellingFinding({ title: 'Hangman' }, texts, KNOWN);
  assert.ok(r);
  assert.equal(r.title, 'Hangmen');
  assert.ok(r.theirs > 2 * r.ours);
});

test('correct title is not flagged', () => {
  assert.equal(titleSpellingFinding({ title: 'Hangmen' }, texts, KNOWN.filter((t) => t !== 'Hangmen')), null);
});

test('a near title only mentioned in passing does not fire (Rent vs Rest, Hamlet in a Hairspray review)', () => {
  assert.equal(titleSpellingFinding({ title: 'Hamlet' }, ['Hamlet opens. Hamlet is long. Hamlet, Hamlet.', 'The Hamlet here is young.'], KNOWN), null);
  assert.equal(titleSpellingFinding({ title: 'Rest' }, ['Rent. Rent. Rent.', 'Rest.'], KNOWN), null); // only one of two texts prints it
});

test('no texts, no finding', () => {
  assert.equal(titleSpellingFinding({ title: 'Hangman' }, [], KNOWN), null);
});
