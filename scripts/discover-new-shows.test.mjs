// Regression tests for WE/OWE discovery filters (scripts/discover-new-shows.js).
//
// Guards the 2026-07-31 Space Dogs incident: a "FirstName LastName"-shaped title
// filter (WE_SOLO_PERFORMER_PATTERN) silently dropped real productions — plays are
// routinely titled after their protagonist ("Jane Eyre", "Kimberly Akimbo"), which
// is indistinguishable from a performer name. The pattern was removed; these tests
// fail if any person-name-shaped filter is reintroduced into the shared venue-page
// predicate, and pin the Other Palace venue-listing config that now carries its
// Studio shows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { shouldExcludeVenueShow, VENUE_LISTING_PAGES } = require('./discover-new-shows.js');
const SOURCE_PATH = fileURLToPath(new URL('./discover-new-shows.js', import.meta.url));

test('two-word protagonist-style titles are NOT excluded (Space Dogs class)', () => {
  const realShows = [
    'Space Dogs',        // The Other Palace Studio, missed at opening 2026-07-31
    'Kimberly Akimbo',
    'Jane Eyre',
    'Twelfth Night',
    'Nine Night',
    'Martin Guerre',
    'Malory Towers',
    'Miss Saigon',
    'Hay Fever',
    'Dear England',
    'Starlight Express',
    'The Producers',     // determiner-led — the 2026-07-21 incident title
  ];
  for (const title of realShows) {
    assert.equal(shouldExcludeVenueShow(title), false, `"${title}" must not be excluded`);
  }
});

test('genuine non-show venue-page noise is still excluded', () => {
  const noise = [
    'Big Finish: A Celebration of Shaiman & Wittman',
    'Words Fail: A Celebration of Pasek & Paul',
    'Songs from the Musicals',
    'Spring Gala Benefit',
    'Playwriting Masterclass',
    'An Evening in Conversation with Elaine Paige',
  ];
  for (const title of noise) {
    assert.equal(shouldExcludeVenueShow(title), true, `"${title}" must be excluded`);
  }
});

test('The Other Palace venue listing config extracts show slugs, not utility pages', () => {
  const venue = VENUE_LISTING_PAGES.find(v => v.name === 'The Other Palace');
  assert.ok(venue, 'The Other Palace must be in VENUE_LISTING_PAGES');
  assert.equal(venue.category, 'off-west-end');
  assert.equal(venue.titleFromSlug, true);

  const showLinks = [
    'https://theotherpalace.co.uk/space-dogs/',
    'https://theotherpalace.co.uk/hot-mess/',
    'https://theotherpalace.co.uk/an-oak-tree/',
    'https://theotherpalace.co.uk/frigid-jones-diary/',
  ];
  for (const href of showLinks) {
    assert.ok(venue.linkPattern.test(href), `${href} must match linkPattern`);
  }

  const utilityLinks = [
    'https://theotherpalace.co.uk/whats-on/',
    'https://theotherpalace.co.uk/my-account/',
    'https://theotherpalace.co.uk/site-map/',
    'https://theotherpalace.co.uk/legal-privacy/',
    'https://theotherpalace.co.uk/top-archive/',
    'https://theotherpalace.co.uk/venue-hire/',
    'https://theotherpalace.co.uk/feed/',
    'https://theotherpalace.co.uk/your-visit/accessibility/', // two-segment self-excludes
    'https://theotherpalace.co.uk/xmlrpc.php',
    '/about',
  ];
  for (const href of utilityLinks) {
    assert.ok(!venue.linkPattern.test(href), `${href} must NOT match linkPattern`);
  }
});

test('Orange Tree + Park Theatre linkPatterns admit shows, reject utility/pagination links', () => {
  const cases = [
    { name: 'Orange Tree Theatre',
      admit: [
        'https://orangetreetheatre.co.uk/whats-on/loves-labours-lost/',
        'https://www.orangetreetheatre.co.uk/whats-on/much-ado-about-nothing/',
      ],
      reject: [
        'https://orangetreetheatre.co.uk/whats-on/',
        'https://orangetreetheatre.co.uk/whats-on/archive/',
        'https://orangetreetheatre.co.uk/whats-on/page/',
        'https://orangetreetheatre.co.uk/about/',
        '/whats-on/loves-labours-lost/',
      ] },
    { name: 'Park Theatre',
      admit: [
        'https://parktheatre.co.uk/events/bull/',
        'https://www.parktheatre.co.uk/events/the-revlon-girl/',
      ],
      reject: [
        'https://parktheatre.co.uk/events/page/',
        'https://parktheatre.co.uk/events/archive/',
        'https://parktheatre.co.uk/whats-on/archive/',
        'https://parktheatre.co.uk/about-us/',
        '/events/bull/',
      ] },
  ];
  for (const { name, admit, reject } of cases) {
    const venue = VENUE_LISTING_PAGES.find(v => v.name === name);
    assert.ok(venue, `${name} must be in VENUE_LISTING_PAGES`);
    for (const href of admit) assert.ok(venue.linkPattern.test(href), `${name} should admit: ${href}`);
    for (const href of reject) assert.ok(!venue.linkPattern.test(href), `${name} should reject: ${href}`);
  }
});

// BRO-108: fetchShowsFromTheatremonkey() was the only fetch() call in this file
// with no timeout/AbortSignal, and could hang a scraper indefinitely regardless
// of any --time-budget-min wall-clock guard (budget checks only run between
// discovery sources, not inside a single hung network call). Static-scans every
// network call site in the file so a future fetch()/https.get() addition without
// timeout protection fails CI instead of shipping a silent hang risk.
test('every fetch()/https.get() call site in discover-new-shows.js has timeout protection', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  const WINDOW = 800;
  const isCommentLine = (index) => {
    const lineStart = source.lastIndexOf('\n', index) + 1;
    return source.slice(lineStart, index).trimStart().startsWith('//');
  };

  // Bare fetch( calls — excludes fetchPage(/fetchShowsFrom...( by requiring no
  // preceding word char or dot immediately before "fetch(", and skips mentions
  // inside // comments.
  const fetchSites = [...source.matchAll(/(?<![.\w])fetch\(/g)].filter(m => !isCommentLine(m.index));
  assert.ok(fetchSites.length >= 2, 'expected at least the known fetch() call sites — did they move or get removed?');
  for (const match of fetchSites) {
    const window = source.slice(match.index, match.index + WINDOW);
    const line = source.slice(0, match.index).split('\n').length;
    assert.match(window, /AbortSignal\.timeout\(\d+\)/,
      `fetch() at line ${line} must pass an AbortSignal.timeout(...) signal`);
  }

  // https.get(/http.get( calls — Node's http(s) module doesn't support
  // AbortSignal directly; timeout protection here is the { timeout: N } option
  // plus a req.on('timeout', ...) handler that destroys the request.
  const httpGetSites = [...source.matchAll(/\bhttps?\.get\(/g)].filter(m => !isCommentLine(m.index));
  assert.ok(httpGetSites.length >= 2, 'expected at least the known https.get() call sites — did they move or get removed?');
  for (const match of httpGetSites) {
    const window = source.slice(match.index, match.index + WINDOW);
    const line = source.slice(0, match.index).split('\n').length;
    assert.match(window, /timeout\s*:\s*\d+/,
      `https.get()/http.get() at line ${line} must pass a { timeout: N } option`);
  }
});
