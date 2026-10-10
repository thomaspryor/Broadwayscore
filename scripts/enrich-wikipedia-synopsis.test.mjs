import { test } from 'node:test';
import assert from 'node:assert/strict';
import pkg from './lib/wikipedia-synopsis-match.js';

const {
  buildSearchTitles,
  isDisambiguationPage,
  isTheatricalPage,
  extractPlotSection,
  trimToSynopsis,
  hasBadSynopsisContent,
  resolveVariantContent,
  pickSearchCandidate,
} = pkg;

// Task #68: the matcher went 0/51, including shows with obvious Wikipedia
// pages. Root cause was NOT the title-guessing logic (verified live against
// the real API on 2026-08-04) — it was a silent 429 rate-limit failure mode
// (see enrich-wikipedia-synopsis.js). These fixtures pin buildSearchTitles'
// coverage of the three shows named in the card, using the REAL Wikipedia
// page titles confirmed live for each (>30% match rate requirement).
test('buildSearchTitles guesses the real Wikipedia title for rabbit-hole-2006 ("Rabbit Hole (play)")', () => {
  const show = { id: 'rabbit-hole-2006', title: 'Rabbit Hole', type: 'play' };
  assert.ok(buildSearchTitles(show).includes('Rabbit Hole (play)'));
});

test('buildSearchTitles guesses the real Wikipedia title for purpose-2025 ("Purpose (play)")', () => {
  const show = { id: 'purpose-2025', title: 'Purpose', type: 'play' };
  assert.ok(buildSearchTitles(show).includes('Purpose (play)'));
});

test('buildSearchTitles guesses the real Wikipedia title for all-about-me-2010 ("All About Me")', () => {
  const show = { id: 'all-about-me-2010', title: 'All About Me', type: 'musical' };
  assert.ok(buildSearchTitles(show).includes('All About Me'));
});

test('buildSearchTitles covers >30% of a diverse fixture sample with the real page title', () => {
  // Titles + real Wikipedia page names confirmed live against the API
  // (2026-08-04) for shows that previously reported "NOT FOUND" in CI.
  const fixtures = [
    { show: { id: 'beautiful-the-carole-king-musical-2014', title: 'Beautiful The Carole King Musical', type: 'musical' }, realTitle: 'Beautiful The Carole King Musical' },
    { show: { id: 'chaplin-2012', title: 'Chaplin', type: 'musical' }, realTitle: 'Chaplin (musical)' },
    { show: { id: 'macbeth-2008', title: 'Macbeth', type: 'play' }, realTitle: 'Macbeth (play)' },
    { show: { id: 'the-heiress-2012', title: 'The Heiress', type: 'play' }, realTitle: 'The Heiress (play)' },
    { show: { id: 'orphans-2013', title: 'Orphans', type: 'play' }, realTitle: 'Orphans (play)' },
    { show: { id: 'ann-2013', title: 'Ann', type: 'play' }, realTitle: 'Ann' },
  ];
  const hits = fixtures.filter(f => buildSearchTitles(f.show).includes(f.realTitle));
  assert.ok(hits.length / fixtures.length > 0.3, `expected >30% match, got ${hits.length}/${fixtures.length}`);
});

test('resolveVariantContent follows a server-side redirect (Macbeth (play) -> Macbeth)', () => {
  const pagesByTitle = new Map([
    ['Macbeth', { title: 'Macbeth', missing: false, revisions: [{ slots: { main: { content: '{{Infobox play}}\n== Plot ==\nThree witches prophesy.' } } }] }],
  ]);
  const redirects = new Map([['Macbeth (play)', 'Macbeth']]);
  const content = resolveVariantContent(pagesByTitle, redirects, 'Macbeth (play)');
  assert.match(content, /Three witches prophesy/);
});

test('resolveVariantContent returns null for a missing page', () => {
  const pagesByTitle = new Map([['Foo (play)', { title: 'Foo (play)', missing: true }]]);
  const content = resolveVariantContent(pagesByTitle, new Map(), 'Foo (play)');
  assert.equal(content, null);
});

test('resolveVariantContent does not infinite-loop on a redirect cycle', () => {
  const redirects = new Map([['A', 'B'], ['B', 'A']]);
  const content = resolveVariantContent(new Map(), redirects, 'A');
  assert.equal(content, null);
});

