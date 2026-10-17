import { test } from 'node:test';
import assert from 'node:assert/strict';
import pkg from './synopsis-fact-check.js';
import validation from './synopsis-validation.js';
const { extractTonyCategoryClaims, checkAwardClaims, findSharedSentences, lineageIds } = pkg;
const { isValidSynopsis, classifyBadSynopsis } = validation;

// The sentence Show Score published for the 2026 Other Desert Cities revival.
const ODC_CLAIM =
  'Written by Jon Robin Baitz, the play originally won the Tony Award for Best Play revival and returns to Broadway in a new production directed by John Benjamin Hickey.';

const shows = [
  { id: 'odc-2011', title: 'Other Desert Cities' },
  { id: 'odc-2026', title: 'Other Desert Cities', originalProductionId: 'odc-2011', synopsis: ODC_CLAIM },
  { id: 'bridge-2015', title: 'A View from the Bridge', synopsis: 'This revival won the Tony Award for Best Revival of a Play.' },
  { id: 'mhe-2024', title: 'Maybe Happy Ending', synopsis: 'Winner of six 2025 Tony Awards including Best Musical.' },
  { id: 'mhe-tour-2026', title: 'Maybe Happy Ending', tourOf: 'mhe-2024', synopsis: 'Winner of six 2025 Tony Awards including Best Musical.' },
];
const showsById = Object.fromEntries(shows.map((s) => [s.id, s]));
const awardsByShow = {
  'odc-2011': { tony: { wins: ['Best Featured Actress in a Play'], nominatedFor: ['Best Play'] } },
  'bridge-2015': { tony: { wins: ['Best Revival of a Play'] } },
  'mhe-2024': { tony: { wins: ['Best Musical', 'Best Book of a Musical'] } },
};
const ctx = { awardsByShow, showsById };

// --- claim extraction ---
test('extracts "won the Tony Award for Best Play revival" as a revival-of-a-play claim', () => {
  const claims = extractTonyCategoryClaims(ODC_CLAIM);
  assert.deepEqual(claims.map((c) => c.category), ['revival of a play']);
});

test('extracts "Tony Award-winning Best Musical"', () => {
  const claims = extractTonyCategoryClaims('This Tony Award-winning Best Musical is tuneful and witty.');
  assert.deepEqual(claims.map((c) => c.category), ['musical']);
});

test('ignores a nomination ("awarded the Pulitzer ... nominated for ... Best Play")', () => {
  const t = 'The play was awarded the 2022 Pulitzer Prize for Drama and was nominated for five Tony Awards including Best Play.';
  assert.deepEqual(extractTonyCategoryClaims(t), []);
});

test('ignores sentences that never mention Tony', () => {
  assert.deepEqual(extractTonyCategoryClaims('It won the Olivier for Best Musical.'), []);
});

// --- claims vs awards data ---
test('flags the Other Desert Cities claim: lineage has Tony data but no revival win', () => {
  const r = checkAwardClaims(showsById['odc-2026'], ctx);
  assert.equal(r.unsupported.length, 1);
  assert.equal(r.unsupported[0].category, 'revival of a play');
  assert.deepEqual(r.unsupported[0].actualWins, ['featured actress in a play']);
});

test('passes a claim that matches the show\'s own win', () => {
  const r = checkAwardClaims(showsById['bridge-2015'], ctx);
  assert.deepEqual(r, { unsupported: [], unverifiable: [] });
});

test('a tour may cite its parent\'s win (lineage follows tourOf)', () => {
  assert.deepEqual(lineageIds(showsById['mhe-tour-2026'], showsById), ['mhe-tour-2026', 'mhe-2024']);
  assert.deepEqual(checkAwardClaims(showsById['mhe-tour-2026'], ctx).unsupported, []);
});

