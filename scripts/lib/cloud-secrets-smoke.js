/**
 * Functional smoke checks behind `check-cloud-secrets.js --smoke` (BRO-6258).
 *
 * `check-cloud-secrets.js` only proves a key is PRESENT. BRO-6112 added scraper,
 * Resend, Bing, Impact and Formspree keys to the cloud environment and each one
 * authenticated, yet two jobs that needed them were still broken: ScrapingBee
 * answered "403 Blocked by egress policy" to Node's https (no proxy), and
 * Playwright could not find its chromium build. Both only show up when the
 * consumer's own transport does its real job. Each check below makes one free
 * or near-free read (scrapes: 1 credit per provider on example.com), sends no
 * email, and uses the same https / fetchPage path the scripts use.
 *
 * Pure parts (judge*, summarize, selectChecks) are unit-tested; run* do I/O.
 */
const https = require('https');
require('./cloud-proxy');

const GROUPS = {
  scrapingdog: ['SCRAPINGDOG_API_KEY'],
  brightdata: ['BRIGHTDATA_TOKEN', 'BRIGHTDATA_ZONE'],
  scrapingbee: ['SCRAPINGBEE_API_KEY'],
  browserbase: ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'],
  playwright: [],
  resend: ['RESEND_API_KEY'],
  bing: ['BING_WEBMASTER_API_KEY'],
  impact: ['IMPACT_ACCOUNT_SID', 'IMPACT_AUTH_TOKEN'],
  formspree: ['FORMSPREE_SUBSCRIBER_API_KEY', 'FORMSPREE_SUBSCRIBER_FORM_ID'],
};

/** Pure: a scrape result is real article/page text, not a block page. */
function judgeScrape(result) {
  const body = result && typeof result.content === 'string' ? result.content : '';
  if (body.length < 200) return { ok: false, detail: `only ${body.length} bytes` };
  if (!/Example Domain/i.test(body)) return { ok: false, detail: 'expected page text "Example Domain" not found' };
  return { ok: true, detail: `${body.length} bytes, source=${result.source}` };
}

/** Pure: HTTP status + parsed JSON → verdict for each API group. */
function judgeApi(group, status, data) {
  if (status !== 200) return { ok: false, detail: `HTTP ${status}` };
  if (group === 'resend') {
    const n = Array.isArray(data && data.data) ? data.data.filter((d) => d.status === 'verified').length : 0;
    return n > 0 ? { ok: true, detail: `${n} verified sending domain(s)` } : { ok: false, detail: 'no verified domain' };
  }
  if (group === 'bing') {
    const n = Array.isArray(data && data.d) ? data.d.length : 0;
    return n > 0 ? { ok: true, detail: `${n} site(s)` } : { ok: false, detail: 'no sites returned' };
  }
  if (group === 'impact') {
    return data && typeof data === 'object' && Array.isArray(data.Actions)
      ? { ok: true, detail: `${data.Actions.length} action(s) yesterday-today` }
      : { ok: false, detail: 'no Actions array in response' };
  }
  if (group === 'formspree') {
    return data && Array.isArray(data.submissions)
      ? { ok: true, detail: `${data.submissions.length} submission(s) read` }
      : { ok: false, detail: 'no submissions array in response' };
  }
  if (group === 'browserbase') {
    return data && typeof data === 'object' ? { ok: true, detail: 'account endpoint answered' } : { ok: false, detail: 'non-JSON body' };
  }
  return { ok: true, detail: 'HTTP 200' };
}

/** Pure: which groups run, and which of their keys are missing. */
function selectChecks(env, only) {
  return Object.entries(GROUPS)
    .filter(([g]) => !only || only.includes(g))
    .map(([group, keys]) => ({ group, missing: keys.filter((k) => !env[k]) }));
}

/** Pure: results → { failed, lines }. every non-ok result (including missing keys) counts as a failure. */
function summarize(results) {
  const failed = results.filter((r) => !r.ok);
  return {
    failed: failed.length,
    lines: results.map((r) => `  ${r.ok ? '✓' : '✗'} ${r.group.padEnd(12)} ${r.detail}`),
  };
}

function httpsJson(url, headers = {}, timeout = 20000) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers, timeout }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(body); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, data, body });
      });
    });
    req.on('error', (e) => resolve({ status: 0, data: null, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: null, body: 'timeout' }); });
  });
}

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
// Impact rejects millisecond precision (same shape as affiliate-stats fmtISO).
const ymd = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

async function runGroup(group, env) {
  if (group === 'scrapingdog' || group === 'brightdata' || group === 'scrapingbee') {
    // Real job: fetchPage forced onto one tier, on a page that costs ~1 credit.
    const { fetchPage } = require('./scraper');
    try {
      const r = await fetchPage('https://example.com/', { tiers: [group], skipVerify: true });
      return judgeScrape(r);
    } catch (e) {
      return { ok: false, detail: `fetchPage(${group}) failed: ${String(e.message).slice(0, 120)}` };
    }
  }
  if (group === 'playwright') {
    try {
      const { chromium } = require('playwright');
      const browser = await chromium.launch({ headless: true, ...require('./playwright-exe').launchExtras(chromium) });
      await browser.close();
      return { ok: true, detail: 'chromium launched' };
    } catch (e) {
      return { ok: false, detail: `chromium.launch failed: ${String(e.message).split('\n')[0].slice(0, 140)}` };
    }
  }
  let res;
  if (group === 'browserbase') {
    res = await httpsJson(`https://api.browserbase.com/v1/projects/${env.BROWSERBASE_PROJECT_ID}/usage`, { 'X-BB-API-Key': env.BROWSERBASE_API_KEY });
  } else if (group === 'resend') {
    res = await httpsJson('https://api.resend.com/domains', { Authorization: `Bearer ${env.RESEND_API_KEY}` });
  } else if (group === 'bing') {
    res = await httpsJson(`https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=${encodeURIComponent(env.BING_WEBMASTER_API_KEY)}`);
  } else if (group === 'impact') {
    const end = new Date(); const start = new Date(end.getTime() - 86400000);
    res = await httpsJson(
      `https://api.impact.com/Mediapartners/${env.IMPACT_ACCOUNT_SID}/Actions.json?StartDate=${ymd(start)}&EndDate=${ymd(end)}`,
      { Authorization: basic(env.IMPACT_ACCOUNT_SID, env.IMPACT_AUTH_TOKEN), Accept: 'application/json' });
  } else if (group === 'formspree') {
    res = await httpsJson(`https://formspree.io/api/0/forms/${env.FORMSPREE_SUBSCRIBER_FORM_ID}/submissions?limit=1`, { Authorization: `Bearer ${env.FORMSPREE_SUBSCRIBER_API_KEY}` });
  }
  return judgeApi(group, res.status, res.data);
}

/** Runs every selected group; never throws. */
async function runSmoke(env, { only } = {}) {
  const results = [];
  for (const { group, missing } of selectChecks(env, only)) {
    if (missing.length) { results.push({ group, ok: false, detail: `missing ${missing.join(', ')}` }); continue; }
    try { results.push({ group, ...(await runGroup(group, env)) }); }
    catch (e) { results.push({ group, ok: false, detail: `threw: ${String(e.message).slice(0, 120)}` }); }
  }
  return results;
}

module.exports = { GROUPS, judgeScrape, judgeApi, selectChecks, summarize, runSmoke };