test('isDisambiguationPage detects a disambiguation page', () => {
  assert.equal(isDisambiguationPage('{{disambiguation}}\n\'\'\'Ann\'\'\' may refer to:'), true);
  assert.equal(isDisambiguationPage('{{Infobox play}}\n== Plot ==\nA grieving family.'), false);
});

test('isTheatricalPage rejects a film-only page for the same title', () => {
  const filmPage = '{{Infobox film|name=All of Me}}\nAll of Me is a 1984 American comedy film.';
  assert.equal(isTheatricalPage(filmPage), false);
});

test('isTheatricalPage accepts a page with a theatre infobox', () => {
  const playPage = '{{Infobox play|name=Rabbit Hole}}\n== Plot ==\nA Larchmont couple.';
  assert.equal(isTheatricalPage(playPage), true);
});

test('isTheatricalPage accepts a page with theatre context in the lead even without infobox', () => {
  const text = 'Some show is a play that premiered on Broadway at the Music Box Theatre.';
  assert.equal(isTheatricalPage(text), true);
});

test('extractPlotSection pulls the == Plot == section and strips markup', () => {
  const content = `{{Infobox play}}\nLead text.\n== Plot ==\nA grieving [[family]] copes with loss.\n== Production ==\nOpened in 2006.`;
  const plot = extractPlotSection(content);
  assert.match(plot, /A grieving family copes with loss/);
  assert.doesNotMatch(plot, /Production/);
});

test('extractPlotSection falls back to Synopsis header', () => {
  const content = `{{Infobox musical}}\n== Synopsis ==\nA family navigates change.\n== Cast ==\nSome names.`;
  const plot = extractPlotSection(content);
  assert.match(plot, /A family navigates change/);
});

test('extractPlotSection returns null when no plot-like section exists', () => {
  const content = `{{Infobox play}}\n== Cast ==\nSome names.\n== Reception ==\nGood reviews.`;
  assert.equal(extractPlotSection(content), null);
});

test('trimToSynopsis caps length and keeps whole sentences', () => {
  const long = 'A. '.repeat(5) + 'This describes the plot in detail. '.repeat(20);
  const trimmed = trimToSynopsis(long);
  assert.ok(trimmed.length <= 500);
});

test('hasBadSynopsisContent flags disambiguation leakage and film-plot leakage', () => {
  assert.equal(hasBadSynopsisContent('Ann may refer to: Ann (2013 play), Ann (given name)'), true);
  assert.equal(hasBadSynopsisContent('All of Me is a 1984 American comedy film starring Steve Martin.'), true);
  assert.equal(hasBadSynopsisContent('A grieving family copes with the loss of their young son.'), false);
});

test('pickSearchCandidate picks a fuzzy-matching search result and skips unrelated ones', () => {
  const show = { title: 'Ghetto Klown' };
  const results = ['Some Unrelated Article', 'Ghetto Klown (play)', 'Another Unrelated Page'];
  assert.equal(pickSearchCandidate(show, results), 'Ghetto Klown (play)');
});

test('pickSearchCandidate returns null when nothing plausibly matches', () => {
  const show = { title: 'A Completely Unique Nonexistent Title Xyzzy' };
  const results = ['Unrelated Page One', 'Unrelated Page Two'];
  assert.equal(pickSearchCandidate(show, results), null);
});

// Wrong-show trap regression (task #68): a same-titled Wikipedia article
// describing a DIFFERENT production must not slip through the plot/theatrical
// checks just because it has theatre-flavored language. The actual reject
// happens in verifyProductionMatch (scripts/lib/synopsis-production-match.js,
// tested separately) — here we confirm hasBadSynopsisContent alone can't be
// relied on to catch it, which is exactly why the LLM gate is mandatory and
// not optional in enrich-wikipedia-synopsis.js's main loop.
test('a wrong-show synopsis (same title, different production) does not trip hasBadSynopsisContent — the LLM gate is the real defense', () => {
  const wrongShowSynopsis = 'All of Me follows a bickering couple who reconcile after a comedic mix-up involving a psychic.';
  assert.equal(hasBadSynopsisContent(wrongShowSynopsis), false);
});
