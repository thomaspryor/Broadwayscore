// Regression test for BRO-112: scrape-wp-theater-blogs.js re-created the
// phantom "Barry Gordin" byline class at scale (207 files, 8 live
// double-counted reviews) because its authorName resolution checked the WP
// author mapping BEFORE the in-body byline. theaterlife.com's WP author id 2
// is the site's shared house/admin account "Barry Gordin" — never the actual
// critic — so authorMapping[authorId] always resolved truthy and the real
// in-body "By: <name>" byline (which extractTheaterLifeByline already parses
// correctly, see tests/unit/theaterlife-byline.test.mjs and Notion 39b637c5)
// was never even consulted.
//
// Requires the REAL exported resolveAuthorName per CLAUDE.md rule 15 — no
// logic copies. Registered explicitly in tests/unit-test-manifest.txt
// (top-level scripts/*.test.mjs is not globbed).
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SITES, resolveAuthorName } = require('./scrape-wp-theater-blogs.js');

const theaterLife = SITES.find((s) => s.id === 'theater-life');
const frontRowCenter = SITES.find((s) => s.id === 'front-row-center');

// Real corpus shape (a-dolls-house-2023/theater-life--barry-gordin.json):
// criticName was stamped "Barry Gordin" even though the post literally opens
// with a different critic's byline.
const REAL_BYLINE_TEXT = 'By: Samuel L. Leiter\n\nMarch 17, 2023: Jessica Chastain’s compelling performance of Nora';
const NO_BYLINE_TEXT = 'A review with no recognizable byline anywhere in the text.';

describe('resolveAuthorName', () => {
  const cases = [
    {
      name: 'house-account site: in-body byline wins over the WP author mapping',
      site: theaterLife,
      authorId: 2,
      authorMapping: { 2: 'Barry Gordin' },
      plainText: REAL_BYLINE_TEXT,
      post: {},
      expected: 'Samuel L. Leiter',
    },
    {
      name: 'house-account site: falls back to WP author mapping when no in-body byline parses',
      site: theaterLife,
      authorId: 2,
      authorMapping: { 2: 'Barry Gordin' },
      plainText: NO_BYLINE_TEXT,
      post: {},
      expected: 'Barry Gordin',
    },
    {
      name: 'house-account site: falls back to Unknown when nothing resolves',
      site: theaterLife,
      authorId: 999,
      authorMapping: {},
      plainText: NO_BYLINE_TEXT,
      post: {},
      expected: 'Unknown',
    },
    {
      name: 'non-house-account site: WP author mapping still wins over content extraction (unchanged behavior)',
      site: { id: 'other-site', usersEndpointPublic: true },
      authorId: 5,
      authorMapping: { 5: 'Some Real Author' },
      plainText: REAL_BYLINE_TEXT,
      post: {},
      expected: 'Some Real Author',
    },
    {
      name: 'knownAuthors map wins unconditionally, even ahead of authorMapping',
      site: frontRowCenter,
      authorId: 2,
      authorMapping: { 2: 'Wrong Name From WP' },
      plainText: REAL_BYLINE_TEXT,
      post: {},
      expected: frontRowCenter.knownAuthors[2],
    },
    {
      name: 'knownAuthors map wins even when authorMappingIsHouseAccount is also set',
      site: { ...theaterLife, knownAuthors: { 2: 'Hand-Verified Critic' } },
      authorId: 2,
      authorMapping: { 2: 'Barry Gordin' },
      plainText: REAL_BYLINE_TEXT,
      post: {},
      expected: 'Hand-Verified Critic',
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.strictEqual(
        resolveAuthorName(c.site, c.authorId, c.authorMapping, c.plainText, c.post),
        c.expected
      );
    });
  }
});

describe('theater-life site config', () => {
  test('is flagged as a WP house account so the priority override applies', () => {
    assert.strictEqual(theaterLife.authorMappingIsHouseAccount, true);
  });
});
