import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractShowTitleFromWetRoundup,
  extractShowTitleFromBwwRoundup,
  isBwwNonStageTieIn,
  isBwwNonNycRoundup,
  titleFromDtliSlug,
  buildShowTitleIndex,
  titleMatchesIndex,
  findUnmatchedCandidates,
} = require('./reverse-discovery.js');

// Real WET category-10 titles captured 2026-07-21.
test('WET roundup title extraction (real titles)', () => {
  assert.equal(
    extractShowTitleFromWetRoundup('The Oresteia Reviews: the performances are stellar, but critics are divided on the creative elements'),
    'The Oresteia'
  );
  assert.equal(
    extractShowTitleFromWetRoundup('Jesus Christ Superstar reviews: spectacular staging and sound, but critics mixed on whether Sam Ryder delivers dramatically'),
    'Jesus Christ Superstar'
  );
  assert.equal(
    extractShowTitleFromWetRoundup('Cyrano de Bergerac Reviews: critics agree it&#8217;s equal parts exquisite and heartbreaking'),
    'Cyrano de Bergerac'
  );
  // Non-roundup shapes must not produce a candidate title
  assert.equal(extractShowTitleFromWetRoundup('Reviews: our summer picks'), null);
  assert.equal(extractShowTitleFromWetRoundup('West End autumn season preview'), null);
});

// Real DTLI slugs from data/dtli-slug-map.json unmatchedSlugs + live sitemap 2026-07-21.
test('DTLI slug → title strips SEO noise tails', () => {
  assert.equal(titleFromDtliSlug('west-side-story-broadway-theater-review'), 'west side story');
  assert.equal(titleFromDtliSlug('white-christmas-reviews'), 'white christmas');
  assert.equal(titleFromDtliSlug('33-variations-broadway-reviews'), '33 variations');
  assert.equal(titleFromDtliSlug('shipwrecked'), 'shipwrecked');
});

test('DTLI slug FP classes: collision suffixes stripped, long titles kept', () => {
  // WordPress slug-collision suffixes (real: giant-2, death-of-a-salesman-3)
  assert.equal(titleFromDtliSlug('giant-2'), 'giant');
  assert.equal(titleFromDtliSlug('death-of-a-salesman-3'), 'death of a salesman');
  // Multi-digit trailing numbers are real title words (live FP: The Fear of 13)
  assert.equal(titleFromDtliSlug('the-fear-of-13'), 'the fear of 13');
  assert.equal(titleFromDtliSlug('1984'), '1984');
  // Long real titles must NOT be dropped (reviewer finding: Curious Incident)
  assert.equal(
    titleFromDtliSlug('the-curious-incident-of-the-dog-in-the-night-time'),
    'the curious incident of the dog in the night time'
  );
  // The originating miss
  assert.equal(titleFromDtliSlug('midnight-at-the-never-get'), 'midnight at the never get');
});

// Real BWW Google-News sitemap <n:title> values, bwwgnewsbway.cfm, captured
// 2026-07-26 (task #477, The Gin Game 2026 miss).
test('BWW roundup title extraction (real titles)', () => {
  assert.equal(
    extractShowTitleFromBwwRoundup('Review Roundup: THE GIN GAME, Starring Debra Winger and Arliss Howard'),
    'THE GIN GAME'
  );
  assert.equal(
    extractShowTitleFromBwwRoundup('Review Roundup: OEDIPUS Opens On Broadway'),
    'OEDIPUS'
  );
  assert.equal(
    extractShowTitleFromBwwRoundup('Review Roundup: RAGTIME Returns to Broadway'),
    'RAGTIME'
  );
  // Non-roundup shapes must not produce a candidate title
  assert.equal(extractShowTitleFromBwwRoundup('BWW Review: A Cabaret Retrospective'), null);
  // Movie/streaming tie-ins are roundup-shaped but name no new stage
  // production — the live FP class flagged alongside this source.
  assert.equal(
    extractShowTitleFromBwwRoundup('Review Roundup: HADESTOWN THE MUSICAL Comes to Movie Theaters'),
    null
  );
  assert.equal(isBwwNonStageTieIn('Review Roundup: HADESTOWN THE MUSICAL Comes to Movie Theaters'), true);
  assert.equal(isBwwNonStageTieIn('Review Roundup: THE GIN GAME, Starring Debra Winger and Arliss Howard'), false);
});