test('no Tony data anywhere in the lineage is unverifiable, not unsupported', () => {
  const r = checkAwardClaims(showsById['bridge-2015'], { awardsByShow: {}, showsById });
  assert.equal(r.unsupported.length, 0);
  assert.equal(r.unverifiable.length, 1);
});

// --- wrong-show detection ---
const LONG = 'A sung-through musical adaptation of a 70-page segment from Leo Tolstoy\'s novel War and Peace.';
test('flags one long sentence shared by unrelated titles', () => {
  const hits = findSharedSentences([
    { id: 'great-comet', title: 'Natasha, Pierre & The Great Comet of 1812', synopsis: LONG },
    { id: 'great-society', title: 'The Great Society', synopsis: LONG },
  ]);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].ids, ['great-comet', 'great-society']);
});

test('does not flag reruns, tours or Both Parts / One Part siblings', () => {
  const OTHER = 'A different long sentence that is only ever shared by the rerun pair in this test fixture.';
  const hits = findSharedSentences([
    { id: 'hp-both', title: 'Harry Potter and the Cursed Child: Both Parts', synopsis: LONG },
    { id: 'hp-one', title: 'Harry Potter and the Cursed Child', synopsis: LONG },
    { id: 'x-2011', title: 'Same Show', synopsis: OTHER },
    { id: 'x-2026', title: 'A Wholly Different Title', originalProductionId: 'x-2011', synopsis: OTHER },
  ]);
  assert.deepEqual(hits, []);
});

test('ignores short sentences', () => {
  const hits = findSharedSentences([
    { id: 'a', title: 'Alpha', synopsis: 'A short line.' },
    { id: 'b', title: 'Beta', synopsis: 'A short line.' },
  ]);
  assert.deepEqual(hits, []);
});

// --- page chrome (cookie banner) rejected by the shared validator ---
const COOKIE_BANNER =
  'We use cookies to personalise your experience, including improving the quality of your show recommendations. By clicking Accept you agree to our use of cookies.';
test('a cookie banner is not a valid synopsis', () => {
  assert.equal(isValidSynopsis(COOKIE_BANNER), false);
  assert.deepEqual(classifyBadSynopsis({ synopsis: COOKIE_BANNER, status: 'open' }), { bad: true, reason: 'invalid' });
});

test('a real synopsis that mentions "cookies" in plot is still valid', () => {
  const t = 'A baker in 1950s Ohio hides a family secret inside her award-winning cookies while her daughter plans to leave town.';
  assert.equal(isValidSynopsis(t), true);
});

// --- ship-check findings (BRO-4853) ---
const { truncateAtSentence, splitSentences, gateScrapedSynopsis } = pkg;

test('a Grammy or Olivier win for Best Musical is not a Tony claim', () => {
  const g = 'It won the Grammy Award for Best Musical Theater Album and earned 12 Tony nominations.';
  assert.deepEqual(extractTonyCategoryClaims(g), []);
  const o = 'It won the Olivier Award for Best New Musical before it won four Tony Awards.';
  assert.deepEqual(extractTonyCategoryClaims(o), []);
});

test('captures every category in "won Tony Awards for Best Play and Best Revival of a Musical"', () => {
  const cats = extractTonyCategoryClaims('The team won Tony Awards for Best Play and Best Revival of a Musical.').map((c) => c.category);
  assert.deepEqual(cats, ['play', 'revival of a musical']);
});

test('a pre-1994 plain "Best Revival" win backs a revival-of-a-musical claim', () => {
  const s = { id: 'old', synopsis: 'It won the Tony Award for Best Revival of a Musical.' };
  const r = checkAwardClaims(s, { awardsByShow: { old: { tony: { wins: ['Best Revival'] } } }, showsById: { old: s } });
  assert.deepEqual(r.unsupported, []);
});

test('sentence splitter keeps initials and abbreviations intact', () => {
  assert.equal(splitSentences('Directed by Jeffrey L. Page at St. James Theatre. A second sentence follows here.').length, 2);
});

