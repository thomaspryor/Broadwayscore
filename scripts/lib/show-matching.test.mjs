// Regression fixtures for Playbill-Verdict slug → show matching.
//
// Real article slugs harvested from the 2026-05-24 cached category page
// (data/aggregator-archive/playbill-verdict/category-page-1.html in the
// review-texts private repo). The Animal Wisdom slug returned NULL from
// matchTitleToShow with the old slug→title-case path; matchSlugToShow uses
// substring matching against shows.json slugs to recover.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fs = require('node:fs');
const { matchSlugToShow, matchBwwRoundupSlugToShow, cleanSlugTitle, loadShows, validateRoundupPageTitle } = require('./show-matching.js');

// shows.json lives in a private repo and is checked out into data/ by CI.
// Locally, fall back to the user's private-repo clone if data/shows.json isn't
// staged. CI: the checkout-core-data action runs before tests.
function loadShowsFlexible() {
  const candidates = [
    path.join(__dirname, '../../data/shows.json'),
    process.env.HOME ? path.join(process.env.HOME, 'broadway-scorecard-data/shows.json') : null,
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return data.shows || data;
    }
  }
  throw new Error(`shows.json not found in: ${candidates.join(', ')}`);
}
const shows = loadShowsFlexible();

// Fixtures: [slug, expected show.id contains, comment]
// "Expected contains" rather than exact match because slugs evolve (e.g.,
// kenrex-off-broadway might become kenrex-off-broadway-2026 in shows.json).
const FIXTURES = [
  ['did-reviewers-find-magic-in-schmigadoon', 'schmigadoon', 'Broadway revival, head: did-reviewers-find-magic-in-'],
  ['did-the-olivier-winning-kenrex-make-a-big-splash-with-new-york-critics', 'kenrex', 'middle-title slug, head + arbitrary tail'],
  ['read-reviews-for-heather-christians-animal-wisdom', 'animal-wisdom', 'possessive author prefix'],
  ['read-the-reviews-for-hamlet-at-brooklyn-academy-of-music', 'hamlet', 'venue suffix -at-brooklyn-academy-of-music'],
  ['reviews-are-out-for-el-ultimo-sueno-de-frida-y-diego-at-met-opera', 'frida-y-diego', 'opera with -at-met-opera tail'],
  ['reviews-did-critics-feel-at-home-on-avenue-q-in-londons-west-end', 'avenue-q', 'West End market tail'],
  ['reviews-did-critics-find-the-rocky-horror-show-revival-worth-the-antici-pation', 'rocky-horror', 'middle-title with punny tail'],
  ['reviews-did-critics-think-celebrity-autobiography-on-broadway-was-a-novel-idea', 'celebrity-autobiography', 'middle-title with punny tail'],
  ['reviews-what-did-critics-think-of-second-stages-the-receptionist', 'receptionist', 'venue-as-possessive prefix (second-stages-)'],
  ['reviews-what-do-the-critics-think-of-beaches-on-broadway', 'beaches', 'classic head + -on-broadway tail'],
  ['reviews-what-do-the-critics-think-of-fallen-angels-on-broadway', 'fallen-angels', null],
  ['reviews-what-do-the-critics-think-of-joe-turners-come-and-gone-on-broadway', 'joe-turners-come-and-gone', null],
  ['reviews-what-do-the-critics-think-of-the-balusters-on-broadway', 'balusters', null],
  ['reviews-what-do-the-critics-think-of-the-lost-boys-on-broadway', 'lost-boys', null],
  ['what-are-reviews-for-broken-snow-starring-tom-cavanagh-tony-danza-and-michael-longfellow', 'broken-snow', 'long arbitrary tail'],
  ['what-are-reviews-for-eliana-theologides-rodriguezs-indian-princesses-off-broadway', 'indian-princesses', 'long possessive author chain + -off-broadway tail'],
  // Regression: pre-2026-05-27 matcher routed this to closed `othello-2025`
  // (1 token match) because longest-substring beat token-set. New token-set
  // matcher requires ALL show-tokens to hit, so 2-token `bedlams-othello-off-
  // broadway-2026` wins over single-token `othello-2025`. Reviews for the
  // 2026 Bedlam revival shipped to the closed 2025 row on 2026-05-27.
  ['what-are-the-reviews-for-bedlams-4-person-version-of-shakespeares-othello', 'bedlams-othello', 'must route to 2026 Bedlam revival not closed 2025 Othello'],
  ['what-do-reviews-think-of-bubba-weilers-well-ill-let-you-go-at-studio-seaview', 'well-ill-let-you-go', 'possessive author + venue suffix'],
  // Bug-trigger slugs (articles that appeared AFTER the May 24 cached page):
  ['read-the-reviews-for-the-maids-off-broadway', 'the-maids', 'verified live on category page 2026-05-27'],
  ['reviews-what-do-the-critics-think-of-heated-rivalry-the-unauthorized-musical-parody', 'heated-rivalry', 'verified live on category page 2026-05-27'],
];