// Live-feed FP class (2026-07-26 review): comma-first splitting truncated
// real titles that contain an internal comma before hitting a keyword
// separator. A bare comma is now only a boundary when it's immediately
// followed by a "who's in it" word.
test('BWW roundup title extraction: internal-comma titles are not truncated', () => {
  assert.equal(
    extractShowTitleFromBwwRoundup('Review Roundup: OH, MARY! Opens on Broadway'),
    'OH, MARY!'
  );
  assert.equal(
    extractShowTitleFromBwwRoundup('Review Roundup: GOOD NIGHT, AND GOOD LUCK Opens on Broadway'),
    'GOOD NIGHT, AND GOOD LUCK'
  );
  // The "TITLE, Starring ..." shape (the actual Gin Game headline pattern)
  // still splits on the comma, since it's followed by a recognized word.
  assert.equal(
    extractShowTitleFromBwwRoundup('Review Roundup: RAGTIME, Starring Joshua Henry'),
    'RAGTIME'
  );
});

// Live-feed FP class (2026-07-26 review): the "bway" sitemap also carries
// West End/tour/regional roundups sharing the same headline shape — this
// source is scoped to NYC only, so those must not produce a candidate.
test('BWW roundup title extraction: non-NYC roundups are filtered', () => {
  assert.equal(extractShowTitleFromBwwRoundup('Review Roundup: HAMILTON West End'), null);
  assert.equal(extractShowTitleFromBwwRoundup('Review Roundup: OH, MARY! in London'), null);
  assert.equal(extractShowTitleFromBwwRoundup('Review Roundup: MEET ME IN ST. LOUIS at The Muny'), null);
});

const SHOWS = [
  { id: 'equus-west-end-2026', title: 'Equus', slug: 'equus-west-end', category: 'off-west-end' },
  { id: 'moulin-rouge-2019', title: 'Moulin Rouge! The Musical', slug: 'moulin-rouge', category: 'broadway' },
  { id: 'beetlejuice-we-2026', title: 'Beetlejuice', slug: 'beetlejuice-west-end', category: 'west-end' },
  { id: 'fallen-angels-2026', title: 'Fallen Angels', slug: 'fallen-angels', category: 'off-broadway' },
];

test('titleMatchesIndex: catalogued shows match, missing shows do not', () => {
  const index = buildShowTitleIndex(SHOWS);
  assert.equal(titleMatchesIndex('Equus', index), true);
  assert.equal(titleMatchesIndex('Moulin Rouge!', index), true);
  assert.equal(titleMatchesIndex('Beetlejuice the Musical', index), true);
  // The originating miss: must surface as a candidate
  assert.equal(titleMatchesIndex('Midnight at the Never Get', index), false);
});

test('market scoping: Broadway-only title does NOT suppress a WE candidate', () => {
  const we = buildShowTitleIndex(SHOWS, 'we');
  const nyc = buildShowTitleIndex(SHOWS, 'nyc');
  // Moulin Rouge catalogued only as broadway → a WET roundup means the WE
  // production is missing and must surface (reviewer finding 2026-07-21)
  assert.equal(titleMatchesIndex('Moulin Rouge!', we), false);
  assert.equal(titleMatchesIndex('Moulin Rouge!', nyc), true);
  // Category-less shows land in every market index (conservative)
  const idx = buildShowTitleIndex([{ id: 'x', title: 'Old Historical Show' }], 'we');
  assert.equal(titleMatchesIndex('Old Historical Show', idx), true);
});

test('containment: headline naming a catalogued show is not a candidate', () => {
  const nyc = buildShowTitleIndex(SHOWS, 'nyc');
  // Real DTLI headline-style slug naming Fallen Angels (catalogued OB)
  assert.equal(
    titleMatchesIndex('kelli ohara and rose byrne are a great slapstick duo in fallen angels', nyc),
    true
  );
  // Headline naming NO catalogued show stays a candidate
  assert.equal(
    titleMatchesIndex('movie spoof unfortunately hits musical iceberg and sinks fast', nyc),
    false
  );
});

