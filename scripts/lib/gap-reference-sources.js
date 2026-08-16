/**
 * West End reference sources for the review-gap audit (WE completeness gate).
 *
 * The gap audit (audit-show-review-gap.js) historically diffed our coverage
 * against Playbill Verdict + BWW Review Roundup — Broadway aggregators — so for
 * West End shows its reference list was empty and "no gaps" was vacuous (the
 * TKAM 2026 failure: 6 reviews live, 15 recoverable, zero alarms). This lib
 * gives the audit a WE reference: the union of outlets cited by the WE roundup
 * aggregators, via the SAME discovery libs the opening-night poller uses
 * (lib/{wet,tr,lbo}-roundup-discover.js) + the existing parsers.
 *
 * Design decisions from plan-review 2026-07-09 (5 reviewers):
 * - Rows may have url:null — WET's dominant table format cites outlet+stars
 *   with no link. The audit must coverage-match those by OUTLET, not URL
 *   (URL-only matching would silently drop the biggest citation class).
 * - Health floors: a source that DISCOVERED a roundup page but parsed 0 rows is
 *   an ERROR (`emptyParse`), never "no citations" — a WET template redesign
 *   must alarm, not turn the detector vacuously green. Total discovery blackout
 *   is reported via `allSourcesFailed`.
 * - Prior-run roundups: a roundup whose post date falls OUTSIDE the current
 *   opening window is marked priorRun (rows kept for REPORTING — a returning
 *   production's earlier-run roundup is informative under priorRuns — but such
 *   rows are NEVER ingest-eligible; auto-ingesting 2022 URLs onto a 2026 entry
 *   is the WET mass-ingestion incident class).
 * - The Stage roundups joined as an ARCHIVE-ONLY source (2026-07-11, was
 *   excluded from v1): The Stage is cookie/Browserbase-gated so the audit never
 *   fetches it live — gather-reviews/opening-night-poller archive the roundup
 *   HTML when their authenticated fetch succeeds, and the audit consumes
 *   data/aggregator-archive/thestage-roundups/{id}.html on later runs. The v1
 *   flap concern (a source silently absent 95% of the time makes set-change
 *   alert dedup flap) doesn't apply to an archive: once the file lands it is
 *   present on every subsequent run. Absence stays EXPECTED (pre-archive, or a
 *   checkout without the archive) — the source is `passive` and never counts
 *   toward allSourcesFailed. Stagedoor remains excluded (archives private AND
 *   it needs a Stagedoor ID — no per-show file to consume).
 *
 * @module gap-reference-sources
 */

const fs = require('fs');
const path = require('path');
const { discoverWetRoundupRows } = require('./wet-roundup-discover');
const { discoverTrRoundupHtml } = require('./tr-roundup-discover');
const { discoverLboRoundupHtml } = require('./lbo-roundup-discover');
const { normalizeOutlet } = require('./review-normalization');

const DAY_MS = 24 * 60 * 60 * 1000;

function isWeShow(show) {
  const cat = show && (show.category || show.market) || '';
  return cat === 'west-end' || cat === 'off-west-end';
}

/**
 * Opening-window scope for the WE reference: openingDate within
 * [now - windowDays, now]. Pre-opening shows are excluded (roundups don't
 * exist yet — CLAUDE.md rule 14); older shows are excluded so the hourly
 * back-catalogue grind (--window=1095 --include-closed, 362 WE shows) doesn't
 * burn 4 aggregator fetches per show per cycle.
 */
function inOpeningWindow(show, now = Date.now(), windowDays = 21) {
  if (!show || !show.openingDate) return false;
  const opening = Date.parse(show.openingDate);
  if (!Number.isFinite(opening)) return false;
  return opening <= now && now - opening <= windowDays * DAY_MS;
}

/**
 * Is a roundup post date consistent with THIS run (vs a prior production's
 * roundup)? Window: [opening - 30d, opening + 90d]. null postDate = unknown →
 * treated as current (TR/LBO pages are already cross-show/date-gated by
 * verifyAggregatorUrl / validateRoundupPageTitle at discovery).
 */
