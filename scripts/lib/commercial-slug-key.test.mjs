// BRO-4623: real pending entries whose `slug` field held a show ID, and the
// commercial.json keys they produced. Fixtures mirror shows.json id/slug pairs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildShowKeyIndex, resolveCommercialSlug, canonicalizeCommercialKeys } = require('./commercial-slug-key.js');

const SHOWS = [
  { id: 'the-outsiders-2024', slug: 'the-outsiders' },
  { id: 'hadestown-2019', slug: 'hadestown' },
  { id: 'the-balusters-2026', slug: 'the-balusters' },
  { id: 'school-girls-or-the-african-mean-girls-play-2026', slug: 'school-girls-or-the-african-mean-girls-play' },
  { id: 'the-lost-boys-2026', slug: 'the-lost-boys' },
  { id: 'giant-2026', slug: 'giant' },
  // id === slug, a distinct production from the mamma-mia revival
  { id: 'mamma-mia-2001', slug: 'mamma-mia-2001' },
  { id: 'mamma-mia-2025', slug: 'mamma-mia' },
  { id: 'beetlejuice-2025', slug: 'beetlejuice-2025' },
];
const index = buildShowKeyIndex({ shows: SHOWS });

test('entry.slug holding a show ID resolves to the real slug (weekly run 37151980535)', () => {
  assert.equal(resolveCommercialSlug('the-outsiders-2024', { slug: 'the-outsiders-2024' }, index).slug, 'the-outsiders');
  assert.equal(resolveCommercialSlug('hadestown-2019', { slug: 'hadestown-2019' }, index).slug, 'hadestown');
  assert.equal(resolveCommercialSlug('the-lost-boys-2026', { slug: 'the-lost-boys-2026' }, index).slug, 'the-lost-boys');
});

test('the RSS-poll apply duplicates (2026-09-26 / 09-28) resolve to their slugs', () => {
  assert.equal(resolveCommercialSlug('the-balusters-2026', { slug: 'the-balusters-2026' }, index).slug, 'the-balusters');
  assert.equal(
    resolveCommercialSlug('school-girls-or-the-african-mean-girls-play-2026', {}, index).slug,
    'school-girls-or-the-african-mean-girls-play'
  );
});

test('a correct entry.slug still wins over an ID key', () => {
  assert.deepEqual(resolveCommercialSlug('giant-2026', { slug: 'giant' }, index), { slug: 'giant', show: SHOWS[5], resolved: true });
});

test('slug-first: mamma-mia-2001 and beetlejuice-2025 are slugs and stay put', () => {
  assert.equal(resolveCommercialSlug('mamma-mia-2001', {}, index).slug, 'mamma-mia-2001');
  assert.equal(resolveCommercialSlug('beetlejuice-2025', { slug: 'beetlejuice-2025' }, index).slug, 'beetlejuice-2025');
  assert.equal(resolveCommercialSlug('mamma-mia-2025', {}, index).slug, 'mamma-mia');
});

test('unknown keys are returned unresolved (callers warn), never invented', () => {
  assert.deepEqual(resolveCommercialSlug('not-a-show', {}, index), { slug: 'not-a-show', show: null, resolved: false });
  assert.deepEqual(resolveCommercialSlug('not-a-show', { slug: 'also-not' }, index), { slug: 'also-not', show: null, resolved: false });
});

test('canonicalizeCommercialKeys re-keys a lone ID key and leaves a pair for dedupe', () => {
  const shows = {
    'the-lost-boys-2026': { designation: 'TBD' },
    'the-balusters-2026': { designation: 'Nonprofit' },
    'the-balusters': { designation: 'Nonprofit', nonprofitOrg: 'Manhattan Theatre Club' },
    'mamma-mia-2001': { designation: 'Miracle' },
    hadestown: { designation: 'Windfall' },
  };
  const r = canonicalizeCommercialKeys(shows, index);
  assert.deepEqual(r.rekeyed, [{ from: 'the-lost-boys-2026', to: 'the-lost-boys' }]);
  assert.deepEqual(r.conflicts, [{ idKey: 'the-balusters-2026', slugKey: 'the-balusters' }]);
  assert.deepEqual(Object.keys(shows).sort(), ['hadestown', 'mamma-mia-2001', 'the-balusters', 'the-balusters-2026', 'the-lost-boys']);
  assert.deepEqual(shows['the-lost-boys'], { designation: 'TBD' });
});