// BWW Review-Roundup slug fixtures keyed by the slug-only path (without
// the /article/ prefix matchBwwRoundupSlugToShow strips). Includes the
// HOLIDAY INN regression: shows with subtitled IDs (full title is
// "Holiday Inn, The New Irving Berlin Musical") must match on pre-comma
// title tokens [holiday, inn], not all id tokens including subtitle.
const BWW_TITLE_FIXTURES = [
  // HOLIDAY INN 2016 — pre-2026-05-27 matcher used id-based tokens
  // [holiday, inn, new, irving, berlin] and rejected this show because
  // the slug only has [holiday, inn]; fell back to closed `holiday-1995`
  // (single token [holiday] matches everything). Caused 10 misrouted
  // files I had to revert. Title-based tokens fix this.
  ['Review-Roundup-HOLIDAY-INN-Opens-on-Broadway-20161006', 'holiday-inn-the-new-irving-berlin-musical-2016', 'subtitled ID — must match on pre-comma title not full id tokens'],
];

test('cleanSlugTitle strips head and tail patterns', () => {
  assert.equal(cleanSlugTitle('read-reviews-for-heather-christians-animal-wisdom'),
    'Heather Christians Animal Wisdom');
  assert.equal(cleanSlugTitle('reviews-what-do-the-critics-think-of-beaches-on-broadway'),
    'Beaches');
  assert.equal(cleanSlugTitle('read-the-reviews-for-the-maids-off-broadway'),
    'The Maids');
});

// BWW Review-Roundup slug fixtures (from broadwayworld.com/reviews/
// landing page, 2026-05-27). Same shape — `expected contains` against
// matched show id.
const BWW_FIXTURES = [
  ['/article/Review-Roundup-HEATED-RIVALRY-THE-UNAUTHORIZED-MUSICAL-PARODY-Opens-Off-Broadway-20260526', 'heated-rivalry', 'shouty-caps + date suffix'],
  ['/article/Review-Roundup-INDIAN-PRINCESSES-Opens-at-Atlantic-Theater-Company', 'indian-princesses', 'Opens-at-VENUE suffix'],
  ['/article/Review-Roundup-CELEBRITY-AUTOPBIOGRAPHY-On-Broadway', 'celebrity-autobiography', 'BWW has typo "AUTOPBIOGRAPHY" (sic) — should NOT match'],
  ['/article/Review-Roundup-DAD-DONT-READ-THIS-At-St-Lukes-Theatre', 'dad-dont-read', 'GAP: not in shows.json'],
  ['/article/Review-Roundup-THE-PEOPLE-VERSUS-LENNY-BRUCE-Off-Broadway', 'lenny-bruce', 'simple -Off-Broadway tail'],
  ['/article/Review-Roundup-NEW-BORN-Starring-Hugh-Jackman-Sepideh-Moafi-Marianna-Gailus', 'new-born', 'arbitrary Starring tail'],
  ['https://www.broadwayworld.com/off-broadway/article/Review-Roundup-Thornton-Wilders-THE-EMPORIUM-at-Classic-Stage-Company-20260518', 'emporium', 'GAP: not in shows.json'],
];

test('matchBwwRoundupSlugToShow finds the right show for BWW roundup URLs', () => {
  const failures = [];
  for (const [slug, expectedFragment, comment] of BWW_FIXTURES) {
    const result = matchBwwRoundupSlugToShow(slug, shows);
    if (!result) {
      failures.push({ slug, expected: expectedFragment, got: 'NULL', comment, gap: true });
      continue;
    }
    const matchedSlug = (result.show.slug || result.show.id || '').toLowerCase();
    if (!matchedSlug.includes(expectedFragment)) {
      failures.push({ slug, expected: expectedFragment, got: matchedSlug, comment });
    }
  }
  if (failures.length > 0) {
    console.log('\n=== matchBwwRoundupSlugToShow fixture failures ===');
    for (const f of failures) {
      const tag = f.gap ? '[GAP — show not in shows.json]' : '[BUG]';
      console.log(`${tag} ${f.slug}`);
      console.log(`        expected:  ${f.expected}`);
      console.log(`        got:       ${f.got}`);
      if (f.comment) console.log(`        comment:   ${f.comment}`);
    }
  }
  const bugs = failures.filter(f => !f.gap);
  assert.equal(bugs.length, 0,
    `matchBwwRoundupSlugToShow returned WRONG show for ${bugs.length} slug(s)`);
});

