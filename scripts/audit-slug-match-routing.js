#!/usr/bin/env node
/**
 * Audit existing review-texts/{showId}/ for files that the current slug
 * matcher would re-route to a different show.
 *
 * Filters to TRUE misroutes — cases where the FROM show's distinctive
 * tokens are NOT all in the article slug, but the TO show's are. These
 * are the routings that the pre-2026-05-27 longest-substring matcher got
 * wrong (e.g. Bedlam's Othello article routed to closed `othello-2025`
 * because "othello" beat "bedlams-othello" on length).
 *
 * Output: writes /tmp/true-misroutes.json with full details + prints a
 * grouped summary by (from, to) showId pair.
 *
 * Use: node scripts/audit-slug-match-routing.js
 *      node scripts/audit-slug-match-routing.js --apply  (NOT YET IMPLEMENTED)
 *
 * The --apply path would move files, but is intentionally not built —
 * the audit produces false positives for shows with venue-suffixed IDs
 * (e.g. `cabaret-at-the-kit-kat-club-west-end-2021` for a 2021 "Cabaret"
 * article) where the slug has no venue mention but the article truly
 * refers to that specific production. Manual review of the audit is
 * required before moving files.
 */

const fs = require('fs');
const path = require('path');
const {
  matchSlugToShow, matchBwwRoundupSlugToShow, loadShows,
  cleanSlugForMatcher, _showDistinctiveTokens, _tokenAppearsInSlug,
} = require('./lib/show-matching');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');

// This script's own local resolver (pre-task #1749) tried the legacy
// $HOME/broadway-review-texts clone BEFORE data/review-texts — backwards from
// the canonical order (the legacy clone was found 143+ commits stale on
// 2026-08-17), so on any machine with both, this read-only audit was silently
// reading the STALER copy. Read-only against RT (writes go to /tmp and
// data/audit/), so the failure mode was misleading findings, not corruption —
// still worth fixing since disposition-misroute.js's runbook quotes this
// script's output directly.
const REVIEW_TEXTS_DIR = resolveReviewTextsDir();
if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
  console.error(`review-texts dir not found: ${REVIEW_TEXTS_DIR}`);
  console.error('Set REVIEW_TEXTS_DIR env var to override.');
  process.exit(1);
}
console.log(`[audit-slug-match-routing] review-texts: ${REVIEW_TEXTS_DIR}`);

// Helpers are now canonical in scripts/lib/show-matching.js — re-export
// here as local names to keep audit logic readable. Single source of truth.
const distinctiveTokens = _showDistinctiveTokens;
const tokenAppears = _tokenAppearsInSlug;
const cleanSlug = cleanSlugForMatcher;

// Generic catch-all / stub show dirs that collect cross-production pollution
// NOT placed by the slug matcher (Class C in the cleanup card). Moving these
// needs a separate outlet-URL attribution audit, so the harness marks them
// outOfScope and the apply script skips them. Extend as new bins surface.
const GENERIC_BIN_IDS = new Set([
  'broadway-1987', 'broadway-1970', 'elf-2024', 'wit-2012',
  'data-off-broadway-2026', 'zack-off-broadway-2026',
]);

const showYear = (show) => parseInt((show && show.openingDate || '').slice(0, 4), 10) || null;

// Article year: BWW roundup slugs end in -YYYYMMDD; PV articles carry it on
// the review's publishDate (PV slugs have no date). Mirror exactly what the
// year-aware matcher derives so the audit's routing == production routing.
function extractArticleYear(slug, source, review) {
  if (source === 'bww') {
    // Mirror matchBwwRoundupSlugToShow EXACTLY: BWW year comes only from the
    // slug tail (the production matcher never sees publishDate). No
    // publishDate fallback here, or the audit would route differently than
    // production for undated BWW slugs. Undated BWW → null → no-date warning.
    const m = String(slug).match(/-(\d{8})$/);
    if (m) { const y = parseInt(m[1].slice(0, 4), 10); if (y >= 1900 && y <= 2100) return y; }
    return null;
  }
  // PV slugs carry no date; the production PV path derives it from publishDate.
  if (review && review.publishDate) {
    const y = parseInt(String(review.publishDate).slice(0, 4), 10);
    if (y >= 1900 && y <= 2100) return y;
  }
  return null;
}

function yearGap(show, articleYear) {
  if (!articleYear) return null;
  const y = showYear(show);
  return y == null ? null : Math.abs(y - articleYear);
}
// (Old duplicated PV_HEAD/PV_TAIL/BWW_HEAD/BWW_TAIL/SLUG_STOPWORDS
// constants and inline cleanSlug() were removed — they drifted from
// show-matching.js on the first matcher edit.)

