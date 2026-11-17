#!/usr/bin/env node
/**
 * verify-cookie-login.js — Prove our subscription/paywalled cookies actually
 * pull FULL review text, not just a logged-out teaser.
 *
 * Why this exists (2026-05-29): cookie-health checks only validated cookie
 * presence + client-side expiry dates. A subscription session can rotate/die
 * server-side while the cookie's expiry is still months out — the cookie looks
 * "healthy" but every fetch returns a paywall/registration wall. The Stage went
 * silently logged-out for ~11 days (cookie-health reported "Auth OK 338.4d")
 * and Variety reviews were truncated by an extractor regression — both invisible
 * to expiry-date checks.
 *
 * The reliable signal is end-to-end: fetch a real review and measure the
 * EXTRACTED BODY length. A live session + working extractor yields thousands of
 * chars; a dead session (paywall) or broken extractor yields a few hundred.
 * This one probe catches BOTH failure modes regardless of root cause.
 *
 * Runs the production fetch path (scripts/lib/scraper fetchPage) + the real
 * article extractor, so it mirrors what gather/collect actually get. Intended to
 * run LOCALLY right after `extract-safari-cookies.py` (residential IP, free) so
 * the user sees immediately which outlets are logged in. Exit 1 if any target is
 * below its threshold so it's usable as a gate.
 *
 * BRO-7705: every outlet with a shared probe (lib/cookie-probes.js) is
 * classified exactly as renew-cookies.js classifies it, WITH a zero-cookie
 * control: the old NYT floor (1500) passed the 2,904-char anonymous page and
 * the old FT probe passed FT's 2,312-char "Subscribe to read" page, so both
 * read "logged in" with no session at all. Browser-only outlets (newyorker,
 * thetimes, ft, telegraph) are measured inside their persistent profile
 * (Mac only; takes the renew lock) against an anonymous-browser control.
 *
 * Usage:
 *   node scripts/verify-cookie-login.js                 # all targets
 *   node scripts/verify-cookie-login.js --outlets=thestage,variety   (--outlet= also works)
 *   node scripts/verify-cookie-login.js --json          # machine-readable
 */

'use strict';

const { fetchPage } = require('./lib/scraper');
const { extractArticleTextFromUrl } = require('./lib/article-extractor');
const { COOKIE_PROBES, isBotChallenge } = require('./lib/cookie-probes');

// Stable review URLs per subscription/paywalled outlet. minBody is the floor
// below which we treat the result as a paywall/extractor failure — real theater
// reviews run 1500+ chars; teasers/walls return a few hundred.
// Outlets with a shared probe use it (fetch or in-profile browser, always
// with a control). The rest keep a plain floor.
const fromProbe = (outlet) => ({ outlet, url: COOKIE_PROBES[outlet].url, shared: true });
const TARGETS = [
  fromProbe('nytimes'),
  { outlet: 'variety',   url: 'https://variety.com/2026/legit/reviews/rocky-horror-show-broadway-review-revival-lacks-shock-fun-luke-evans-1236728429/', minBody: 1500 },
  fromProbe('thestage'),
  // WSJ answers non-browser fetches with 401 or a one-paragraph preview even
  // for a live subscriber session (task #779); only recover-wsj-browser.js can
  // read it, so this plain-fetch probe cannot prove the login either way.
  { outlet: 'wsj',       url: 'https://www.wsj.com/articles/gypsy-review-audra-mcdonalds-turn-on-broadway-ff528df3', minBody: 1500, knownLoggedOut: 'plain fetch is always previewed; check with recover-wsj-browser.js --auth-only' },
  fromProbe('newyorker'),
  fromProbe('wapo'),
  fromProbe('ft'),
  fromProbe('thetimes'),
  fromProbe('telegraph'),
];

function getArg(name) {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : null;
}
const JSON_OUT = process.argv.includes('--json');
const onlyOutlets = (getArg('outlets') || getArg('outlet') || '').split(',').map((s) => s.trim()).filter(Boolean);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function plainAnon(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  return res.text();
}

// The renew lock guards the persistent profiles; a launchd renew run holds
// it for a few minutes at most, so wait rather than fail.
let lockRelease = null;
async function takeProfileLock() {
  if (lockRelease) return true;
  const { acquireLock, renewLockPath } = require('./lib/cookie-renew');
  for (let i = 0; i < 40; i++) {
    lockRelease = acquireLock(renewLockPath());
    if (lockRelease) return true;
    if (i === 0) console.error('waiting for the cookie-renew lock (a renew or recovery run has the profiles open)...');
    await new Promise((r) => setTimeout(r, 15000));
  }
  return false;
}

