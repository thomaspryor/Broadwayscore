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
  const isCommentLine = (index) => {
    const lineStart = source.lastIndexOf('\n', index) + 1;
    return source.slice(lineStart, index).trimStart().startsWith('//');
  };
  // Top-level function boundaries, sorted — used to scope each call site's
  // search to "rest of its enclosing function" instead of a fixed character
  // window. A fixed window either misses handlers in long functions or, if
  // widened enough to cover them, can bleed into an unrelated later call's
  // handler and mask a real gap. Scoping to the enclosing function is exact.
  const fnBoundaries = [...source.matchAll(/^(?:async )?function \w+\(/gm)].map(m => m.index);
  const restOfEnclosingFunction = (index) => {
    const next = fnBoundaries.find(b => b > index);
    return source.slice(index, next === undefined ? source.length : next);
  };

  // Bare fetch( calls — excludes fetchPage(/fetchShowsFrom...( by requiring no
  // preceding word char or dot immediately before "fetch(", and skips mentions
  // inside // comments.
  const fetchSites = [...source.matchAll(/(?<![.\w])fetch\(/g)].filter(m => !isCommentLine(m.index));
  assert.ok(fetchSites.length >= 2, 'expected at least the known fetch() call sites — did they move or get removed?');
  for (const match of fetchSites) {
    const scope = restOfEnclosingFunction(match.index);
    const line = source.slice(0, match.index).split('\n').length;
    assert.match(scope, /AbortSignal\.timeout\(\d+\)/,
      `fetch() at line ${line} must pass an AbortSignal.timeout(...) signal`);
  }

  // https.get(/http.get( calls — Node's http(s) module doesn't support
  // AbortSignal directly. The { timeout: N } option alone is not enough: Node
  // just emits a 'timeout' event and does nothing further, so the request
  // hangs forever unless a listener destroys it (this was a real gap in the
  // OLT/LT redirect-follow calls — the option was set but nothing destroyed
  // the socket on fire). Require both the option AND a handler that calls
  // .destroy() on it, within the same enclosing function (so an outer
  // request's handler can't be mistaken for a nested redirect request's).
  const httpGetSites = [...source.matchAll(/\bhttps?\.get\(/g)].filter(m => !isCommentLine(m.index));
  assert.ok(httpGetSites.length >= 2, 'expected at least the known https.get() call sites — did they move or get removed?');
  for (const match of httpGetSites) {
    const scope = restOfEnclosingFunction(match.index);
    const line = source.slice(0, match.index).split('\n').length;
    assert.match(scope, /timeout\s*:\s*\d+/,
      `https.get()/http.get() at line ${line} must pass a { timeout: N } option`);
    assert.match(scope, /on\(\s*'timeout'\s*,[\s\S]*?\.destroy\(\)/,
      `https.get()/http.get() at line ${line} must have a .on('timeout', ...) handler that calls .destroy()`);
  }
});

// task #1863 (BRO-102 follow-up): applyVerifiedIbdbCreativeTeam() is the
// first-write path for every newly-discovered Broadway show's creative team
// — the highest-risk of the IBDB creativeTeam consumers, since a bad write
// here ships before auto-fix-show-data.js's own IBDB step ever runs (that
// step only fires when the team is empty/1-entry, which won't be true once
// this write lands). Mocks verifyCreativeTeamViaSerp (the network boundary)
// rather than re-implementing its decision logic — CLAUDE.md rule 15.
const creativeTeamVerifyPath = require.resolve('./lib/creative-team-verify.js');
const discoverNewShowsPath = require.resolve('./discover-new-shows.js');

function loadWithMockedVerify(verifyImpl) {
  const real = require(creativeTeamVerifyPath);
  delete require.cache[creativeTeamVerifyPath];
  delete require.cache[discoverNewShowsPath];
  require.cache[creativeTeamVerifyPath] = {
    id: creativeTeamVerifyPath, filename: creativeTeamVerifyPath, loaded: true,
    exports: { ...real, verifyCreativeTeamViaSerp: verifyImpl },
  };
  try {
    return require(discoverNewShowsPath);
  } finally {
    delete require.cache[creativeTeamVerifyPath];
    delete require.cache[discoverNewShowsPath];
    require.cache[creativeTeamVerifyPath] = { id: creativeTeamVerifyPath, filename: creativeTeamVerifyPath, loaded: true, exports: real };
  }
}

test('applyVerifiedIbdbCreativeTeam: no member confirmed -> show.creativeTeam stays unset (wrong-table-cell case)', async () => {
  const { applyVerifiedIbdbCreativeTeam } = loadWithMockedVerify(async () => []);
  const show = { id: 'wrong-cell-2026', title: 'Wrong Cell', openingDate: '2026-01-15' };
  await applyVerifiedIbdbCreativeTeam(show, [{ name: 'Hallucinated Name', role: 'Director' }]);
  assert.equal(show.creativeTeam, undefined);
});

test('applyVerifiedIbdbCreativeTeam: a confirmed member is written to show.creativeTeam', async () => {
  const { applyVerifiedIbdbCreativeTeam } = loadWithMockedVerify(async (show, proposed) =>
    proposed.map(m => ({ ...m, _source: 'serp-verified-ibdb-discovery' }))
  );
  const show = { id: 'confirmed-2026', title: 'Confirmed', openingDate: '2026-01-15' };
  await applyVerifiedIbdbCreativeTeam(show, [{ name: 'Mary Zimmerman', role: 'Director' }]);
  assert.equal(show.creativeTeam.length, 1);
  assert.equal(show.creativeTeam[0].name, 'Mary Zimmerman');
  assert.equal(show.creativeTeam[0]._source, 'serp-verified-ibdb-discovery');
});

test('applyVerifiedIbdbCreativeTeam: combined names are split before SERP verification', async () => {
  let seenProposed;
  const { applyVerifiedIbdbCreativeTeam } = loadWithMockedVerify(async (show, proposed) => {
    seenProposed = proposed;
    return [];
  });
  const show = { id: 'combined-2026', title: 'Combined', openingDate: '2026-01-15' };
  await applyVerifiedIbdbCreativeTeam(show, [{ name: 'John Doe & Jane Smith', role: 'Director' }]);
  assert.equal(seenProposed.length, 2, 'combined name must be split into individual entries before verification');
  assert.deepEqual(seenProposed.map(m => m.name).sort(), ['Jane Smith', 'John Doe']);
});
