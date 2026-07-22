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

test('DTLI slug FP classes: collision suffixes stripped, headline slugs rejected', () => {
  // WordPress slug-collision suffixes (real: giant-2, death-of-a-salesman-3)
  assert.equal(titleFromDtliSlug('giant-2'), 'giant');
  assert.equal(titleFromDtliSlug('death-of-a-salesman-3'), 'death of a salesman');
  // Multi-digit trailing numbers are real title words (live FP: The Fear of 13)
  assert.equal(titleFromDtliSlug('the-fear-of-13'), 'the fear of 13');
  assert.equal(titleFromDtliSlug('1984'), '1984');
  // Long headline-style slugs are unmatchable → null (real sitemap entry)
  assert.equal(titleFromDtliSlug('kelli-ohara-and-rose-byrne-are-a-great-slapstick-duo-in-fallen-angels'), null);
  // 5-word real titles stay under the headline cap (the originating miss)
  assert.equal(titleFromDtliSlug('midnight-at-the-never-get'), 'midnight at the never get');
});

test('title variants: venue tails, market qualifiers, slug years (live FP classes)', () => {
  const idx = buildShowTitleIndex([
    { id: 'mc', title: 'Mother Courage and Her Children - Globe', slug: 'mother-courage-and-her-children-globe-west-end' },
    { id: 'ia', title: 'Inter Alia', slug: 'inter-alia-west-end-2026' },
  ]);
  assert.equal(titleMatchesIndex('Mother Courage and Her Children', idx), true);
  assert.equal(titleMatchesIndex('Inter Alia West End', idx), true);
  assert.equal(titleMatchesIndex('Midnight at the Never Get', idx), false);
});

const SHOWS = [
  { id: 'equus-west-end-2026', title: 'Equus', slug: 'equus-west-end' },
  { id: 'moulin-rouge-2019', title: 'Moulin Rouge! The Musical', slug: 'moulin-rouge' },
  { id: 'beetlejuice-we-2026', title: 'Beetlejuice', slug: 'beetlejuice-west-end' },
];

test('titleMatchesIndex: catalogued shows match, missing shows do not', () => {
  const index = buildShowTitleIndex(SHOWS);
  assert.equal(titleMatchesIndex('Equus', index), true);
  // "the musical" variant both directions
  assert.equal(titleMatchesIndex('Moulin Rouge!', index), true);
  assert.equal(titleMatchesIndex('Beetlejuice the Musical', index), true);
  // The originating miss: must surface as a candidate
  assert.equal(titleMatchesIndex('Midnight at the Never Get', index), false);
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
