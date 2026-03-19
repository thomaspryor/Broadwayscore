/**
 * SERP-based slug discovery for audience scrapers.
 *
 * When a scraper can't find a show via slug variants, this does a single
 * Google SERP query (site:platform.com "Show Title") to find the actual URL.
 * Extracts the slug from the first matching result.
 *
 * Uses BrightData SERP API (~$0.002/query). Falls back gracefully if
 * BRIGHTDATA_TOKEN is not set.
 *
 * Usage:
 *   const { discoverSlug } = require('./lib/serp-slug-discovery');
 *   const slug = await discoverSlug('seatplan.com', 'Hamilton', 'london');
 *   // Returns 'hamilton' or null
 */

const BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_TOKEN;
const BD_CUSTOMER = process.env.BRIGHTDATA_CUSTOMER || 'hl_a2c64a47';
const BD_SERP_ZONE = process.env.BRIGHTDATA_SERP_ZONE || 'serp_api1';

/**
 * Discover the correct slug for a show on a platform via Google SERP.
 *
 * @param {string} siteDomain - e.g., 'seatplan.com', 'londonboxoffice.co.uk', 'londontheatredirect.com'
 * @param {string} showTitle - Show title to search for
 * @param {string} [pathPrefix] - Optional path prefix to match (e.g., 'london' for seatplan.com/london/)
 * @returns {Promise<string|null>} The discovered slug, or null
 */
async function discoverSlug(siteDomain, showTitle, pathPrefix) {
  if (!BRIGHTDATA_TOKEN) return null;

  const query = `site:${siteDomain} "${showTitle}" tickets`;

  try {
    const submitRes = await fetch(
      `https://api.brightdata.com/serp/req?customer=${BD_CUSTOMER}&zone=${BD_SERP_ZONE}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BRIGHTDATA_TOKEN}`,
        },
        body: JSON.stringify({ query: { q: query, gl: 'gb' } }),
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!submitRes.ok) return null;

    const submitData = await submitRes.json();
    const responseId = submitData.response_id;
    if (!responseId) return null;

    // Poll for results (max 20s)
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const pollRes = await fetch(
        `https://api.brightdata.com/serp/get_result?customer=${BD_CUSTOMER}&zone=${BD_SERP_ZONE}&response_id=${responseId}`,
        {
          headers: { 'Authorization': `Bearer ${BRIGHTDATA_TOKEN}` },
          signal: AbortSignal.timeout(10000),
        }
      );
      if (pollRes.status === 202) continue;
      if (!pollRes.ok) return null;

      const data = await pollRes.json();
      if (data.organic && data.organic.length > 0) {
        // Extract slug from first result URL
        for (const result of data.organic) {
          const url = result.link || result.url || '';
          if (!url.includes(siteDomain)) continue;

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
      }
      if (data.response_id) continue;
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Batch discover slugs for multiple shows.
 * Rate-limited to avoid SERP API abuse.
 *
 * @param {string} siteDomain
 * @param {Array<{id: string, title: string}>} shows - Shows to discover
 * @param {string} [pathPrefix]
 * @param {number} [delayMs=3000] - Delay between SERP queries
 * @returns {Promise<Map<string, string>>} Map of showId → discovered slug
 */
async function batchDiscoverSlugs(siteDomain, shows, pathPrefix, delayMs = 3000) {
  if (!BRIGHTDATA_TOKEN) {
    console.log('  ⚠️  BRIGHTDATA_TOKEN not set — skipping SERP slug discovery');
    return new Map();
  }

  const discovered = new Map();
  console.log(`\n🔍 SERP slug discovery for ${shows.length} missed shows on ${siteDomain}...`);

  for (let i = 0; i < shows.length; i++) {
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