test('truncateAtSentence returns text that still passes isValidSynopsis', () => {
  const sentence = 'A family gathers on Christmas Eve and old wounds reopen as secrets surface. ';
  const long = sentence.repeat(12).trim();
  const cut = truncateAtSentence(long, 500);
  assert.ok(cut.length <= 500);
  assert.equal(isValidSynopsis(cut), true);
  assert.equal(isValidSynopsis(long.slice(0, 500)), false, 'precondition: a hard cut is rejected');
});

test('short text is returned unchanged', () => {
  assert.equal(truncateAtSentence('Short and sweet.', 500), 'Short and sweet.');
});

test('gateScrapedSynopsis rejects the Other Desert Cities blurb and accepts a clean one', () => {
  const show = { id: 'odc-2026', status: 'previews', originalProductionId: 'odc-2011' };
  const bad = 'A family drama set in Palm Springs on Christmas Eve, where a daughter returns with a memoir. ' + ODC_CLAIM;
  const g = gateScrapedSynopsis(show, bad, { awardsByShow, showsById });
  assert.equal(g.ok, false);
  assert.match(g.reason, /unsupported award claim/);
  const good = 'A family drama set in Palm Springs on Christmas Eve, where a daughter returns with a memoir that threatens to expose the past.';
  assert.deepEqual(gateScrapedSynopsis(show, good, { awardsByShow, showsById }), { ok: true, reason: null });
});

const { ledeTitleMismatch } = pkg;
test('ledeTitleMismatch flags another work\'s Wikipedia lede (Linda Vista / Buena Vista Social Club)', () => {
  const show = { id: 'lv', title: 'Linda Vista', synopsis: 'Buena Vista Social Club is a 2023 stage musical, with a book by Marco Ramirez.' };
  assert.equal(ledeTitleMismatch(show), 'Buena Vista Social Club');
});

test('ledeTitleMismatch flags a person biography in the synopsis field', () => {
  const show = { id: 'oma', title: 'Our Mother\'s Brief Affair', synopsis: 'Richard Greenberg (February 22, 1958 – July 4, 2025) was an American playwright and television writer.' };
  assert.match(ledeTitleMismatch(show), /^Richard Greenberg/);
});

test('ledeTitleMismatch leaves the right lede, spelling variants and character openers alone', () => {
  assert.equal(ledeTitleMismatch({ id: 'a', title: 'Hadestown', synopsis: 'Hadestown is a musical with music, lyrics and book by Anaïs Mitchell.' }), null);
  assert.equal(ledeTitleMismatch({ id: 'b', title: 'SIX the Musical', synopsis: 'Six (stylised SIX in all caps) is a musical with music and lyrics by Toby Marlow.' }), null);
  assert.equal(ledeTitleMismatch({ id: 'c', title: 'Beetlejuice', synopsis: 'Lydia Deetz is a goth teenager who can see ghosts.' }), null);
  assert.equal(ledeTitleMismatch({ id: 'd', title: 'No synopsis' }), null);
});

test('wiki markup and disambiguation scraps are not valid synopses', () => {
  assert.equal(isValidSynopsis('Peter Pan commonly refers to: Peter Pan (character), a fictional boy who refuses to grow up, created by J. M. Barrie.'), false);
  assert.equal(isValidSynopsis('composer = Lawrence Shragge country = United States language = English executive_producer = Richard Welsh'), false);
  assert.equal(isValidSynopsis('= The following is the list of musical numbers in the Broadway production of the show.'), false);
  assert.equal(isValidSynopsis('A young boy who refuses to grow up whisks three children away to Neverland, where they meet pirates and fairies.'), true);
});

test('gateScrapedSynopsis rejects a cookie banner', () => {
  assert.equal(gateScrapedSynopsis({ id: 'x', status: 'open' }, COOKIE_BANNER, { awardsByShow, showsById }).ok, false);
});
