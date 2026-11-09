'use strict';
/**
 * browser-outlet-adapters.js — per-outlet pieces of the subscriber-browser
 * recovery route (BROWSER_SESSION), lifted from the recover-*-browser.js
 * scripts so the gap-recovery driver and the manual scripts share one copy
 * (BRO-7171 Stage 2; the other five outlets lifted in Stage 4). An outlet with
 * no entry here gets `no_adapter` from the driver instead of a guess.
 *
 * Session rules (revised plan item 8): one persistent Chrome profile per
 * outlet OUTSIDE /tmp, the same one renew-cookies.js uses
 * (cookie-renew.profileDir), opened only while holding the cookie-renew lock
 * so the two never fight over the profile; the auth probe runs once per batch.
 */

const path = require('path');

/**
 * Navigate and report a hard "not found". A 404/410 from the outlet is evidence
 * about the stored url (Stage 4: sampled wsj and newyorker urls answered 404
 * with the session logged in; the old extractors read the 404 template and
 * called it "logged out"). Returns null when the page loaded.
 */
async function gotoOrNotFound(page, url, waitMs) {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const status = res ? res.status() : 0;
  if (status === 404 || status === 410) return { error: `HTTP ${status} not found`, notFound: true, status };
  await page.waitForTimeout(waitMs);
  return null;
}

/**
 * Server-HTML extractor (article-extractor's outlet rules on the rendered page).
 * The Stage and The Times; the bodies are the ones the manual scripts used.
 */
function htmlExtractor({ host, waitMs = 1500, label }) {
  return async function extract(page, url) {
    const { extractArticleText } = require('./article-extractor');
    const nf = await gotoOrNotFound(page, url, waitMs);
    if (nf) return nf;
    const html = await page.content();
    if (/verify you.re not a robot|access denied|too many requests/i.test(html)) {
      return { error: 'Bot-check challenge detected', html };
    }
    const text = extractArticleText(html, host);
    const title = await page.title();
    if (!text) return { error: `No article body element found (${label} returned null — likely logged out)`, title, html };
    return { text, title, len: text.length, html };
  };
}

/**
 * Client-DOM extractor: first matching selector (or the longest, for WaPo,
 * whose .article-body wraps only the lede on some templates: 269 vs 6,693
 * chars, confirmed live 2026-08-02). Bodies lifted from recover-nyt/
 * newyorker/wapo/wsj-browser.js.
 */
function domExtractor({ selectors, botRe, pickLongest = false, stripGaa = true, waitMs = 1800, waitForSelector = null, botLabel = 'Bot-check challenge detected' }) {
  return async function extract(page, url) {
    const target = stripGaa ? url.split('?gaa_')[0] : url;
    const nf = await gotoOrNotFound(page, target, waitMs); // let client-side entitlement hydration resolve
    if (nf) return nf;
    // Client-rendered body (WSJ, Stage 4: <article> absent at 1.8s, 6,107
    // chars at 4s on the logged-in auth page): wait for it, bounded.
    if (waitForSelector) await page.waitForSelector(waitForSelector, { timeout: 10000 }).catch(() => {});
    const r = await page.evaluate(({ selectors: sels, botSrc, pickLongest: longest }) => {
      const bodyText = (document.body && document.body.innerText) || '';
      if (new RegExp(botSrc, 'i').test(bodyText)) return { bot: true };
      const els = sels.map((s) => document.querySelector(s)).filter(Boolean);
      const texts = els.map((el) => el.innerText || '');
      const text = longest ? texts.reduce((b, t) => (t.length > b.length ? t : b), '') : (texts[0] || '');
      return { text, title: document.title || '' };
    }, { selectors, botSrc: botRe.source, pickLongest });
    if (r.bot) return { error: botLabel };
    if (!r.text) return { error: 'No article body element found', title: r.title };
    const html = await page.content();
    return { text: r.text, title: r.title, len: r.text.length, html };
  };
}

