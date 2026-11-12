// BRO-7401: the first pass missed Everything Theatre on 3 Off-West End openings because the registry
// said domain "everythingtheatre.co.uk" (no such host) while the real site is everything-theatre.co.uk.
// Every `site:<domain>` SERP query, domain->outlet lookup and domain-based coverage check used the dead
// host, so SERP returned 0 results and the outlet was only ever found by a later aggregator-gap audit.
// Class guard: an outlet's registry domain (or a domainAlias) must match the host of every feed, API or
// census source we poll for it. Pure data check, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const registry = JSON.parse(fs.readFileSync(new URL('../../data/outlet-registry.json', import.meta.url), 'utf8'));
const OUTLETS = registry.outlets || registry;
const poller = require('../../scripts/outlet-listing-poller.js');
const { LANE_FEEDS } = require('../../scripts/lib/opening-night-lane/lane-sources.js');
const census = require('../../scripts/lib/outlet-census-sources.js');

// Hosted-platform API gateways: the host says nothing about the outlet's own domain.
const PLATFORM_HOSTS = new Set(['public-api.wordpress.com']);
// Outlets whose feed lives on a hosting domain while the site answers on its own domain (checked, not drift).
const FEED_HOST_EXEMPT = { 'bobs-theater-blog': 'Blogger feed (gotham-playgoer.blogspot.com) behind the bobstheaterblog.com custom domain' };
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

function sourceUrls() {
  const out = [];
  for (const [id, c] of Object.entries(poller.OUTLET_STRATEGY_CONFIG)) if (c.url) out.push([id, c.url, 'poller']);
  for (const [id, c] of Object.entries(poller.WP_API_CONFIG)) if (c.apiBase) out.push([id, c.apiBase, 'poller-wp']);
  for (const f of LANE_FEEDS) out.push([f.outletId, f.url, 'lane']);
  for (const [id, c] of Object.entries({ ...census.SOURCES, ...census.LONDON_SOURCES })) {
    const u = c.url || c.apiBase;
    if (typeof u === 'string') out.push([id, u, 'census']);
  }
  return out;
}

test('every polled feed/API/census host matches the primary registry domain', () => {
  const bad = [];
  for (const [id, url, kind] of sourceUrls()) {
    const o = OUTLETS[id];
    const h = host(url);
    if (!o || !o.domain || !h || PLATFORM_HOSTS.has(h) || FEED_HOST_EXEMPT[id]) continue;
    // Primary domain only: site:<domain> SERP queries and domain lookups use it, not the aliases.
    const d = o.domain.replace(/^www\./, '');
    if (!(h === d || h.endsWith(`.${d}`) || d.endsWith(`.${h}`))) bad.push(`${id} (${kind}): feed host ${h}, registry primary domain ${d}`);
  }
  assert.deepEqual(bad, [], 'registry domain disagrees with the host we actually poll; site: SERP queries target the wrong host');
});

test('BRO-7401: Everything Theatre registry domain is the live host everything-theatre.co.uk', () => {
  const o = OUTLETS['everything-theatre'];
  assert.equal(o.domain, 'everything-theatre.co.uk');
  assert.ok((o.domainAliases || []).includes('everythingtheatre.co.uk'), 'old spelling stays an alias for URL resolution');
});
