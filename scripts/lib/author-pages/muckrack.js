'use strict';
/**
 * muckrack.js — Fetch articles from a critic's Muckrack profile page.
 *
 * Exported from scripts/lib/author-pages/ so S1-T7 can dedupe across sources
 * via the `source` field.
 *
 * BRO-6956: muckrack.com sits behind a Cloudflare managed challenge on every
 * path (even robots.txt). Bright Data times out, ScrapingBee 500s (plain,
 * render_js and premium), Scrapingdog stealth fails, and the Playwright tier
 * hands back a 300 KB "Technical Issue | Muck Rack" block page that fetchPage
 * accepts as success — which the audit then read as "no-articles-found" for
 * every critic. A Browserbase session (captcha solving on) gets the real
 * profile page, so that is the primary route: ONE session per process, shared
 * by every critic (a new tab per page), closed by close(). fetchPage stays as
 * the fallback when Browserbase is unavailable (no keys, kill switch, cap).
 *
 * Whatever route answers, a page that is not a Muck Rack profile page is a
 * failed fetch, never "0 articles" (isProfilePage).
 */
const path = require('path');
const { fetchPage } = require(path.join(__dirname, '../scraper.js'));

module.exports = { fetch, close, isProfilePage, parseArticles, fetchHtmlDefault, _resetForTest, _isClosed: () => _closed };

const BB_KEYS = ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'];

/** A real profile page is titled "Articles by <Name>'s Profile | ... | Muck Rack". */
function isProfilePage(html) {
  if (!html || typeof html !== 'string') return false;
  const t = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
  return /Articles by .+Muck Rack/i.test(t);
}

function parseArticles(html) {
  const out = [];
  const matches = [...html.matchAll(/<h\d[^>]*>\s*<a[^>]+href="(https?:[^"]+)"[^>]*>([^<]{6,200})<\/a>/g)];
  for (const m of matches) {
    const u = m[1];
    const title = m[2].replace(/\s+/g, ' ').trim();
    if (/msn\.com|gossipbucket|flipboard|google\.com|aol\.com|yahoo\.com|inkl\.com|ourcommunitynow|thepoke/.test(u)) continue;
    out.push({ url: u, title, source: 'muckrack' });
  }
  return out;
}

// ── Browserbase session (lazy, shared) ───────────────────────────────────────
let _bb = null; // Promise<{browser, context} | null>
let _closed = false; // close() is final: a later fetch must not open an unowned session
// Consecutive failed page reads across every route. Past the limit the host is
// treated as unreachable for the rest of the run: each further read would only
// spend BD/SB/Browserbase time on a challenge it cannot pass (ship-check BRO-6956).
const MAX_CONSECUTIVE_FAILURES = 3;
let _consecutiveFailures = 0;
let _readerForTest = null;
// Muck Rack answers "Rate limited | Muck Rack" when the audit's 4 parallel
// critics read at once (seen live 2026-11-27). So every read goes through one
// queue, MIN_GAP_MS apart, and a rate-limit page backs off and retries before
// it counts as a failed read.
const MIN_GAP_MS = Number(process.env.MUCKRACK_MIN_GAP_MS || 2000);
const RATE_LIMIT_BACKOFF_MS = [20000, 60000];
let _queue = Promise.resolve();
let _lastReadAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRateLimited = (html) => /<title[^>]*>\s*Rate limited/i.test(html || '');
/** Test seam: replace the network read and reset run state. */
function _resetForTest(reader = null) { _readerForTest = reader; _consecutiveFailures = 0; _closed = false; _bb = null; _queue = Promise.resolve(); _lastReadAt = 0; }

function bbCreds() {
  const env = {};
  for (const k of BB_KEYS) if (process.env[k]) env[k] = process.env[k];
  if (BB_KEYS.some((k) => !env[k])) {
    try { Object.assign(env, require(path.join(__dirname, '../load-env.js')).readEnvKeys(BB_KEYS)); } catch (_) { /* no .env */ }
  }
  return BB_KEYS.every((k) => env[k]) ? { apiKey: env.BROWSERBASE_API_KEY, projectId: env.BROWSERBASE_PROJECT_ID } : null;
}

