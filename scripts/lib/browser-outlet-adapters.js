'use strict';
/**
 * browser-outlet-adapters.js — per-outlet pieces of the subscriber-browser
 * recovery route (BROWSER_SESSION), lifted from the recover-*-browser.js
 * scripts so the gap-recovery driver and the manual scripts share one copy
 * (BRO-7171 Stage 2). Only The Stage is lifted so far; the other five scripts
 * (nyt, newyorker, wapo, thetimes, wsj) still own their extractors, and the
 * driver records `no_adapter` for those outlets instead of guessing.
 *
 * Session rules (revised plan item 8): one persistent Chrome profile per
 * outlet OUTSIDE /tmp, the same one renew-cookies.js uses
 * (cookie-renew.profileDir), opened only while holding the cookie-renew lock
 * so the two never fight over the profile; the auth probe runs once per batch.
 */

const path = require('path');

/** Read The Stage article from the live authenticated page. */
async function extractThestage(page, url) {
  const { extractArticleText } = require('./article-extractor');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  const html = await page.content();
  if (/verify you.re not a robot|access denied|too many requests/i.test(html)) {
    return { error: 'Bot-check challenge detected', html };
  }
  const text = extractArticleText(html, 'thestage.co.uk');
  const title = await page.title();
  if (!text) return { error: 'No article body element found (extractStageBody returned null — likely logged out)', title, html };
  return { text, title, len: text.length, html };
}

const ADAPTERS = Object.freeze({
  thestage: Object.freeze({
    outletIds: ['thestage'],
    cookieDomain: 'thestage.co.uk',
    testUrl: 'https://www.thestage.co.uk/reviews/a-midsummer-nights-dream-review-shakespeares-globe-london-emily-lim',
    minAuthChars: 500,
    extract: extractThestage,
    labels: {
      fetchMethod: 'thestage-subscriber-browser-session',
      sourceMethod: 'thestage-subscriber-recovery-login',
      contentTierReasonFallback: 'Recovered via authenticated The Stage browser session (gap-recovery driver)',
    },
  }),
});

function adapterFor(outletId) {
  for (const [name, a] of Object.entries(ADAPTERS)) if (a.outletIds.includes(outletId)) return { name, ...a };
  return null;
}

function renewLockPath() {
  // The main checkout's data/cookies (worktrees have no cookie jar of their own).
  let root = null;
  try { root = require('./review-texts-dir').mainWorktreeOf(path.join(__dirname, '..', '..')); } catch { /* fall back */ }
  root = root || path.join(require('os').homedir(), 'Broadwayscore');
  return path.join(root, 'data', 'cookies', '_renew.lock');
}

/**
 * Open the outlet's persistent profile with its cookies and run the auth probe.
 * @returns {Promise<{ok:true, session:{extract:Function, close:Function}}|{ok:false, outcome:'auth_failed'|'browser_unavailable', reason:string}>}
 */
async function openSession(adapter) {
  const { acquireLock, profileDir } = require('./cookie-renew');
  const release = acquireLock(renewLockPath());
  if (!release) return { ok: false, outcome: 'browser_unavailable', reason: 'cookie_renew_lock_held' };
  let context;
  try {
    const { loadCookiesForDomain } = require('./cookie-loader');
    const cookies = loadCookiesForDomain(adapter.cookieDomain);
    if (!cookies || !cookies.length) { release(); return { ok: false, outcome: 'auth_failed', reason: 'no_cookies' }; }
    const { launchOtpBrowser } = require('./otp-login-helpers');
    context = await launchOtpBrowser(profileDir(adapter.name), { headless: false });
    await context.addCookies(cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
      expires: c.expires && c.expires > 0 ? c.expires : undefined,
      httpOnly: !!c.httpOnly, secure: !!c.secure,
      sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
    })));
    const page = context.pages()[0] || (await context.newPage());
    const probe = await adapter.extract(page, adapter.testUrl).catch((e) => ({ error: e.message }));
    const close = async () => { try { await context.close(); } finally { release(); } };
    if (probe.error || !probe.text || probe.len < adapter.minAuthChars) {
      await close();
      return { ok: false, outcome: 'auth_failed', reason: `auth_probe: ${probe.error || `${probe.len || 0} chars`}` };
    }
    return { ok: true, session: { extract: (url) => adapter.extract(page, url), close } };
  } catch (e) {
    try { if (context) await context.close(); } catch { /* ignore */ }
    release();
    return { ok: false, outcome: 'browser_unavailable', reason: `launch_failed: ${e.message.split('\n')[0]}` };
  }
}

module.exports = { ADAPTERS, adapterFor, openSession, extractThestage };
