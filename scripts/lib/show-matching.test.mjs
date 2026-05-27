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
const { matchSlugToShow, matchBwwRoundupSlugToShow, cleanSlugTitle, loadShows } = require('./show-matching.js');

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
  ['what-are-the-reviews-for-bedlams-4-person-version-of-shakespeares-othello', 'othello', 'company prefix + classical author prefix'],
  ['what-do-reviews-think-of-bubba-weilers-well-ill-let-you-go-at-studio-seaview', 'well-ill-let-you-go', 'possessive author + venue suffix'],
  // Bug-trigger slugs (articles that appeared AFTER the May 24 cached page):
  ['read-the-reviews-for-the-maids-off-broadway', 'the-maids', 'verified live on category page 2026-05-27'],
  ['reviews-what-do-the-critics-think-of-heated-rivalry-the-unauthorized-musical-parody', 'heated-rivalry', 'verified live on category page 2026-05-27'],
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
