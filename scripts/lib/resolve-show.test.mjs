import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  resolveShow,
  resolveShowMatches,
  extractShowTitlesFromText,
  normalizeShowName,
  isAmbiguousMatch,
  labelShowCandidates,
} = require('./resolve-show.js');

const SHOWS = [
  { id: 'ma-1971', slug: 'ma', title: 'Ma', status: 'closed', openingDate: '1971-03-01' },
  { id: 'rent-1996', slug: 'rent', title: 'Rent', status: 'closed', openingDate: '1996-04-29' },
  { id: 'rent-we-2021', slug: 'rent-west-end', title: 'Rent', status: 'closed', openingDate: '2021-10-01' },
  {
    id: 'different-times-1972',
    slug: 'different-times',
    title: 'Different Times',
    status: 'closed',
    openingDate: '1972-05-01',
  },
  {
    id: 'happy-journey-1948',
    slug: 'happy-journey',
    title: 'The Happy Journey to Trenton and Camden',
    status: 'closed',
    openingDate: '1948-03-01',
  },
  {
    id: 'misterman-theatre-row-off-broadway-2026',
    slug: 'misterman-theatre-row-off-broadway',
    title: 'Misterman (Theatre Row)',
    status: 'open',
    openingDate: '2026-06-25',
  },
  { id: 'romeo-juliet-2024', slug: 'romeo-juliet', title: 'Romeo & Juliet', status: 'closed', openingDate: '2024-10-24' },
];

// The GH #393 regression: "Ma" (earlier in the array) must not hijack
// "MISTERMAN" via reverse-substring, and the parenthetical qualifier in the
// stored title must not block the match.
test('MISTERMAN resolves to Misterman (Theatre Row), not Ma', () => {
  const show = resolveShow('MISTERMAN', SHOWS);
  assert.equal(show?.id, 'misterman-theatre-row-off-broadway-2026');
});

test('exact title beats fuzzy ranks', () => {
  assert.equal(resolveShow('Ma', SHOWS)?.id, 'ma-1971');
  assert.equal(resolveShow('Different Times', SHOWS)?.id, 'different-times-1972');
});

test('short titles never reverse-substring into longer names', () => {
  const matches = resolveShowMatches('Misterman', SHOWS);
  assert.deepEqual(
    matches.map((s) => s.id),
    ['misterman-theatre-row-off-broadway-2026']
  );
});

test('rent does not match inside "currently" or "Trenton"', () => {
  // "rent" as a token-sequence is not contained in these titles' tokens
  const matches = resolveShowMatches('rent', SHOWS);
  assert.deepEqual(new Set(matches.map((s) => s.id)), new Set(['rent-1996', 'rent-we-2021']));
});

test('multiple productions: open/newest wins single-resolve', () => {
  const show = resolveShow('rent', SHOWS);
  assert.equal(show?.id, 'rent-we-2021');
});

test('ampersand and "and" are interchangeable', () => {
  assert.equal(resolveShow('Romeo and Juliet', SHOWS)?.id, 'romeo-juliet-2024');
});

test('extractShowTitlesFromText requires token boundaries', () => {
  const msg =
    'We have been tracking MISTERMAN at Theatre Row. There are currently no references to our production, and my grandparents took a happy journey at different times.';
  const titles = extractShowTitlesFromText(msg, SHOWS);
  assert.ok(titles.includes('Misterman (Theatre Row)'), `expected Misterman in ${titles}`);
  assert.ok(!titles.includes('Rent'), '"currently" must not match Rent');
  // "different times" DOES appear as words in the message — legitimate match
  assert.ok(titles.includes('Different Times'));
});

test('junk inputs return empty', () => {
  assert.equal(resolveShow('', SHOWS), null);
  assert.equal(resolveShow('N/A', SHOWS), null);
  assert.equal(resolveShow(null, SHOWS), null);
  assert.deepEqual(extractShowTitlesFromText('', SHOWS), []);
});

test('normalizeShowName strips punctuation and case', () => {
  assert.equal(normalizeShowName("  Schmigadoon!  "), 'schmigadoon');
  assert.equal(normalizeShowName("O'Hara's Place"), 'o hara s place');
});