test('matchBwwRoundupSlugToShow handles subtitled-ID shows via title tokens', () => {
  const failures = [];
  for (const [slug, expectedId, comment] of BWW_TITLE_FIXTURES) {
    const result = matchBwwRoundupSlugToShow(slug, shows);
    if (!result || result.show.id !== expectedId) {
      failures.push({ slug, expected: expectedId, got: result ? result.show.id : 'NULL', comment });
    }
  }
  if (failures.length > 0) {
    console.log('\n=== matchBwwRoundupSlugToShow title-token failures ===');
    for (const f of failures) {
      console.log(`[BUG] ${f.slug}`);
      console.log(`        expected:  ${f.expected}`);
      console.log(`        got:       ${f.got}`);
      if (f.comment) console.log(`        comment:   ${f.comment}`);
    }
  }
  assert.equal(failures.length, 0, `${failures.length} title-token regression(s)`);
});

test('matchSlugToShow finds the right show for all 20 real fixtures', () => {
  const failures = [];
  for (const [slug, expectedFragment, comment] of FIXTURES) {
    const result = matchSlugToShow(slug, shows);
    if (!result) {
      // Some target shows don't have shows.json entries yet (Beaches, Broken
      // Snow, Hamlet at BAM, Bedlam's Othello, Receptionist). Those are
      // discovery gaps tracked separately; the matcher correctly returns null
      // so they land in the unmatched-articles audit log.
      failures.push({ slug, expected: expectedFragment, got: 'NULL', comment, gap: true });
      continue;
    }
    const matchedSlug = (result.show.slug || result.show.id || '').toLowerCase();
    if (!matchedSlug.includes(expectedFragment)) {
      failures.push({ slug, expected: expectedFragment, got: matchedSlug, comment });
    }
  }
  // Print actionable summary
  if (failures.length > 0) {
    console.log('\n=== matchSlugToShow fixture failures ===');
    for (const f of failures) {
      const tag = f.gap ? '[GAP — show not in shows.json]' : '[BUG]';
      console.log(`${tag} ${f.slug}`);
      console.log(`        expected:  ${f.expected}`);
      console.log(`        got:       ${f.got}`);
      if (f.comment) console.log(`        comment:   ${f.comment}`);
    }
  }
  // BUGs (matcher returned wrong show) fail the test.
  // GAPs (matcher returned null because show isn't in shows.json) are logged
  // but don't fail — they're tracked as discovery work.
  const bugs = failures.filter(f => !f.gap);
  assert.equal(bugs.length, 0,
    `matchSlugToShow returned WRONG show for ${bugs.length} slug(s) (see log above)`);
});

// ---------------------------------------------------------------------------
// Date-context disambiguation (2026-05-28). BWW roundup slugs end in
// -YYYYMMDD; matchBwwRoundupSlugToShow extracts that year and prefers a
// production within ±2 years of it (then closest year) ABOVE the
// closed/recency tiebreakers. Synthetic shows are used because the real
// audit has zero same-token-set productions where date and recency disagree
// — the value of this axis is preventive (future same-title shows) and as a
// safety flag for the misroute audit (a far-year match is a likely wrong-to).
// Single-token titles must be ≥5 chars to clear the distinctive-token gate,
// so "Pippin" (6) is used, not a 3-char stub.
const DATE_CTX_SHOWS = [
  { id: 'pippin-1972', title: 'Pippin', openingDate: '1972-10-23', status: 'closed', category: 'broadway' },
  { id: 'pippin-2013', title: 'Pippin', openingDate: '2013-04-25', status: 'closed', category: 'broadway' },
  // Open long-runner whose openingDate is the original (not a recent revival).
  // Models the Les Misérables West End record (openingDate 1985, status open).
  { id: 'pippin-open-1985', title: 'Pippin', openingDate: '1985-12-04', status: 'open', category: 'west-end' },
  { id: 'nodate-revue', title: 'Pippin', openingDate: '', status: 'closed', category: 'broadway' },
];

test('date-context: BWW slug year picks the era-correct same-title production', () => {
  // 1972 article → 1972 production, even though recency alone would pick 2013.
  const r1972 = matchBwwRoundupSlugToShow('/article/Review-Roundup-PIPPIN-Opens-on-Broadway-19721023', DATE_CTX_SHOWS);
  assert.equal(r1972 && r1972.show.id, 'pippin-1972', 'a 1972-dated slug must route to pippin-1972, not the more recent pippin-2013');

  // 2013 article → 2013 production.
  const r2013 = matchBwwRoundupSlugToShow('/article/Review-Roundup-PIPPIN-Opens-on-Broadway-20130425', DATE_CTX_SHOWS);
  assert.equal(r2013 && r2013.show.id, 'pippin-2013', 'a 2013-dated slug must route to pippin-2013');
});

