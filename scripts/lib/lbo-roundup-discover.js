/**
 * London Box Office roundup discovery (WE/OWE).
 *
 * Extracted verbatim from opening-night-poller.js block 1d (2026-07-10) so the
 * same discovery chain — curated URL map → local archive → live news-sitemap
 * scan — is callable by both the poller and the review-gap audit
 * (audit-show-review-gap.js WE reference sources). Per the repo convention for
 * per-source discovery libs (bww-rr-discover.js, show-score-discover.js).
 *
 * Returns the validated roundup HTML; PARSING stays in
 * scrape-london-box-office-roundups.js (extractReviewsFromLBO).
 *
 * Discovery chain:
 *   1. Curated map data/lbo-roundup-urls.json (shows[showId] → URL) — fetched live
 *   2. Archived page data/aggregator-archive/lbo-roundups/{showId}.html
 *   3. Live sitemap https://www.londonboxoffice.co.uk/news-sitemap.xml — slug →
 *      matchTitleToShow high-confidence match ONLY (the old "≥2 title words"
 *      heuristic caused the Stuart King contamination, 2026-04-25)
 *
 * Every candidate is validated with validateRoundupPageTitle before being
 * returned; a mismatching ARCHIVE file is quarantined (renamed .mismatch) so
 * future runs don't repeat the mistake. A sitemap hit that validates is
 * archived for future runs.
 *
 * @param {object} show - shows.json record ({ id, title, ... })
 * @param {object} [opts]
 * @param {string}   [opts.dataDir]   Repo data/ dir (default: ../../data)
 * @param {Function} [opts.fetchPage] Injected for tests
 * @param {Function} [opts.log]       Logger (default console.log)
 * @returns {Promise<{html: string, url: string|null, source: 'curated'|'archive'|'sitemap'}|null>}
 */

const fs = require('fs');
const path = require('path');
const { matchTitleToShow, validateRoundupPageTitle } = require('./show-matching');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');

