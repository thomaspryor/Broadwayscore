import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractShowTitleFromWetRoundup,
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
