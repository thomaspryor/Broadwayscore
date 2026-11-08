// LIVE-DATA-LANE: reads data/shows.json and other untracked core data via data-core. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// Owner, 2026-11-08: "opera doesn't count as West End; give it its own section,
// lower down, like Broadway." Mirrors off-broadway-opera-exclusion.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { belongsOnWestEndArchive, belongsOnOffWestEndArchive } = require('../../scripts/lib/london-listing');
const previousFeatures = process.env.NEXT_PUBLIC_FEATURES;
process.env.NEXT_PUBLIC_FEATURES = [previousFeatures, 'westEnd'].filter(Boolean).join(',');
const unregister = require('tsx/cjs/api').register();
const previousReact = globalThis.React;
globalThis.React = require('react');
const core = require('../../src/lib/data-core');
const { getMarketFromPath } = require('../../src/hooks/useCurrentMarket');
const { isOperaShowPath } = require('../../src/lib/opera-show-ids');
const { SHELF_MAX_ITEMS } = require('../../src/lib/market-list-window');
const WestEndPage = require('../../src/app/west-end/page').default;
after(() => {
  unregister();
  if (previousReact === undefined) delete globalThis.React;
  else globalThis.React = previousReact;
  if (previousFeatures === undefined) delete process.env.NEXT_PUBLIC_FEATURES;
  else process.env.NEXT_PUBLIC_FEATURES = previousFeatures;
});

const isLondon = s => s.category === 'west-end' || s.category === 'off-west-end';

test('archive predicates exclude opera at every London category', () => {
  for (const category of ['west-end', 'off-west-end']) {
    assert.equal(belongsOnWestEndArchive({ category, type: 'opera' }), false);
    assert.equal(belongsOnOffWestEndArchive({ category, type: 'opera' }), false);
    assert.equal(belongsOnWestEndArchive({ category, type: 'play' }), true);
  }
  assert.equal(belongsOnOffWestEndArchive({ category: 'off-west-end', type: 'musical' }), true);
  assert.equal(belongsOnOffWestEndArchive({ category: 'west-end', type: 'special', genre: 'dance' }), true);
  for (const f of ['generate-west-end-archive.js', 'generate-off-west-end-archive.js']) {
    const src = fs.readFileSync(new URL(`../../scripts/${f}`, import.meta.url), 'utf8');
    assert.match(src, /belongsToMarket: belongsOn(Off)?WestEndArchive/, f);
  }
});

test('London listings hold no opera; real London opera exists', () => {
  const londonOpera = core.getOperaShows().filter(isLondon);
  assert.ok(londonOpera.length > 0, 'real ENO / ROH cases exist');
  for (const s of [...core.getWestEndShows(), ...core.getOffWestEndShows(), ...core.getAllLondonShows()]) {
    assert.notEqual(s.type, 'opera', s.id);
  }
});

test('/west-end lists no opera and gives it its own section below Best Off-West End', () => {
  const tree = WestEndPage();
  const elements = [];
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node?.props) return;
    elements.push(node);
    walk(node.props.children);
  })(tree);
  const client = elements.find(node => node.props.marketOpenCounts);
  assert.ok(client, 'found WestEndPageClient props');
  for (const key of ['shows', 'lotteryShows', 'rushShows', 'beyondLondonShows']) {
    for (const show of client.props[key] || []) assert.notEqual(show.type, 'opera', `${key}: ${show.id}`);
  }
  const expected = core.getOperaShows().filter(s => isLondon(s) && s.status !== 'closed').map(s => s.id).sort();
  const got = client.props.operaShows.map(s => s.id);
  assert.ok(got.length > 0, 'opera section has shows');
  assert.equal(got.length, Math.min(expected.length, SHELF_MAX_ITEMS));
  for (const id of got) assert.ok(expected.includes(id), id);
  const clientSrc = fs.readFileSync(new URL('../../src/components/WestEndPageClient.tsx', import.meta.url), 'utf8');
  const bestOwe = clientSrc.indexOf('title="Best Off-West End"');
  const opera = clientSrc.indexOf('title="Opera in London"');
  assert.ok(bestOwe > 0 && opera > bestOwe, 'opera section sits below Best Off-West End');
});

test('London opera show pages read as Opera in the nav, not West End', () => {
  for (const s of core.getOperaShows().filter(isLondon)) {
    const path = `/show/${s.slug}`;
    assert.ok(isOperaShowPath(path), `${s.id} missing from OPERA_SHOW_ID_PREFIXES`);
    // The URL still says west-end; MarketNav must override it for opera pages.
    assert.ok(['west-end', 'off-west-end'].includes(getMarketFromPath(path)), path);
  }
  const nav = fs.readFileSync(new URL('../../src/components/MarketNav.tsx', import.meta.url), 'utf8');
  assert.match(nav, /const isWestEnd = \(marketId === 'west-end' \|\| isUkRegional\) && !isOperaShowPage/);
  assert.match(nav, /const isOffWestEnd = marketId === 'off-west-end' && !isOperaShowPage/);
});

test('/west-end/audience-buzz uses the opera-free West End listing', () => {
  const src = fs.readFileSync(new URL('../../src/app/west-end/audience-buzz/page.tsx', import.meta.url), 'utf8');
  assert.match(src, /getWestEndShows\(\)\.filter/);
  assert.doesNotMatch(src, /getAllShows\(\)/);
});
