/**
 * SERP-based slug discovery for audience scrapers.
 *
 * When a scraper can't find a show via slug variants, this does a single
 * Google SERP query (site:platform.com "Show Title") to find the actual URL.
 * Extracts the slug from the first matching result.
 *
 * 2026-05-17: refactored to use the shared serpQuery() from url-discovery.js
 * so it inherits the 24h SERP cache (scripts/lib/serp-cache.js). Repeated
 * slug-discovery queries for the same show within 24h now skip the BD/SB
 * SERP API entirely. Pre-refactor this file had its own BD-only SERP code.
 *
 * Usage:
 *   const { discoverSlug } = require('./lib/serp-slug-discovery');
 *   const slug = await discoverSlug('seatplan.com', 'Hamilton', 'london');
 *   // Returns 'hamilton' or null
 */

const { serpQuery } = require('./url-discovery');

const BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_TOKEN;
const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY;

/**
 * Discover the correct slug for a show on a platform via Google SERP.
 *
 * @param {string} siteDomain - e.g., 'seatplan.com', 'londonboxoffice.co.uk', 'londontheatredirect.com'
 * @param {string} showTitle - Show title to search for
 * @param {string} [pathPrefix] - Optional path prefix to match (e.g., 'london' for seatplan.com/london/)
 * @returns {Promise<string|null>} The discovered slug, or null
 */
async function discoverSlug(siteDomain, showTitle, pathPrefix) {
  // Need at least one SERP provider — same gate as before the refactor.
  if (!BRIGHTDATA_TOKEN && !SCRAPINGBEE_API_KEY) return null;

  const query = `site:${siteDomain} "${showTitle}" tickets`;

  let results;
  try {
    // serpQuery handles the BD/SB fallback chain AND the 24h cache.
    // We force the slug-discovery path through BD-first (preferSpeed=false)
    // because routine slug discovery doesn't need ScrapingBee's speed advantage.
    results = await serpQuery(query, {
      nbResults: 10,
      brightDataKey: BRIGHTDATA_TOKEN,
      scrapingBeeKey: SCRAPINGBEE_API_KEY,
      // All three callers of this module target UK-only sites (seatplan.com/london,
      // londonboxoffice.co.uk, londontheatredirect.com). Their queries don't contain
      // the literal "West End" trigger, so we set geo explicitly to preserve the
      // pre-2026-05-17 behavior of forcing Google UK.
      geo: 'gb',
      log: () => {}, // suppress per-query logs in batch mode
    });
  } catch {
    return null;
  }

  if (!results || results.length === 0) return null;

  // Title validation: SERP result title must contain at least half of the
  // show's meaningful words to prevent wrong-show matches (e.g., "Black Is
  // The Color" matching a Mary Poppins page).
  const titleNorm = showTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const titleWords = titleNorm.split(/\s+/).filter(w => w.length > 2 && !['the', 'and', 'for'].includes(w));

  for (const result of results) {
    const url = result.url || '';
    if (!url.includes(siteDomain)) continue;

    const resultTitle = (result.title || '').toLowerCase();
    const matchCount = titleWords.filter(w => resultTitle.includes(w)).length;
    if (titleWords.length > 0 && matchCount < Math.max(1, Math.ceil(titleWords.length * 0.5))) {
      continue; // Skip — result title doesn't match our show
    }

    // Skip news/blog/review URLs — we want ticket pages
    const urlLower = url.toLowerCase();
    if (urlLower.includes('/news/') || urlLower.includes('/blog/') || urlLower.includes('/post/')) {
      continue;
    }

    try {
      const parsed = new URL(url);
      const pathParts = parsed.pathname.split('/').filter(Boolean);

      // If pathPrefix specified, find the slug after it
      if (pathPrefix) {
        const prefixIdx = pathParts.indexOf(pathPrefix);
        if (prefixIdx >= 0 && pathParts[prefixIdx + 1]) {
          return pathParts[prefixIdx + 1].replace(/-tickets\/?$/, '');
        }
      }

      // Otherwise return the last meaningful path segment
      const last = pathParts[pathParts.length - 1];
      if (last && last !== 'tickets') {
        return last.replace(/-tickets\/?$/, '');
      }
    } catch { /* malformed URL */ }
  }

  return null;
}

/**
 * Batch discover slugs for multiple shows.
 * Rate-limited to avoid SERP API abuse.
 *
 * @param {string} siteDomain
 * @param {Array<{id: string, title: string}>} shows - Shows to discover
 * @param {string} [pathPrefix]
 * @param {number} [delayMs=3000] - Delay between SERP queries
 * @param {Object|null} [budget] - Optional run-budget (scripts/lib/run-budget.js); stops early if exceeded
 * @returns {Promise<Map<string, string>>} Map of showId → discovered slug
 */
async function batchDiscoverSlugs(siteDomain, shows, pathPrefix, delayMs = 3000, budget = null) {
  if (delayMs != null && typeof delayMs !== 'number') {
    throw new TypeError(`batchDiscoverSlugs: delayMs must be a number, got ${typeof delayMs} — did you mean to pass budget as the 5th argument?`);
  }
  if (!BRIGHTDATA_TOKEN && !SCRAPINGBEE_API_KEY) {
    console.log('  ⚠️  No SERP provider keys set (BRIGHTDATA_TOKEN / SCRAPINGBEE_API_KEY) — skipping SERP slug discovery');
    return new Map();
  }

  const discovered = new Map();
  console.log(`\n🔍 SERP slug discovery for ${shows.length} missed shows on ${siteDomain}...`);

  for (let i = 0; i < shows.length; i++) {
    if (budget && budget.exceeded()) {
      console.log(`  ⏱ Time budget (${budget.minutes} min) reached — stopping SERP slug discovery early (${shows.length - i} shows unprocessed).`);
      break;
    }
    const show = shows[i];
    const slug = await discoverSlug(siteDomain, show.title, pathPrefix);
    if (slug) {
      console.log(`  ✅ ${show.title} → ${slug}`);
      discovered.set(show.id, slug);
    } else {
      console.log(`  ❌ ${show.title} — not found via SERP`);
    }
    if (i < shows.length - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  if (discovered.size > 0) {
    console.log(`\n  Discovered ${discovered.size}/${shows.length} slugs. Add to override map:`);
    for (const [id, slug] of discovered) {
      const show = shows.find(s => s.id === id);
      console.log(`  '${show.title}': '${slug}',`);
    }
  }

  return discovered;
}

module.exports = { discoverSlug, batchDiscoverSlugs };
