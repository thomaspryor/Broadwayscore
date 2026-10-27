import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { belongsOnOffBroadwayListing } = require('../../scripts/lib/off-broadway-listing');
const { generateMarketArchive } = require('../../scripts/lib/generate-market-archive');
const previousFeatures = process.env.NEXT_PUBLIC_FEATURES;
process.env.NEXT_PUBLIC_FEATURES = [previousFeatures, 'offBroadway'].filter(Boolean).join(',');
// The acceptance command uses plain node, so register the TypeScript loader here.
const unregister = require('tsx/cjs/api').register();
const previousReact = globalThis.React;
globalThis.React = require('react');
const core = require('../../src/lib/data-core');
const OffBroadwayPage = require('../../src/app/off-broadway/page').default;
after(() => {
  unregister();
  if (previousReact === undefined) delete globalThis.React;
  else globalThis.React = previousReact;
  if (previousFeatures === undefined) delete process.env.NEXT_PUBLIC_FEATURES;
  else process.env.NEXT_PUBLIC_FEATURES = previousFeatures;
});

test('listing policy excludes opera at every status without excluding plays or musicals', () => {
  for (const status of ['open', 'previews', 'upcoming', 'closed']) {
    for (const type of ['opera', 'play', 'musical', 'special']) {
      assert.equal(belongsOnOffBroadwayListing({ category: 'off-broadway', type, status }), type !== 'opera');
    }
  }
  for (const category of ['broadway', 'west-end', 'off-west-end', 'regional', undefined]) {
    assert.equal(belongsOnOffBroadwayListing({ category, type: 'play' }), false);
  }
});

test('real server query excludes exactly the opera inventory', () => {
  const all = core.getAllShows();
  const categoryShows = all.filter(s => s.category === 'off-broadway');
  assert.ok(categoryShows.some(s => s.type === 'opera'), 'real opera cases exist');
  const listed = new Set(core.getOffBroadwayShows().map(s => s.id));
  for (const show of categoryShows) {
    assert.equal(listed.has(show.id), show.type !== 'opera', show.id);
  }
  assert.equal(core.getOffBroadwayShows().length, listed.size);
});

test('venue pages retain opera houses and match the redirect inventory', () => {
  const { offBroadwayShows, stubTheaterNames } = require('../../scripts/lib/page-name-sources');
  const { slugify } = require('../../scripts/lib/url-slug');
  assert.ok(core.getAllOffBroadwayTheaterSlugs().includes('metropolitan-opera-house'));
  // The venue index groups spelling variants by slug; redirects retain every name.
  assert.deepEqual(
    core.getAllOffBroadwayTheaters().map(theater => theater.slug).sort(),
    [...new Set(stubTheaterNames(offBroadwayShows(core.getAllShows())).map(slugify))].sort(),
  );
  const met = core.getOffBroadwayTheaterBySlug('metropolitan-opera-house');
  const expected = offBroadwayShows(core.getAllShows()).filter(show => show.venue === met.name);
  assert.ok(expected.length > 0, 'real Met productions exist');
  assert.deepEqual(met.allShows.map(show => show.id).sort(), expected.map(show => show.id).sort());
});

test('active props, shelves, counts and JSON-LD use the opera-free inventory', () => {
  const tree = OffBroadwayPage();
  const elements = [];
  function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node?.props) return;
    elements.push(node);
    walk(node.props.children);
  }
  walk(tree);
  const client = elements.find(node => node.props.marketOpenCounts);
  assert.ok(client, 'found serialized OffBroadwayPageClient props');
  const active = core.getOffBroadwayShows().filter(s => ['open', 'previews'].includes(s.status));
  assert.equal(client.props.totalShows, active.length);
  assert.equal(client.props.totalReviews, active.reduce((n, s) => n + (s.criticScore?.reviewCount ?? 0), 0));
  assert.equal(client.props.marketOpenCounts.offBroadway, active.length);
  for (const node of elements) {
    for (const key of ['shows', 'startingSoonShows', 'justOpenedShows']) {
      for (const show of node.props[key] || []) assert.notEqual(show.type, 'opera', `${key}: ${show.id}`);
    }
  }
  const schemas = elements.filter(node => node.props.type === 'application/ld+json');
  assert.equal(schemas.length, 1);
  const json = schemas[0].props.dangerouslySetInnerHTML.__html;
  for (const opera of core.getOperaShows()) assert.ok(!json.includes(`/show/${opera.slug}"`), opera.id);
});

test('archive writer excludes closed opera and preserves every other eligible record', () => {
  const filename = `bro-5854-test-${process.pid}.json`;
  const output = new URL(`../../public/data/${filename}`, import.meta.url);
  try {
    const options = { outputFilename: filename, entryCategory: 'off-broadway', label: 'Off-Broadway' };
    const before = generateMarketArchive({ ...options, belongsToMarket: s => s.category === 'off-broadway' });
    const after = generateMarketArchive({ ...options, belongsToMarket: belongsOnOffBroadwayListing });
    assert.ok(before.some(s => s.type === 'opera'), 'real closed opera cases exist');
    assert.deepEqual(after, before.filter(s => s.type !== 'opera'));
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), after);
  } finally {
    fs.rmSync(output, { force: true });
  }
});

test('existing archive caller uses the shared predicate and client rejects obsolete opera filter', () => {
  const writer = fs.readFileSync(new URL('../../scripts/generate-off-broadway-archive.js', import.meta.url), 'utf8');
  assert.match(writer, /belongsToMarket: belongsOnOffBroadwayListing/);
  const client = fs.readFileSync(new URL('../../src/components/OffBroadwayPageClient.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(client, /['"]opera['"]/);
});

test('opera query and At the Met still include the real opera productions', () => {
  const { isOperaShow } = require('../../src/lib/show-market');
  assert.deepEqual(core.getOperaShows(), core.getAllShows().filter(isOperaShow));
  const { buildHomepageExtra } = require('../../src/lib/homepage-extra');
  const met = buildHomepageExtra().featuredRows.find(s => s.title === 'At the Met');
  assert.ok(met?.shows.length, 'At the Met has real shows');
  for (const show of met.shows) {
    assert.equal(show.type, 'opera');
    assert.ok(core.getOperaShows().some(s => s.id === show.id));
  }
});
