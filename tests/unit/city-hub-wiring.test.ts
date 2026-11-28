// LIVE-DATA-LANE: reads data/venue-metros.json (read by the test); data/city-hubs.json (read by the test). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
/**
 * City hubs on rails (BRO-6833): every city in data/city-hubs.json is fully wired from
 * that one entry. A new US city is the registry entry plus a data/venue-metros.json place
 * (and the app's CITY_MARKETS entry); this pins the rest so a half-wired city fails here
 * instead of silently dropping out of the menu, the app or the local-only filter.
 *
 * Run: npx tsx --test tests/unit/city-hub-wiring.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ALL_HUB_CITIES, HUB_CITIES } from '../../src/lib/city-hub';
import { isLocalOnlyShow, LOCAL_DISCOVERY_SOURCES } from '../../src/lib/local-market';

const require = createRequire(import.meta.url);
const root = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const metros = JSON.parse(read('data/venue-metros.json'));
const { getCity, CITIES } = require('../../scripts/lib/tic-cities.js');
const { resolveMetro } = require('../../scripts/lib/venue-metro.js');
const jsLocal = require('../../scripts/lib/local-market.js');
const registry = JSON.parse(read('data/city-hubs.json')).hubs as Record<string, any>;

test('registry schema: launched is an explicit boolean; tic keys are known (a typo would silently disable a filter)', () => {
  const ticKeys = new Set(['key', 'base', 'host', 'files', 'since', 'tourHouses', 'venueCities', 'requireMetro', 'minOutlets', 'allowTypes']);
  for (const [slug, h] of Object.entries(registry)) {
    assert.equal(typeof h.launched, 'boolean', `${slug}.launched must be an explicit boolean`);
    for (const k of Object.keys(h.tic || {})) assert.ok(ticKeys.has(k), `${slug}.tic.${k} is not a known key`);
  }
});

test('registry has at least Chicago and DC, and HUB_CITIES is exactly the launched subset', () => {
  assert.ok(ALL_HUB_CITIES['chicago-il'] && ALL_HUB_CITIES['washington-dc']);
  assert.deepEqual(Object.keys(HUB_CITIES), Object.keys(ALL_HUB_CITIES).filter(s => registry[s].launched !== false));
});

for (const [slug, hub] of Object.entries(ALL_HUB_CITIES)) {
  test(`${slug}: venue-metros place, local-market source, display fields`, () => {
    assert.ok(metros.metros[slug], `${slug}: no metro in data/venue-metros.json`);
    assert.equal(metros.metros[slug].country, 'US');
    assert.equal(resolveMetro(`Some Theatre, ${hub.home}`), slug, `${slug}: a venue ending "${hub.home}" must resolve to it`);
    assert.ok(hub.discoverySource, 'discoverySource');
    assert.ok(LOCAL_DISCOVERY_SOURCES.includes(hub.discoverySource), 'TS local-market list');
    assert.ok(jsLocal.LOCAL_DISCOVERY_SOURCES.includes(hub.discoverySource), 'JS local-market list');
    assert.equal(isLocalOnlyShow({ discoverySource: hub.discoverySource }), true);
    for (const f of ['name', 'short', 'home', 'emoji', 'cardLabel', 'menuSub', 'appMarket'] as const) assert.ok(hub[f], `${slug}.${f}`);
    assert.ok(hub.home.endsWith(', ' + hub.home.split(', ').pop()), 'home is "City, ST"');
  });

  test(`${slug}: Theatre Limelight config resolves to this metro and discovery source`, () => {
    const tic = registry[slug].tic;
    if (!tic) return; // non-Limelight city: discovery is its own scraper
    const c = getCity(tic.key);
    assert.equal(c.metro, slug);
    assert.equal(c.discoverySource, hub.discoverySource);
    assert.ok(c.files.seen && c.files.added, 'audit files');
    if (c.requireMetro) assert.ok(c.venueCities?.length, 'requireMetro needs venueCities');
  });
}

test('Limelight hosts, keys and audit files never collide across cities', () => {
  const all = Object.values(CITIES) as any[];
  for (const k of ['key', 'host']) assert.equal(new Set(all.map(c => c[k])).size, all.length, k);
  const files = all.flatMap(c => [c.files.seen, c.files.added]);
  assert.equal(new Set(files).size, files.length, 'audit files');
});

test('menu, footer and stats are driven by the registry: no hand-wired city slug left in them', () => {
  const surfaces = ['src/components/MarketNav.tsx', 'src/components/FooterExploreCards.tsx', 'src/components/FooterMarketContent.tsx', 'src/lib/data-core.ts'];
  for (const f of surfaces) {
    const text = read(f);
    for (const slug of Object.keys(ALL_HUB_CITIES)) assert.ok(!text.includes(slug), `${f} hard-codes ${slug}; use HUB_CITIES`);
  }
  assert.match(read('src/components/MarketNav.tsx'), /HUB_CITIES/);
  assert.match(read('src/components/FooterExploreCards.tsx'), /HUB_CITIES/);
  assert.match(read('src/components/FooterMarketContent.tsx'), /HUB_CITIES/);
  assert.match(read('src/lib/data-core.ts'), /Object\.keys\(HUB_CITIES\)/);
});

test('feed writes the city slug for launched registry cities only', () => {
  const gen = read('scripts/generate-mobile-data.js');
  assert.match(gen, /entry\.cy = show\.city/);
  assert.match(gen, /city-hubs\.json/);
});

// The app repo is not in CI; locally (and in headless sessions) it sits beside the web checkout.
const appFile = [path.join(os.homedir(), 'BroadwayScorecard-app'), path.join(root, '..', 'BroadwayScorecard-app')]
  .map(d => path.join(d, 'lib', 'market-filter.ts')).find(f => fs.existsSync(f));
test('app: every launched web hub slug has a CITY_MARKETS entry (skipped without the app checkout)', { skip: !appFile }, () => {
  const app = fs.readFileSync(appFile!, 'utf8');
  for (const [slug, hub] of Object.entries(HUB_CITIES)) {
    assert.match(app, new RegExp(`${hub.appMarket}:\\s*\\{\\s*slug:\\s*'${slug}'`), `${slug}: app CITY_MARKETS.${hub.appMarket}`);
  }
});

test('a staged city can only be dry-run (a real tic-daily run would write its shows)', () => {
  const { assertRunnable } = require('../../scripts/lib/tic-cities.js');
  const staged = Object.entries(registry).find(([, h]) => h.launched === false && h.tic);
  if (!staged) return;
  const city = getCity(staged[1].tic.key);
  assert.throws(() => assertRunnable(city, false), /staged/);
  assert.doesNotThrow(() => assertRunnable(city, true));
  assert.doesNotThrow(() => assertRunnable(getCity('chicago'), false));
});

test('deploy gate and CI watch the registry file', () => {
  assert.match(read('scripts/lib/should-deploy-gate.js'), /data\/city-hubs\.json/);
  assert.match(read('.github/workflows/test.yml'), /data\/city-hubs\.json/);
});

test('every tic-cities venueCities entry resolves to its metro (else requireMetro silently drops those houses)', () => {
  for (const c of Object.values(CITIES) as any[]) {
    for (const v of c.venueCities || []) {
      assert.equal(resolveMetro(`Some Theatre, ${v}`), c.metro, `${v} must resolve to ${c.metro} in data/venue-metros.json places`);
    }
  }
});

test('opening digest and outlet-metro are hand-wired per city: every launched slug appears in both', () => {
  const digest = read('scripts/send-opening-digest.js');
  const outlet = read('src/lib/outlet-metro.ts');
  for (const slug of Object.keys(HUB_CITIES)) {
    assert.ok(digest.includes(`'${slug}'`), `scripts/send-opening-digest.js must mention '${slug}' (CITY_REGIONS / REGION_BRAND)`);
    assert.ok(outlet.includes(`'${slug}'`) || outlet.includes(`${slug}:`) , `src/lib/outlet-metro.ts REGION_METRO must map a region to ${slug}`);
  }
});
