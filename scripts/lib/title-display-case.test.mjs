import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isShoutedTitle, toDisplayTitleCase } = require('./title-display-case.js');

// The four the owner saw in the 2026-09-20 Broadway round-up.
test('the real corpus offenders convert correctly', () => {
  assert.equal(toDisplayTitleCase('AMERICA, WHO HURT YOU?'), 'America, Who Hurt You?');
  assert.equal(toDisplayTitleCase('IN HONOR OF JEAN-MICHEL BASQUIAT'), 'In Honor of Jean-Michel Basquiat');
  assert.equal(toDisplayTitleCase('THE HOPE THEORY'), 'The Hope Theory');
  assert.equal(
    toDisplayTitleCase('THE BODY OF MARY: A PLAY IN THREE ACTS (OF GOD)'),
    'The Body of Mary: A Play in Three Acts (of God)',
  );
});

test('the rest of the multi-word corpus offenders', () => {
  assert.equal(toDisplayTitleCase('KING OF THE YEES'), 'King of the Yees');
  assert.equal(toDisplayTitleCase('MILES FOR MARY'), 'Miles for Mary');
  assert.equal(toDisplayTitleCase('ORATORIO FOR LIVING THINGS'), 'Oratorio for Living Things');
  assert.equal(toDisplayTitleCase('COPPERFIELD! THE NEW MUSICAL'), 'Copperfield! The New Musical');
  assert.equal(toDisplayTitleCase('GOD IS A WOMAN THE MUSICAL'), 'God Is a Woman the Musical');
  assert.equal(toDisplayTitleCase('AFTER ALL THESE YEARS'), 'After All These Years');
  assert.equal(toDisplayTitleCase('LOS SOLES TRUNCOS'), 'Los Soles Truncos');
});

test("apostrophes: KING'S must not become KING'S -> King'S", () => {
  assert.equal(toDisplayTitleCase("THE KING'S CRITIQUE"), "The King's Critique");
});

test('a minor word is capitalised when it is first or last', () => {
  assert.equal(toDisplayTitleCase('THE PLAY THAT GOES WRONG'), 'The Play That Goes Wrong');
  assert.equal(toDisplayTitleCase('WHAT THE CONSTITUTION MEANS TO ME'), 'What the Constitution Means to Me');
});

test('a minor word after terminal punctuation is force-capitalised', () => {
  assert.equal(toDisplayTitleCase('SOMETHING ROTTEN: THE MUSICAL'), 'Something Rotten: The Musical');
  assert.equal(toDisplayTitleCase('WHO IS THERE? A GHOST STORY'), 'Who Is There? A Ghost Story');
});

test('acronyms keep their shape', () => {
  assert.equal(toDisplayTitleCase('A TRIP TO NYC TODAY'), 'A Trip to NYC Today');
  assert.equal(toDisplayTitleCase('HENRY IV PART ONE'), 'Henry IV Part One');
});

// --- the conservative half: what must NOT be touched ---

test('genuinely stylised short all-caps titles are left alone', () => {
  for (const t of ['SIX', 'POTUS', 'BLKS', 'FELA!', 'MJ', 'HAIR', 'RENT', 'CATS']) {
    assert.equal(toDisplayTitleCase(t), t, `${t} must not be rewritten`);
    assert.equal(isShoutedTitle(t), false, `${t} must not be flagged`);
  }
});

test('two-word all-caps is left alone (SIX THE MUSICAL-style stylisations)', () => {
  assert.equal(toDisplayTitleCase('WET HOUSE'), 'WET HOUSE');
  assert.equal(isShoutedTitle('WET HOUSE'), false);
});

test('already correctly-cased titles pass through untouched', () => {
  for (const t of [
    'The Cherry Orchard (Park Avenue Armory)',
    'Man to Man',
    "My Son's A Queer (But What Can You Do?)",
    'Thelma & Louise: A New Musical',
    'Hamilton',
  ]) {
    assert.equal(toDisplayTitleCase(t), t);
    assert.equal(isShoutedTitle(t), false);
  }
});

test('a mixed-case title with some caps is not flagged', () => {
  assert.equal(isShoutedTitle('SIX: The Musical'), false);
  assert.equal(toDisplayTitleCase('SIX: The Musical'), 'SIX: The Musical');
});

test('junk input is handled', () => {
  assert.equal(isShoutedTitle(''), false);
  assert.equal(isShoutedTitle(null), false);
  assert.equal(isShoutedTitle(undefined), false);
  assert.equal(toDisplayTitleCase(null), null);
  assert.equal(toDisplayTitleCase(''), '');
});

test('minWords is configurable for callers that want a stricter sweep', () => {
  assert.equal(isShoutedTitle('WET HOUSE', { minWords: 2 }), true);
  assert.equal(toDisplayTitleCase('WET HOUSE', { minWords: 2 }), 'Wet House');
});
