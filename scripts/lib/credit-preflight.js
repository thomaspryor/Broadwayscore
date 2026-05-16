/*
 * Shared credit/zone pre-flight checks for sweeps and bulk scrapes (S1-T3).
 *
 * Returns { ok: true } when all configured providers are healthy. Otherwise
 * returns { ok: false, failures: [{ provider, reason }] } so the caller can
 * log a stable error string and exit non-zero.
 *
 * Mirrors the live-API behaviour in scripts/check-secrets-health.js, but
 * collapses to a single boolean + reason string for use at script startup.
 *
 * Threshold: SB aborts when remaining credit < `sbMinPct` (default 25%).
 * BD aborts when the zone is not in active state or unreachable with the
 * configured token.
 */

const https = require('https');

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

async function checkScrapingBee({ minPct = 25 } = {}) {
  const key = process.env.SCRAPINGBEE_API_KEY;
  if (!key) {
    return { provider: 'ScrapingBee', ok: false, reason: 'SB credit check failed: SCRAPINGBEE_API_KEY not set' };
  }
  let res;
  try {
    res = await httpsGet(`https://app.scrapingbee.com/api/v1/usage?api_key=${encodeURIComponent(key)}`);
  } catch (e) {
    return { provider: 'ScrapingBee', ok: false, reason: `SB credit check failed: ${e.message}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { provider: 'ScrapingBee', ok: false, reason: 'SB credit check failed: key invalid' };
  }
  if (res.status !== 200) {
    return { provider: 'ScrapingBee', ok: false, reason: `SB credit check failed: HTTP ${res.status}` };
  }
  let data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    return { provider: 'ScrapingBee', ok: false, reason: 'SB credit check failed: unparseable usage response' };
  }
  const used = data.used_api_credit || 0;
  const max = data.max_api_credit || 0;
  if (max <= 0) {
    return { provider: 'ScrapingBee', ok: false, reason: 'SB credit check failed: max_api_credit reported as 0' };
  }
  const remaining = max - used;
  const remainingPct = Math.round((remaining / max) * 100);
  if (remainingPct < minPct) {
    return {
      provider: 'ScrapingBee',
      ok: false,
      reason: `SB credit check failed: ${remainingPct}% remaining (${remaining}/${max}) — below ${minPct}% threshold`,
    };
  }
  return {
    provider: 'ScrapingBee',
    ok: true,
    reason: `${remaining}/${max} credits remaining (${remainingPct}%)`,
  };
}

async function checkBrightData() {
  const token = process.env.BRIGHTDATA_TOKEN;
  if (!token) {
    return { provider: 'BrightData', ok: false, reason: 'BD zone health check failed: BRIGHTDATA_TOKEN not set' };
  }
  const zoneName = process.env.BRIGHTDATA_ZONE || 'web_unlocker2';
  let res;
  try {
    res = await httpsGet(`https://api.brightdata.com/zone?zone=${encodeURIComponent(zoneName)}`, {
      Authorization: `Bearer ${token}`,
    });
  } catch (e) {
    return { provider: 'BrightData', ok: false, reason: `BD zone health check failed: ${e.message}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { provider: 'BrightData', ok: false, reason: 'BD zone health check failed: token invalid or unauthorized' };
  }
  if (res.status !== 200) {
    return { provider: 'BrightData', ok: false, reason: `BD zone health check failed: HTTP ${res.status}` };
  }
  let data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    return { provider: 'BrightData', ok: false, reason: 'BD zone health check failed: unparseable zone response' };
  }
  const disableReason = (data.plan && data.plan.disable) || data.disable;
  if (disableReason) {
    return {
      provider: 'BrightData',
      ok: false,
      reason: `BD zone health check failed: zone ${zoneName} disabled (${disableReason})`,
    };
  }
  return { provider: 'BrightData', ok: true, reason: `zone ${zoneName} active` };
}

async function preflightCredits(opts = {}) {
  const sbMinPct = opts.sbMinPct != null ? opts.sbMinPct : 25;
  const [sb, bd] = await Promise.all([
    checkScrapingBee({ minPct: sbMinPct }),
    checkBrightData(),
  ]);
  const failures = [sb, bd].filter((r) => !r.ok);
  return {
    ok: failures.length === 0,
    results: [sb, bd],
    failures,
  };
}

module.exports = { preflightCredits, checkScrapingBee, checkBrightData };