test('date-context: no year hint is inert — defers to existing non-date heuristics', () => {
  // matchSlugToShow carries no slug date and gets no options → the date axis is
  // skipped entirely, so the result is whatever the pre-change closed/recency
  // logic produces. With an open production present that is pippin-open-1985
  // (open beats closed before recency even applies). Golden regression: the
  // date axis must not change the year=null outcome.
  const r = matchSlugToShow('reviews-what-do-the-critics-think-of-pippin-on-broadway', DATE_CTX_SHOWS);
  assert.equal(r && r.show.id, 'pippin-open-1985', 'no year hint must fall through to the existing closed/recency tiebreakers');
});

test('date-context: explicit options.year overrides slug-derived year', () => {
  // Slug says 2013 but caller forces 1972 → 1972 wins.
  const r = matchBwwRoundupSlugToShow('/article/Review-Roundup-PIPPIN-Opens-on-Broadway-20130425', DATE_CTX_SHOWS, { year: 1972 });
  assert.equal(r && r.show.id, 'pippin-1972', 'options.year must override the YYYYMMDD parsed from the slug');
});

test('date-context: a candidate with no openingDate never wins the date axis', () => {
  // nodate-revue shares the [pippin] token but has no openingDate (gap=∞).
  // For a 1972 article it must lose to pippin-1972, never win on the date axis.
  const r = matchBwwRoundupSlugToShow('/article/Review-Roundup-PIPPIN-Opens-on-Broadway-19721023', DATE_CTX_SHOWS);
  assert.notEqual(r && r.show.id, 'nodate-revue', 'a dateless production must not win the date-proximity axis');
});

test('date-context: when NO candidate is in-window the date axis is inert (open production wins, not closest year)', () => {
  // Regression for the Les Misérables flip (ship-check Codex, 2026-05-28): a
  // 2040 article is far from ALL productions (1972/1985/2013). The date axis
  // must NOT pick the year-closest (pippin-2013, gap 27) over the OPEN current
  // production (pippin-open-1985, gap 55). With no in-window candidate the axis
  // falls through to the closed/recency heuristics, which prefer the open one.
  const r = matchBwwRoundupSlugToShow('/article/Review-Roundup-PIPPIN-Opens-on-Broadway-20400101', DATE_CTX_SHOWS);
  assert.equal(r && r.show.id, 'pippin-open-1985', 'no in-window candidate → defer to open-production preference, not closest year');
});

// ---------------------------------------------------------------------------
// Location-preposition guard (2026-07-08): "iceboy-in-chicago" is a place
// mention of Chicago, not the musical CHICAGO. A single-token show whose token
// appears in the slug ONLY after "in-"/"at-" must never match.
// ---------------------------------------------------------------------------

const LOC_SHOWS = [
  { id: 'chicago-1996', title: 'Chicago', openingDate: '1996-11-14', status: 'open', category: 'broadway' },
  { id: 'iceboy-regional-2026', title: 'Iceboy!', openingDate: '2026-06-29', status: 'open', category: 'regional' },
  { id: 'maybe-happy-ending-2024', title: 'Maybe Happy Ending', openingDate: '2024-11-12', status: 'open', category: 'broadway' },
];

test('location-preposition: "-in-chicago" routes to the show whose title actually matches, not the city', () => {
  const r = matchSlugToShow('did-reviewers-warm-to-world-premiere-musical-iceboy-in-chicago', LOC_SHOWS);
  assert.equal(r && r.show.id, 'iceboy-regional-2026',
    '"chicago" after "in-" is a location, so iceboy must win despite its shorter token');
});

test('location-preposition: a sole candidate matched only via "in-<city>" is rejected outright', () => {
  const r = matchSlugToShow('a-new-musical-comedy-opens-in-chicago', LOC_SHOWS);
  assert.equal(r, null, 'a place mention alone is not recognition — must stay unmatched');
});

test('location-preposition: multi-token titles after "in" still match (only the first token follows the preposition)', () => {
  const r = matchSlugToShow('were-critics-swept-up-in-maybe-happy-ending', LOC_SHOWS);
  assert.equal(r && r.show.id, 'maybe-happy-ending-2024');
});

test('location-preposition: a non-prepositioned occurrence anywhere keeps the match', () => {
  const r = matchSlugToShow('did-critics-cheer-the-revival-of-chicago', LOC_SHOWS);
  assert.equal(r && r.show.id, 'chicago-1996', '"of-chicago" is not a location preposition — Chicago must still match');
});

