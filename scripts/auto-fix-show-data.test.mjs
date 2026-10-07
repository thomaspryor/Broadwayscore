// BRO-102: the IBDB creative-team scrape path (fixCreativeTeam Step 2) used
// to take ibdb.creativeTeam verbatim — a wrong table cell or stale IBDB entry
// would ship a hallucinated attribution the same way the LLM path did before
// the 2026-05-26 Liberation fix (generateCreativeTeamWithSerpVerification).
// Both paths now route through the same verifyCreativeTeamViaSerp() gate.
//
// serpQuery and lookupIBDBDates are network calls, so this file mocks them
// via require.cache injection (pre-seed the module cache for their owning
// libs before requiring auto-fix-show-data.js fresh) rather than re-implementing
// their decision logic — see CLAUDE.md rule 15 ("require() the real function").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

process.env.SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY || 'test-key';

const targetPath = require.resolve('./auto-fix-show-data.js');
const urlDiscoveryPath = require.resolve('./lib/url-discovery.js');
const ibdbDatesPath = require.resolve('./lib/ibdb-dates.js');

// Load auto-fix-show-data.js with serpQuery and lookupIBDBDates swapped out.
// Restores the real modules afterward so other tests in the same process
// (or a later require in this file) aren't left with mocks installed.
function loadWithMocks({ serpQueryImpl, ibdbCreativeTeam }) {
  const realUrlDiscovery = require(urlDiscoveryPath);
  const realIbdbDates = require(ibdbDatesPath);

  delete require.cache[urlDiscoveryPath];
  delete require.cache[ibdbDatesPath];
  delete require.cache[targetPath];

  require.cache[urlDiscoveryPath] = {
    id: urlDiscoveryPath, filename: urlDiscoveryPath, loaded: true,
    exports: { ...realUrlDiscovery, serpQuery: serpQueryImpl },
  };
  require.cache[ibdbDatesPath] = {
    id: ibdbDatesPath, filename: ibdbDatesPath, loaded: true,
    exports: {
      ...realIbdbDates,
      lookupIBDBDates: async () => ({
        previewsStartDate: '2026-01-01',
        openingDate: '2026-01-15',
        closingDate: null,
        creativeTeam: ibdbCreativeTeam,
        showType: null,
        ibdbUrl: 'https://www.ibdb.com/broadway-production/example-123456',
        found: true,
      }),
    },
  };

  try {
    return require(targetPath);
  } finally {
    // Restore the real modules for anything requiring them after this point,
    // even if requiring targetPath threw — a leaked mock in require.cache
    // would otherwise silently poison every later test in this process that
    // does a plain require('./lib/ibdb-dates') / require('./lib/url-discovery').
    delete require.cache[urlDiscoveryPath];
    delete require.cache[ibdbDatesPath];
    delete require.cache[targetPath];
    require.cache[urlDiscoveryPath] = { id: urlDiscoveryPath, filename: urlDiscoveryPath, loaded: true, exports: realUrlDiscovery };
    require.cache[ibdbDatesPath] = { id: ibdbDatesPath, filename: ibdbDatesPath, loaded: true, exports: realIbdbDates };
  }
}

function fakeShow(overrides = {}) {
  return {
    id: 'example-2026',
    title: 'Example',
    openingDate: '2026-01-15',
    ibdbUrl: 'https://www.ibdb.com/broadway-production/example-123456',
    ...overrides,
  };
}

test('verifyCreativeTeamViaSerp: unrecognized (design/tech-credit) roles are rejected without a network call', async () => {
  let calls = 0;
  const { verifyCreativeTeamViaSerp } = loadWithMocks({
    serpQueryImpl: async () => { calls++; return []; },
    ibdbCreativeTeam: [],
  });

  const proposed = [{ name: 'Arnulfo Maldonado', role: 'Scenic Design' }];
  const verified = await verifyCreativeTeamViaSerp(fakeShow(), proposed, '2026', 'serp-verified-ibdb');

  assert.deepEqual(verified, []);
  assert.equal(calls, 0, 'unverifiable roles must never reach serpQuery');
});

test('verifyCreativeTeamViaSerp: a member confirmed by SERP is accepted and tagged with the source', async () => {
  const { verifyCreativeTeamViaSerp } = loadWithMocks({
    serpQueryImpl: async () => [
      { title: 'Example opens', snippet: 'Example, directed by Mary Zimmerman, begins previews.' },
    ],
    ibdbCreativeTeam: [],
  });

  const proposed = [{ name: 'Mary Zimmerman', role: 'Director' }];
  const verified = await verifyCreativeTeamViaSerp(fakeShow(), proposed, '2026', 'serp-verified-ibdb');

  assert.equal(verified.length, 1);
  assert.equal(verified[0].name, 'Mary Zimmerman');
  assert.equal(verified[0].role, 'Director');
  assert.equal(verified[0]._source, 'serp-verified-ibdb');
});

