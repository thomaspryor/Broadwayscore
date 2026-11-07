import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Module = require('node:module');
// Plain node is this card's acceptance runner. Load the real TS helpers with
// the installed dev dependency, without copying their implementation here.
const loader = require('ts-node').register({
  skipProject: true,
  transpileOnly: true,
  compilerOptions: { module: 'Node16', moduleResolution: 'Node16', target: 'ES2022' },
});
const resolveFilename = Module._resolveFilename;
let affiliate, tickets;
try {
  Module._resolveFilename = function (id, ...args) {
    const resolved = id === '@/config/affiliate-platforms.json'
      ? fileURLToPath(new URL('../../src/config/affiliate-platforms.json', import.meta.url))
      : id;
    return resolveFilename.call(this, resolved, ...args);
  };
  // Extensionless CommonJS imports resolve through the registered TS loader.
  affiliate = require('../../src/lib/affiliate-utils');
  tickets = require('../../src/lib/ticket-utils');
} finally {
  Module._resolveFilename = resolveFilename;
  loader.enabled(false);
}
const { venueFallbackUrl, findDeadEndShows } = require('../../scripts/lib/ob-ticket-link-gaps.js');

for (const [platform, url, isAffiliate] of [
  ['TodayTix', 'https://www.todaytix.com/london/shows/1-example', true],
  ['Ticketmaster', 'https://www.ticketmaster.com/example', true],
  ['SeatPlan', 'https://seatplan.com/london/example-tickets/', true],
  ['ATG Tickets', 'https://www.atgtickets.com/shows/example/', false],
  ['Telecharge', 'https://www.telecharge.com/example', false],
  ['Official Site', 'https://example.org/box-office', false],
]) {
  test(`${platform} clicks preserve the provider and its actual affiliate status`, () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const beacons = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { href: 'https://broadwayscorecard.com/show/example' },
        posthog: { get_distinct_id: () => 'test-visitor' },
      },
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { sendBeacon: (destination, body) => { beacons.push({ destination, body }); return true; } },
    });
    try {
      const built = affiliate.buildAffiliateUrl(url, platform, 'show');
      assert.equal(built.isAffiliate, isAffiliate);
      if (!isAffiliate) assert.equal(built.url, url);
      affiliate.trackTicketClick({
        showId: 'example', showName: 'Example', showStatus: 'open',
        platform, pageType: 'show', isAffiliate: built.isAffiliate,
      });
      assert.equal(beacons.length, 1);
      assert.equal(beacons[0].destination, '/ingest/capture/');
      const { event, properties } = JSON.parse(beacons[0].body);
      assert.equal(event, 'ticket_click');
      assert.equal(properties.platform, platform);
      assert.equal(properties.is_affiliate, isAffiliate);
      assert.equal(properties.show_id, 'example');
      assert.equal(properties.distinct_id, 'test-visitor');
      assert.equal(properties.page_type, 'show');
    } finally {
      delete globalThis.window;
      delete globalThis.navigator;
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    }
  });
}

test('non-TodayTix sellers remain available when they are the only buy path', () => {
  for (const platform of ['Ticketmaster', 'Telecharge', 'ATG Tickets', 'SeatPlan', 'Official Site']) {
    const link = { platform, url: 'https://example.org/tickets' };
    assert.deepEqual(tickets.sortTicketLinks([link]), [link]);
  }
  assert.deepEqual(tickets.sortTicketLinks([{ platform: 'StubHub', url: 'https://example.org/resale' }]), []);
});

const nyVenues = [{ name: 'Signature Theatre', url: 'https://signaturetheatre.org/productions/' }];
const londonVenues = [
  { name: 'Finborough Theatre', url: 'https://www.finboroughtheatre.co.uk/' },
  { name: 'Orange Tree Theatre', url: 'https://www.orangetreetheatre.co.uk/whats-on/' },
];

test('Off-West End dead ends use London venue box offices instead of the NY registry', () => {
  for (const [venue, expected] of [
    ['Finborough Theatre', 'https://www.finboroughtheatre.co.uk/'],
    ['Orange Tree Theatre', 'https://www.orangetreetheatre.co.uk/'],
  ]) {
    assert.equal(venueFallbackUrl({ category: 'off-west-end', venue }, nyVenues, londonVenues), expected);
  }
  assert.equal(venueFallbackUrl({ category: 'off-west-end', venue: 'Signature Theatre' }, nyVenues, londonVenues), null);
  assert.equal(venueFallbackUrl({ category: 'off-broadway', venue: 'Signature Theatre' }, nyVenues, londonVenues), 'https://signaturetheatre.org/');
});

test('fallback enrichment preserves existing ticket links, official sites and closed shows', () => {
  const base = { id: 'missing', category: 'off-west-end', status: 'open', venue: 'Finborough Theatre' };
  assert.deepEqual(findDeadEndShows([
    base,
    { ...base, id: 'ticketed', ticketLinks: [{ platform: 'SeatPlan', url: 'https://example.org/tickets' }] },
    { ...base, id: 'official', officialUrl: 'https://example.org/' },
    { ...base, id: 'closed', status: 'closed' },
  ]).map(s => s.id), ['missing']);
});

test('the scheduled writer supplies both venue registries to the shared fallback', () => {
  const writer = readFileSync(new URL('../../scripts/ob-discovery-ticket-links.js', import.meta.url), 'utf8');
  assert.match(writer, /venueFallbackUrl\(show,\s*OB_VENUE_CONFIGS,\s*loadLondonFallbackConfigs\(\)\)/);
  assert.match(writer, /londonReaderConfigs\(OWE_VENUE_CONFIGS,\s*require\('\.\/discover-new-shows'\)\.VENUE_LISTING_PAGES\)/);
});

test('London fallback also covers Off-West End link-reader venues outside OWE_VENUE_CONFIGS (BRO-5190)', () => {
  const { londonReaderConfigs } = require('../../scripts/lib/ob-venue-reader-coverage.js');
  const { OWE_VENUE_CONFIGS } = require('../../scripts/lib/venue-listing-discover.js');
  const { VENUE_LISTING_PAGES } = require('../../scripts/discover-new-shows.js');
  const london = londonReaderConfigs(OWE_VENUE_CONFIGS, VENUE_LISTING_PAGES);
  for (const [venue, expected] of [
    ['Marylebone Theatre', 'https://marylebonetheatre.com/'],
    ['The Other Palace', 'https://theotherpalace.co.uk/'],
    ['Finborough Theatre', 'https://www.finboroughtheatre.co.uk/'],
  ]) {
    assert.equal(venueFallbackUrl({ category: 'off-west-end', venue }, nyVenues, london), expected);
  }
  // A palace that is not The Other Palace must not borrow its box office.
  assert.equal(venueFallbackUrl({ category: 'off-west-end', venue: 'Alexandra Palace Theatre' }, nyVenues, london), null);
});