async function discoverLboRoundupHtml(show, opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const fetchPage = opts.fetchPage || require('./scraper').fetchPage;
  const log = opts.log || console.log;
  // opts.stats (optional, mutated): { fetchErrors } — see tr-roundup-discover.
  const stats = opts.stats || {};
  stats.fetchErrors = 0;

  // 1. Curated URL map
  const lboMapPath = path.join(dataDir, 'lbo-roundup-urls.json');
  let lboUrl = null;
  try {
    const lboMap = JSON.parse(fs.readFileSync(lboMapPath, 'utf8'));
    lboUrl = (lboMap.shows || {})[show.id];
  } catch (e) {}

  const lboArchivePath = path.join(dataDir, 'aggregator-archive', 'lbo-roundups', `${show.id}.html`);

  let lboHtml = null;
  let lboHtmlSource = null; // 'curated' | 'archive' | 'sitemap'
  let foundUrl = lboUrl || null;

  if (lboUrl) {
    log(`    Curated URL: ${lboUrl}`);
    try {
      const lboResult = await fetchPage(lboUrl, { renderJs: false });
      lboHtml = lboResult?.content || null;
      if (lboHtml) lboHtmlSource = 'curated';
    } catch (e) {
      stats.fetchErrors++;
      log(`    LBO fetch error: ${e.message}`);
    }
  } else if (fs.existsSync(lboArchivePath)) {
    log('    Using archived LBO page');
    lboHtml = fs.readFileSync(lboArchivePath, 'utf8');
    lboHtmlSource = 'archive';
  }

  // 3. Fallback: live sitemap discovery (free, ~16 entries)
  if (!lboHtml) {
    try {
      let sitemapXml = null;
      try {
        const smResult = await fetchPage('https://www.londonboxoffice.co.uk/news-sitemap.xml', { renderJs: false });
        sitemapXml = smResult?.content || null;
      } catch (e) { stats.fetchErrors++; /* sitemap fetch failed, continue */ }
      if (sitemapXml) {
        const reviewUrls = [...sitemapXml.matchAll(/<loc>(https:\/\/www\.londonboxoffice\.co\.uk\/news\/post\/[^<]*review[^<]*)<\/loc>/gi)]
          .map(m => m[1])
          .filter(url => {
            const slug = url.split('/').pop().toLowerCase();
            return slug.includes('review') && !slug.includes('photo') && !slug.includes('cast-announced') && !slug.includes('announces');
          });
        const findHighConfidence = (urls) => urls.find(url => {
          const slug = url.split('/').pop()
            .replace(/^review-(?:round-?up-)?/i, '')
            .replace(/-review(?:-[\w-]+)?$/i, '')
            .replace(/-/g, ' ')
            .toLowerCase();
          // Roundup URLs often carry a trailing venue name that isn't in the
          // show title (e.g. "death note the musical barbican theatre" for
          // review-roundup-death-note-the-musical-barbican-theatre) — LBO's
          // theatre-name suffix list (scrape-london-box-office-roundups.js's
          // stripTheatreFromSlug) doesn't cover every venue-name variant, so
          // instead of maintaining a second list here, progressively drop
          // trailing words and take the first high-confidence match. Capped
          // at 3 words: further trimming only degrades match confidence in
          // practice (verified against the Death Note roundup slug — 2
          // dropped words: high; 3: medium), so it doesn't risk false
          // positives on an unrelated short show title.
          const words = slug.split(' ').filter(Boolean);
          for (let drop = 0; drop <= 3 && drop < words.length; drop++) {
            const candidate = words.slice(0, words.length - drop).join(' ');
            const r = matchTitleToShow(candidate, [show], { market: 'west-end' });
            if (r && r.show && r.confidence === 'high') return true;
          }
          return false;
        });
        // Prefer a genuine multi-outlet "review-roundup-*" URL over a
        // single-critic individual review page when both exist for the same
        // show (#1708 — the loose "contains review" filter above treats
        // both URL shapes as equally valid candidates, but a real roundup
        // typically has several more citations than the individual page
        // alone; verified live for Death Note: 6 outlet citations on the
        // roundup vs. 1 on the individual page).
        const isRoundupSlug = (url) => /round-?up/i.test(url.split('/').pop());
        const match = findHighConfidence(reviewUrls.filter(isRoundupSlug))
          || findHighConfidence(reviewUrls.filter((u) => !isRoundupSlug(u)));
        if (match) {
          log(`    Sitemap match: ${match}`);
          try {
            const matchResult = await fetchPage(match, { renderJs: false });
            lboHtml = matchResult?.content || null;
            if (lboHtml) { lboHtmlSource = 'sitemap'; foundUrl = match; }
          } catch (e) { /* page fetch failed */ }
        }
      }
    } catch (e) {
      log(`    LBO sitemap fallback error: ${(e.message || '').substring(0, 60)}`);
    }
  }

  // Validate page title before returning / archiving — protects against
  // poisoned cache entries (archive source) and against any URL/sitemap
  // mismatch we may have missed (curated/sitemap sources).
  if (lboHtml) {
    const validation = validateRoundupPageTitle(lboHtml, show.title);
    if (!validation.ok) {
      log(`  LBO: skipping (${validation.reason}) — page title "${(validation.pageTitle || '').substring(0, 60)}" doesn't match "${show.title}"`);
      if (lboHtmlSource === 'archive' && fs.existsSync(lboArchivePath)) {
        // Quarantine the bad archive so future runs don't repeat the mistake.
        const quarantine = lboArchivePath + '.mismatch';
        try { fs.renameSync(lboArchivePath, quarantine); log(`    Quarantined bad archive → ${path.basename(quarantine)}`); } catch (e) {}
      }
      return null;
    } else if (lboHtmlSource === 'sitemap') {
      // Only persist after validation passed.
      try {
        const archDir = path.dirname(lboArchivePath);
        if (!fs.existsSync(archDir)) fs.mkdirSync(archDir, { recursive: true });
        fs.writeFileSync(lboArchivePath, lboHtml);
      } catch (e) { /* best-effort archive write */ }
    }
  }

  return lboHtml ? { html: lboHtml, url: foundUrl, source: lboHtmlSource } : null;
}

module.exports = { discoverLboRoundupHtml };
