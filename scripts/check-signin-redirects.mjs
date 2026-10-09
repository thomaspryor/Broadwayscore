#!/usr/bin/env node
/**
 * check-signin-redirects.mjs — daily synthetic check that "Continue with
 * Google" and "Continue with Apple" on the live site still start a real
 * sign-in (BRO-4615). Run by .github/workflows/account-metrics.yml.
 *
 *   node scripts/check-signin-redirects.mjs [--base-url=https://broadwayscorecard.com] [--json=out.json] [--route-alerts]
 *
 * Google: click the header "Sign in" → "Continue with Google", capture the
 *   Supabase /auth/v1/authorize request (aborted, so no real OAuth starts),
 *   then follow ONE hop in node with redirect: 'manual' and require a 302 to
 *   accounts.google.com.
 * Apple: click "Continue with Apple", capture the appleid.apple.com authorize
 *   popup URL (aborted), check it names our /auth/apple-callback redirect,
 *   then GET it once in node and require Apple to answer 200 without an
 *   invalid_request / invalid_client error.
 *
 * Analytics hosts are blocked in the browser so the check never adds fake
 * sign-in starts to PostHog (they would trip the "nobody finishes signing
 * in" alert). Signs nobody in and creates no account.
 *
 * Each provider gets two tries. A result is "inconclusive" (never pages,
 * never resolves) when the browser threw, or the provider/Supabase hop timed
 * out or answered 429/5xx: one flaky run must not page the owner.
 *
 * --route-alerts: page the owner (owner-alert-router.js, once per incident)
 *   for each provider that is definitely broken, and resolve the condition
 *   for each provider that passed.
 *
 * Exit 0 = both fine, 1 = a provider is broken (details on stdout / --json),
 * 2 = inconclusive (site down, browser failed, provider hop flaky).
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
const BASE = String(args['base-url'] || 'https://broadwayscorecard.com').replace(/\/$/, '');
const BLOCKED_HOSTS = /(^|\.)posthog\.com$|(^|\.)google-analytics\.com$|(^|\.)googletagmanager\.com$|(^|\.)sentry\.io$|(^|\.)clarity\.ms$/;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 BroadwayScorecardSigninCheck';

const isTransient = (status) => status === 429 || status >= 500;

/**
 * Pure verdicts, exported for the unit test. `googlePage` is Google's own
 * answer for the hop (status + body), when fetched: a redirect_uri_mismatch
 * page means Supabase's callback is not on the OAuth client, which the hop
 * alone cannot see (BRO-4894: the custom auth domain changes that callback).
 */
export function judgeGoogle(authorizeUrl, hop, googlePage) {
  if (!authorizeUrl) return { ok: false, reason: 'clicking Continue with Google did not request the Supabase authorize URL' };
  if (!/\/auth\/v1\/authorize\?/.test(authorizeUrl) || !/provider=google/.test(authorizeUrl)) {
    return { ok: false, reason: `unexpected authorize URL ${authorizeUrl.split('?')[0]}` };
  }
  if (!hop) return { ok: false, inconclusive: true, reason: 'the authorize URL could not be fetched' };
  if (isTransient(hop.status)) return { ok: false, inconclusive: true, reason: `Supabase answered HTTP ${hop.status}` };
  if (hop.status < 300 || hop.status > 399) return { ok: false, reason: `Supabase answered HTTP ${hop.status} instead of redirecting to Google` };
  let host = '';
  try { host = new URL(hop.location).hostname; } catch { /* empty */ }
  if (host !== 'accounts.google.com') return { ok: false, reason: `Supabase redirected to ${host || 'nowhere'} instead of accounts.google.com` };
  if (googlePage) {
    if (isTransient(googlePage.status)) return { ok: false, inconclusive: true, reason: `Google answered HTTP ${googlePage.status}` };
    // A bot block (403) is not a verdict either way.
    if (googlePage.status === 403) return { ok: false, inconclusive: true, reason: 'Google answered HTTP 403 (bot block) for the sign-in page' };
    const dead = (googlePage.body || '').match(/invalid_client|deleted_client|disabled_client/i);
    if (dead && googlePage.status >= 400) return { ok: false, reason: `Google rejects the OAuth client (${dead[0]})` };
    // Google's own error markers; the page can come with HTTP 200 when
    // redirects are followed (seen live 2026-10-09), so the status is no guide.
    if (/Error 400: redirect_uri_mismatch|data-error-code="redirect_uri_mismatch"/i.test(googlePage.body || '')) return { ok: false, reason: 'Google rejects the callback (redirect_uri_mismatch): the OAuth client does not list the Supabase callback URL' };
  }
  return { ok: true, reason: 'Supabase redirects to accounts.google.com' };
}