test('diacritics fold: Misérables == Miserables', () => {
  assert.equal(normalizeShowName('Les Misérables'), 'les miserables');
  const shows = [
    { id: 'lesmis-1987', slug: 'les-miserables', title: 'Les Miserables', status: 'closed', openingDate: '1987-03-12', category: 'broadway' },
    { id: 'lesmis-we-2021', slug: 'les-miserables-west-end', title: 'Les Misérables', status: 'open', openingDate: '1985-12-04', category: 'west-end' },
  ];
  // ASCII query must see BOTH productions (rank 1 normalized-exact), and
  // single-resolve prefers the open one.
  assert.equal(resolveShowMatches('Les Miserables', shows).length, 2);
  assert.equal(resolveShow('Les Miserables', shows)?.id, 'lesmis-we-2021');
  assert.equal(resolveShow('Les Misérables', shows)?.id, 'lesmis-we-2021');
});

test('both open: Broadway original beats later-opening West End transfer', () => {
  const shows = [
    { id: 'hamilton-2015', slug: 'hamilton', title: 'Hamilton', status: 'open', openingDate: '2015-08-06', category: 'broadway' },
    { id: 'hamilton-we-2021', slug: 'hamilton-west-end', title: 'Hamilton', status: 'open', openingDate: '2017-12-21', category: 'west-end' },
  ];
  assert.equal(resolveShow('Hamilton', shows)?.id, 'hamilton-2015');
  // But a closed Broadway run loses to an open West End run.
  shows[0].status = 'closed';
  assert.equal(resolveShow('Hamilton', shows)?.id, 'hamilton-we-2021');
});

// Feedback #905: the reader typed "Book of mormon" (no "the"), which exactly
// matches book-of-mormon-2011's bare slug ("book-of-mormon") at rank 0 and
// short-circuited before the fuzzy ranks could catch the two same-titled
// siblings — so the diagnosis only ever saw the Broadway production and
// missed that the reader likely meant the West End or tour run. The three
// shows below mirror the real shapes: only the original Broadway run kept
// the un-suffixed slug, the transfer and tour got suffixed ones.
const BOOK_OF_MORMON_SHOWS = [
  { id: 'book-of-mormon-2011', slug: 'book-of-mormon', title: 'The Book of Mormon', status: 'open', openingDate: '2011-03-24', category: 'broadway' },
  { id: 'book-of-mormon-we-2024', slug: 'the-book-of-mormon-west-end', title: 'The Book of Mormon', status: 'open', openingDate: '2013-03-21', category: 'west-end' },
  { id: 'book-of-mormon-tour-2022', slug: 'book-of-mormon-tour-2022', title: 'The Book of Mormon', status: 'open', openingDate: '2022-09-23', category: 'tour' },
];

test('a bare-slug match does not hide same-titled siblings (#905)', () => {
  for (const name of ['Book of mormon', 'book of mormon', 'The Book of Mormon']) {
    const matches = resolveShowMatches(name, BOOK_OF_MORMON_SHOWS);
    assert.deepEqual(
      new Set(matches.map((s) => s.id)),
      new Set(['book-of-mormon-2011', 'book-of-mormon-we-2024', 'book-of-mormon-tour-2022']),
      `expected all 3 productions for ${JSON.stringify(name)}, got ${matches.map((s) => s.id)}`
    );
    assert.equal(isAmbiguousMatch(name, BOOK_OF_MORMON_SHOWS), true);
  }
});

test('typing the full, specific slug stays a single unambiguous match', () => {
  for (const [name, expectedId] of [
    ['book-of-mormon-tour-2022', 'book-of-mormon-tour-2022'],
    ['the-book-of-mormon-west-end', 'book-of-mormon-we-2024'],
    ['book-of-mormon-2011', 'book-of-mormon-2011'],
  ]) {
    const matches = resolveShowMatches(name, BOOK_OF_MORMON_SHOWS);
    assert.deepEqual(matches.map((s) => s.id), [expectedId], `expected only ${expectedId} for ${JSON.stringify(name)}`);
    assert.equal(isAmbiguousMatch(name, BOOK_OF_MORMON_SHOWS), false);
  }
});

test('isAmbiguousMatch is false for a genuinely unique title', () => {
  assert.equal(isAmbiguousMatch('Different Times', SHOWS), false);
  assert.equal(isAmbiguousMatch('rent', SHOWS), true);
});

