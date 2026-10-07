/**
 * Shared helper for resolving the site's sitemap shard URLs.
 *
 * The sitemap is sharded via Next's generateSitemaps() (src/app/sitemap.ts),
 * which emits /sitemap/0.xml … /sitemap/N.xml — there is NO /sitemap.xml index
 * under static export. The published list of shards lives in robots.txt, which
 * src/app/robots.ts derives from SITEMAP_SHARDS. Rather than duplicate the shard
 * list (and risk drift), runtime scripts read robots.txt and parse its
 * `Sitemap:` lines. robots.txt is the single source of truth.
 *
 * History: GSC + several discovery scripts hardcoded /sitemap.xml, which 404s.
 * GSC fetched the 404 page from 2026-04-16 (errors:1, contents:None) and the
 * deploy-time re-submission kept re-adding the dead URL. See robots.ts.
 */

const DEFAULT_SITE = 'https://broadwayscorecard.com';

/**
 * Parse `Sitemap:` directives out of a robots.txt body.
 * Pure function (no I/O) so it's unit-testable.
 * @param {string} robotsText
 * @returns {string[]} absolute sitemap URLs in file order
 */
function parseSitemapLines(robotsText) {
  if (!robotsText || typeof robotsText !== 'string') return [];
  return [...robotsText.matchAll(/^[ \t]*Sitemap:[ \t]*(\S+)/gim)].map(m => m[1].trim());
}

/**
 * Fetch the published sitemap shard URLs from the live robots.txt.
 * Returns [] on any failure — callers must decide their own fallback rather
 * than silently re-submitting a hardcoded (possibly dead) URL.
 * @param {string} [siteUrl] base origin, no trailing slash required
 * @returns {Promise<string[]>}
 */
async function fetchSitemapIndexUrls(siteUrl = DEFAULT_SITE) {
  const base = siteUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/robots.txt`);
    if (!res.ok) return [];
    return parseSitemapLines(await res.text());
  } catch {
    return [];
  }
}

module.exports = { parseSitemapLines, fetchSitemapIndexUrls, DEFAULT_SITE };
