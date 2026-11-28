import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { broadwayWebsites, venueList, publishVenueAccess } = require('../../scripts/lib/venue-access-publish');
const { accessibilityFor, sourcedAccessTips } = require('../../scripts/lib/venue-access-display');
const { buildMergedStructuredTips } = require('../../scripts/lib/theater-tips-merge');
const website = 'https://theatre.example/';
const key = 'broadway/example-theatre';
const quote = 'Wheelchair spaces are available in the orchestra.';
const answer = { wheelchair: { value: true, quote } };
const checkpoint = { gemini: answer, openai: answer, at: '2026-11-25T00:00:00Z' };
const sites = { [key]: { name: 'Example Theatre', website, how: { website: 'gemini+openai' }, sources: [website] } };
const pages = [{ url: website, text: quote }];

test('Broadway access targets use agreed websites and honor market, only and limit', () => {
  const info = { 'london/example': { name: 'London Example', fields: { website } } };
  const list = venueList(info, sites, { market: 'broadway', only: 'example-theatre', limit: 1 });
  assert.equal(list.length, 1);
  assert.equal(list[0].key, key);
  assert.equal(list[0].website, website);
  assert.equal(venueList(info, sites).length, 2);
  assert.equal(venueList(info, sites, { only: 'absent' }).length, 0);
});

test('only real houses with two-model websites enter research; published sites survive a missing checkpoint', () => {
  const meta = { _meta: {}, 'Example Theatre': {} };
  assert.deepEqual(broadwayWebsites(meta, {}, sites), sites);
  assert.deepEqual(broadwayWebsites(meta, { 'Example Theatre': { gemini: { website }, openai: { website: 'https://other.example/' } } }, sites), {});
  const raw = { 'Example Theatre': { gemini: { website, sources: [website] }, openai: { website }, at: checkpoint.at }, Ghost: checkpoint };
  assert.equal(Object.keys(broadwayWebsites(meta, raw)).length, 1);
});

test('Broadway publication retains the website AND applies the same quote gate to each fact', async () => {
  const venues = venueList({}, sites);
  const raw = { access: { [key]: checkpoint } };
  const good = await publishVenueAccess(venues, raw, async () => pages, sites);
  assert.equal(good.out[key].website, website);
  assert.equal(good.out[key].access.wheelchair, true);
  assert.deepEqual(good.out[key].access.evidence.wheelchair, { quote, url: website });
  assert.equal(good.out[key].access.sourceUrl, website);
  for (const [name, record, text] of [
    ['invented quote', checkpoint, 'Welcome to the theatre.'],
    ['disagreement', { ...checkpoint, openai: { wheelchair: { value: false, quote } } }, quote],
    ['missing second quote', { ...checkpoint, openai: { wheelchair: { value: true } } }, quote],
  ]) {
    const result = await publishVenueAccess(venues, { access: { [key]: record } }, async () => [{ url: website, text }], sites);
    assert.equal(result.out[key].access, undefined, name);
    assert.equal(result.out[key].website, website, name);
  }
});

test('all markets publish through the same gate; Broadway does not gain seat research', async () => {
  const keys = [key, 'off-broadway/example', 'london/example'];
  const venues = keys.map(key => ({ key, market: key.split('/')[0], name: 'Example', website }));
  const raw = { access: Object.fromEntries(keys.map(key => [key, checkpoint])), seats: { [key]: { seatplan: 'https://seatplan.com/new-york/example/' } } };
  const result = await publishVenueAccess(venues, raw, async () => pages, sites);
  assert.equal(Object.values(result.out).filter(v => v.access).length, 3);
  assert.equal(result.out[key].seatLinks, undefined);
});

test('gated access takes precedence, preserves explicit denials, and never fills unknowns from legacy', async () => {
  const legacy = { wheelchair: true, elevator: true, verified: true, sourceUrl: website };
  const denied = { elevator: { value: false, quote: 'There is no elevator in this theatre.' } };
  const built = await publishVenueAccess(venueList({}, sites), { access: { [key]: { ...checkpoint, gemini: denied, openai: denied } } }, async () => [{ url: website, text: denied.elevator.quote }], sites);
  const display = accessibilityFor(built.out[key], legacy);
  assert.equal(display.elevator, false);
  assert.deepEqual(display.denied, ['elevator']);
  assert.equal(display.wheelchair, false);
  assert.deepEqual(accessibilityFor(undefined, legacy), legacy);
  for (const sourceUrl of [undefined, '', ' ', 'javascript:alert(1)', 'not a url']) {
    assert.equal(accessibilityFor(undefined, { ...legacy, sourceUrl }), undefined);
    assert.equal(accessibilityFor({ access: { verified: true, wheelchair: true, sourceUrl } }), undefined);
  }
  assert.equal(accessibilityFor({ access: { verified: true, wheelchair: true, sourceUrl: website } }), undefined, 'missing evidence');
});

test('unsourced legacy access cannot reappear through seating tips', () => {
  const tips = { seating: { bestSeats: 'Center', accessibility: 'Unsupported note', sections: [{ name: 'Orchestra' }] }, parking: { tip: 'Nearby' } };
  const cleaned = sourcedAccessTips(tips, undefined);
  assert.equal(cleaned.seating.accessibility, undefined);
  assert.equal(cleaned.seating.bestSeats, 'Center');
  assert.deepEqual(cleaned.seating.sections, tips.seating.sections);
  assert.equal(tips.seating.accessibility, 'Unsupported note', 'does not mutate imported metadata');
  const built = buildMergedStructuredTips({ seating: { bestSeats: 'Center' } }, { accessibility: { verified: true, wheelchair: true }, structuredTips: tips });
  assert.equal(built.accessibilityInjected, false);
  assert.equal(built.structuredTips.seating.accessibility, undefined);
});


test('scoped backfills preserve other markets without fetching them and remove stale selected facts', async () => {
  const old = { ...sites, 'london/untouched': { name: 'Untouched', access: { wheelchair: true } } };
  old[key] = { ...sites[key], access: { wheelchair: true } };
  const rejected = { 'london/untouched': [{ reason: 'preserve' }], [key]: [{ reason: 'old' }] };
  let fetched = 0;
  const result = await publishVenueAccess(venueList({}, sites), { access: {} }, async () => { fetched++; return []; }, sites, old, rejected);
  assert.equal(fetched, 0);
  assert.deepEqual(result.out['london/untouched'], old['london/untouched']);
  assert.deepEqual(result.rejects['london/untouched'], rejected['london/untouched']);
  assert.equal(result.out[key].access, undefined);
  assert.equal(result.rejects[key], undefined);
  assert.ok(old[key].access, 'does not mutate existing publication');
});

test('BRO-8342: a hand-picked official page enters research when the models gave no host', () => {
  const sites = broadwayWebsites({ 'Hudson Theatre': {}, 'Other Theatre': {} }, {}, {}, { 'Hudson Theatre': 'https://us.atgtickets.com/venues/hudson-theatre-broadway/venue-info/' });
  assert.equal(sites['broadway/hudson-theatre'].website, 'https://us.atgtickets.com/venues/hudson-theatre-broadway/venue-info/');
  assert.equal(sites['broadway/other-theatre'], undefined);
});