// BRO-4563: "Richard II" tokenized to [richard] (the numeral was dropped as a
// <3-char token), so an actor's name in a roundup slug routed Hay Fever's
// reviews to Richard II. Short Roman numerals are now required title tokens.
const ROMAN_SHOWS = [
  { id: 'richard-ii-off-west-end-2026', title: 'Richard Ii', status: 'open', openingDate: '2026-09-10', category: 'off-west-end' },
  { id: 'hay-fever-west-end-2026', title: 'Hay Fever', status: 'open', openingDate: '2026-10-01', category: 'west-end' },
  { id: 'henry-iv-2003', title: 'Henry IV', status: 'closed', openingDate: '2003-11-20', category: 'broadway' },
  { id: 'henry-vi-a-trilogy-in-two-parts-off-broadway-2026', title: 'Henry VI: A Trilogy in Two Parts', status: 'open', openingDate: '2026-03-01', category: 'off-broadway' },
];

test('roman numerals: an actor named Richard does not route a Hay Fever roundup to Richard II', () => {
  const r = matchBwwRoundupSlugToShow('Review-Roundup-Richard-E-Grant-Christine-Baranski-in-HAY-FEVER-20261002', ROMAN_SHOWS);
  assert.equal(r && r.show.id, 'hay-fever-west-end-2026');
});

test('roman numerals: a Richard II roundup still matches Richard II', () => {
  const r = matchBwwRoundupSlugToShow('Review-Roundup-RICHARD-II-Opens-at-the-Bridge-Theatre-20260912', ROMAN_SHOWS);
  assert.equal(r && r.show.id, 'richard-ii-off-west-end-2026');
});

test('roman numerals: Henry IV and Henry VI no longer match each other', () => {
  assert.equal(matchBwwRoundupSlugToShow('Review-Roundup-HENRY-VI-Off-Broadway-20260301', ROMAN_SHOWS)?.show.id, 'henry-vi-a-trilogy-in-two-parts-off-broadway-2026');
  assert.equal(matchBwwRoundupSlugToShow('Review-Roundup-HENRY-IV-Opens-on-Broadway-20031120', ROMAN_SHOWS)?.show.id, 'henry-iv-2003');
});

test('roman numerals: a kept numeral does not lift a short single-word title past the gate', () => {
  const shows = [{ id: 'life-x-3-2003', title: 'Life (x) 3', status: 'closed', openingDate: '2003-12-01', category: 'broadway' }];
  assert.equal(matchBwwRoundupSlugToShow('Review-Roundup-Malcolm-X-Opera-Brings-a-Life-to-the-Met-20260401', shows), null);
});

test('roman numerals: page-title checks keep the numeral too (BRO-4563 cached Hay Fever page)', () => {
  const { titleWordsMatch, titleWordsMatchWithConfidence, validateRoundupPageTitle } = require('./show-matching.js');
  const hayFever = 'Review Roundup: Richard E. Grant & Christine Baranski in HAY FEVER, UK / West End | BroadwayWorld';
  const page = t => `<html><head><title>${t}</title></head><body></body></html>`;
  assert.equal(validateRoundupPageTitle(page(hayFever), 'Richard II', 'off-west-end', []).ok, false);
  assert.equal(titleWordsMatchWithConfidence('Richard II', hayFever).matched, false);
  assert.equal(titleWordsMatch('Richard II', hayFever), false);
  const real = 'Review Roundup: RICHARD II at the Bridge Theatre, UK / West End | BroadwayWorld';
  assert.equal(validateRoundupPageTitle(page(real), 'Richard II', 'off-west-end', []).ok, true);
  assert.equal(titleWordsMatchWithConfidence('Richard II', real).matched, true);
  assert.equal(titleWordsMatchWithConfidence('Henry V', 'Review Roundup: HENRY VIII at Shakespeare\'s Globe').matched, false);
  assert.equal(titleWordsMatchWithConfidence('Henry V', 'Review Roundup: HENRY V at the Donmar').matched, true);
});

