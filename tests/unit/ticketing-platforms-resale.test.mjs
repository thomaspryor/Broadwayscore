import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TICKETING_PLATFORMS, RESALE_HOSTS, platformForUrl, pickTicketUrl } =
  require('../../scripts/lib/ticket-link-discovery.js');

// First-party source audit: docs/ticketing-platforms-audit-bro-3699.md.
// Ticketmaster and See Tickets also offer resale, but sell primary inventory.
const auditedPrimary = [
  ['todaytix.com', 'TodayTix'],
  ['ticketmaster.com', 'Ticketmaster'],
  ['ticketmaster.co.uk', 'Ticketmaster'],
  ['telecharge.com', 'Telecharge'],
  ['ovationtix.com', 'OvationTix'],
  ['eventbrite.com', 'Eventbrite'],
  ['universe.com', 'Universe'],
  ['showclix.com', 'ShowClix'],
  ['ticketleap.com', 'TicketLeap'],
  ['seetickets.com', 'See Tickets'],
  ['ticketsource.co.uk', 'TicketSource'],
];
const show = { title: 'Audit Production', category: 'regional' };
const result = (url) => ({ url, title: show.title });
const primaryResult = result('https://ci.ovationtix.com/123/production/456');

test('every allowlisted platform has a primary-sales finding in the audit', () => {
  assert.deepEqual(
    TICKETING_PLATFORMS.map(({ host, platform }) => [host, platform]).sort(),
    [...auditedPrimary].sort(),
  );
  assert.equal(new Set(TICKETING_PLATFORMS.map(({ host }) => host)).size, TICKETING_PLATFORMS.length);
  for (const { host } of TICKETING_PLATFORMS) {
    assert.ok(!RESALE_HOSTS.includes(host), `${host} must not also be classified as resale-only`);
  }
});

for (const [host, platform] of auditedPrimary) {
  test(`${host} remains eligible for primary ticket discovery`, () => {
    for (const prefix of ['', 'www.']) {
      const url = `https://${prefix}${host}/event/audit-fixture`;
      assert.equal(platformForUrl(url), platform);
      assert.deepEqual(pickTicketUrl([result(url)], show), { url, platform });
    }
    const spoof = `https://${host}.example.org/event/audit-fixture`;
    assert.equal(platformForUrl(spoof), null);
    assert.equal(pickTicketUrl([result(spoof)], show), null);
  });
}

// Keep the original BRO-3636 regressions explicit so dropping one from the
// denylist cannot silently drop its test coverage too.
for (const host of new Set([...RESALE_HOSTS, 'gotickets.com', 'boxofficeticketsales.com'])) {
  test(`${host} resale results cannot win over primary inventory`, () => {
    assert.ok(RESALE_HOSTS.includes(host));
    for (const prefix of ['', 'www.', 'tickets.']) {
      const url = `https://${prefix}${host}/event/audit-fixture`;
      assert.equal(platformForUrl(url), null);
      assert.equal(pickTicketUrl([result(url)], show), null);
      assert.deepEqual(pickTicketUrl([result(url), primaryResult], show), {
        url: primaryResult.url, platform: 'OvationTix',
      });
    }
  });
}

for (const host of ['smarttix.com', 'ticketcentral.com']) {
  test(`${host} is no longer a verified theatre ticket seller`, () => {
    for (const prefix of ['', 'www.', 'tickets.']) {
      const url = `https://${prefix}${host}/event/audit-fixture`;
      assert.equal(platformForUrl(url), null);
      assert.equal(pickTicketUrl([result(url)], show), null);
      assert.deepEqual(pickTicketUrl([result(url), primaryResult], show), {
        url: primaryResult.url, platform: 'OvationTix',
      });
    }
  });
}