/** Read The Stage article from the live authenticated page. */
const extractThestage = htmlExtractor({ host: 'thestage.co.uk', label: 'extractStageBody' });

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
  // Stage 4: the other five recover-*-browser.js outlets. Profile names
  // (the adapter key) match the persistent profiles renew-cookies.js keeps.
  nyt: Object.freeze({
    // Stage 4 live batch 2026-11-09: 4/20 accepted (20%, under the 30% bar).
    // Most rejects were not_longer (the stored text already is the whole
    // review: false truncation) or 404s on old urls; one accept was a
    // multi-show London column (fixed by hand). Off for the nightly.
    nightly: false,
    outletIds: ['nytimes'],
    cookieDomain: 'nytimes.com',
    testUrl: 'https://www.nytimes.com/2022/10/06/theater/1776-review-broadway.html',
    minAuthChars: 1500,
    extract: domExtractor({ selectors: ['section[name="articleBody"]', '[itemprop="articleBody"]', 'article'], botRe: /unusual activity|verify you.re not a robot/ }),
    labels: {
      fetchMethod: 'nyt-subscriber-browser-session',
      sourceMethod: 'nyt-subscriber-recovery-otp-login',
      contentTierReasonFallback: 'Recovered via authenticated NYT browser session (gap-recovery driver)',
    },
  }),
  newyorker: Object.freeze({
    outletIds: ['newyorker'],
    cookieDomain: 'newyorker.com',
    testUrl: 'https://www.newyorker.com/magazine/2023/03/20/dolls-house-review-broadway-jessica-chastain',
    minAuthChars: 1500,
    extract: domExtractor({ selectors: ['[data-testid="BodyWrapper"]', '[data-testid="ArticleBodyWrapper"]', '.body__inner-container', 'article'], botRe: /access denied|verify you.re not a robot/ }),
    labels: {
      fetchMethod: 'newyorker-subscriber-browser-session',
      sourceMethod: 'newyorker-subscriber-recovery-otp-login',
      contentTierReasonFallback: 'Recovered via authenticated New Yorker browser session (gap-recovery driver)',
    },
  }),
  wapo: Object.freeze({
    // Stage 4 live batches 2026-11-09: 0/40 accepted. 31 stored urls answer a
    // real 404 ("Page Not Found", confirmed in a fresh browser too); those
    // rows are dead urls for ARCHIVE, not a session problem. Off for the nightly.
    nightly: false,
    outletIds: ['washpost'],
    cookieDomain: 'washingtonpost.com',
    testUrl: 'https://www.washingtonpost.com/entertainment/theater/2025/09/29/masquerade-phantom-review/',
    minAuthChars: 1000,
    extract: domExtractor({ selectors: ['article[data-qa="article-body"]', '[itemprop="articleBody"]', '.article-body', 'article'], botRe: /unusual activity|verify you.re not a robot|access denied/, pickLongest: true, stripGaa: false }),
    labels: {
      fetchMethod: 'wapo-subscriber-browser-session',
      sourceMethod: 'wapo-subscriber-recovery-login',
      contentTierReasonFallback: 'Recovered via authenticated WaPo browser session (gap-recovery driver)',
    },
  }),
  wsj: Object.freeze({
    // Stage 4 live batch 2026-11-09: 1/20 accepted. 16 stored urls answer a
    // real 404 ("Page Not Found", confirmed in a fresh browser): wrong urls,
    // work for url rediscovery, not the session. Off for the nightly.
    nightly: false,
    outletIds: ['wsj'],
    cookieDomain: 'wsj.com',
    testUrl: 'https://www.wsj.com/articles/smash-review-an-inside-broadway-musical-bdcafc62',
    minAuthChars: 1500,
    extract: domExtractor({ selectors: ['article'], waitForSelector: 'article', botRe: /verification required|slide right to secure/, botLabel: 'DataDome challenge detected' }),
    labels: {
      fetchMethod: 'wsj-subscriber-browser-session',
      sourceMethod: 'wsj-subscriber-recovery-otp-login',
      contentTierReasonFallback: 'Recovered via authenticated WSJ browser session (gap-recovery driver)',
    },
  }),
  thetimes: Object.freeze({
    // Stage 4 live batch 2026-11-09 (times-uk): 0/20 accepted. 12 not_longer:
    // the stored text already was the whole review, read as truncated because
    // of the listing footer + promo line (fixed in trailer-signatures
    // stripTimesFooter: 39 files flip to complete on the next rebuild); 6
    // extractor_null. Off for the nightly.
    nightly: false,
    outletIds: ['times-uk', 'sunday-times'],
    cookieDomain: 'thetimes.co.uk',
    testUrl: 'https://www.thetimes.com/culture/theatre-dance/article/1536-review-theatre-henry-viii-anne-boleyn-v6hg7frjb',
    minAuthChars: 500,
    extract: htmlExtractor({ host: 'thetimes.com', label: 'extractTimesBody' }),
    labels: {
      fetchMethod: 'thetimes-subscriber-browser-session',
      sourceMethod: 'thetimes-subscriber-recovery-login',
      contentTierReasonFallback: 'Recovered via authenticated Times UK browser session (gap-recovery driver)',
    },
  }),
});

function adapterFor(outletId) {
  for (const [name, a] of Object.entries(ADAPTERS)) if (a.outletIds.includes(outletId)) return { name, ...a };
  return null;
}

/**
 * Stage 4 30% rule, per adapter: an adapter whose measured live yield is under
 * 30% sets `nightly: false` and the unattended run plans no BROWSER_SESSION
 * for it. A manual run that names the outlet (--outlet=nytimes) still may.
 * @param {string} outletId
 * @param {{explicitOutlets?: Set<string>|string[]|null}} [o]
 */
function adapterUsable(outletId, { explicitOutlets = null } = {}) {
  const a = adapterFor(outletId);
  if (!a) return false;
  if (a.nightly !== false) return true;
  return !!explicitOutlets && [...explicitOutlets].includes(outletId);
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
    return { ok: true, session: { extract: (url) => adapter.extract(page, url), probe: () => adapter.extract(page, adapter.testUrl), close } };
  } catch (e) {
    try { if (context) await context.close(); } catch { /* ignore */ }
    release();
    return { ok: false, outcome: 'browser_unavailable', reason: `launch_failed: ${e.message.split('\n')[0]}` };
  }
}

module.exports = { ADAPTERS, adapterFor, adapterUsable, openSession, extractThestage, gotoOrNotFound };
