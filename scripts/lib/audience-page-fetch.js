'use strict';

// Shared by the LBO, LTD and SeatPlan slug/retry loops. Each invocation can
// follow another attempt in the same show, so the outer show check is stale.
async function fetchAudiencePage(url, {
  budget, httpsGet, fetchWithBrightData, brightDataEnabled,
  stopStatuses = [404], log = console.log,
}) {
  if (budget && budget.exceeded()) return null;
  try {
    const res = await httpsGet(url);
    if (res.status === 200 && res.body.length > 1000) return res.body;
    if (stopStatuses.includes(res.status)) return null;
  } catch (e) {
    log(`  ⚠️  Plain fetch failed: ${e.message}`);
  }

  if (brightDataEnabled && !(budget && budget.exceeded())) {
    try {
      log('  → Trying BrightData fallback...');
      const result = await fetchWithBrightData(url);
      if (result && result.content && result.content.length > 1000) return result.content;
    } catch (e) {
      log(`  ⚠️  BrightData failed: ${e.message}`);
    }
  }
  return null;
}

// BD-only fetch for the audience scrapers (BRO-6008). Routes through
// fetchPage() restricted to the brightdata tier, so the breaker/budget consult,
// spend ledger and domain-skip all live in scraper.js instead of three inlined
// copies of the BD HTTP call. scraper.js is required lazily (Playwright itself
// is already lazy there) so a --help/dry run does not load the provider stack.
async function fetchWithBrightDataViaFetchPage(url, fetchPage = require('./scraper').fetchPage) {
  if (!process.env.BRIGHTDATA_TOKEN) return null;
  try {
    const r = await fetchPage(url, { tiers: ['brightdata'], skipVerify: true });
    return r && r.content ? { content: r.content } : null;
  } catch (_) {
    return null; // 'All scraping methods failed' = a BD miss, like the old helper's null
  }
}

// True once BD refused any call this run for the daily breaker / per-run
// budget: a zero-match run is then a deferral, not a URL-pattern change.
function brightDataWasCapped(getScraperStats = require('./scraper').getScraperStats) {
  const st = getScraperStats();
  return (st.bdBlocked || 0) > 0;
}

module.exports = { fetchAudiencePage, fetchWithBrightDataViaFetchPage, brightDataWasCapped };
