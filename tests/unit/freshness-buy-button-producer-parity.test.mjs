// BRO-7437 class guard: "Data freshness: shows missing poster/synopsis/tickets"
// was filed three times in 30 days (BRO-5455, BRO-7368, BRO-7412). ~80 of the
// ~100 open shows it flagged for missing tickets were category 'regional', and
// two halves of the system disagreed about them:
//   1. the "never dead-end" producer (ob-discovery-ticket-links.js, BRO-166)
//      only targeted off-broadway/off-west-end, so no regional row ever got
//      the venue link the owner ruled acceptable on 2026-08-04;
//   2. the freshness check ignored officialUrl, which the site renders as the
//      buy button, so even rows that producer DID fill stayed high-severity.
// These tests require the real functions (CLAUDE.md rule 15) and fail if
// either half regresses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkShowCompleteness, hasOfficialSiteButton } = require('../../scripts/check-show-freshness.js');
const { findDeadEndShows, venueFallbackUrl, usesSerpDiscovery, TARGET_CATEGORIES } = require('../../scripts/lib/ob-ticket-link-gaps.js');
const { REGIONAL_VENUE_SITES } = require('../../scripts/lib/ticket-link-discovery.js');

const highTypes = (show) => checkShowCompleteness(show, {}, {}).filter((i) => i.severity === 'high').map((i) => i.type);
const types = (show) => checkShowCompleteness(show, {}, {}).map((i) => i.type);

const regional = (o = {}) => ({
  id: 'present-laughter-royal-bath-regional-2026',
  title: 'Present Laughter',
  category: 'regional',
  status: 'open',
  venue: 'Theatre Royal Bath, Bath',
  ...o,
});

test('freshness: an open show whose only buy button is officialUrl is not a high missing_tickets gap', () => {
  const s = regional({ officialUrl: 'https://theatreroyal.org.uk/' });
  assert.ok(!highTypes(s).includes('missing_tickets'));
  assert.ok(types(s).includes('tickets_official_site_only'), 'stays visible as a medium gap');
});

test('freshness: no ticketLinks and no officialUrl is still a high missing_tickets gap', () => {
  assert.ok(highTypes(regional()).includes('missing_tickets'));
  assert.ok(highTypes(regional({ officialUrl: '' })).includes('missing_tickets'));
  assert.ok(highTypes(regional({ officialUrl: 'not a url' })).includes('missing_tickets'));
  assert.equal(hasOfficialSiteButton({ officialUrl: 'javascript:alert(1)' }), false);
});

test('freshness: a real ticket link is not flagged at all', () => {
  const t = types(regional({ ticketLinks: [{ platform: 'Venue Box Office', url: 'https://x/y' }], officialUrl: 'https://x/' }));
  assert.ok(!t.includes('missing_tickets') && !t.includes('tickets_official_site_only'));
});

test('producer: regional is a target category of the never-dead-end fallback', () => {
  assert.ok(TARGET_CATEGORIES.has('regional'));
  assert.deepEqual(findDeadEndShows([regional()]).map((s) => s.id), [regional().id]);
  assert.deepEqual(findDeadEndShows([regional({ officialUrl: 'https://a/' })]), []);
  assert.deepEqual(findDeadEndShows([regional({ status: 'closed' })]), []);
});

test('producer: a regional show at a registry venue gets that venue site; no SERP', () => {
  assert.equal(usesSerpDiscovery(regional()), false);
  assert.equal(venueFallbackUrl(regional(), [], []), 'https://theatreroyal.org.uk/');
  assert.equal(venueFallbackUrl(regional({ venue: 'Theater Wit, Chicago, IL' }), [], []), 'https://theaterwit.org/');
});

test('producer: an unknown regional venue gets nothing, and NY/London configs are never used for regional', () => {
  const nyConfigs = [{ name: 'Irish Repertory Theatre', url: 'https://irishrep.org/' }];
  assert.equal(venueFallbackUrl(regional({ venue: 'Irish Repertory Theatre, Dublin' }), nyConfigs, nyConfigs), null);
  assert.equal(venueFallbackUrl(regional({ venue: 'Some Fringe Room, Leeds' }), [], []), null);
});

test('producer: every regional registry venue resolves to its own host (round trip)', () => {
  for (const v of REGIONAL_VENUE_SITES) {
    const url = venueFallbackUrl(regional({ venue: `${v.venue}, Somewhere` }), [], []);
    assert.equal(url, `https://${v.host}/`, v.host);
  }
});

test('end to end: what the producer writes clears the high-severity freshness gap', () => {
  const s = regional();
  assert.ok(highTypes(s).includes('missing_tickets'));
  const [target] = findDeadEndShows([s]);
  target.officialUrl = venueFallbackUrl(target, [], []);
  assert.ok(!highTypes(target).includes('missing_tickets'));
});