test('two-letter title words and numbers are required too (BRO-4563 cousins)', () => {
  const { titleWordsMatch, titleWordsMatchWithConfidence, validateRoundupPageTitle } = require('./show-matching.js');
  const page = t => `<html><head><title>${t}</title></head><body></body></html>`;
  const theLife = 'Review Roundup: THE LIFE at the Southwark Playhouse | BroadwayWorld';
  assert.equal(validateRoundupPageTitle(page(theLife), 'Life of Pi', 'broadway', []).ok, false);
  assert.equal(titleWordsMatchWithConfidence('Life of Pi', theLife).matched, false);
  assert.equal(titleWordsMatch('Life of Pi', theLife), false);
  const real = 'Review Roundup: LIFE OF PI on Broadway | BroadwayWorld';
  assert.equal(validateRoundupPageTitle(page(real), 'Life of Pi', 'broadway', []).ok, true);
  assert.equal(titleWordsMatch('Life of Pi', real), true);
  assert.equal(titleWordsMatchWithConfidence('Life of Pi', real).matched, true);

  // A kept short token never trips the short-title guard by itself: the real
  // Richard II page title carries "| BroadwayWorld", an extra word.
  const r2 = 'Review Roundup: RICHARD II at the Bridge Theatre, UK / West End | BroadwayWorld';
  assert.equal(titleWordsMatch('Richard II', r2), true);
  assert.equal(titleWordsMatch('Richard II', 'Review Roundup: RICHARD III at the Old Vic'), false);
  // Long titles do not need the short word: headlines drop "Dr. Seuss'".
  assert.equal(titleWordsMatch("Dr. Seuss' How the Grinch Stole Christmas!", 'How the Grinch Stole Christmas! The Musical returns'), true);
  // The short word only narrows: "Mr." plus one shared word is no match.
  assert.equal(titleWordsMatch('Mr. Saturday Night', 'Saturday Night Fever on Broadway'), false);
  assert.equal(titleWordsMatch('Mr. Saturday Night', 'Review Roundup: MR. SATURDAY NIGHT on Broadway'), true);
  const fever = 'Review Roundup: SATURDAY NIGHT FEVER | BroadwayWorld';
  assert.equal(titleWordsMatchWithConfidence('Mr. Saturday Night', fever).matched, false);
  assert.equal(validateRoundupPageTitle(page(fever), 'Mr. Saturday Night', 'broadway', []).ok, false);
  const mrSat = 'Review Roundup: MR. SATURDAY NIGHT Opens on Broadway | BroadwayWorld';
  assert.equal(validateRoundupPageTitle(page(mrSat), 'Mr. Saturday Night', 'broadway', []).ok, true);

  const shows = [
    { id: 'the-39-steps-2008', title: 'The 39 Steps', category: 'broadway', openingDate: '2008-01-15' },
    { id: 'hay-fever-west-end-2026', title: 'Hay Fever', category: 'west-end', openingDate: '2026-10-01' },
  ];
  assert.equal(matchSlugToShow('review-roundup-steps-at-the-park', shows), null);
  const hit = matchSlugToShow('review-roundup-the-39-steps', shows);
  assert.equal(hit && (hit.show ? hit.show.id : hit.id), 'the-39-steps-2008');
});

// BRO-2137: same-title, different-production disambiguation. Playbill's
// "What Do Critics Think of The Outsiders on Broadway?" roundup (Broadway
// 2024) was accepted for the 2023 La Jolla regional show: the heading has no
// "(Broadway)" qualifier, so only the title words were compared.
test('same-title different-production: "on Broadway" roundup is rejected for the regional sibling (BRO-2137)', () => {
  const html = t => `<html><head><title>${t}</title></head></html>`;
  const broadwayPage = html('What Do Critics Think of The Outsiders on Broadway? | Playbill');
  const regional = validateRoundupPageTitle(broadwayPage, 'The Outsiders', 'regional', ['broadway']);
  assert.equal(regional.ok, false);
  assert.equal(regional.reason, 'cross-market-sibling');
  // The Broadway show itself, and a regional page with no Broadway signal, still pass.
  assert.equal(validateRoundupPageTitle(broadwayPage, 'The Outsiders', 'broadway', ['regional']).ok, true);
  assert.equal(validateRoundupPageTitle(html('What Do Critics Think of The Outsiders at La Jolla Playhouse? | Playbill'),
    'The Outsiders', 'regional', ['broadway']).ok, true);
  // No same-title Broadway sibling: nothing to confuse it with.
  assert.equal(validateRoundupPageTitle(broadwayPage, 'The Outsiders', 'regional', []).ok, true);
});