test('title variants: venue tails, market qualifiers, slug years (live FP classes)', () => {
  const idx = buildShowTitleIndex([
    { id: 'mc', title: 'Mother Courage and Her Children - Globe', slug: 'mother-courage-and-her-children-globe-west-end', category: 'west-end' },
    { id: 'ia', title: 'Inter Alia', slug: 'inter-alia-west-end-2026', category: 'west-end' },
  ]);
  assert.equal(titleMatchesIndex('Mother Courage and Her Children', idx), true);
  assert.equal(titleMatchesIndex('Inter Alia West End', idx), true);
  assert.equal(titleMatchesIndex('Midnight at the Never Get', idx), false);
});

test('findUnmatchedCandidates surfaces only unmatched items', () => {
  const index = buildShowTitleIndex(SHOWS);
  const items = [
    { title: 'Equus', source: 'wet-roundup', url: 'u1' },
    { title: 'Midnight at the Never Get', source: 'wet-roundup', url: 'u2' },
  ];
  const out = findUnmatchedCandidates(items, index);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Midnight at the Never Get');
});

// Fixture: shows.json checkout carrying only the pre-2026 Gin Game entries
// (task #477's exact miss) — a naive title match suppresses the 2026 BWW
// roundup because "The Gin Game" IS catalogued, just as three closed shows.
const GIN_GAME_CATALOGUE = [
  { id: 'the-gin-game-1977', title: 'The Gin Game', slug: 'the-gin-game-1977', category: 'broadway', status: 'closed', closingDate: '1978-01-29' },
  { id: 'the-gin-game-1997', title: 'The Gin Game', slug: 'the-gin-game-1997', category: 'broadway', status: 'closed', closingDate: '1997-08-31' },
  { id: 'the-gin-game-2015', title: 'The Gin Game', slug: 'the-gin-game-2015', category: 'broadway', status: 'closed', closingDate: '2016-01-10' },
];

test('allowClosedRevival: BWW roundup for an all-closed title surfaces as a missing revival', () => {
  const nyc = buildShowTitleIndex(GIN_GAME_CATALOGUE, 'nyc');
  // Default (WET/DTLI) behavior is unchanged: title match still suppresses.
  assert.equal(titleMatchesIndex('The Gin Game', nyc), true);
  // bww opts in: every catalogued "The Gin Game" has closed, so this BWW
  // roundup for a NEW production must surface as a candidate.
  assert.equal(titleMatchesIndex('The Gin Game', nyc, { allowClosedRevival: true }), false);

  const items = [{
    title: extractShowTitleFromBwwRoundup('Review Roundup: THE GIN GAME, Starring Debra Winger and Arliss Howard'),
    source: 'bww-roundup',
    url: 'https://www.broadwayworld.com/article/Review-Roundup-THE-GIN-GAME-Starring-Debra-Winger-and-Arliss-Howard-20260724',
  }];
  const out = findUnmatchedCandidates(items, nyc, { allowClosedRevival: true });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, items[0].url);
});

// Audit findings 2026-07-26 (third-pass review of the merged code). Each case
// below is a verbatim failing input from that audit.
test('BWW venue/lead-in tails are stripped (audit finding 1)', () => {
  // Junk tail retained → single-word titles alerted as missing even when
  // catalogued and OPEN (containment can't rescue them: it needs a space).
  assert.equal(extractShowTitleFromBwwRoundup('Review Roundup: GYPSY Opens at the Majestic'), 'GYPSY');
  assert.equal(
    extractShowTitleFromBwwRoundup('Review Roundup: 13 THE MUSICAL Opens at the Bernard B. Jacobs Theatre'),
    '13 THE MUSICAL'
  );
  assert.equal(extractShowTitleFromBwwRoundup('Review Roundup: SUNSET BOULEVARD - All the Reviews!'), 'SUNSET BOULEVARD');
  assert.equal(
    extractShowTitleFromBwwRoundup('Review Roundup: What Did the Critics Think Of MAYBE HAPPY ENDING?'),
    'MAYBE HAPPY ENDING?'
  );
  // A bare " at " must NOT split — real titles contain it.
  assert.equal(extractShowTitleFromBwwRoundup('Review Roundup: DINNER AT EIGHT'), 'DINNER AT EIGHT');
});