function bbContext() {
  if (_bb) return _bb;
  _bb = (async () => {
    if (_closed || process.env.MUCKRACK_BROWSERBASE_DISABLED === '1') return null;
    const creds = bbCreds();
    if (!creds) return null;
    try {
      const { createBbSession } = require(path.join(__dirname, '../browserbase-session.js'));
      const { chromium } = require('playwright');
      const session = await createBbSession({
        ...creds,
        caller: 'audit-critic-coverage:muckrack',
        purpose: 'Muck Rack critic profile pages (Cloudflare managed challenge)',
        host: 'muckrack.com',
        category: 'discovery',
        body: { timeout: 3600, browserSettings: { solveCaptchas: true } },
      });
      const browser = await chromium.connectOverCDP(session.connectUrl);
      const context = browser.contexts()[0] || await browser.newContext();
      return { browser, context };
    } catch (e) {
      console.warn(`::warning::[muckrack] Browserbase unavailable (${e.message}); falling back to fetchPage, which Cloudflare usually blocks`);
      return null;
    }
  })();
  return _bb;
}

/** Close the shared Browserbase session, if one was opened. Safe to call twice. */
async function close() {
  _closed = true;
  const p = _bb;
  _bb = null;
  if (!p) return;
  const bb = await p.catch(() => null);
  if (bb) await bb.browser.close().catch(() => {});
}

async function fetchHtmlDefault(url) {
  if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    throw new Error(`skipped: muckrack.com unreachable this run (${_consecutiveFailures} consecutive failed reads)`);
  }
  const run = _queue.then(() => readWithBackoff(url));
  _queue = run.catch(() => {});
  try {
    const html = await run;
    if (isProfilePage(html)) _consecutiveFailures = 0; else _consecutiveFailures++;
    return html;
  } catch (e) {
    _consecutiveFailures++;
    throw e;
  }
}

async function readWithBackoff(url) {
  const reader = _readerForTest || readOnce;
  const gap = _readerForTest ? 0 : MIN_GAP_MS;
  for (let attempt = 0; ; attempt++) {
    const wait = _lastReadAt + gap - Date.now();
    if (wait > 0) await sleep(wait);
    _lastReadAt = Date.now();
    const html = await reader(url);
    if (!isRateLimited(html) || attempt >= RATE_LIMIT_BACKOFF_MS.length) return html;
    const back = _readerForTest ? 0 : RATE_LIMIT_BACKOFF_MS[attempt];
    console.warn(`  [muckrack] rate limited on ${url}; retrying in ${back / 1000}s`);
    await sleep(back);
  }
}

async function readOnce(url) {
  const bb = await bbContext();
  if (bb) {
    let page = null;
    try {
      const { readBrowserPage } = require(path.join(__dirname, '../browser-read-page.js'));
      page = await bb.context.newPage();
      const r = await readBrowserPage(page, url, { waits: 10 });
      if (isProfilePage(r.html) || isRateLimited(r.html)) return r.html;
      console.warn(`  [muckrack] Browserbase got a non-profile page for ${url} (title "${r.title}")`);
    } catch (e) {
      console.warn(`  [muckrack] Browserbase read failed for ${url}: ${e.message}`);
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }
  const r = await fetchPage(url, { timeout: 30000 });
  return r && r.content;
}

/**
 * Fetch articles listed on a critic's Muckrack profile.
 *
 * @param {string} slug  — Muckrack URL slug (e.g. 'jesse-green')
 * @param {number} maxPages — max pages to scrape (default 2)
 * @param {{fetchHtml?: (url: string) => Promise<string|null>}} [opts] — test seam
 * @returns {Promise<Array<{url: string, title: string, source: string}>>}
 */
async function fetch(slug, maxPages = 2, opts = {}) {
  const fetchHtml = opts.fetchHtml || fetchHtmlDefault;
  const all = [];
  for (let p = 1; p <= maxPages; p++) {
    const url = p === 1
      ? `https://muckrack.com/${slug}/articles`
      : `https://muckrack.com/${slug}/articles?page=${p}`;
    let html, fetchErr = null;
    try { html = await fetchHtml(url); } catch (e) { html = null; fetchErr = e; }
    if (!html || html.length < 5000 || !isProfilePage(html)) {
      // Page 1 failing means we learned nothing about this critic. Throw so the
      // caller records a failed source instead of "0 missing" (BRO-6927), and a
      // block/challenge page counts as failing (BRO-6956).
      if (p === 1) {
        const why = fetchErr ? fetchErr.message
          : !html || html.length < 5000 ? `got ${html ? html.length : 0} bytes`
          : `not a profile page (title "${((html.match(/<title[^>]*>([^<]*)/i) || [])[1] || '').trim().slice(0, 80)}")`;
        throw new Error(`muckrack ${url}: ${why}`);
      }
      break;
    }
    const found = parseArticles(html);
    all.push(...found);
    if (found.length === 0) {
      console.warn(`  [muckrack] WARN: ${url} returned ${html.length} bytes but 0 articles parsed - possible structural drift, filtered links, or no recent bylines`);
    }
    if (found.length < 10) break;
  }
  return all;
}