function isCurrentRunRoundup(postDate, show) {
  if (!postDate || !show || !show.openingDate) return true;
  const post = Date.parse(postDate);
  const opening = Date.parse(show.openingDate);
  if (!Number.isFinite(post) || !Number.isFinite(opening)) return true;
  return post >= opening - 30 * DAY_MS && post <= opening + 90 * DAY_MS;
}

/** Stable hash of the missing-outlet set, for alert dedup on set change. */
function missingSetHash(outletIds) {
  const s = [...new Set(outletIds)].sort().join('|');
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return String(h >>> 0);
}

/**
 * Collect WE reference rows for a show.
 *
 * @param {object} show shows.json record
 * @param {object} [opts] { log, fetchPage, fetchJSON, dataDir } — injected for tests
 * @returns {Promise<{
 *   rows: Array<{url: string|null, outletId: string, outletName: string, stars: number|null, source: string, sourceArticleUrl: string|null, priorRun: boolean}>,
 *   sources: Record<string, {found: boolean, rows: number, emptyParse: boolean, error: string|null}>,
 *   allSourcesFailed: boolean,
 * }>}
 */
async function getWeReferenceRows(show, opts = {}) {
  const log = opts.log || console.log;
  const sources = {
    westendtheatre: { found: false, rows: 0, emptyParse: false, error: null },
    'theatre-reviews': { found: false, rows: 0, emptyParse: false, error: null },
    'lbo-roundup': { found: false, rows: 0, emptyParse: false, error: null },
  };
  const rows = [];

  const push = (source, sourceArticleUrl, priorRun, r) => {
    const outletName = (r.outlet || '').trim();
    if (!outletName) return;
    rows.push({
      url: r.url || null,
      outletId: r.outletId || normalizeOutlet(outletName),
      outletName,
      stars: typeof r.stars === 'number' ? r.stars : null,
      source,
      sourceArticleUrl: sourceArticleUrl || null,
      priorRun,
    });
  };

  // WestEndTheatre — rows already extracted by the discover lib. The lib returns
  // null BOTH for "no matching post" and "matched post(s) but 0 rows parsed";
  // stats.titleMatchedPosts disambiguates — the latter is WET template drift and
  // must be flagged emptyParse (pre-mortem secondary scenario: parser drift made
  // the detector vacuously green while a real opening sat at 6/21 reviews).
  const wetStats = {}; const trStats = {}; const lboStats = {};
  try {
    const wet = await discoverWetRoundupRows(show, { ...opts, stats: wetStats });
    if (wet) {
      sources.westendtheatre.found = true;
      sources.westendtheatre.rows = wet.rows.length;
      const priorRun = !isCurrentRunRoundup(wet.post.date, show);
      for (const r of wet.rows) push('westendtheatre', wet.post.link, priorRun, r);
    } else if ((wetStats.titleMatchedPosts || 0) > 0) {
      sources.westendtheatre.found = true;
      sources.westendtheatre.emptyParse = true;
    }
  } catch (e) {
    sources.westendtheatre.error = e.message;
    log(`    WE-ref WET error: ${(e.message || '').slice(0, 80)}`);
  }

  // theatre.reviews — discover HTML, parse with the existing scraper module
  try {
    const tr = await discoverTrRoundupHtml(show, { ...opts, stats: trStats });
    if (tr) {
      sources['theatre-reviews'].found = true;
      const { extractReviews } = require('../scrape-theatre-reviews');
      const parsed = extractReviews(tr.html, show.id) || [];
      sources['theatre-reviews'].rows = parsed.length;
      if (parsed.length === 0) sources['theatre-reviews'].emptyParse = true;
      for (const r of parsed) push('theatre-reviews', tr.url, false, r);
    }
  } catch (e) {
    sources['theatre-reviews'].error = e.message;
    log(`    WE-ref TR error: ${(e.message || '').slice(0, 80)}`);
  }

  // London Box Office — discover HTML (title-validated), parse with existing module
  try {
    const lbo = await discoverLboRoundupHtml(show, { ...opts, stats: lboStats });
    if (lbo) {
      sources['lbo-roundup'].found = true;
      const { extractReviewsFromLBO } = require('../scrape-london-box-office-roundups');
      const parsed = extractReviewsFromLBO(lbo.html, show.id, lbo.url) || [];
      sources['lbo-roundup'].rows = parsed.length;
      if (parsed.length === 0) sources['lbo-roundup'].emptyParse = true;
      for (const r of parsed) push('lbo-roundup', lbo.url, false, r);
    }
  } catch (e) {
    sources['lbo-roundup'].error = e.message;
    log(`    WE-ref LBO error: ${(e.message || '').slice(0, 80)}`);
  }

  // The Stage — archive-only, `passive`: absence is expected (cookie-gated live;
  // archive lands only after gather/poller's authenticated fetch) and must never
  // count toward allSourcesFailed. An archive that EXISTS but parses 0 rows is
  // still emptyParse — gather archives only pages that parsed >0 rows at fetch
  // time, so 0 rows later means parser drift, not zero citations. Rows are
  // date-gated like every other roundup: gather's SERP title-match is weak
  // enough to archive a prior production's roundup under the current show id.
  sources['thestage-archive'] = { found: false, rows: 0, emptyParse: false, error: null, passive: true };
  try {
    const dataDir = opts.dataDir || path.join(__dirname, '..', '..', 'data');
    const archPath = path.join(dataDir, 'aggregator-archive', 'thestage-roundups', `${show.id}.html`);
    if (fs.existsSync(archPath)) {
      const html = fs.readFileSync(archPath, 'utf8');
      // Wrong-show guard (QA review 2026-07-11): every other archive consumer
      // title-validates before trusting archive content (gather quarantines on
      // mismatch) — a wrong-show archive must not feed outlets into the reference.
      const { validateRoundupPageTitle } = require('./show-matching');
      const v = validateRoundupPageTitle(html, show.title);
      if (!v.ok) {
        sources['thestage-archive'].error = `archive title mismatch (${v.reason})`;
        log(`    WE-ref TS-archive title mismatch for ${show.id} (${v.reason}) — archive ignored`);
      } else {
        sources['thestage-archive'].found = true;
        const { extractReviews: extractTsRows } = require('./thestage-extract');
        const parsed = extractTsRows(html, show.id) || [];
        sources['thestage-archive'].rows = parsed.length;
        if (parsed.length === 0) sources['thestage-archive'].emptyParse = true;
        const { extractPublishDate } = require('./article-extractor');
        const canonical = (html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) || [])[1] || null;
        // Pass the archive page's own canonical URL so extractPublishDate scopes
        // JSON-LD to the main-article entity (multi-article TS roundups embed
        // related-article dates; without scoping a related date could win).
        const priorRun = !isCurrentRunRoundup(extractPublishDate(html, canonical), show);
        for (const r of parsed) push('thestage-archive', canonical, priorRun, r);
      }
    }
  } catch (e) {
    sources['thestage-archive'].error = e.message;
    log(`    WE-ref TS-archive error: ${(e.message || '').slice(0, 80)}`);
  }

  // A source "failed" if it threw OR if its discovery hit fetch errors and found
  // nothing (the discover libs swallow network errors by poller-design, so a
  // total blackout would otherwise be indistinguishable from "no roundup exists").
  // Passive (archive-only) sources are excluded: their absence is expected, and
  // counting them would mask a real network blackout of the fetching sources.
  sources.westendtheatre.fetchErrors = wetStats.fetchErrors || 0;
  sources['theatre-reviews'].fetchErrors = trStats.fetchErrors || 0;
  sources['lbo-roundup'].fetchErrors = lboStats.fetchErrors || 0;
  const allSourcesFailed = Object.values(sources).filter((s) => !s.passive).every(
    (s) => !s.found && (s.error !== null || (s.fetchErrors || 0) > 0)
  );
  return { rows, sources, allSourcesFailed };
}

module.exports = {
  getWeReferenceRows,
  isWeShow,
  inOpeningWindow,
  isCurrentRunRoundup,
  missingSetHash,
};
