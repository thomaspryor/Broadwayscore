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
 * accepted as success — which the audit then read as "no-articles-found" for
 * every critic. A Browserbase session (captcha solving on) gets the real
 * profile page, so that is the route whenever Browserbase is available. The
 * session lifecycle (single-flight create, one tab per read, Cloudflare
 * warm-up, rotation, release on a failed connect, refusal latching) is the
 * opening-night lane's createBrowserbaseFetcher, not a copy of it. fetchPage
 * is used only when Browserbase is unavailable (no keys, kill switch, cap),
 * never as a fallback for a Browserbase read: it cannot pass the challenge.
 *
 * Every read is classified (classifyPage): a profile page; a missing profile
 * (404: our slug is not a Muck Rack slug, per critic); rate limited (backed
 * off and retried); or blocked. Only blocked reads count toward the run-wide
 * MAX_CONSECUTIVE_BLOCKS latch, so critics without a profile never switch the
 * host off for everyone else (ship-check BRO-6956).
 */
const path = require('path');
const { fetchPage } = require(path.join(__dirname, '../scraper.js'));

module.exports = { fetch, close, isProfilePage, classifyPage, parseArticles, _resetForTest, _isClosed: () => _closed };

const BB_KEYS = ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'];
const SPAM = /msn\.com|gossipbucket|flipboard|google\.com|aol\.com|yahoo\.com|inkl\.com|ourcommunitynow|thepoke/;

