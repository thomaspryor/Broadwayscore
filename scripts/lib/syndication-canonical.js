'use strict';

/**
 * syndication-canonical.js — canonical-source extraction for syndicated
 * reprints (BRO-3188).
 *
 * The Independent's Man to Man review (2026-09-12) was invisible to discovery:
 * its outlet RSS, every roundup and 10 monitor passes missed it. The only SERP
 * signal was a reprint on msnbctv.news. Syndication portals are never the
 * review's outlet, so a hit on one is an EXTRACTION input: fetch it, read
 * rel=canonical / og:url, else the first in-body link to a registered outlet,
 * and enqueue THAT url through normal ingestion + guards.
 *
 * Pure extraction (extractCanonicalSourceUrl) + a thin fetch wrapper
 * (resolveSyndicatedHit). Consumer: discover-opening-night-reviews.js.
 */

// Hosts whose pages republish other outlets' copy. review-normalization's
// SYNDICATION_PORTAL_HOSTS (yahoo/msn/aol.com) is the resolver-side list;
// this one adds the reprint farms and feed readers seen in SERP.
const SYNDICATION_HOSTS = Object.freeze([
  'msn.com', 'msnbctv.news', 'aol.com', 'aol.co.uk', 'yahoo.com',
  'news.google.com', 'apple.news',
]);

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/\.+$/, '').replace(/^www\./, ''); } catch { return ''; }
}

function hostMatches(host, domain) {
  return !!host && !!domain && (host === domain || host.endsWith('.' + domain));
}

function isSyndicationHost(url) {
  const h = hostOf(url);
  return SYNDICATION_HOSTS.some((d) => hostMatches(h, d));
}

function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&#38;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`(?<![\\w-])${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>"']+))`, 'i'));
  if (!m) return null;
  return decodeEntities(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]);
}

function absolutize(href, base) {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.search = ''; // tracking params; keeps dedupe against stored URLs exact
    u.hash = '';
    return u.href;
  } catch { return null; }
}

/**
 * @param {string} html reprint page HTML
 * @param {string} pageUrl the syndicator URL (base for relative links)
 * @param {{isRegisteredOutletUrl: (url: string) => boolean, isRejectedUrl?: (url: string) => boolean}} opts
 * @returns {{url: string, via: 'canonical'|'og:url'|'body-link'} | null}
 */
function extractCanonicalSourceUrl(html, pageUrl, opts) {
  // A bare host or one-segment path is a homepage/section, not an article.
  const isArticlePath = (u) => new URL(u).pathname.split('/').filter(Boolean).length >= 2;
  const ok = (u) => !!u && !isSyndicationHost(u) && isArticlePath(u)
    && opts.isRegisteredOutletUrl(u) && !(opts.isRejectedUrl && opts.isRejectedUrl(u));
  const src = String(html || '').replace(/<!--[\s\S]*?-->/g, '');

  for (const tag of src.match(/<link\b[^>]*>/gi) || []) {
    if (!/\brel\s*=\s*["']?canonical\b/i.test(tag)) continue;
    const u = absolutize(attr(tag, 'href'), pageUrl);
    if (ok(u)) return { url: u, via: 'canonical' };
  }
  for (const tag of src.match(/<meta\b[^>]*>/gi) || []) {
    if (!/\b(property|name)\s*=\s*["']og:url["']/i.test(tag)) continue;
    const u = absolutize(attr(tag, 'content'), pageUrl);
    if (ok(u)) return { url: u, via: 'og:url' };
  }
  const body = src.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '');
  for (const tag of body.match(/<a\b[^>]*>/gi) || []) {
    const u = absolutize(attr(tag, 'href'), pageUrl);
    if (ok(u)) return { url: u, via: 'body-link' };
  }
  return null;
}

/**
 * Registered-outlet predicate over outlet-registry domains (url-discovery's
 * OUTLET_DOMAINS values + REGISTRY_DOMAIN_ALIASES keys).
 */
function makeRegisteredOutletPredicate(outletDomains, domainAliases) {
  const domains = new Set([
    ...Object.values(outletDomains || {}),
    ...Object.keys(domainAliases || {}),
  ].filter(Boolean).map((d) => String(d).toLowerCase().replace(/^www\./, '')));
  return (url) => {
    const h = hostOf(url);
    for (const d of domains) if (hostMatches(h, d)) return true;
    return false;
  };
}

/**
 * Resolve a SERP hit on a syndication host to its source outlet URL.
 * Non-syndication URLs return null (caller keeps its own URL). Fetch failures
 * return null: the hit stays rejected, never guessed.
 * @param {string} url
 * @param {{fetch: (url: string) => Promise<string>, isRegisteredOutletUrl: Function, isRejectedUrl?: Function}} deps
 */
async function resolveSyndicatedHit(url, deps) {
  if (!isSyndicationHost(url)) return null;
  let html;
  try { html = await deps.fetch(url); } catch { return null; }
  return extractCanonicalSourceUrl(html, url, deps);
}

module.exports = {
  SYNDICATION_HOSTS,
  isSyndicationHost,
  extractCanonicalSourceUrl,
  makeRegisteredOutletPredicate,
  resolveSyndicatedHit,
};
