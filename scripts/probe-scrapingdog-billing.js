#!/usr/bin/env node
/**
 * probe-scrapingdog-billing.js — A0 gate for the cost round-2 plan
 * (claude-outputs/2026-07-19-scraping-cost-round2-plan.md).
 *
 * Question: does Scrapingdog BILL failed requests? The A1/A2 fixes convert
 * today's failures (SERP 404s on operator queries, DTLI page 400s) into
 * successes. If failures are currently FREE, the fixes add net-new billable
 * SD volume rather than reclaiming existing spend — which changes the
 * cap-blowout math before any load-shifting from Bright Data.
 *
 * Method: read account requestUsed → fire known-failing calls (same request
 * shapes as production code) → re-read → fire control successes → re-read.
 * Both deltas are reported; the control proves the counter moves at all
 * (without it, "failures didn't move the counter" is inconclusive).
 *
 * Cost: ≤ ~25 credits worst case. Requires SCRAPINGDOG_API_KEY (CI secret —
 * dispatch via scrapingdog-account-usage.yml with mode=billing-probe).
 */

const axios = require('axios');

const API_KEY = process.env.SCRAPINGDOG_API_KEY;
if (!API_KEY) {
  console.error('SCRAPINGDOG_API_KEY not set');
  process.exit(1);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function readUsed() {
  const { data } = await axios.get('https://api.scrapingdog.com/account', {
    params: { api_key: API_KEY }, timeout: 15000,
  });
  if (typeof data.requestUsed !== 'number') {
    const safe = { ...data }; delete safe.api_key; delete safe.apiKey; delete safe.key;
    throw new Error(`unexpected account response: ${JSON.stringify(safe).slice(0, 120)}`);
  }
  return data.requestUsed;
}

// Same request shape as _serpViaScrapingdog (scripts/lib/url-discovery.js) —
// operator queries historically 404 on this endpoint.
async function serpCall(query) {
  try {
    const { status } = await axios.get('https://api.scrapingdog.com/google/', {
      params: { api_key: API_KEY, query, results: 10, country: 'us' }, timeout: 30000,
    });
    return { ok: true, status };
  } catch (err) {
    return { ok: false, status: err.response?.status || err.message.slice(0, 60) };
  }
}

// Same request shape as fetchWithScrapingdog (scripts/lib/scraper.js) minus
// optional params — DTLI URLs have been returning HTTP 400 on this endpoint.
async function pageCall(url) {
  try {
    const { status } = await axios.get('https://api.scrapingdog.com/scrape', {
      params: { api_key: API_KEY, url }, timeout: 45000,
    });
    return { ok: true, status };
  } catch (err) {
    return { ok: false, status: err.response?.status || err.message.slice(0, 60) };
  }
}

(async () => {
  // Ambient-drift baseline: other workflows (hourly poller etc.) consume SD
  // credits concurrently; requestUsed is monotonic, so their traffic inflates
  // our deltas. Measure the idle drift over 20s and subtract it (scaled) from
  // each phase; refuse to conclude when ambient traffic is heavy.
  const pre = await readUsed();
  await sleep(20000);
  const used0 = await readUsed();
  const ambientPer20s = used0 - pre;
  console.log(`ambient drift: ${ambientPer20s} credits/20s · baseline requestUsed: ${used0}`);
  if (ambientPer20s > 5) {
    console.log('WARNING: heavy ambient SD traffic — verdict below is unreliable; re-run in a quiet window (e.g. not at the top of the hour when the poller fires).');
  }

  // --- Phase 1: intended-failure calls (3 operator SERP + 2 DTLI pages) ---
  const failures = [];
  failures.push(await serpCall('site:nytimes.com "Death Becomes Her" review after:2024-01-01 before:2025-01-01'));
  failures.push(await serpCall('site:vulture.com "Maybe Happy Ending" review after:2024-10-01 before:2025-02-01'));
  failures.push(await serpCall('"Sunset Boulevard" review site:variety.com after:2024-09-01'));
  failures.push(await pageCall('https://didtheylikeit.com/shows/maybe-happy-ending/'));
  failures.push(await pageCall('https://didtheylikeit.com/shows/death-becomes-her/'));
  console.log('failure-phase outcomes:', JSON.stringify(failures));
  const actuallyFailed = failures.filter(f => !f.ok).length;

  await sleep(20000);
  const used1 = await readUsed();
  console.log(`after failure phase: ${used1} (delta ${used1 - used0}, ${actuallyFailed}/5 calls failed as expected)`);

  // --- Phase 2: control successes (1 plain SERP ≈5cr + 1 simple page ≈1cr) ---
  const controls = [];
  controls.push(await serpCall('broadway theater reviews'));
  controls.push(await pageCall('https://example.com/'));
  console.log('control outcomes:', JSON.stringify(controls));

  await sleep(20000);
  const used2 = await readUsed();
  console.log(`after control phase: ${used2} (delta ${used2 - used1})`);

  // Each phase spans ~40s (calls + 20s settle) ≈ 2 ambient windows.
  const ambientPerPhase = ambientPer20s * 2;
  const failureDeltaAdj = (used1 - used0) - ambientPerPhase;
  const controlDeltaAdj = (used2 - used1) - ambientPerPhase;

  let verdict;
  if (controlDeltaAdj <= 0) {
    verdict = 'INCONCLUSIVE — control successes did not clearly move requestUsed above ambient drift (counter lag or heavy concurrent traffic); re-run in a quiet window';
  } else if (actuallyFailed === 0) {
    verdict = 'INCONCLUSIVE — none of the intended-failure calls actually failed (SD may now return 200/empty for operator queries); A1 may already be partially moot, re-check with fresh failing shapes';
  } else if (failureDeltaAdj >= 3) {
    verdict = `FAILURES ARE BILLED (~${failureDeltaAdj} credits above ambient for ${actuallyFailed} failures) — A1/A2 fixes reclaim existing spend`;
  } else if (failureDeltaAdj <= 1) {
    verdict = 'FAILURES ARE FREE — A1/A2 fixes will ADD net-new billable SD volume; size the cap-blowout guard accordingly';
  } else {
    verdict = 'INCONCLUSIVE — failure delta within ambient noise band; re-run in a quiet window';
  }

  console.log(JSON.stringify({
    baseline: used0, afterFailures: used1, afterControls: used2,
    ambientPer20s, failureDeltaRaw: used1 - used0, failureDeltaAdj,
    controlDeltaRaw: used2 - used1, controlDeltaAdj,
    failedCalls: actuallyFailed, verdict,
  }, null, 2));
})().catch(err => { console.error('probe crashed:', err.message); process.exit(1); });
