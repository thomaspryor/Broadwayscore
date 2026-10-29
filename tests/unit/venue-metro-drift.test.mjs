// BRO-6515: data/venue-metros.json and data/uk-regional-venues.json must agree.
// Lives in tests/unit because it reads a data file outside scripts/lib.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveMetroInfo, TABLE } = require('../../scripts/lib/venue-metro.js');
const UK_VENUES = require('../../data/uk-regional-venues.json');

test('no drift: every data/uk-regional-venues.json entry resolves to a UK metro', () => {
  for (const v of UK_VENUES) {
    const info = resolveMetroInfo(`${v.venue}, ${v.city}`);
    assert.ok(info && info.country === 'UK', `${v.venue} unmapped`);
    for (const a of v.aliases) assert.equal(resolveMetroInfo(a)?.country, 'UK', `alias ${a}`);
  }
});

// Design review (BRO-6515): the site's UK classification (src/lib/market-utils.ts
// isUkRegionalShow, getMarketCountry) reads data/uk-regional-venues.json, so a
// UK house mapped here but missing there would get a UK city yet a US label
// and the Pre-Broadway shelf.
test('no drift: every UK venue here is a data/uk-regional-venues.json house', () => {
  const keys = UK_VENUES.flatMap((u) => [u.match, ...(u.aliases || [])]);
  for (const v of TABLE.venues) {
    if (TABLE.metros[v.metro].country !== 'UK') continue;
    const names = [v.venue, ...v.aliases].map((n) => n.toLowerCase());
    assert.ok(names.some((n) => keys.some((k) => n.includes(k))), `${v.venue} missing from uk-regional-venues.json`);
  }
});