// "Two Girls" reduced to the single word "girls" ("two" is a generic word) and
// matched the NYC Theatre roundup for "School Girls; Or, The African Mean Girls
// Play": four School Girls reviews went live on a show that had not started
// previews (BRO-4852). A one-word reduction of a multi-word title now needs
// the whole title as a phrase.
test('single-word reduction of a multi-word title needs the full phrase (BRO-4852)', async () => {
  const { titleWordsMatch, titleWordsMatchWithConfidence } = require('./show-matching.js');
  const { validatePageMatchesShow } = require('./page-validator.js');
  const rejects = [
    ['Two Girls', 'School Girls; Or, The African Mean Girls Play Reviews | New York City Theatre'],
    ['The King and I', 'The Lion King Reviews'],
    ['All My Sons', 'Sons of the Prophet'],
    ['Come From Away', 'Far Away Reviews'],
  ];
  for (const [title, cand] of rejects) {
    assert.equal(titleWordsMatch(title, cand), false, `${title} vs ${cand}`);
    const c = titleWordsMatchWithConfidence(title, cand);
    assert.equal(c.matched, false, `${title} vs ${cand}`);
    assert.equal(c.matchCount, 1);
  }
  const accepts = [
    ['Two Girls', 'Two Girls Reviews | New York City Theatre'],
    ['Two Girls', 'two-girls-review'],
    ['The King and I', 'Review Roundup: THE KING AND I'],
    ['Me and My Girl', 'Me & My Girl review'],
    ['Oh, Mary!', 'Oh, Mary! Broadway Reviews'],
    ['Amélie, A New Musical', 'Amelie reviews'],
    ['Boop! The Musical', 'BOOP! Review roundup'],
    ['Dana H.', 'Dana H. reviews'],
    // Billing words and numerals are not part of the phrase a page must carry.
    ['Copperfield! The New Musical', 'COPPERFIELD! Off-Broadway Reviews | Show Score'],
    ['Giant The Play', 'Giant | Show Score'],
    ['Oh, Hello on Broadway', 'Oh, Hello! review'],
    ['Riverdance - On Broadway', 'Riverdance reviews'],
    ['Two Girls', '2 Girls review'],
    ['Act One', 'Act 1 Broadway reviews'],
  ];
  for (const [title, cand] of accepts) {
    assert.equal(titleWordsMatch(title, cand), true, `${title} vs ${cand}`);
    assert.equal(titleWordsMatchWithConfidence(title, cand).matched, true, `${title} vs ${cand}`);
  }
  // With no LLM to break the tie, the page is rejected rather than accepted.
  const page = '<html><head><title>School Girls; Or, The African Mean Girls Play Reviews | New York City Theatre</title></head><body><h1>School Girls; Or, The African Mean Girls Play Reviews</h1></body></html>';
  const v = await validatePageMatchesShow(page, 'Two Girls', { skipLlm: true, openingYear: 2026 });
  assert.equal(v.valid, false);
});

// BRO-4929: shows whose only long title word is under 5 chars (Oh, Mary!, SIX,
// Boop!, The Wiz, MJ) were unmatchable by the token path, whose gate must stay
// as it is (a 4-char gate caused 241 misroutes on 2026-05-27). A roundup slug
// that equals the show's whole title, once a national-tour tail is removed,
// matches through the exact-title path instead.
test('exact-title path: short-title shows match a national-tour roundup slug (BRO-4929)', () => {
  const shows = [
    { id: 'oh-mary-2024', title: 'Oh, Mary!', category: 'broadway', status: 'open', openingDate: '2024-07-11' },
    { id: 'six-2021', title: 'SIX', category: 'broadway', status: 'open', openingDate: '2021-10-03' },
    { id: 'six-degrees-of-separation-2017', title: 'Six Degrees of Separation', category: 'broadway', status: 'closed', openingDate: '2017-04-25' },
    { id: 'boop-2025', title: 'Boop! The Musical', category: 'broadway', status: 'closed', openingDate: '2025-04-05' },
    { id: 'the-wiz-2024', title: 'The Wiz', category: 'broadway', status: 'closed', openingDate: '2024-04-17' },
    { id: 'mj-2022', title: 'MJ The Musical', category: 'broadway', status: 'open', openingDate: '2022-02-01' },
    { id: 'mary-jane-2024', title: 'Mary Jane', category: 'broadway', status: 'closed', openingDate: '2024-04-23' },
  ];
  const expect = {
    'Review-Roundup-OH-MARY-Opens-National-Tour-20261007': 'oh-mary-2024',
    'Review-Roundup-SIX-Launches-North-American-Tour-20260101': 'six-2021',
    'Review-Roundup-BOOP-Launches-National-Tour-20261003': 'boop-2025',
    'Review-Roundup-BOOP-THE-MUSICAL-Launches-National-Tour-20261003': 'boop-2025',
    'Review-Roundup-THE-WIZ-on-Tour-20260926': 'the-wiz-2024',
    'Review-Roundup-MJ-Opens-National-Tour-20260101': 'mj-2022',
    'Review-Roundup-OH-MARY-Opens-on-Broadway-20240711': 'oh-mary-2024',
  };
  for (const [slug, id] of Object.entries(expect)) {
    const m = matchBwwRoundupSlugToShow(slug, shows);
    assert.ok(m, slug);
    assert.equal(m.show.id, id, slug);
    assert.equal(m.via, 'slug-exact-title', slug);
  }
});

