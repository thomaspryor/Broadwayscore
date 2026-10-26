// ScrapingBee credit status helper. Callable from workflows (node -e) or scripts (require).
//
// Usage (script):
//   const { fetchSBCreditStatus } = require('./scripts/lib/check-sb-credits');
//   const status = await fetchSBCreditStatus();
//   // { ok, maxCredits, usedCredits, remaining, pctUsed, pctRemaining, message }
//
// Usage (CLI):
//   node scripts/lib/check-sb-credits.js                    # prints status + JSON line
//   node scripts/lib/check-sb-credits.js --warn-used-pct=90 # emits ::warning:: if >=90% used
//   node scripts/lib/check-sb-credits.js --output=skip_serp --floor-remaining-pct=1
//     # emits "skip_serp=true" or "skip_serp=false" to stdout on separate line

// secret-optional: SCRAPINGBEE_API_KEY fetchSBCreditStatus returns { ok: false, reason: 'no-key' } without it (BRO-3602).
const https = require('https');
require('./cloud-proxy'); // BRO-6258: route ScrapingBee through the cloud egress proxy
const { sbUsageFields } = require('./provider-billing'); // BRO-3010: SB /usage field names live in one place

function httpsGetJson(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, data: null, error: e.message }); }
      });
    });
    req.on('error', (e) => resolve({ status: 0, data: null, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: null, error: 'timeout' }); });
  });
}

async function fetchSBCreditStatus() {
  const key = process.env.SCRAPINGBEE_API_KEY;
  if (!key) {
    return { ok: false, reason: 'no-key', message: 'SCRAPINGBEE_API_KEY not set' };
  }
  const { status, data, error } = await httpsGetJson(
    // encodeURIComponent to match the two sibling implementations
    // (lib/credit-preflight.js, lib/provider-billing.js fetchSbUsage). An
    // unencoded key containing &, + or # authenticates as something else and
    // surfaces only as a generic api-error WARN (BRO-3032 review).
    `https://app.scrapingbee.com/api/v1/usage?api_key=${encodeURIComponent(key)}`
  );
  return classifySBUsage(status, data, error);
}

/**
 * Pure classification of one /usage response (BRO-3039). Split out of
 * fetchSBCreditStatus so a synchronous caller that fetched the payload
 * itself (scripts/opening-night-readiness.js) reads it the same way instead
 * of hand-rolling the field reads. A non-200, an unparseable body, or a
 * well-formed payload without a positive max_api_credit is never "ok": the
 * old hand-rolled reader turned a missing cap into "100% remaining".
 */
function classifySBUsage(status, data, error) {
  if (status !== 200 || !data) {
    return { ok: false, reason: 'api-error', status, error, message: status === 200 ? 'usage endpoint returned 200 with an unreadable body' : `usage endpoint returned ${status}` };
  }
  const sbFields = sbUsageFields(data);
  const maxCredits = Number(sbFields.max) || 0;
  const usedCredits = Number(sbFields.used) || 0;
  if (maxCredits <= 0) {
    return { ok: false, reason: 'no-max', message: 'max_api_credit missing from response', raw: data };
  }
  const remaining = maxCredits - usedCredits;
  const pctUsed = Math.round((usedCredits / maxCredits) * 100);
  const pctRemaining = Math.round((remaining / maxCredits) * 100);
  return {
    ok: true,
    maxCredits,
    usedCredits,
    remaining,
    pctUsed,
    pctRemaining,
    message: `SB credits: ${remaining} remaining (${pctRemaining}% of ${maxCredits}, ${pctUsed}% used)`,
  };
}

module.exports = { fetchSBCreditStatus, classifySBUsage };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2).reduce((acc, a) => {
      const m = a.match(/^--([^=]+)=(.*)$/);
      if (m) acc[m[1]] = m[2];
      else if (a.startsWith('--')) acc[a.slice(2)] = true;
      return acc;
    }, {});
    const status = await fetchSBCreditStatus();
    console.error(status.message || JSON.stringify(status));
    if (!status.ok) {
      // Soft: don't fail. Callers that want hard-fail can parse the JSON.
      console.log(JSON.stringify(status));
      process.exit(0);
    }
    const warnPct = args['warn-used-pct'] ? Number(args['warn-used-pct']) : null;
    if (warnPct != null && status.pctUsed >= warnPct) {
      console.error(
        `::warning::ScrapingBee ${status.pctUsed}% used (${status.remaining}/${status.maxCredits} remaining). ` +
        `Consider buying credits or tightening SB_CREDIT_BUDGET before a big run.`
      );
    }
    if (args.output === 'skip_serp') {
      const floor = args['floor-remaining-pct'] ? Number(args['floor-remaining-pct']) : 1;
      const skip = status.pctRemaining < floor;
      console.log(`skip_serp=${skip ? 'true' : 'false'}`);
    }
    console.log(JSON.stringify(status));
  })();
}
