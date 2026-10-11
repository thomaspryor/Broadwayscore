// Tests for opening-date-sources.js — the per-market routing for where a
// missing openingDate should be filled from. Broadway has IBDB; the other three
// markets do not and each route to their own enricher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { OPENING_DATE_SOURCES, openingDateSourceHint, venuePageDomainSourceProblem } = require('./opening-date-sources.js');

test('every supported market maps to a source + enricher', () => {
  for (const market of ['broadway', 'off-broadway', 'west-end', 'off-west-end']) {
    assert.ok(OPENING_DATE_SOURCES[market], `${market} should be mapped`);
    assert.ok(OPENING_DATE_SOURCES[market].source, `${market} needs a source`);
    assert.ok(OPENING_DATE_SOURCES[market].enricher, `${market} needs an enricher`);
  }
});

test('only Broadway routes to IBDB; other markets must not', () => {
  assert.match(openingDateSourceHint('broadway'), /IBDB/);
  assert.match(openingDateSourceHint('broadway'), /enrich-ibdb-dates\.js/);
  for (const market of ['off-broadway', 'west-end', 'off-west-end']) {
    assert.doesNotMatch(openingDateSourceHint(market), /IBDB/, `${market} must not route to IBDB`);
  }
});

test('off-Broadway routes to Playbill/Show-Score enrichers', () => {
  const hint = openingDateSourceHint('off-broadway');
  assert.match(hint, /enrich-off-broadway-dates\.js/);
  assert.match(hint, /show-score/i);
});

test('west-end and off-west-end route to the WE enricher', () => {
  assert.match(openingDateSourceHint('west-end'), /enrich-west-end-dates\.js/);
  assert.match(openingDateSourceHint('off-west-end'), /enrich-west-end-dates\.js/);
});

test('unknown/missing market falls back to a generic manual-lookup hint', () => {
  assert.match(openingDateSourceHint('opera'), /manual/i);
  assert.match(openingDateSourceHint(undefined), /manual/i);
  // The fallback must never crash or return empty.
  assert.ok(openingDateSourceHint(null).length > 0);
});

// BRO-3793
test('venue-page:<domain> opening-date source is flagged, code-written forms are not', () => {
  for (const bad of ['venue-page:59e59.org', 'venue-page:https://59e59.org', 'venue-page: 59e59.org']) {
    assert.match(venuePageDomainSourceProblem({ openingDateSource: bad }), /web domain/, bad);
  }
  for (const ok of ['venue-page', 'venue-page:soho-playhouse', 'venue-page:the-other-palace', "venue-page:st.-ann's-warehouse", 'venue-page:a.r.t./new-york-theatres', 't2conline.com']) {
    assert.equal(venuePageDomainSourceProblem({ openingDateSource: ok }), null, ok);
  }
  assert.equal(venuePageDomainSourceProblem({}), null);
});
