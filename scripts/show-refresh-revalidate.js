#!/usr/bin/env node
'use strict';
/**
 * BRO-8170 gap 2: after a show-refresh kill or unkill, make the cached show
 * pages re-render. Without this a kill only changes what the NEXT render reads;
 * every page, reviews.json and OG image already cached from a slice keeps
 * serving it until its own ISR expiry (24 h).
 *
 * POSTs {all:true, tag:true} to <site>/api/show-refresh/revalidate with header
 * x-show-refresh-secret. The route expands `all` to every show this deployment
 * could have refreshed and drops every cached store read.
 *
 *   node scripts/show-refresh-revalidate.js [--base=https://broadwayscorecard.com]
 *
 * Env: SHOW_REFRESH_REVALIDATE_SECRET.
 * Exit 0  revalidated (or: this deployment has no build manifest, so no page
 *         can hold a slice; printed as a warning).
 * Exit 3  not configured: the secret is unset here. Dormant while the reader
 *         is off. Once the secret is set, a 404 is a FAILURE (the site should
 *         have the route), never "not configured".
 * Exit 1  anything else: wrong secret, 5xx, network, or a site that answered
 *         ok but revalidated nothing (an older deployment ignoring `all`).
 */
require('./lib/cli-help').exitOnHelp(module);

const DEFAULT_BASE = 'https://broadwayscorecard.com';
const TIMEOUT_MS = 90_000;
const TRIES = 2;
const EXIT = Object.freeze({ OK: 0, FAIL: 1, NOT_CONFIGURED: 3 });

/** One outcome per HTTP answer. Pure, for tests. */
function classify(status, body) {
  if (status === 200 && body && body.ok === true) {
    if (!(Number(body.count) > 0)) return { code: EXIT.FAIL, retry: false, msg: 'site answered ok but revalidated 0 paths (does this deployment ignore `all`?)' };
    return { code: EXIT.OK, retry: false, msg: `revalidated ${body.count} paths, store cache dropped (tag=${body.tag})` };
  }
  if (status === 503 && /no build manifest/.test(String(body && body.error))) {
    return { code: EXIT.OK, retry: false, warning: true, msg: 'this deployment has no show-refresh manifest, so no page can hold a slice: nothing to revalidate' };
  }
  if (status === 404) return { code: EXIT.FAIL, retry: false, msg: 'route answered 404: SHOW_REFRESH_REVALIDATE_SECRET is set here but not (or too short) on Vercel' };
  if (status === 401) return { code: EXIT.FAIL, retry: false, msg: 'route answered 401: the GitHub and Vercel secrets differ' };
  return { code: EXIT.FAIL, retry: status >= 500, msg: `route answered ${status}: ${JSON.stringify(body).slice(0, 300)}` };
}

async function revalidateAll({ env = process.env, base = DEFAULT_BASE, fetchImpl = fetch, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const secret = env.SHOW_REFRESH_REVALIDATE_SECRET || '';
  if (!secret) {
    log('show-refresh revalidate: NOT CONFIGURED (SHOW_REFRESH_REVALIDATE_SECRET unset); cached pages were not revalidated');
    return EXIT.NOT_CONFIGURED;
  }
  const url = new URL('/api/show-refresh/revalidate', base).toString();
  let last = { code: EXIT.FAIL, msg: 'no attempt' };
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-show-refresh-secret': secret },
        body: JSON.stringify({ all: true, tag: true }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      last = classify(res.status, body);
      if (!last.retry) break;
    } catch (e) {
      last = { code: EXIT.FAIL, retry: true, msg: `request failed: ${e && e.message}` };
    }
    if (attempt < TRIES) await sleep(5000 * attempt);
  }
  log(`show-refresh revalidate: ${last.code === EXIT.OK ? (last.warning ? 'WARNING' : 'OK') : 'FAILED'}: ${last.msg}`);
  if (last.warning && env.GITHUB_ACTIONS) log(`::warning::${last.msg}`);
  return last.code;
}

if (require.main === module) {
  const baseArg = process.argv.slice(2).find((a) => a.startsWith('--base='));
  revalidateAll(baseArg ? { base: baseArg.slice(7) } : {}).then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = EXIT.FAIL; });
}

module.exports = { classify, revalidateAll, EXIT };