test('verifyCreativeTeamViaSerp: a member SERP does not confirm is rejected (the wrong-table-cell / hallucination case)', async () => {
  const { verifyCreativeTeamViaSerp } = loadWithMocks({
    // No result mentions "written by Reginald Rose" for this show — simulates
    // IBDB regex grabbing the wrong playwright (the romantic-comedy-1979 bug).
    serpQueryImpl: async () => [
      { title: 'Unrelated', snippet: 'Some other show entirely, opening next month.' },
    ],
    ibdbCreativeTeam: [],
  });

  const proposed = [{ name: 'Reginald Rose', role: 'Playwright' }];
  const verified = await verifyCreativeTeamViaSerp(fakeShow({ title: 'Romantic Comedy' }), proposed, '2026', 'serp-verified-ibdb');

  assert.deepEqual(verified, []);
});

test('fixCreativeTeam: IBDB step drops an unconfirmed member but keeps a confirmed one, and writes only the verified set', async () => {
  const { fixCreativeTeam } = loadWithMocks({
    serpQueryImpl: async (query) => {
      if (query.includes('directed by')) {
        return [{ title: 'Example opens', snippet: 'Example, directed by Mary Zimmerman, begins previews.' }];
      }
      // "written by Reginald Rose" (or any other query) finds nothing.
      return [];
    },
    ibdbCreativeTeam: [
      { name: 'Mary Zimmerman', role: 'Director' },
      { name: 'Reginald Rose', role: 'Playwright' }, // wrong table cell — unconfirmed
    ],
  });

  const show = fakeShow();
  const result = await fixCreativeTeam(show, { shows: {} });

  assert.match(result, /SERP-verified/);
  assert.equal(show.creativeTeam.length, 1);
  assert.equal(show.creativeTeam[0].name, 'Mary Zimmerman');
  assert.ok(!show.creativeTeam.some(m => m.name === 'Reginald Rose'), 'the unconfirmed member must not be written');
});

test('fixCreativeTeam: IBDB step writes nothing when no member passes SERP verification', async () => {
  const { fixCreativeTeam } = loadWithMocks({
    serpQueryImpl: async () => [],
    ibdbCreativeTeam: [{ name: 'Someone Wrong', role: 'Director' }],
  });

  const show = fakeShow();
  const result = await fixCreativeTeam(show, { shows: {} });

  assert.equal(result, null);
  assert.equal(show.creativeTeam, undefined, 'no creative team data may be introduced without verification');
});

test('verifyCreativeTeamViaSerp: dedupes duplicate name+role entries (one SERP call, one output entry)', async () => {
  let calls = 0;
  const { verifyCreativeTeamViaSerp } = loadWithMocks({
    serpQueryImpl: async () => {
      calls++;
      return [{ title: 'Example opens', snippet: 'Example, directed by Mary Zimmerman, begins previews.' }];
    },
    ibdbCreativeTeam: [],
  });

  const proposed = [
    { name: 'Mary Zimmerman', role: 'Director' },
    { name: 'Mary Zimmerman', role: 'Director' },
    { name: 'mary zimmerman', role: 'director' }, // case-insensitive duplicate
  ];
  const verified = await verifyCreativeTeamViaSerp(fakeShow(), proposed, '2026', 'serp-verified-ibdb');

  assert.equal(calls, 1, 'duplicate members must only be SERP-queried once');
  assert.equal(verified.length, 1, 'duplicate members must only appear once in the output');
});

test('verifyCreativeTeamViaSerp: a blank/missing name is rejected without a network call (would otherwise wildcard-match any "<verb> <anyone>" snippet)', async () => {
  let calls = 0;
  const { verifyCreativeTeamViaSerp } = loadWithMocks({
    serpQueryImpl: async () => { calls++; return [{ title: 'Example opens', snippet: 'Example, directed by Someone Else, begins previews.' }]; },
    ibdbCreativeTeam: [],
  });

  const proposed = [{ name: '', role: 'Director' }, { name: '   ', role: 'Director' }];
  const verified = await verifyCreativeTeamViaSerp(fakeShow(), proposed, '2026', 'serp-verified-ibdb');

  assert.deepEqual(verified, []);
  assert.equal(calls, 0, 'a blank name must never reach serpQuery');
});

test('verifyCreativeTeamViaSerp: "Music & Lyrics" confirms on either "music and lyrics by" or "music & lyrics by"', async () => {
  const { verifyCreativeTeamViaSerp } = loadWithMocks({
    serpQueryImpl: async () => [
      { title: 'Example opens', snippet: 'Example, music & lyrics by Jason Robert Brown, begins previews.' },
    ],
    ibdbCreativeTeam: [],
  });

  const proposed = [{ name: 'Jason Robert Brown', role: 'Music & Lyrics' }];
  const verified = await verifyCreativeTeamViaSerp(fakeShow(), proposed, '2026', 'serp-verified-ibdb');

  assert.equal(verified.length, 1);
  assert.equal(verified[0].name, 'Jason Robert Brown');
});

test('fixCreativeTeam: IBDB step never overwrites an existing creativeTeam[1] with an unverified replacement', async () => {
  const { fixCreativeTeam } = loadWithMocks({
    serpQueryImpl: async () => [],
    ibdbCreativeTeam: [{ name: 'Someone Wrong', role: 'Director' }],
  });

  const show = fakeShow({ creativeTeam: [{ name: 'Existing Person', role: 'Director' }] });
  await fixCreativeTeam(show, { shows: {} });

  assert.deepEqual(show.creativeTeam, [{ name: 'Existing Person', role: 'Director' }]);
});
