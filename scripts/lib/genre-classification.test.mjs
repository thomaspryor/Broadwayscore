// Tests the conservative genre classifier + the non-theatrical policy list.
// Also parity-guards NON_THEATRICAL_GENRES against the TS source src/lib/genre.ts
// (parsed as text, since this runs under plain node --test in the lib glob).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { classifyGenre, isNonTheatricalGenre, applyGenreCategoryOverride, NON_THEATRICAL_GENRES } =
  require('./genre-classification.js');

test('dance houses classify as dance', () => {
  assert.equal(classifyGenre({ title: 'The Car Man', venue: "Sadler's Wells" }), 'dance');
  assert.equal(classifyGenre({ title: 'Some Show', venue: 'Peacock Theatre' }), 'dance');
});

test('high-confidence title signals classify', () => {
  assert.equal(classifyGenre({ title: 'Now You See Me Live', venue: 'London Coliseum' }), 'magic');
  assert.equal(classifyGenre({ title: 'This Is Rambert', venue: 'Some Venue' }), 'dance');
  assert.equal(classifyGenre({ title: 'Derren Brown: Only Human', venue: 'TBA' }), 'magic');
  assert.equal(classifyGenre({ title: 'Liberace & Liza: A Tribute', venue: 'TBA' }), 'cabaret');
});

test('manual genre is authoritative', () => {
  assert.equal(classifyGenre({ title: 'A Life in Four Seasons', venue: "Regent's Park", genre: 'dance' }), 'dance');
});

test('conservative: plays/musicals do NOT misclassify', () => {
  assert.equal(classifyGenre({ title: 'The Dancer Upstairs', venue: 'Apollo Theatre' }), null);
  assert.equal(classifyGenre({ title: 'Death of a Salesman', venue: "Regent's Park Open Air Theatre" }), null);
  // "comedy" the bare word must not trip (many plays are comedies)
  assert.equal(classifyGenre({ title: 'The Comedy of Errors', venue: 'Globe' }), null);
  assert.equal(classifyGenre({ title: 'Noises Off', venue: 'Garrick', description: 'A backstage comedy farce' }), null);
});

test('known false positives stay null (bare-keyword + venue traps)', () => {
  // "Cabaret" the Kander & Ebb musical — bare "cabaret" must not classify.
  assert.equal(classifyGenre({ title: 'Cabaret at the Kit Kat Club', venue: 'Playhouse Theatre' }), null);
  // "Magic Mike Live" is a dance show, not a magic act — bare "magic" must not classify.
  assert.equal(classifyGenre({ title: 'Magic Mike Live', venue: 'London Hippodrome' }), null);
  // A jukebox musical at a dance house — venue-dance suppressed by "musical".
  assert.equal(classifyGenre({ title: "I'm Every Woman, The Chaka Khan Musical", venue: 'Peacock Theatre' }), null);
  // "An evening with" is a talk/Q&A, not stand-up.
  assert.equal(classifyGenre({ title: 'Raising Hare: An Evening with Chloe Dalton', venue: 'Kiln Theatre' }), null);
});

test('venue-dance still fires for non-musical dance-house shows', () => {
  assert.equal(classifyGenre({ title: 'Tango After Dark', venue: 'Peacock Theatre' }), 'dance');
  assert.equal(classifyGenre({ title: 'The Snowman', venue: 'Peacock Theatre' }), 'dance');
});

test('isNonTheatricalGenre', () => {
  for (const g of NON_THEATRICAL_GENRES) assert.equal(isNonTheatricalGenre(g), true, g);
  assert.equal(isNonTheatricalGenre('musical'), false);
  assert.equal(isNonTheatricalGenre('play'), false);
  assert.equal(isNonTheatricalGenre(undefined), false);
  assert.equal(isNonTheatricalGenre(null), false);
});

// BRO-157: The Car Man (dance, Sadler's Wells) shipped with category="west-end"
// at discovery, showing "WEST END" on its own page while genre-routing already
// placed it on the Off-West End hub in listings. Root cause: only the
// validate-data.js CI backstop applied "genre overrides venue" for category —
// discover-new-shows.js didn't, so a freshly-discovered show could sit with
// the wrong category (and show the wrong tag) until the next CI run. Fixed by
// calling this same helper at discovery time too (scripts/discover-new-shows.js).
test('applyGenreCategoryOverride: non-theatrical genre forces off-west-end', () => {
  assert.equal(applyGenreCategoryOverride('west-end', 'dance'), 'off-west-end');
  assert.equal(applyGenreCategoryOverride('west-end', 'magic'), 'off-west-end');
});

test('applyGenreCategoryOverride: leaves category alone otherwise', () => {
  assert.equal(applyGenreCategoryOverride('west-end', 'play'), 'west-end');
  assert.equal(applyGenreCategoryOverride('west-end', null), 'west-end');
  assert.equal(applyGenreCategoryOverride('off-west-end', 'dance'), 'off-west-end');
  assert.equal(applyGenreCategoryOverride('off-broadway', 'dance'), 'off-broadway');
});

test('The Car Man (dance @ Sadler\'s Wells) never ships with category="west-end"', () => {
  const genre = classifyGenre({ title: 'The Car Man', venue: "Sadler's Wells" });
  assert.equal(applyGenreCategoryOverride('west-end', genre), 'off-west-end');
});

test('backfill-genre.js uses the shared applyGenreCategoryOverride helper, not a hand-rolled copy', () => {
  const src = readFileSync(join(here, '../backfill-genre.js'), 'utf8');
  assert.ok(
    /applyGenreCategoryOverride\(/.test(src),
    'backfill-genre.js no longer calls applyGenreCategoryOverride — it likely reverted to a ' +
      'hand-rolled "genre overrides venue" copy, which is exactly the drift BRO-157 fixed by ' +
      'introducing this shared helper (validate-data.js, discover-new-shows.js, and this file ' +
      'must all call the same function).'
  );
});

test('NON_THEATRICAL_GENRES matches the TS source in src/lib/genre.ts', () => {
  const tsSrc = readFileSync(join(here, '../../src/lib/genre.ts'), 'utf8');
  const block = tsSrc.match(/NON_THEATRICAL_GENRES\s*=\s*\[([^\]]*)\]/);
  assert.ok(block, 'could not find NON_THEATRICAL_GENRES in src/lib/genre.ts');
  const tsList = [...block[1].matchAll(/'([a-z]+)'/g)].map(m => m[1]);
  assert.deepEqual(
    [...NON_THEATRICAL_GENRES].sort(),
    tsList.sort(),
    'JS and TS NON_THEATRICAL_GENRES lists must match',
  );
});