// Regression guard for a defect introduced by the fix above and caught in
// review before it could fire: a standalone " at the " separator truncated
// real catalogued titles. Both inputs are verbatim from data/shows.json.
test('BWW: " at the " inside a real title is never a separator', () => {
  // The originating miss of this whole detector (task #281). Truncating to
  // "MIDNIGHT" exact-matches the UNRELATED show "Midnight" and silently
  // suppresses a genuine missing show — the worst failure mode here.
  assert.equal(
    extractShowTitleFromBwwRoundup('Review Roundup: MIDNIGHT AT THE NEVER GET Opens Off-Broadway'),
    'MIDNIGHT AT THE NEVER GET'
  );
  // Open off-broadway show; truncation produced a false "missing show" alert.
  assert.equal(
    extractShowTitleFromBwwRoundup('Review Roundup: HUGO MARCHAND | ARTISTS AT THE CENTER'),
    'HUGO MARCHAND | ARTISTS AT THE CENTER'
  );
  // An opening verb still splits the venue tail correctly.
  assert.equal(extractShowTitleFromBwwRoundup('Review Roundup: GYPSY Opens at the Majestic'), 'GYPSY');
});

test('BWW non-NYC filter: NYC venue kept, London tail caught (audit finding 2)', () => {
  // The West End Theatre is a real Off-Broadway house (263 W 86th St) — a
  // genuine NYC miss must NOT be dropped.
  // The point of this case is that the NYC venue must NOT be filtered to null.
  // The venue tail is left attached (no bare " at the " split — see the
  // regression test below); an unsplit tail costs at most a noisy candidate.
  assert.equal(
    extractShowTitleFromBwwRoundup("Review Roundup: BEDLAM'S OTHELLO at The West End Theatre"),
    "BEDLAM'S OTHELLO at The West End Theatre"
  );
  assert.equal(isBwwNonNycRoundup('OTHELLO at The West End Theatre'), false);
  // ...but a real West End / London item still filters out.
  assert.equal(extractShowTitleFromBwwRoundup('Review Roundup: EVITA at London Palladium Opens'), null);
  assert.equal(extractShowTitleFromBwwRoundup('Review Roundup: HAMILTON West End'), null);
  // LONDON ROAD is a real show — a bare "london" match would swallow it.
  assert.equal(isBwwNonNycRoundup('LONDON ROAD'), false);
});

test('allowClosedRevival also applies on the containment path (audit finding 3)', () => {
  const nyc = buildShowTitleIndex(GIN_GAME_CATALOGUE, 'nyc');
  // A long headline naming an all-closed title must still surface as a
  // revival candidate — previously containment returned true unconditionally
  // and suppressed the exact case this option exists for.
  const headline = 'what did critics think of the gin game revival on stage';
  assert.equal(titleMatchesIndex(headline, nyc), true);
  assert.equal(titleMatchesIndex(headline, nyc, { allowClosedRevival: true }), false);
  // A live show under that title still suppresses via containment.
  const withLive = [...GIN_GAME_CATALOGUE, { id: 'the-gin-game-2026', title: 'The Gin Game', slug: 'the-gin-game-2026', category: 'off-broadway', status: 'open' }];
  assert.equal(
    titleMatchesIndex(headline, buildShowTitleIndex(withLive, 'nyc'), { allowClosedRevival: true }),
    true
  );
});

test('allowClosedRevival: a LIVE show under the same title still suppresses (genuine match)', () => {
  const catalogue = [...GIN_GAME_CATALOGUE, { id: 'the-gin-game-2026', title: 'The Gin Game', slug: 'the-gin-game-2026', category: 'off-broadway', status: 'open', closingDate: '2026-08-09' }];
  const nyc = buildShowTitleIndex(catalogue, 'nyc');
  assert.equal(titleMatchesIndex('The Gin Game', nyc, { allowClosedRevival: true }), true);
});

test('--help returns before any network/env access', async () => {
  const { main } = require('../audit-reverse-discovery.js');
  const code = await main(['--help']);
  assert.equal(code, 0);
});

