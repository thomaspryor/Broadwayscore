'use strict';

/**
 * Tours To You (tourstoyou.org) page fetching, shared by enrich-tour-dates.js,
 * create-tour-entries.js, discover-running-tours.js and fetch-tour-schedules.js.
 * Lives in lib with no scraper.js dependency so a plain-GET caller does not
 * pull in the paid-scraper chain (and its spend-ledger obligations, BRO-4601).
 */

const https = require('https');
const { scheduleSlugs, parseTourSchedule } = require('./tour-schedule');

const USER_AGENT = 'BroadwayScorecardBot/1.0 (https://broadwayscorecard.com; contact@broadwayscorecard.com)';

/** Plain GET. Tours To You is a public WordPress site with no bot wall. */
function fetchText(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 20000 }, (res) => {
      // A renamed show page answers 301 (tourstoyou.org/shows/six/).
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

/**
 * The tour's schedule page, trying each candidate slug. With a fetchPage
 * (scraper.js), a page that fails or parses empty gets one plain GET as a
 * fallback; without one, a single plain GET per slug.
 * @returns {Promise<{url: string|null, html: string}>}
 */
async function fetchSchedule(tour, fetchPage = null) {
  // scheduleSlugs returns at most 2 (the stored slug, or title and
  // title-the-musical); the slice states that bound for audit-run-budget-coverage.
  for (const slug of scheduleSlugs(tour).slice(0, 2)) {
    const url = `https://tourstoyou.org/shows/${slug}/`;
    let html = '';
    if (fetchPage) {
      try {
        const res = await fetchPage(url);
        html = typeof res === 'string' ? res : (res && (res.html || res.content)) || '';
      } catch (e) {
        console.log(`  fetchPage failed for ${url}: ${e.message}; trying a plain GET`);
      }
    }
    if (!parseTourSchedule(html).length) {
      try { html = await fetchText(url); } catch (e) { console.log(`  plain GET failed for ${url}: ${e.message}`); }
    }
    if (parseTourSchedule(html).length) return { url, html };
  }
  return { url: null, html: '' };
}

module.exports = { fetchText, fetchSchedule, USER_AGENT };