test('exact-title path: only exact equality, never a partial or reduced title (BRO-4929)', () => {
  const ohMary = { id: 'oh-mary-2024', title: 'Oh, Mary!', category: 'broadway', status: 'open', openingDate: '2024-07-11' };
  const cats = { id: 'cats-2016', title: 'Cats', category: 'broadway', status: 'closed', openingDate: '2016-07-31' };
  const jellicle = { id: 'cats-the-jellicle-ball-2026', title: 'CATS: The Jellicle Ball', category: 'broadway', status: 'closed', openingDate: '2026-04-07' };
  const six = { id: 'six-2021', title: 'SIX', category: 'broadway', status: 'open', openingDate: '2021-10-03' };
  // "Mary Jane" is not "Oh, Mary!".
  assert.equal(matchBwwRoundupSlugToShow('Review-Roundup-MARY-JANE-Opens-National-Tour-20261007', [ohMary]), null);
  assert.equal(matchBwwRoundupSlugToShow('Review-Roundup-MARY-JANE-Opens-Off-Broadway-20240423', [ohMary]), null);
  // A subtitled title does not answer to its first word, and the reverse.
  assert.equal(matchBwwRoundupSlugToShow('Review-Roundup-CATS-THE-JELLICLE-BALL-Opens-National-Tour-20261007', [cats]), null);
  assert.equal(matchBwwRoundupSlugToShow('Review-Roundup-CATS-Opens-National-Tour-20261007', [jellicle]), null);
  // ...but exact equality does match.
  assert.equal(matchBwwRoundupSlugToShow('Review-Roundup-CATS-Opens-National-Tour-20261007', [jellicle, cats]).show.id, 'cats-2016');
  // Extra words in the slug are not equality ("SIX Degrees..." is not SIX).
  assert.equal(matchBwwRoundupSlugToShow('Review-Roundup-SIX-FLAGS-Opens-National-Tour-20261007', [six]), null);
  // Tour words in the middle of a slug are not stripped.
  assert.equal(matchBwwRoundupSlugToShow('Review-Roundup-NATIONAL-TOUR-OH-MARY-20261007', [ohMary]), null);
  // The token path is untouched: a long-token show still matches via it.
  const hamilton = { id: 'hamilton-2015', title: 'Hamilton', category: 'broadway', status: 'open', openingDate: '2015-08-06' };
  assert.equal(matchBwwRoundupSlugToShow('Review-Roundup-HAMILTON-Launches-National-Tour-20261007', [hamilton]).via, 'slug-token-set');
});

test('exact-title path: same-title productions tie-break by article year (BRO-4929)', () => {
  const bway = { id: 'oh-mary-2024', title: 'Oh, Mary!', category: 'broadway', status: 'open', openingDate: '2024-07-11' };
  const tour = { id: 'oh-mary-tour-2026', title: 'Oh, Mary!', category: 'tour', status: 'open', openingDate: '2026-09-19' };
  const m = matchBwwRoundupSlugToShow('Review-Roundup-OH-MARY-Opens-National-Tour-20261007', [bway, tour]);
  assert.equal(m.show.id, 'oh-mary-tour-2026');
});

test('exact-title path is for national-tour roundup slugs only (ship-check BRO-4931)', () => {
  const shows = [
    { id: 'six-2021', title: 'SIX', category: 'broadway', status: 'closed', openingDate: '2021-10-03' },
    { id: 'six-tour-2022', title: 'SIX', category: 'tour', status: 'open', openingDate: '2022-09-20' },
    { id: 'rent-west-end-2026', title: 'Rent', category: 'west-end', status: 'open', openingDate: '2026-03-01' },
  ];
  // Playbill Verdict and non-tour roundup slugs name no tour: no exact-title match.
  assert.equal(matchSlugToShow('read-the-reviews-for-six-on-broadway', shows), null);
  assert.equal(matchSlugToShow('read-the-reviews-for-rent-off-broadway', shows), null);
  assert.equal(matchBwwRoundupSlugToShow('Review-Roundup-SIX', shows), null);
  assert.equal(matchBwwRoundupSlugToShow('Review-Roundup-SIX-20240101', shows), null);
  // A national-tour roundup slug still matches (production context breaks the tie).
  assert.equal(matchBwwRoundupSlugToShow('Review-Roundup-SIX-Launches-North-American-Tour-20260101', shows).via, 'slug-exact-title');
});