// Sibling grouping must tolerate punctuation differences between productions
// of "the same" title (e.g. a scraper that drops the exclamation point) —
// grouping on raw case-folded text instead of normalizeTitleCore would miss
// this sibling entirely.
test('slug-sibling expansion groups titles that differ only in punctuation', () => {
  const shows = [
    { id: 'dolly-1964', slug: 'hello-dolly', title: 'Hello, Dolly!', status: 'closed', openingDate: '1964-01-16', category: 'broadway' },
    { id: 'dolly-2017', slug: 'hello-dolly-2017', title: 'Hello Dolly', status: 'closed', openingDate: '2017-04-20', category: 'broadway' },
  ];
  const matches = resolveShowMatches('hello dolly', shows);
  assert.deepEqual(new Set(matches.map((s) => s.id)), new Set(['dolly-1964', 'dolly-2017']));
  assert.equal(isAmbiguousMatch('hello dolly', shows), true);
});

// Typing a sibling's EXACT punctuated title is the same shape of input as
// typing its bare slug — both are "specific to one show's representation,"
// not fuzzy text — so both must trigger the same sibling-expansion as the
// unpunctuated "hello dolly" case above, not just the slug path.
test('exact-title sibling expansion groups titles that differ only in punctuation', () => {
  const shows = [
    { id: 'dolly-1964', slug: 'hello-dolly', title: 'Hello, Dolly!', status: 'closed', openingDate: '1964-01-16', category: 'broadway' },
    { id: 'dolly-2017', slug: 'hello-dolly-2017', title: 'Hello Dolly', status: 'closed', openingDate: '2017-04-20', category: 'broadway' },
  ];
  for (const name of ['Hello, Dolly!', 'Hello Dolly']) {
    const matches = resolveShowMatches(name, shows);
    assert.deepEqual(
      new Set(matches.map((s) => s.id)),
      new Set(['dolly-1964', 'dolly-2017']),
      `expected both productions for ${JSON.stringify(name)}, got ${matches.map((s) => s.id)}`
    );
    assert.equal(isAmbiguousMatch(name, shows), true);
  }
});

// Codex /ship-check review of BRO-4659: a same-market revival collides even
// after the category suffix (both labels become "Cabaret (broadway)"), and
// a missing category used to render the literal string "(undefined)".
test('labelShowCandidates breaks a same-category title collision with opening year', () => {
  const shows = [
    { id: 'cabaret-1998', title: 'Cabaret', category: 'broadway', openingDate: '1998-03-19' },
    { id: 'cabaret-2024', title: 'Cabaret', category: 'broadway', openingDate: '2024-04-21' },
  ];
  const labels = labelShowCandidates(shows);
  assert.deepEqual(labels, ['Cabaret, opened 1998', 'Cabaret, opened 2024']);
});

test('labelShowCandidates never renders a literal "(undefined)" for a missing category', () => {
  const shows = [
    { id: 'no-category-show', title: 'Some Show' },
    { id: 'tour-show', title: 'Some Show', category: 'tour' },
  ];
  const labels = labelShowCandidates(shows);
  assert.ok(labels.every((l) => !l.includes('undefined')), `labels leaked undefined: ${labels}`);
});

test("extractShowTitlesFromText reads 'n' as and and drops titles only nested in a longer match (BRO-4953)", () => {
  const shows = [
    { id: 'the-heart-off-broadway-2026', title: 'The Heart' },
    { id: 'heart-of-rock-and-roll-2024', title: 'The Heart of Rock and Roll' },
    { id: 'rock-n-roll-2007', title: "Rock 'n' Roll" },
  ];
  const msg = "The reviews on the page for The Heart are actually reviews for The Heart of Rock 'n' Roll";
  assert.deepEqual(extractShowTitlesFromText(msg, shows).sort(), ['The Heart', 'The Heart of Rock and Roll']);
  // A standalone mention of the nested title keeps it.
  const both = "Rock 'n' Roll at the Royal Court, not The Heart of Rock and Roll";
  assert.deepEqual(extractShowTitlesFromText(both, shows).sort(), ["Rock 'n' Roll", 'The Heart of Rock and Roll']);
});

test('labelShowCandidates appends category only when candidates span more than one', () => {
  const shows = [
    { id: 'tour-a', title: 'A', category: 'tour' },
    { id: 'tour-b', title: 'B', category: 'tour' },
  ];
  assert.deepEqual(labelShowCandidates(shows), ['A', 'B']);
});