function pageTitle(html) {
  return (((html || '').match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '').trim();
}

/** A real profile page is titled "Articles by <Name>'s Profile | ... | Muck Rack". */
function isProfilePage(html) {
  return typeof html === 'string' && /Articles by .+Muck Rack/i.test(pageTitle(html));
}

/** @returns {'profile'|'missing'|'rate-limited'|'blocked'} */
function classifyPage(html) {
  if (isProfilePage(html)) return 'profile';
  const t = pageTitle(html);
  if (/^\s*Rate limited/i.test(t)) return 'rate-limited';
  if (/\b404\b|Page Not Found/i.test(t)) return 'missing';
  return 'blocked';
}

/**
 * @returns {{articles: Array<{url,title,source}>, headings: number, matched: number}}
 *   headings = story-title blocks on the page, matched = parsed before the spam filter
 */
function parseArticles(html) {
  const articles = [];
  const matches = [...html.matchAll(/<h\d[^>]*>\s*<a[^>]+href="(https?:[^"]+)"[^>]*>([^<]{6,200})<\/a>/g)];
  for (const m of matches) {
    const u = m[1];
    if (SPAM.test(u)) continue;
    articles.push({ url: u, title: m[2].replace(/\s+/g, ' ').trim(), source: 'muckrack' });
  }
  return { articles, headings: (html.match(/class="news-story-title"/g) || []).length, matched: matches.length };
}

// ── Run state ────────────────────────────────────────────────────────────────
// Muck Rack answers "Rate limited | Muck Rack" when the audit's 4 parallel
// critics read at once (seen live 2026-11-27), so every read goes through one
// queue, MIN_GAP_MS apart, and a rate-limit page backs off before it counts.
const MIN_GAP_MS = Number(process.env.MUCKRACK_MIN_GAP_MS || 2000);
const RATE_LIMIT_BACKOFF_MS = [20000, 60000];
const MAX_CONSECUTIVE_BLOCKS = 3;
let _queue = Promise.resolve();
let _lastReadAt = 0;
let _blocks = 0;
let _closed = false;
let _bb; // undefined = not built yet, null = unavailable
let _readerForTest = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function _resetForTest(reader = null) {
  _readerForTest = reader; _queue = Promise.resolve(); _lastReadAt = 0; _blocks = 0; _closed = false; _bb = undefined;
}

function browserbase() {
  if (_bb !== undefined) return _bb;
  _bb = null;
  if (_closed || process.env.MUCKRACK_BROWSERBASE_DISABLED === '1') return _bb;
  if (BB_KEYS.some((k) => !process.env[k])) {
    // Local runs keep the keys in .env; publish only these two, never the whole file.
    try { Object.assign(process.env, require(path.join(__dirname, '../load-env.js')).readEnvKeys(BB_KEYS)); } catch (_) { /* no .env */ }
  }
  if (BB_KEYS.some((k) => !process.env[k])) return _bb;
  const lane = require(path.join(__dirname, '../opening-night-lane/browserbase-fetch.js'));
  _bb = lane.createBrowserbaseFetcher({
    env: process.env,
    log: (m) => console.warn(`  [muckrack] ${m}`),
    caller: 'audit-critic-coverage:muckrack',
    host: 'muckrack.com',
    purpose: 'Muck Rack critic profile pages (Cloudflare managed challenge)',
    maxSessions: 3,
    sessionTimeoutSec: 3600,
    fetchTimeoutMs: 90000,
    createSession: (opts) => require(path.join(__dirname, '../browserbase-session.js')).createBbSession(opts),
    connect: (connectUrl) => require('playwright').chromium.connectOverCDP(connectUrl),
    readPage: (page, url, opts) => require(path.join(__dirname, '../browser-read-page.js')).readBrowserPage(page, url, { ...opts, waits: 10 }),
    releaseSession: lane.bbSessionReleaser(process.env),
  });
  return _bb;
}

/** Close the Browserbase session, if one was opened. Final: later reads use no session. */
async function close() {
  _closed = true;
  const bb = _bb;
  _bb = null;
  if (bb) await Promise.race([bb.close(), sleep(15000)]).catch(() => {});
}

/** One network read: html, or an error carrying `status` (404/410 = missing profile). */
async function readOnce(url) {
  const bb = browserbase();
  if (bb && bb.available()) {
    try {
      return (await bb.fetch(url)).content;
    } catch (e) {
      if (!e || !e.bbUnavailable) throw e; // challenge, timeout, 404: the answer for this read, no paid fallback
      console.warn(`::warning::[muckrack] Browserbase unavailable (${e.message}); using fetchPage, which Cloudflare usually blocks`);
    }
  }
  const r = await fetchPage(url, { timeout: 30000 });
  return r && r.content;
}

/** Queued, spaced, rate-limit-aware read. @returns {Promise<{kind: string, html: string|null, why: string}>} */
function read(url) {
  const run = _queue.then(async () => {
    // Checked inside the queue so reads already waiting see a latch tripped ahead of them.
    if (_blocks >= MAX_CONSECUTIVE_BLOCKS) {
      return { kind: 'blocked', html: null, why: `skipped: muckrack.com blocked this run (${_blocks} consecutive blocked reads)` };
    }
    const reader = _readerForTest || readOnce;
    const gap = _readerForTest ? 0 : MIN_GAP_MS;
    let res;
    for (let attempt = 0; ; attempt++) {
      const wait = _lastReadAt + gap - Date.now();
      if (wait > 0) await sleep(wait);
      _lastReadAt = Date.now();
      try {
        const html = await reader(url);
        const kind = html && html.length >= 5000 ? classifyPage(html) : 'blocked';
        res = { kind, html, why: kind === 'profile' ? '' : `${kind} (${html ? `${html.length} bytes, title "${pageTitle(html).slice(0, 80)}"` : 'no content'})` };
      } catch (e) {
        const missing = e && (e.status === 404 || e.status === 410);
        res = { kind: missing ? 'missing' : 'blocked', html: null, why: e && e.message };
      }
      if (res.kind !== 'rate-limited' || attempt >= RATE_LIMIT_BACKOFF_MS.length) break;
      const back = _readerForTest ? 0 : RATE_LIMIT_BACKOFF_MS[attempt];
      console.warn(`  [muckrack] rate limited on ${url}; retrying in ${back / 1000}s`);
      await sleep(back);
    }
    if (res.kind === 'profile') _blocks = 0;
    else if (res.kind === 'blocked' || res.kind === 'rate-limited') _blocks++;
    return res;
  });
  _queue = run.catch(() => {});
  return run;
}

/**
 * Fetch articles listed on a critic's Muckrack profile.
 *
 * @param {string} slug  — Muckrack URL slug (e.g. 'jesse-green')
 * @param {number} maxPages — max pages to scrape (default 2)
 * @returns {Promise<Array<{url: string, title: string, source: string}>>}
 */
async function fetch(slug, maxPages = 2) {
  const all = [];
  for (let p = 1; p <= maxPages; p++) {
    const url = p === 1
      ? `https://muckrack.com/${slug}/articles`
      : `https://muckrack.com/${slug}/articles?page=${p}`;
    const r = await read(url);
    if (r.kind !== 'profile') {
      // Page 1 failing means we learned nothing about this critic: throw so the
      // audit records a failed source instead of "0 missing" (BRO-6927, BRO-6956).
      if (p === 1) throw new Error(`muckrack ${url}: ${r.kind === 'missing' ? `no Muck Rack profile at this slug (set a muckrack override in data/critic-author-pages.json): ${r.why}` : r.why}`);
      break;
    }
    const { articles, headings, matched } = parseArticles(r.html);
    // Story headings on the page but none matched the parser = markup drift, not an empty critic.
    if (p === 1 && headings > 0 && matched === 0) {
      throw new Error(`muckrack ${url}: ${headings} story headings but 0 parsed (structural drift)`);
    }
    all.push(...articles);
    if (articles.length === 0) {
      console.warn(`  [muckrack] WARN: ${url} profile page has 0 usable articles (${matched} matched, all filtered) - no recent bylines or only syndicated copies`);
    }
    if (matched < 10) break;
  }
  return all;
}