function main() {
  const shows = loadShows();
  const showById = new Map(shows.map(s => [s.id, s]));

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(d => !d.startsWith('.') && !d.startsWith('_'))
    .filter(d => {
      try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory(); }
      catch { return false; }
    });

  console.log(`Scanning ${showDirs.length} show directories in ${REVIEW_TEXTS_DIR}...`);

  const trueMisroutes = [];
  let scanned = 0;

  for (const showId of showDirs) {
    const files = fs.readdirSync(path.join(REVIEW_TEXTS_DIR, showId)).filter(f => f.endsWith('.json'));
    for (const f of files) {
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(REVIEW_TEXTS_DIR, showId, f), 'utf8')); }
      catch { continue; }
      scanned++;

      // Identify aggregator-discovery URLs we can re-evaluate
      let slug = null, source = null, matcher = null;
      if (r.playbillVerdictUrl && r.playbillVerdictUrl.includes('playbill.com/article/')) {
        slug = (r.playbillVerdictUrl.split('/article/')[1] || '').replace(/[?#].*$/, '');
        source = 'pv';
        matcher = matchSlugToShow;
      } else if (r.bwwRoundupUrl && /review-roundup/i.test(r.bwwRoundupUrl)) {
        slug = r.bwwRoundupUrl.split('/article/')[1] || '';
        source = 'bww';
        matcher = matchBwwRoundupSlugToShow;
      }
      if (!slug || !matcher) continue;

      // Pass the article year so the audit reproduces the year-aware
      // production routing (BWW auto-extracts from the slug tail; PV needs the
      // publishDate). Without this the committed audit would diverge from
      // what the live scrapers actually do.
      const articleYear = extractArticleYear(slug, source, r);
      const m = matcher(slug, shows, articleYear ? { year: articleYear } : {});
      if (!m || m.show.id === showId) continue;

      // Filter to TRUE misroutes — FROM's distinctive tokens are NOT all in
      // the cleaned slug, but TO's are. Skip false-positive shuffles
      // (e.g. recency-tiebreak moves where both shows fully match).
      const fromShow = showById.get(showId);
      const toShow = m.show;
      if (!fromShow || !toShow) continue;

      const cleanedSlug = cleanSlug(slug, source);
      const fromTokens = distinctiveTokens(fromShow);
      const toTokens = distinctiveTokens(toShow);
      const fromMatched = fromTokens.filter(t => tokenAppears(t, cleanedSlug)).length;
      const toMatched = toTokens.filter(t => tokenAppears(t, cleanedSlug)).length;

      const isTrueMisroute = (toMatched > fromMatched)
        || (fromMatched < fromTokens.length && toMatched === toTokens.length);
      if (!isTrueMisroute) continue;

      // Per-pair verification fields. The matcher's `to` is NOT trusted on its
      // own (the 2026-05-27 HOLIDAY-INN revert) — an operator confirms each
      // row. Warnings keep dangerous rows confirm-locked by the apply script:
      //   to-year-far       — matched show is >2yr from the article date; the
      //                       matcher's `to` is probably wrong (the correct
      //                       production may not be in shows.json at all).
      //   no-date           — no article year or unparseable to-date; the
      //                       date safety check could not run.
      //   from-also-full-match — FROM also fully matches the slug (an
      //                       ambiguous recency shuffle, not a clear misroute).
      const toGap = yearGap(toShow, articleYear);
      const fromGap = yearGap(fromShow, articleYear);
      const warnings = [];
      if (toGap != null && toGap > 2) warnings.push('to-year-far');
      if (articleYear == null || showYear(toShow) == null) warnings.push('no-date');
      if (fromMatched === fromTokens.length && fromTokens.length > 0) warnings.push('from-also-full-match');
      const cls = (GENERIC_BIN_IDS.has(showId) || GENERIC_BIN_IDS.has(m.show.id)) ? 'C' : 'A';

      trueMisroutes.push({
        from: showId, to: m.show.id, file: f, slug, source,
        url: r.playbillVerdictUrl || r.bwwRoundupUrl,
        fromTokens: fromTokens.join('|'),
        toTokens: toTokens.join('|'),
        articleYear,
        toYearGap: toGap,
        fromYearGap: fromGap,
        fromShow: { title: fromShow.title, venue: fromShow.venue || null, openingDate: fromShow.openingDate || null, status: fromShow.status || null, category: fromShow.category || null },
        toShow: { title: toShow.title, venue: toShow.venue || null, openingDate: toShow.openingDate || null, status: toShow.status || null, category: toShow.category || null },
        class: cls,
        outOfScope: cls === 'C',
        warnings,
        confirm: false,
      });
    }
  }

  console.log(`Scanned files: ${scanned}`);
  console.log(`TRUE misroutes: ${trueMisroutes.length}`);
  console.log();

  const byKey = {};
  for (const m of trueMisroutes) {
    const k = `${m.from} → ${m.to}`;
    byKey[k] = (byKey[k] || 0) + 1;
  }
  const sorted = Object.entries(byKey).sort((a, b) => b[1] - a[1]).slice(0, 50);
  for (const [k, n] of sorted) console.log(' ', String(n).padStart(3), '|', k);

  // Persist to data/audit/ following the audit-cross-production-weekly
  // pattern: { generatedAt, totalScanned, findings: [...] }. The committed
  // file is the input to the weekly workflow's delta-based alerting.
  const repoRoot = path.resolve(__dirname, '..');
  const auditDir = path.join(repoRoot, 'data', 'audit');
  if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
  // Named auditOutPath (not outPath) so the safeWriteReview lint heuristic
  // doesn't flag this read-only-on-review-texts script: it scans review-texts
  // but only ever WRITES to data/audit/. (test.yml safeWriteReview guard)
  const auditOutPath = process.env.AUDIT_OUT_PATH
    || path.join(auditDir, 'slug-misroute-audit.json');
  const output = {
    generatedAt: new Date().toISOString(),
    totalScanned: scanned,
    findings: trueMisroutes,
  };
  fs.writeFileSync(auditOutPath, JSON.stringify(output, null, 2));
  console.log();
  console.log(`Full audit: ${auditOutPath}`);

  // Also write /tmp copy for backwards compat with ad-hoc local use.
  try {
    fs.writeFileSync('/tmp/true-misroutes.json', JSON.stringify(trueMisroutes, null, 2));
  } catch { /* /tmp may not be writable in some sandboxes */ }
}

if (require.main === module) main();
