import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const unregister = require('tsx/cjs/api').register();
after(unregister);
const core = require('../../src/lib/data-core');
const { SITEMAP_SHARDS } = require('../../src/config/sitemap-shards');
const { CURATED_HISTORICAL_SHOWS } = require('../../src/config/scoring');
const { isShowIndexable } = require('../../src/lib/seo-indexability');
let rows = [];
let missingShow = false;
const date = new Date('2026-10-01');
const data = {
  ...core,
  getAllShowSlugs: () => [...rows.map(s => s.slug), ...(missingShow ? ['missing-show'] : [])],
  getShowBySlug: slug => rows.find(s => s.slug === slug),
  getOperaShows: () => rows.filter(s => s.opera),
  getShowSitemapLastmod: () => date,
  getDataFreshness: () => ({ showsLastUpdated: date, reviewsLastUpdated: date }),
};

// Run the actual sitemap entry point and review/indexability predicates. Only
// supply show fixtures and isolate imports for unrelated shards (cast, etc.).
const originalLoad = Module._load;
Module._load = function (id, parent, ...args) {
  if (parent?.filename.endsWith('/src/app/sitemap.ts')) {
    if (id === '@/lib/data-core') return data;
    if (!['next/navigation', '@/lib/seo-indexability', '@/lib/critic-score-display', '@/config/sitemap-shards'].includes(id)) return {};
  }
  return originalLoad.call(this, id, parent, ...args);
};
let sitemap;
try {
  sitemap = require('../../src/app/sitemap').default;
} finally {
  Module._load = originalLoad;
}

function show(slug, category, reviewCount, overrides = {}) {
  return {
    id: slug, slug, category, status: 'open',
    criticScore: { reviewCount, tier1Count: 1, tier2Count: 0 },
    ...overrides,
  };
}

async function urls(shard) {
  const id = SITEMAP_SHARDS.findIndex(s => s.name === shard);
  return (await sitemap({ id: Promise.resolve(String(id)) })).map(entry => new URL(entry.url).pathname);
}

test('known categories keep existing indexability below the review minimum and before opening', async () => {
  rows = [];
  for (const [category, minimum] of [
    ['broadway', 5], ['off-broadway', 3], ['west-end', 5], ['off-west-end', 3],
    ['regional', 3], ['tour', 3],
  ]) {
    for (const status of ['open', 'closed', 'upcoming', 'announced', 'previews']) {
      rows.push(show(`${category}-${status}-zero`, category, 0, { status }));
      rows.push(show(`${category}-${status}-below`, category, minimum - 1, { status }));
      rows.push(show(`${category}-${status}-enough`, category, minimum, { status }));
    }
  }
  // Preserve the existing tour and thin-page rules, including the cohort.
  assert.deepEqual(await urls('shows'), rows.filter(s => isShowIndexable(s, s.slug)).map(s => `/show/${s.slug}`));
});

test('unenumerated and missing categories require the shared review minimum', async () => {
  rows = [];
  for (const [category, minimum] of [
    ['off-off-broadway', 3], ['unknown', 5], [undefined, 5], [null, 5], ['', 5],
  ]) {
    for (const status of ['open', 'closed', 'upcoming', 'announced', 'previews']) {
      const prefix = `${category}-${status}`;
      rows.push(show(`${prefix}-zero`, category, 0, { status }));
      rows.push(show(`${prefix}-below`, category, minimum - 1, { status }));
      rows.push(show(`${prefix}-enough`, category, minimum, { status }));
      rows.push(show(`${prefix}-no-score`, category, 0, { status, criticScore: null }));
      rows.push(show(`${prefix}-missing-score`, category, 0, { status, criticScore: undefined }));
    }
  }
  assert.deepEqual(await urls('shows'), rows.filter(s => s.slug.endsWith('-enough')).map(s => `/show/${s.slug}`));
});

test('T3-only thresholds gate new categories while known categories retain absent and curated scores', async () => {
  const curatedId = [...CURATED_HISTORICAL_SHOWS][0];
  assert.ok(curatedId);
  rows = [
    show('blogs-below', 'off-off-broadway', 4, { criticScore: { reviewCount: 4, tier1Count: 0, tier2Count: 0 } }),
    show('blogs-enough', 'off-off-broadway', 5, { criticScore: { reviewCount: 5, tier1Count: 0, tier2Count: 0 } }),
    show('unknown-blogs-below', 'unknown', 6, { criticScore: { reviewCount: 6, tier1Count: 0, tier2Count: 0 } }),
    show('unknown-blogs-enough', 'unknown', 7, { criticScore: { reviewCount: 7, tier1Count: 0, tier2Count: 0 } }),
    show('curated', 'broadway', 4, { id: curatedId }),
    show('not-curated', 'broadway', 4),
    show('no-score', 'off-broadway', 0, { criticScore: null }),
    show('missing-score', 'off-broadway', 0, { criticScore: undefined }),
  ];
  assert.deepEqual(await urls('shows'), [
    '/show/blogs-enough', '/show/unknown-blogs-enough', '/show/curated',
    '/show/not-curated', '/show/no-score', '/show/missing-score',
  ]);
});

test('an unresolved slug retains the existing fail-open behavior', async () => {
  rows = [];
  missingShow = true;
  try {
    assert.deepEqual(await urls('shows'), ['/show/missing-show']);
  } finally {
    missingShow = false;
  }
});

test('qualifying shows keep URL metadata, including scored tours', async () => {
  rows = [
    show('scored-open', 'broadway', 5),
    show('scored-closed', 'broadway', 5, { status: 'closed' }),
    show('scored-tour', 'tour', 3),
    show('unlisted-tour', 'tour', 2, { status: 'closed' }),
  ];
  const id = SITEMAP_SHARDS.findIndex(s => s.name === 'shows');
  const entries = await sitemap({ id });
  assert.deepEqual(entries.map(e => [new URL(e.url).pathname, e.priority, e.changeFrequency, e.lastModified]), [
    ['/show/scored-open', 0.9, 'weekly', date], ['/show/scored-closed', 0.6, 'monthly', date],
    ['/show/scored-tour', 0.9, 'weekly', date],
  ]);
});

test('opera preserves known categories and gates new ones while retaining the hub and upcoming exclusion', async () => {
  rows = [
    show('zero-opera', 'off-west-end', 0, { opera: true, criticScore: null }),
    show('thin-opera', 'off-west-end', 2, { opera: true }),
    show('scored-opera', 'off-west-end', 3, { opera: true }),
    show('upcoming-opera', 'off-west-end', 3, { opera: true, status: 'upcoming' }),
    show('thin-new-opera', 'off-off-broadway', 2, { opera: true }),
    show('scored-new-opera', 'off-off-broadway', 3, { opera: true }),
    show('missing-category-opera', undefined, 0, { opera: true }),
    show('scored-missing-category-opera', undefined, 5, { opera: true }),
    show('upcoming-new-opera', 'off-off-broadway', 3, { opera: true, status: 'upcoming' }),
  ];
  assert.deepEqual(await urls('shows'), []);
  assert.deepEqual(await urls('opera'), ['/opera', ...[
    'zero-opera', 'thin-opera', 'scored-opera', 'scored-new-opera', 'scored-missing-category-opera',
  ].map(slug => `/opera/${core.getOperaTitleSlug(slug)}`)]);
});
