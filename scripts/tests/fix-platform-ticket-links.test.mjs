// scripts/tests/fix-platform-ticket-links.test.mjs
//
// Regression guard for the a-christmas-carol-west-end-2026 clobber (2026-08-05
// and again 2026-08-07): fix-platform-ticket-links.js's SERP re-verify replaced
// a verified ticketmaster.co.uk link on a west-end show with the US
// "A Christmas Carol (NY)" artist page — twice — because its matcher only
// recognized ticketmaster.com and never region-checked candidates. Per
// CLAUDE.md §15 this require()s the REAL matcher, not a copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { matchTicketmasterFromResults } = require('../fix-platform-ticket-links.js');

const WEST_END_SHOW = { id: 'a-christmas-carol-west-end-2026', market: 'west-end', title: 'A Christmas Carol' };
const BROADWAY_SHOW = { id: 'a-christmas-carol-2026', market: 'broadway', title: 'A Christmas Carol' };

const US_RESULT = {
  url: 'https://www.ticketmaster.com/a-christmas-carol-ny-tickets/artist/2923062',
  title: 'A Christmas Carol (NY) Tickets | Ticketmaster',
};
const UK_RESULT = {
  url: 'https://www.ticketmaster.co.uk/a-christmas-carol-tickets/artist/890378',
  title: 'A Christmas Carol Tickets | Ticketmaster UK',
};
const UK_EXISTING = 'https://www.ticketmaster.co.uk/a-christmas-carol-tickets/artist/890378';

test('west-end show: US ticketmaster.com SERP result is REJECTED (the 2x real clobber)', () => {
  const r = matchTicketmasterFromResults([US_RESULT], WEST_END_SHOW.title, UK_EXISTING, WEST_END_SHOW);
  assert.equal(r, null, 'a US artist page must never replace a UK link on a west-end show');
});

test('broadway show: US ticketmaster.com SERP result is still accepted', () => {
  const r = matchTicketmasterFromResults([US_RESULT], BROADWAY_SHOW.title, 'https://www.ticketmaster.com/old-url/event/1', BROADWAY_SHOW);
  assert.ok(r && r.status === 'updated', 'US result should update a US show');
  assert.equal(r.newUrl, US_RESULT.url);
});

test('west-end show: ticketmaster.co.uk SERP result is accepted and www-normalized', () => {
  const bare = { url: 'https://ticketmaster.co.uk/a-christmas-carol-tickets/artist/890378', title: UK_RESULT.title };
  const r = matchTicketmasterFromResults([bare], WEST_END_SHOW.title, 'https://www.ticketmaster.co.uk/stale/artist/1', WEST_END_SHOW);
  assert.ok(r && r.status === 'updated');
  assert.equal(r.newUrl, UK_EXISTING);
});

test('west-end show: existing verified UK link confirms ok against its own SERP result', () => {
  const r = matchTicketmasterFromResults([UK_RESULT], WEST_END_SHOW.title, UK_EXISTING, WEST_END_SHOW);
  assert.ok(r && r.status === 'ok', 'identical verified link should confirm, not churn');
});

test('mixed results: region-mismatched US hit is skipped in favor of the UK hit', () => {
  const r = matchTicketmasterFromResults([US_RESULT, UK_RESULT], WEST_END_SHOW.title, 'https://www.ticketmaster.co.uk/stale/artist/1', WEST_END_SHOW);
  assert.ok(r && r.status === 'updated');
  assert.equal(r.newUrl, UK_EXISTING);
});
