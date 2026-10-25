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

// BRO-5063: wikitext debris saved as live synopses. Fixtures are the real
// Wikipedia markup (fetched 2026-10-11) that produced Taking Sides' photo
// caption, Little Me's ";Act I" and Betrayal's ";1977 Scene One: Pub. :Emma".
const LITTLE_ME_PLOT = `{{Infobox musical}}\n== Plot ==\nNote: This summary is based on the original Broadway production. The libretto was revised heavily for both of the subsequent revivals, with songs cut, added, or moved (most notably "Little Me").\n\n;'''Act I'''\nBelle Poitrine (née Schlumpfert) writes her autobiography with the help of Patrick Dennis ("The Truth"). As a child from Venezuela, Illinois, she lived in Drifter's Row, the poor side of town.\n== Productions ==\nx`;
const BETRAYAL_PLOT = `{{Infobox play}}\n==Synopsis==\nThe years between 1968 and 1977 occur in reverse order; scenes within years 1977 and 1973 move forward.<ref name=Quigley/>\n\n;'''1977'''\n*Scene One: '''Pub. 1977. Spring.'''\n:Emma and Jerry meet for the first time in two years. For seven years they had an affair and a secret flat, and Jerry says no one else knew.\n*Scene Two: '''Jerry's House. Later the same day.'''\n:Jerry meets Robert to talk about the affair.\n== Productions ==\nx`;
const TAKING_SIDES_LEAD = `{{Short description|1995 play by Ronald Harwood}}\n{{italic title}}\n[[File:Lenka Pichlikova in Taking Sides.jpg|thumb|[[Lenka Pichlíková-Burke|Lenka Pichlíková]] (at center) as Tamara Sachs in ''Taking Sides'' (Stamford Theatre Works, Connecticut, 1999).]]\n\n'''''Taking Sides''''' is a 1995 play by [[United Kingdom|British]] [[playwright]] [[Ronald Harwood]], about the post-war United States [[denazification]] investigation of the German conductor [[Wilhelm Furtwängler]].\n== Productions ==\nx`;
const HAY_FEVER_IMAGE = `== Plot ==\nThe action is set in the Hall of David Bliss's house at Cookham, Berkshire.\n[[File:Hay Fever 1925.jpg|thumb|upright|alt=middle aged white woman, extravagantly dressed, striking a theatrical pose|[[Marie Tempest]] as Judith Bliss strikes a pose, 1925]]\nSorel and Simon Bliss, a brother and sister, exchange artistic and bohemian dialogue.\n== Productions ==\nx`;

test('extractPlotSection drops definition-list act headings (Little Me ";Act I")', () => {
  const plot = extractPlotSection(LITTLE_ME_PLOT);
  assert.doesNotMatch(plot, /;|Act I/);
  assert.match(plot, /"Little Me"\)\. Belle Poitrine/);
});

test('extractPlotSection drops scene labels and keeps indented paragraphs (Betrayal)', () => {
  const plot = extractPlotSection(BETRAYAL_PLOT);
  assert.doesNotMatch(plot, /\s;|Scene One|(^|\s):/);
  assert.match(plot, /move forward\. Emma and Jerry meet/);
});

test('extractPlotSection removes a File caption that holds its own links (Taking Sides, Hay Fever)', () => {
  const lead = extractPlotSection(TAKING_SIDES_LEAD);
  assert.doesNotMatch(lead, /at center|Tamara Sachs|thumb/);
  assert.match(lead, /^Taking Sides is a 1995 play/);
  const plot = extractPlotSection(HAY_FEVER_IMAGE);
  assert.doesNotMatch(plot, /thumb|alt=|strikes a pose|Marie Tempest/);
  assert.match(plot, /Berkshire\. Sorel and Simon Bliss/);
});

test('the enricher pipeline output for each fixture passes isValidSynopsis', async () => {
  const { isValidSynopsis } = (await import('./lib/synopsis-validation.js')).default;
  const { stripLeadingJunk } = (await import('./lib/wiki-utils.js')).default;
  for (const content of [LITTLE_ME_PLOT, BETRAYAL_PLOT, TAKING_SIDES_LEAD, HAY_FEVER_IMAGE]) {
    const synopsis = trimToSynopsis(stripLeadingJunk(extractPlotSection(content)));
    assert.equal(isValidSynopsis(synopsis), true, synopsis);
  }
});

test('definition-list handling keeps plot on heading lines and drops setting labels (BRO-5063 review)', async () => {
  const { stripWikiMarkup, stripFileLinks } = (await import('./lib/wiki-utils.js')).default;
  assert.equal(stripWikiMarkup(';Place: Near Bethlehem\n:Time: The first century, just after the birth of Christ\nAmahl, a disabled boy, tells tall tales.'), 'Amahl, a disabled boy, tells tall tales.');
  assert.equal(stripWikiMarkup('; Act I: Belle Poitrine writes her autobiography with [[Patrick Dennis]].\nShe grew up poor.'), 'Belle Poitrine writes her autobiography with Patrick Dennis. She grew up poor.');
  assert.equal(stripWikiMarkup('*Act I: The family gathers at the farm for the reading of the will.\n*Act II: Maria returns.'), 'The family gathers at the farm for the reading of the will.');
  // A one-line stored synopsis opening with ";" (clean-synopsis-markup.js) is not erased.
  assert.equal(stripWikiMarkup(';Act I Lestat leaves his mother [[Gabrielle]] to go to Paris.'), 'Act I Lestat leaves his mother Gabrielle to go to Paris.');
  // An unclosed File link is left for hasWikiMarkup instead of swallowing the plot after it.
  assert.match(stripFileLinks('The story begins. [[File:x.jpg|thumb|caption\nThe hero sets off on a quest.'), /The hero sets off on a quest/);
});

test('second review: unclosed captions, long headings, setting lines with plot, times in labels', async () => {
  const { stripWikiMarkup } = (await import('./lib/wiki-utils.js')).default;
  assert.equal(stripWikiMarkup('The story begins in a quiet town. [[File:x.jpg|thumb|Smith as Bob in the 1990 production\nThe hero sets off to find [[Gabrielle]] there.'), 'The story begins in a quiet town. The hero sets off to find Gabrielle there.');
  assert.equal(stripWikiMarkup(';Act One — The Ballroom of the Grand Hotel, Paris, 1890\nCount Danilo meets Hanna at the embassy ball.'), 'Count Danilo meets Hanna at the embassy ball.');
  assert.match(stripWikiMarkup(':Setting: A drawing room in Mayfair. Lady Bracknell arrives and interrogates Jack about his parents.\nJack proposes.'), /^A drawing room in Mayfair\. Lady Bracknell arrives/);
  assert.match(stripWikiMarkup(';Act I, 10:30 p.m.: The bar is full and the band plays a slow number for the lovers.\nThey dance.'), /^The bar is full/);
});
