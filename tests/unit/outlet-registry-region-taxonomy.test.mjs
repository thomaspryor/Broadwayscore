import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const registry = require('../../data/outlet-registry.json');
const { outletFieldShapeErrors } = require('../../scripts/lib/outlet-registry-field-shape.js');
const {
  buildOutletMaps, isBroadwayLocalRegion, isWestEndLocalRegion, US_SERP_REGIONS,
} = require('../../scripts/lib/outlet-region-map.js');

test('the real registry uses only canonical region values', () => {
  const errors = Object.entries(registry.outlets)
    .flatMap(([id, entry]) => outletFieldShapeErrors(id, entry));
  assert.deepEqual(errors, []);
});

test('the registration validator rejects duplicate spellings and unknown regions', () => {
  for (const region of ['new-york', 'dc', 'NYC', 'national', 'unknown-city', '', null, 123]) {
    const errors = outletFieldShapeErrors('example', { region });
    assert.equal(errors.length, 1, `region=${JSON.stringify(region)} must fail`);
    assert.match(errors[0], /region=.*must be one of/);
  }
});

test('canonical city, country and dual regions validate; an absent region remains valid', () => {
  for (const region of ['nyc', 'us', 'london', 'uk', 'dual', 'washington-dc', 'chicago', 'nj']) {
    assert.deepEqual(outletFieldShapeErrors('example', { region }), []);
  }
  assert.deepEqual(outletFieldShapeErrors('example', {}), []);
});

// Scope evidence checked 2026-10-18, from page text rather than URL metadata:
// Cititour's registered NYC edition describes five-borough coverage:
// https://cititour.com/About
// Culture Sauce's theater archive has Broadway and Off Broadway reviews,
// including Midnight and Memoirs of Amorous Gentlemen, October 15-16, 2026:
// https://culturesauce.com/
// Gothamist's publisher describes its NYC newsroom:
// https://wnyc.org/story/nypr-and-gothamist-are-mission-save-local-news/
test('confirmed NYC coverage uses nyc and stays discoverable on Broadway', () => {
  const { outletRegionMap } = buildOutletMaps(registry);
  for (const id of ['cititour', 'culturesauce', 'gothamist']) {
    assert.equal(registry.outlets[id].region, 'nyc', id);
    assert.equal(isBroadwayLocalRegion(outletRegionMap[id]), true, id);
    assert.equal(isWestEndLocalRegion(outletRegionMap[id]), false, id);
    assert.equal(US_SERP_REGIONS.has(registry.outlets[id].region), true, id);
  }
});

// The original card's remaining outlets are not NYC-only. Keep country-level
// us where coverage is broader or outside NYC; us does not imply NYC-only.
// BPN explicitly covers West Coast regional productions and national tours:
// https://broadwaypodcastnetwork.com/podcasts/west-of-broadway-podcast
// Forward's mission serves American Jews: https://forward.com/about-us/mission/
// Stage and Cinema lists Boston, Chicago, LA, DC and more: https://stageandcinema.com/
// 1 Minute Critic publishes Boston, Chicago and Tucson coverage: https://1minutecritic.com/
// NBC News is a national news brand: https://www.nbcuniversal.com/about
// Jitney explicitly covers West Palm Beach through Key West:
// https://jitneybooks.com/about-jitney-books/
// Huron Daily covers Michigan's Upper Thumb, not NYC:
// https://www.michigansthumb.com/news/article/Tribune-nbsp-now-offering-Insider-content-to-15475786.php
// Dance Magazine covers San Francisco Ballet: https://dancemagazine.com/
// Pointe covers Houston Ballet: https://pointemagazine.com/
// Front Mezz Junkies explicitly covers NY, London, Toronto and other cities:
// https://frontmezzjunkies.com/about/
test('multi-city, national and non-NYC outlets are not mechanically retagged nyc', () => {
  for (const id of [
    'broadwaypodcastnetwork', 'forward', 'stageandcinema', 'one-minute-critic',
    'nbcnews', 'jitney', 'huron-daily', 'dance-magazine', 'pointe-magazine', 'frontmezzjunkies',
  ]) {
    assert.equal(registry.outlets[id].region, 'us', id);
  }
});

test('DC outlets share one spelling and remain non-local to Broadway and the West End', () => {
  const { outletRegionMap } = buildOutletMaps(registry);
  for (const id of ['washingtoncitypaper', 'morris-theatre-dc', 'feature-presentation']) {
    assert.equal(registry.outlets[id].region, 'washington-dc', id);
    assert.equal(isBroadwayLocalRegion(outletRegionMap[id]), false, id);
    assert.equal(isWestEndLocalRegion(outletRegionMap[id]), false, id);
  }
});
