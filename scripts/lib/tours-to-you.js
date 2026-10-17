'use strict';

/**
 * Tours To You (tourstoyou.org) page fetching, shared by enrich-tour-dates.js,
 * create-tour-entries.js, discover-running-tours.js and fetch-tour-schedules.js.
 * Lives in lib with no scraper.js dependency so a plain-GET caller does not
 * pull in the paid-scraper chain (and its spend-ledger obligations, BRO-4601).
 * A caller that wants the paid fallback passes its own fetchPage in.
 *
 * Politeness (BRO-4725): the site answered HTTP 429 to 11+ of ~250 back-to-back
 * page reads on 2026-10-05. Every request in this process goes through one
 * pacer (a minimum gap between requests that widens after each 429), and a 429
 * is retried after Retry-After or a backoff. Only when the plain GET is still
 * rate-limited does a caller-supplied fetchPage (the paid chain) get a turn,
 * at most MAX_FALLBACKS times per process so a hard block can't drain credits.
 */

const https = require('https');
const { scheduleSlugs, parseTourSchedule } = require('./tour-schedule');

const USER_AGENT = 'BroadwayScorecardBot/1.0 (https://broadwayscorecard.com; contact@broadwayscorecard.com)';
// 20 reads 1s apart drew no 429 from a cloud session (BRO-4725); CI runners
// share IPs, so leave more room. TOURS_TO_YOU_GAP_MS overrides.
const GAP_MS = Number(process.env.TOURS_TO_YOU_GAP_MS) || 2000;
const MAX_GAP_MS = 15000;
const RETRIES = 2;
const BACKOFF_BASE_MS = 15000;
const MAX_WAIT_MS = 60000;
const MAX_FALLBACKS = 10;
// A scraper.js fetchPage walks several tiers at up to 45s each; never start
// one with less than this left in the caller's budget (BRO-4725 review).
const FALLBACK_MIN_REMAINING_MS = 150000;
// After this many answers in a row without a 429, the gap halves back
// toward GAP_MS.
const RECOVER_AFTER = 10;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Retry-After (seconds or an HTTP date) in ms, or null. Pure. */
function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const at = Date.parse(s);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** How long to wait before retry `attempt` (0-based) after a 429. Pure. */
function backoffMs(attempt, retryAfterMs = null) {
  const wait = retryAfterMs != null ? retryAfterMs : BACKOFF_BASE_MS * 2 ** attempt;
  return Math.min(Math.max(wait, 1000), MAX_WAIT_MS);
}

/** Minimum gap between requests; slowDown() doubles it for the rest of the run. */
function createPacer(gapMs = GAP_MS, { now = Date.now, wait = sleep } = {}) {
  let gap = gapMs;
  let next = 0;
  let calm = 0;
  return {
    async take() {
      const t = now();
      if (t < next) await wait(next - t);
      next = Math.max(t, next) + gap;
    },
    slowDown() { gap = Math.min(gap * 2, MAX_GAP_MS); calm = 0; },
    ok() { if (gap > gapMs && ++calm >= RECOVER_AFTER) { gap = Math.max(gapMs, gap / 2); calm = 0; } },
    gap: () => gap,
  };
}

const pacer = createPacer();
const stats = { requests: 0, rateLimited: 0, retried: 0, fallbacks: 0, fallbackOk: 0 };

/** Plain GET. Tours To You is a public WordPress site with no bot wall. */
function fetchText(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 20000 }, (res) => {
      // A renamed show page answers 301 (tourstoyou.org/shows/six/).
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        const err = new Error(`HTTP ${res.statusCode}`);
        err.status = res.statusCode;
        err.retryAfterMs = parseRetryAfter(res.headers['retry-after']);
        return reject(err);
      }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

/**
 * fetchText through the shared pacer, retrying a 429. When the plain GET is
 * still rate-limited, `fallback` (a scraper.js fetchPage) is tried once.
 * `budget` (run-budget.js) stops a retry wait that would overrun the run.
 * Any other failure is thrown as before.
 */
async function politeFetchText(url, { fallback = null, budget = null, log = console.log, get = fetchText, wait = sleep, pace = pacer } = {}) {
  for (let attempt = 0; ; attempt++) {
    await pace.take();
    stats.requests++;
    try {
      const body = await get(url);
      if (pace.ok) pace.ok();
      return body;
    } catch (e) {
      if (e.status !== 429) throw e;
      stats.rateLimited++;
      pace.slowDown();
      const ms = backoffMs(attempt, e.retryAfterMs);
      const room = !budget || budget.remainingMs() > ms + 30000;
      if (attempt < RETRIES && room) {
        stats.retried++;
        log(`  429 from ${url}; waiting ${Math.round(ms / 1000)}s (requests now ${pace.gap() / 1000}s apart)`);
        await wait(ms);
        continue;
      }
      const fallbackRoom = !budget || budget.remainingMs() > FALLBACK_MIN_REMAINING_MS;
      if (fallback && fallbackRoom && stats.fallbacks < MAX_FALLBACKS) {
        stats.fallbacks++;
        try {
          const res = await fallback(url);
          const html = typeof res === 'string' ? res : (res && (res.html || res.content)) || '';
          // The schedule parser reads HTML tables; a markdown tier's text or a
          // bare error body would count as read yet parse to nothing, hiding
          // the page for a cycle.
          if (/<body|<html/i.test(html) && !(res && res.format === 'markdown')) { stats.fallbackOk++; log(`  429 from ${url}; read it through the scraper chain instead`); return html; }
          log(`  scraper fallback for ${url} returned no HTML`);
        } catch (fe) {
          log(`  scraper fallback failed for ${url}: ${fe.message}`);
        }
      }
      throw e;
    }
  }
}

/**
 * The tour's schedule page, trying each candidate slug with a polite plain
 * GET. A `fetchPage` (scraper.js) is used only when Tours To You rate-limits
 * the plain GET (BRO-4725); before that it went first on every page.
 * @returns {Promise<{url: string|null, html: string}>}
 */
async function fetchSchedule(tour, fetchPage = null, opts = {}) {
  // scheduleSlugs returns at most 2 (the stored slug, or title and
  // title-the-musical); the slice states that bound for audit-run-budget-coverage.
  for (const slug of scheduleSlugs(tour).slice(0, 2)) {
    const url = `https://tourstoyou.org/shows/${slug}/`;
    let html = '';
    try { html = await politeFetchText(url, { ...opts, fallback: fetchPage }); } catch (e) { console.log(`  plain GET failed for ${url}: ${e.message}`); }
    if (parseTourSchedule(html).length) return { url, html };
  }
  return { url: null, html: '' };
}

/**
 * A body that is a Tours To You show page, not a challenge or error page:
 * it names the site and has a title. Only such a page counts as read.
 */
function looksLikeShowPage(html) {
  return typeof html === 'string' && /<title/i.test(html) && /tourstoyou\.org/i.test(html);
}

module.exports = { looksLikeShowPage, fetchText, politeFetchText, fetchSchedule, parseRetryAfter, backoffMs, createPacer, stats, USER_AGENT, MAX_FALLBACKS };