test('digest surfacing: reverseDiscoveryBacklogResults wired in health-check', () => {
  const { reverseDiscoveryBacklogResults } = require('../health-check.js');
  assert.equal(typeof reverseDiscoveryBacklogResults, 'function');
  const out = reverseDiscoveryBacklogResults({
    candidates: [{ title: 'Midnight at the Never Get', source: 'wet-roundup', url: 'u' }],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'warn');
  assert.match(out[0].message, /Midnight at the Never Get/);
  assert.equal(reverseDiscoveryBacklogResults({ candidates: [] }).length, 0);
  assert.equal(reverseDiscoveryBacklogResults(null).length, 0);
});

// ── Sprint A (v2 reconciler plan): Playbill roundups + evidence resolution ──

const {
  extractShowTitleFromPlaybillRoundup,
  resolveMatchedShowId,
  extractOpeningFactsFromArticle,
  resolveDate,
} = require('./reverse-discovery.js');

test('Playbill roundup title extraction (real headline, Broad Strokes 2026-07-28)', () => {
  assert.equal(
    extractShowTitleFromPlaybillRoundup("Reviews: What Do Critics Think of Cat Cohen's Broad Strokes Off-Broadway?"),
    "Cat Cohen's Broad Strokes"
  );
  assert.equal(
    extractShowTitleFromPlaybillRoundup('Reviews: What Do the Critics Think of Death Becomes Her on Broadway?'),
    'Death Becomes Her'
  );
  // Non-roundup headlines are not roundups.
  assert.equal(extractShowTitleFromPlaybillRoundup('Mae West Musical Come Up and See Me Sometime Plans NYC Industry Presentations'), null);
  assert.equal(extractShowTitleFromPlaybillRoundup('Get a 1st Look at The Girl on the Train at Houston&#039;s Alley Theatre'), null);
});

test('resolveMatchedShowId: possessive headline resolves to the catalogued show (Broad Strokes golden case)', () => {
  const shows = [
    { id: 'cat-cohen-broad-strokes-off-broadway-2026', title: 'Cat Cohen: Broad Strokes', category: 'off-broadway', status: 'previews' },
    { id: 'hamilton-2015', title: 'Hamilton', category: 'broadway', status: 'open' },
  ];
  const index = buildShowTitleIndex(shows, 'nyc');
  assert.equal(
    resolveMatchedShowId("Cat Cohen's Broad Strokes", index),
    'cat-cohen-broad-strokes-off-broadway-2026'
  );
});

test('resolveMatchedShowId: closed-only and ambiguous matches return null', () => {
  const shows = [
    { id: 'the-gin-game-1997', title: 'The Gin Game', category: 'broadway', status: 'closed' },
    { id: 'twin-a', title: 'Twin Show', category: 'broadway', status: 'open' },
    { id: 'twin-b', title: 'Twin Show', category: 'off-broadway', status: 'previews' },
  ];
  const index = buildShowTitleIndex(shows, 'nyc');
  assert.equal(resolveMatchedShowId('The Gin Game', index), null, 'closed-only match must not attach evidence');
  assert.equal(resolveMatchedShowId('Twin Show', index), null, 'two live same-title shows are ambiguous');
  assert.equal(resolveMatchedShowId('Nonexistent Show', index), null);
});

test('extractOpeningFactsFromArticle: real Playbill sentence (Broad Strokes)', () => {
  const text = 'The production began previews July 14, officially opening July 27 at the Lucille Lortel Theatre. ' +
    'Performances will continue an additional three weeks through September 25.';
  const facts = extractOpeningFactsFromArticle(text, '2026-07-28');
  assert.equal(facts.previewsStartDate, '2026-07-14');
  assert.equal(facts.openingDate, '2026-07-27');
  assert.equal(facts.closingDate, '2026-09-25');
});

test('resolveDate: year resolution across boundaries + explicit years', () => {
  assert.equal(resolveDate('January 5', '2026-12-20'), '2027-01-05', 'December article, January date = next year');
  assert.equal(resolveDate('December 20', '2026-01-05'), '2025-12-20', 'January article, December date = prior year');
  assert.equal(resolveDate('July 27, 2026', '2026-07-28'), '2026-07-27');
  assert.equal(resolveDate('Not A Date', '2026-07-28'), null);
});

test('titleMatchesIndex: possessive-variant match prevents false missing-show candidates', () => {
  const shows = [{ id: 'cat-cohen-broad-strokes-off-broadway-2026', title: 'Cat Cohen: Broad Strokes', category: 'off-broadway', status: 'previews' }];
  const index = buildShowTitleIndex(shows, 'nyc');
  assert.equal(titleMatchesIndex("Cat Cohen's Broad Strokes", index), true);
});
