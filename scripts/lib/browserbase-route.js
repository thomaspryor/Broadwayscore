/**
 * Browserbase-first routing for outlets only Browserbase can fetch (BRO-5222).
 *
 * WSJ blocks CI IPs on most tiers; Browserbase (real browser + subscriber
 * login) is the route that works (125 stored WSJ texts over 1500 chars came
 * from it, against 16 from Bright Data). The New Yorker is not listed: its
 * texts come from archive.org and ScrapingBee, not Browserbase. The learned per-domain order in
 * scripts/config/domain-tier-order.json is regenerated weekly from attempt
 * stats and, for wsj.com, lost Browserbase: a day of capped runs records no
 * Browserbase successes, so the next regeneration ranks it out. Bright Data
 * then used the whole 90s per-review budget and Browserbase never ran. The
 * pin lives in code so a regeneration cannot undo it.
 */
'use strict';

const BROWSERBASE_FIRST_DOMAINS = Object.freeze(['wsj.com']);
/** Free, fast tiers allowed to stay ahead of Browserbase (36 WSJ texts via cookies). */
const AHEAD_OF_BROWSERBASE = Object.freeze(['direct-cookies']);

/**
 * @param {string} hostname - e.g. 'www.wsj.com', 'online.wsj.com'
 * @returns {boolean}
 */
function isBrowserbaseFirstDomain(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  return BROWSERBASE_FIRST_DOMAINS.some(d => host === d || host.endsWith('.' + d));
}

/**
 * For a Browserbase-first domain, move the browserbase tier to the front of
 * the chain, behind only the free AHEAD_OF_BROWSERBASE tiers already leading
 * it. If the skip list removed browserbase, it is taken back from builtChain
 * (the chain before reorder/skip). Other domains: unchanged.
 *
 * @param {Array<{id: string}>} chain - tier chain after reorder and skip
 * @param {string} hostname
 * @param {Array<{id: string}>} [builtChain] - tier chain as first built
 * @returns {Array<{id: string}>}
 */
function pinBrowserbaseFirst(chain, hostname, builtChain = chain) {
  if (!isBrowserbaseFirstDomain(hostname)) return chain;
  const tier = chain.find(t => t.id === 'browserbase') || (builtChain || []).find(t => t.id === 'browserbase');
  if (!tier) return chain;
  const rest = chain.filter(t => t.id !== 'browserbase');
  let lead = 0;
  while (lead < rest.length && AHEAD_OF_BROWSERBASE.includes(rest[lead].id)) lead++;
  return [...rest.slice(0, lead), tier, ...rest.slice(lead)];
}

module.exports = { BROWSERBASE_FIRST_DOMAINS, isBrowserbaseFirstDomain, pinBrowserbaseFirst };
