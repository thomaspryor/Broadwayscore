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

module.exports = { fetchAudiencePage };