async function sharedProbe(t) {
  const p = COOKIE_PROBES[t.outlet];
  const bprobe = require('./lib/cookie-browser-probe');
  const base = { outlet: t.outlet, url: p.url, knownLoggedOut: null, error: null };
  let withCookies, withoutCookies, where;
  try {
    if (p.browserOnly) {
      if (process.platform !== 'darwin') return { ...base, ok: false, error: 'browser-only probe runs on the Mac Studio only' };
      if (!(await takeProfileLock())) return { ...base, ok: false, error: 'cookie-renew lock busy for 10 min' };
      const { launchOtpBrowser } = require('./lib/otp-login-helpers');
      const { profileDir, profileNameFor } = require('./lib/cookie-renew');
      const ctx = await launchOtpBrowser(profileDir(profileNameFor(t.outlet)), { headless: true, userAgent: bprobe.UA });
      try { withCookies = await bprobe.loadProbe(ctx, p); } finally { await ctx.close().catch(() => {}); }
      ({ control: withoutCookies } = await bprobe.classifyWithControl(p, withCookies));
      where = 'in-profile browser';
    } else {
      const r = await fetchPage(p.url, { source: 'verify-cookie-login' });
      const html = (r && (r.content || r.html || r.body)) || (typeof r === 'string' ? r : '');
      withCookies = { html, body: bprobe.probeBody(p, html) };
      const anon = await plainAnon(p.url);
      withoutCookies = { html: anon, body: bprobe.probeBody(p, anon) };
      where = 'fetch';
    }
  } catch (e) {
    return { ...base, ok: false, error: e.message.split('\n')[0] };
  }
  const status = bprobe.classify(p, withCookies, withoutCookies);
  const detail = `${where}: ${status}; body ${withCookies.body.length} vs ${withoutCookies.body.length} with no session (need ${p.minBody})`;
  return { ...base, ok: status === 'logged-in', detail, botBlocked: status === 'error' && (isBotChallenge(withCookies.html) || isBotChallenge(withoutCookies.html)), vacuous: status === 'vacuous' };
}

async function probe(t) {
  if (t.shared) return sharedProbe(t);
  let body = '';
  let htmlLen = 0;
  let html = '';
  let error = null;
  try {
    const r = await fetchPage(t.url, { source: 'verify-cookie-login' });
    html = (r && (r.content || r.html || r.body)) || (typeof r === 'string' ? r : '');
    htmlLen = html.length;
    if (!t.loggedInMarker) body = extractArticleTextFromUrl(html, t.url) || '';
  } catch (e) {
    error = e.message;
  }
  let ok, detail;
  if (t.loggedInMarker) {
    // Marker mode: outlets with anti-bot challenges where body extraction is
    // unreliable. Trust the logged-in marker (e.g. "my account") in the HTML.
    ok = !error && t.loggedInMarker.test(html);
    detail = `marker ${ok ? 'present' : 'absent'} (html ${htmlLen})`;
  } else {
    // wallMarker mode: a registration/paywall interstitial can still carry
    // extractable page furniture — marker PRESENT means logged-out regardless
    // of body length.
    const walled = t.wallMarker ? !error && t.wallMarker.test(html) : false;
    ok = !error && !walled && body.length >= t.minBody;
    detail = walled
      ? `wall marker present (html ${htmlLen}, body ${body.length})`
      : `body ${body.length} / need ${t.minBody}`;
  }
  const botBlocked = !error && !ok && isBotChallenge(html);
  if (botBlocked) detail = `bot challenge page — login state unknown; ${detail}`;
  return { outlet: t.outlet, ok, detail, error, url: t.url, knownLoggedOut: t.knownLoggedOut || null, botBlocked };
}

(async () => {
  const unknown = onlyOutlets.filter((o) => !TARGETS.some((t) => t.outlet === o));
  if (unknown.length) {
    // Never drop a requested outlet silently (telegraph used to vanish).
    console.error(`Unknown outlet(s): ${unknown.join(', ')}. Known: ${TARGETS.map((t) => t.outlet).join(', ')}`);
    process.exit(1);
  }
  const targets = TARGETS.filter((t) => onlyOutlets.length === 0 || onlyOutlets.includes(t.outlet));
  const results = [];
  for (const t of targets) {
    results.push(await probe(t));
  }
  if (lockRelease) lockRelease();

  if (JSON_OUT) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log('\n=== Cookie login verification (extracted body length) ===\n');
    for (const r of results) {
      const mark = r.error ? '⚠️  ERROR     ' : r.ok ? '✅ logged-in  ' : r.botBlocked ? '🤖 BOT-CHECK ' : r.vacuous ? '⚠️  VACUOUS   ' : r.knownLoggedOut ? '⚠️  logged-out' : '❌ LOGGED-OUT ';
      const suffix = !r.ok && r.knownLoggedOut ? ` [expected: ${r.knownLoggedOut}]` : '';
      console.log(`${mark} ${r.outlet.padEnd(11)} ${r.error || r.detail}${suffix}`);
    }
    const bad = results.filter((r) => !r.ok && !r.knownLoggedOut && !r.botBlocked);
    const blocked = results.filter((r) => r.botBlocked);
    console.log('');
    if (blocked.length) {
      console.log(`🤖 ${blocked.length} outlet(s) answered with an anti-bot check, so their login could not be tested: ${blocked.map((r) => r.outlet).join(', ')}`);
      console.log('   Logging in again will not help; retry later.');
    }
    if (bad.length) {
      console.log(`❌ ${bad.length} outlet(s) not returning full text: ${bad.map((r) => r.outlet).join(', ')}`);
      console.log('   → Automatic renewal handles these (launchd com.broadwayscore.cookie-renew). Run it now with:');
      console.log(`     node scripts/renew-cookies.js --outlets=${bad.map((r) => r.outlet).join(',')}`);
    } else if (!blocked.length) {
      console.log('✅ All probed outlets return full review text (known-logged-out outlets excluded).');
    }
  }

  // knownLoggedOut targets report honestly but don't gate the exit code.
  // A bot-checked outlet still exits 1: its login is unverified, not healthy.
  process.exit(results.some((r) => !r.ok && !r.knownLoggedOut) ? 1 : 0);
})().catch((e) => {
  console.error('verify-cookie-login failed:', e.stack || e.message);
  process.exit(1);
});
