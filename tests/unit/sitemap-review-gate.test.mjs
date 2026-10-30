import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const unregister = require('tsx/cjs/api').register();
after(unregister);
const core = require('../../src/lib/data-core');
const { SITEMAP_SHARDS } = require('../../src/config/sitemap-shards');
const { CURATED_HISTORICAL_SHOWS } = require('../../src/config/scoring');
let rows = [];
const date = new Date('2026-10-01');
const data = {
  ...core,
  getAllShowSlugs: () => [...rows.filter(s => !s.opera).map(s => s.slug), 'missing-show'],
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

test('show sitemap applies the shared minimum to every category, including unknown ones', async () => {
  rows = [];
  for (const [category, minimum] of [
    ['broadway', 5], ['off-broadway', 3], ['west-end', 5], ['off-west-end', 3],
    ['regional', 3], ['tour', 3], ['off-off-broadway', 3], ['unknown', 5], [undefined, 5],
  ]) {
    rows.push(show(`${category}-zero`, category, 0));
    rows.push(show(`${category}-below`, category, minimum - 1));
    rows.push(show(`${category}-enough`, category, minimum));
  }
  assert.deepEqual(await urls('shows'), rows.filter(s => s.slug.endsWith('-enough')).map(s => `/show/${s.slug}`));
});

test('sitemap honors T3-only and curated historical thresholds and excludes absent scores', async () => {
  const curatedId = [...CURATED_HISTORICAL_SHOWS][0];
  assert.ok(curatedId);
  rows = [
    show('blogs-below', 'off-off-broadway', 4, { criticScore: { reviewCount: 4, tier1Count: 0, tier2Count: 0 } }),
    show('blogs-enough', 'off-off-broadway', 5, { criticScore: { reviewCount: 5, tier1Count: 0, tier2Count: 0 } }),
    show('curated', 'broadway', 4, { id: curatedId }),
    show('not-curated', 'broadway', 4),
    show('no-score', 'off-broadway', 0, { criticScore: null }),
    show('missing-score', 'off-broadway', 0, { criticScore: undefined }),
  ];
  assert.deepEqual(await urls('shows'), ['/show/blogs-enough', '/show/curated']);
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

test('opera show URLs also require enough reviews while retaining the hub and upcoming exclusion', async () => {
  rows = [
    show('thin-opera', 'off-west-end', 2, { opera: true }),
    show('scored-opera', 'off-west-end', 3, { opera: true }),
    show('upcoming-opera', 'off-west-end', 3, { opera: true, status: 'upcoming' }),
  ];
  assert.deepEqual(await urls('opera'), ['/opera', `/opera/${core.getOperaTitleSlug('scored-opera')}`]);
});
