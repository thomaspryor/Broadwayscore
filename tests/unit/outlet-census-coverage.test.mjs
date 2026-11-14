// BRO-7148: every repeat discovery-gap outlet (BRO-7145 audit) is either read by the poller's census
// listing reader or sits on this documented known-gap list. Requires the real census modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const census = require('../../scripts/lib/outlet-listing-census.js');

// Outlets whose reviews needed hand ingests because discovery missed them (BRO-7145).
const REPEAT_OUTLETS = ['guardian', 'new-york-sun', 'talkinbroadway', 'cititour', 'british-theatre', 'timeout-london'];

// Not readable by the poller yet, with the reason. Remove an entry when its source lands (the
// staleness test below fails if a listed outlet gains coverage).
const KNOWN_GAPS = {
  'new-york-sun': 'census source is paid Google (serp) only; the site has no free listing the census client can read',
  talkinbroadway: 'census source is paid Google (serp) only; no free listing probed',
  cititour: 'census source is paid Google (serp) only; no free listing probed',
  'british-theatre': 'sitemap is .xml.gz; the poller reads text only, gzip needs a buffer fetch',
  'timeout-london': 'sitemap is .xml.gz; the poller reads text only, gzip needs a buffer fetch',
};

test('every repeat outlet has census coverage or a documented known gap', () => {
  for (const id of REPEAT_OUTLETS) {
    const covered = !!census.censusSourceFor(id);
    assert.ok(covered || KNOWN_GAPS[id], `${id} has no census listing source and is not on KNOWN_GAPS`);
  }
});

test('known-gap list holds no covered outlet and no stray ids', () => {
  for (const id of Object.keys(KNOWN_GAPS)) {
    assert.ok(REPEAT_OUTLETS.includes(id), `${id} is on KNOWN_GAPS but not a repeat outlet`);
    assert.equal(census.censusSourceFor(id), null, `${id} is now covered: drop it from KNOWN_GAPS`);
  }
});

test('guardian is read via the Content API, observer.com is not', () => {
  assert.equal(census.censusSourceFor('guardian').kind, 'guardian-api');
  assert.equal(census.censusSourceFor('observer'), null);
});

const cutoff = new Date('2026-09-01T00:00:00Z');
const page = (results, pages = 1) => JSON.stringify({ response: { pages, results } });
const g = (slug, over = {}) => ({ webUrl: `https://www.theguardian.com/stage/2026/oct/01/${slug}`, webPublicationDate: '2026-10-01T10:00:00Z',
  webTitle: `${slug} review`, fields: { headline: `${slug} review – fine`, publication: 'theguardian.com' }, ...over });

test('guardian items: reviews kept, blog/observer/news dropped, key never leaks', async () => {
  const urls = [];
  const fetchText = async (u) => { urls.push(u); return page([g('hamlet'), g('x', { webUrl: 'https://www.theguardian.com/stage/theatreblog/2026/oct/01/x' }),
    g('y', { fields: { headline: 'Casting news', publication: 'theguardian.com' }, webTitle: 'Casting news' }), g('z', { fields: { headline: 'z review', publication: 'The Observer' } })]); };
  const items = await census.enumerateCensusItems('guardian', cutoff, { fetchText, log: () => {}, env: { GUARDIAN_API_KEY: 'sekrit' } });
  assert.deepEqual(items.map((i) => i.url), ['https://www.theguardian.com/stage/2026/oct/01/hamlet']);
  assert.match(urls[0], /from-date=2026-09-01/);
  const boom = async (u) => { throw new Error(`HTTP 500 for ${u}`); };
  await assert.rejects(census.enumerateCensusItems('guardian', cutoff, { fetchText: boom, log: () => {}, env: { GUARDIAN_API_KEY: 'sekrit' } }), (e) => !/sekrit/.test(e.message));
});

test('guardian without GUARDIAN_API_KEY reads nothing', async () => {
  let called = false;
  const items = await census.enumerateCensusItems('guardian', cutoff, { fetchText: async () => { called = true; return '{}'; }, log: () => {}, env: {} });
  assert.deepEqual(items, []);
  assert.equal(called, false);
});