export function judgeApple(popupUrl, hop, base) {
  if (!popupUrl) return { ok: false, reason: 'clicking Continue with Apple did not open the Apple sign-in window' };
  let u;
  try { u = new URL(popupUrl); } catch { return { ok: false, reason: 'Apple sign-in URL is not a URL' }; }
  if (u.hostname !== 'appleid.apple.com') return { ok: false, reason: `Apple sign-in opened ${u.hostname}` };
  const redirect = u.searchParams.get('redirect_uri') || '';
  if (redirect !== `${base}/auth/apple-callback`) return { ok: false, reason: `Apple redirect_uri is ${redirect || 'missing'}` };
  if (!hop) return { ok: false, inconclusive: true, reason: 'the Apple sign-in page could not be fetched' };
  if (isTransient(hop.status)) return { ok: false, inconclusive: true, reason: `Apple answered HTTP ${hop.status}` };
  if (hop.status !== 200) return { ok: false, reason: `Apple answered HTTP ${hop.status}` };
  if (/invalid_request|invalid_client|unauthorized_client/i.test(hop.body || '')) return { ok: false, reason: 'Apple refused the request (invalid client or redirect)' };
  return { ok: true, reason: 'Apple shows its sign-in page for our redirect' };
}

/** Google's sign-in page for the hop's Location (redirects followed), or null. */
async function googlePageFor(hop) {
  if (!hop || !hop.location) return null;
  try {
    const res = await fetch(hop.location, { redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
    return { status: res.status, body: (await res.text()).slice(0, 300000) };
  } catch {
    return null;
  }
}

async function oneHop(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
    const body = res.status === 200 ? (await res.text()).slice(0, 200000) : '';
    return { status: res.status, location: res.headers.get('location') || '', body };
  } catch {
    return null;
  }
}

async function openModal(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const btn = page.getByRole('button', { name: 'Sign in' }).first();
  await btn.waitFor({ state: 'visible', timeout: 30000 });
  // The header renders before hydration; retry the click until the modal opens.
  for (let i = 0; i < 10; i++) {
    await btn.click();
    if (await page.getByRole('button', { name: /Continue with Google/ }).isVisible().catch(() => false)) return;
    await page.waitForTimeout(1000);
  }
  throw new Error('the sign-in box did not open');
}

async function captureGoogle(browser) {
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  await blockAnalytics(context);
  let authorizeUrl = null;
  await context.route(/\/auth\/v1\/authorize\?/, (route) => { authorizeUrl = route.request().url(); return route.abort(); });
  const page = await context.newPage();
  try {
    await openModal(page);
    await page.getByRole('button', { name: /Continue with Google/ }).click();
    for (let i = 0; i < 30 && !authorizeUrl; i++) await page.waitForTimeout(500);
  } finally {
    await context.close();
  }
  return authorizeUrl;
}

async function captureApple(browser) {
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  await blockAnalytics(context);
  let popupUrl = null;
  await context.route(/^https:\/\/appleid\.apple\.com\/auth\/authorize/, (route) => { popupUrl = route.request().url(); return route.abort(); });
  const page = await context.newPage();
  try {
    await openModal(page);
    await page.getByRole('button', { name: /Continue with Apple/ }).click();
    for (let i = 0; i < 30 && !popupUrl; i++) await page.waitForTimeout(500);
  } finally {
    await context.close();
  }
  return popupUrl;
}

async function blockAnalytics(context) {
  await context.route((url) => BLOCKED_HOSTS.test(url.hostname) || url.pathname.startsWith('/_vercel/insights') || url.pathname.startsWith('/_vercel/speed-insights'), (route) => route.abort());
}

const PROVIDER_NAMES = { google: 'Google', apple: 'Apple' };

async function routeAlerts(result) {
  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router');
  const { ALERT_KEYS } = require('./lib/account-metrics');
  for (const p of ['google', 'apple']) {
    const r = result[p] || { ok: false, inconclusive: true, reason: result.error || 'the browser did not start' };
    // Could not tell (flaky hop, browser error, or the Sign in button itself
    // changed): never page or resolve the broken key, but tell the owner's
    // morning digest so a check that is blind for days is not silent.
    const blindKey = ALERT_KEYS.signInCheckBlind + p;
    if (r.inconclusive) {
      await routeAlert({
        conditionKey: blindKey,
        title: `The daily Sign in with ${PROVIDER_NAMES[p]} check could not run`,
        description: `It could not tell whether "Continue with ${PROVIDER_NAMES[p]}" works: ${r.reason}. If this repeats, the check (scripts/check-signin-redirects.mjs) needs updating.`,
        severity: 'warning',
        disposition: 'digest',
        url: `${BASE}/`,
        cooldownHours: 24,
      });
      console.log(`digest: ${blindKey}`);
      continue;
    }
    resolveCondition(blindKey, { reason: 'sign-in start check ran' });
    const key = ALERT_KEYS.signInRedirect + p;
    if (r.ok) {
      if (resolveCondition(key, { reason: 'sign-in start check passed' })) console.log(`resolved ${key}`);
      continue;
    }
    await routeAlert({
      conditionKey: key,
      title: `Sign in with ${PROVIDER_NAMES[p]} is broken on broadwayscorecard.com`,
      description: `The daily check clicked "Continue with ${PROVIDER_NAMES[p]}" and it did not reach ${PROVIDER_NAMES[p]}'s sign-in page: ${r.reason}.`,
      hint: 'Supabase Auth provider settings, the OAuth client, or the redirect URL may have changed.',
      severity: 'error',
      disposition: 'human',
      url: `${BASE}/`,
      cooldownHours: 24,
    });
    console.log(`alert routed: ${key}`);
  }
}

/** Two tries; a browser error counts as inconclusive, not broken. */
async function checkProvider(browser, capture, judge, probe) {
  let r;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const url = await capture(browser);
      const hop = url ? await oneHop(url) : null;
      r = judge(url, hop, probe && hop ? await probe(hop) : undefined);
    } catch (e) {
      r = { ok: false, inconclusive: true, reason: `the check itself failed: ${String(e && e.message || e).slice(0, 200)}` };
    }
    if (r.ok) break;
  }
  return r;
}

/** 0 both fine, 1 a provider definitely broken, 2 could not tell. */
export function exitCodeFor(result) {
  const rs = [result.google, result.apple];
  if (rs.some((r) => r && !r.ok && !r.inconclusive)) return 1;
  return rs.every((r) => r && r.ok) ? 0 : 2;
}

async function main() {
  let browser;
  const result = { checkedAt: new Date().toISOString(), base: BASE, google: null, apple: null };
  try {
    // CHROMIUM_PATH: a preinstalled browser when the pinned one is absent (cloud sandboxes).
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    result.google = await checkProvider(browser, captureGoogle, judgeGoogle, googlePageFor);
    result.apple = await checkProvider(browser, captureApple, (u, hop) => judgeApple(u, hop, BASE));
  } catch (e) {
    result.error = String(e && e.message || e).slice(0, 300);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  console.log(JSON.stringify(result, null, 2));
  if (args.json) writeFileSync(String(args.json), JSON.stringify(result, null, 2) + '\n');
  if (args['route-alerts']) await routeAlerts(result);
  return exitCodeFor(result);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c));
}
