'use strict';

// Card #1919 review (Codex adversarial pass): the first version of this
// sampler checked out the private core-data repo (a new secret dependency,
// and a hard failure there would red the whole per-deploy Lighthouse gate —
// see checkout-core-data/action.yml's canary `exit 1`) just to pick 1-2 show
// slugs. That also risked sampling a slug not yet in the deployed build.
// Reading the LIVE sitemap instead guarantees every picked slug is an
// actually-deployed route and needs no private-repo access at all.

const { fetchSitemapIndexUrls } = require('./sitemap-urls');

const SHOW_LOC_RE = /<loc>https?:\/\/[^/]+\/show\/([^<\/]+)<\/loc>/g;

/**
 * Pure: extract show slugs from one sitemap shard's raw XML.
 * @param {string} xml
 * @returns {string[]}
 */
function extractShowSlugs(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const slugs = [];
  for (const match of xml.matchAll(SHOW_LOC_RE)) slugs.push(match[1]);
  return slugs;
}

/**
 * Fetches every sitemap shard listed in robots.txt and returns the union of
 * show slugs found across them, sorted for a stable rotation order. Returns
 * [] on any failure — callers must decide their own fallback.
 * @param {string} [siteUrl]
 * @returns {Promise<string[]>}
 */
async function fetchLiveShowSlugs(siteUrl) {
  try {
    const shardUrls = await fetchSitemapIndexUrls(siteUrl);
    if (shardUrls.length === 0) return [];
    const shardXmls = await Promise.all(
      shardUrls.map(url => fetch(url).then(res => (res.ok ? res.text() : null)).catch(() => null))
    );
    const slugs = new Set();
    for (const xml of shardXmls) {
      for (const slug of extractShowSlugs(xml)) slugs.add(slug);
    }
    return [...slugs].sort();
  } catch {
    return [];
  }
}

module.exports = { extractShowSlugs, fetchLiveShowSlugs };
