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

const https = require('https');

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
    `https://app.scrapingbee.com/api/v1/usage?api_key=${key}`
  );
  if (status !== 200 || !data) {
    return { ok: false, reason: 'api-error', status, error, message: `usage endpoint returned ${status}` };
  }
  const maxCredits = Number(data.max_api_credit) || 0;
  const usedCredits = Number(data.used_api_credit) || 0;
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

module.exports = { fetchSBCreditStatus };

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
