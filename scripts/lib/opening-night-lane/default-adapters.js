'use strict';
/**
 * Default discovery sources for the lane's configurable adapters (BRO-5993). Without them the RSS and section-index
 * adapters had no feeds and the SERP phase never ran (it needs missingOutlets), so the lane saw only what the
 * aggregators cited: the Oct 22 shadow run (The Imaginary Invalid) never found Vulture or the Chicago Tribune, which
 * neither BWW nor DTLI listed.
 *
 *   feeds:          the regular pipeline's outlet feeds (rss-discovery.js ALL_FEEDS) for the show's market
 *   missingOutlets: tier-1 then tier-2 outlets (data/outlet-registry.json) the lane searches for after +3h until it
 *                   has a review from each (discovery.js serpAllowed); London-only outlets are left out on Broadway
 *                   and US-only ones on the West End
 *
 * An explicit adapters config (--adapters=FILE) overrides either key.
 */

function laneMarket(show) {
  return /west[-\s]?end|london/i.test(String((show && (show.market || show.category)) || '')) ? 'west-end' : 'broadway';
}

function defaultFeeds(show) {
  const { ALL_FEEDS } = require('../rss-discovery');
  const market = laneMarket(show);
  return ALL_FEEDS.filter((f) => !f.market || f.market === market).map((f) => ({ url: f.url, outletId: f.outletId, name: f.name }));
}

function defaultMissingOutlets(show, registry = require('../../../data/outlet-registry.json')) {
  const market = laneMarket(show);
  const outlets = registry.outlets || registry;
  const fits = (o) => (market === 'west-end' ? ['london', 'dual'].includes(o.region) : o.region !== 'london');
  // One id per domain: sunday-times shares times-uk's domain, so its reviews resolve to times-uk and it could never
  // count as captured; it would be searched (a duplicate site: query) all night.
  const seenDomains = new Set();
  return Object.entries(outlets)
    .filter(([, o]) => o && (o.tier === 1 || o.tier === 2) && o.domain && fits(o))
    .sort(([, a], [, b]) => a.tier - b.tier)
    .filter(([, o]) => { const dom = String(o.domain).replace(/^www\./, '').toLowerCase(); if (seenDomains.has(dom)) return false; seenDomains.add(dom); return true; })
    .map(([id]) => id);
}

function laneAdaptersConfig(show, explicit = {}) {
  return { feeds: defaultFeeds(show), missingOutlets: defaultMissingOutlets(show), ...explicit };
}

module.exports = { laneMarket, defaultFeeds, defaultMissingOutlets, laneAdaptersConfig };
