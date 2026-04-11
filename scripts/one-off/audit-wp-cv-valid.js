#!/usr/bin/env node
/**
 * audit-wp-cv-valid.js
 *
 * Finds all review-text files where wrongProduction=true but contentVerification
 * explicitly says isValid=true (and doesn't itself flag wrongProduction or
 * wrongArticle). These are candidates for recovery — the LLM verifier vouched
 * for the content but a separate legacy guard stamped wrongProduction without
 * recording a specific reason, hiding the review from the composite.
 *
 * Classifies each file into a confidence bucket for safe recovery:
 *
 *   HIGH — URL matches show slug/keywords AND text mentions show keywords AND
 *          (publishDate within 180d of opening, OR no publishDate + URL contains
 *          a year compatible with the show).
 *          → safe to auto-recover.
 *
 *   MEDIUM — text mentions show keywords but URL/date checks are inconclusive,
 *            OR URL matches slug but we can't keyword-verify the text.
 *            → flag for review.
 *
 *   LOW — text does NOT mention the show's keywords (likely CV hallucination)
 *         OR URL points to a clearly different show slug (misfiled, needs
 *         separate move-to-correct-show pass).
 *         → do not recover in this pass.
 *
 * Usage:
 *   node scripts/one-off/audit-wp-cv-valid.js              — dry report to stdout
 *   node scripts/one-off/audit-wp-cv-valid.js --json=out   — JSON report to file
 */

const fs = require('fs');
const path = require('path');

const {
  buildShowKeywordSet,
  findShowKeywordInText,
  isRevivalByCanonicalTitle,
} = require('../lib/review-guards');

const argv = process.argv.slice(2);
const jsonArg = argv.find(a => a.startsWith('--json='));
const jsonOut = jsonArg ? jsonArg.split('=')[1] : null;

const ROOT = path.join(__dirname, '..', '..');
const REVIEW_ROOT = path.join(ROOT, 'data', 'review-texts');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');

const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
const shows = showsData.shows;
const showById = {};
for (const s of shows) showById[s.id] = s;

/** Active shows — in previews or recently open (opened within 180d, not closed). */
const DAY_MS = 86400000;
const now = Date.now();
function isActiveShow(show) {
  if (!show) return false;
  if (show.status === 'closed') return false;
  if (show.status === 'previews') return true;
  if (!show.openingDate) return false;
  const opened = new Date(show.openingDate).getTime();
  if (isNaN(opened)) return false;
  return (now - opened) <= 180 * DAY_MS;
}

/** Canonical slug used in URLs — show title lowercased and hyphenated. */
function showSlugTokens(show) {
  const title = (show.canonicalTitle || show.title || '').toLowerCase();
  return title
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !['the', 'and', 'for', 'with'].includes(w));
}

/** Publish year from publishDate. */
function extractPubYearFromDate(data) {
  if (data.publishDate) {
    const m = String(data.publishDate).match(/(19|20)\d{2}/);
    if (m) return parseInt(m[0], 10);
  }
  return null;
}

/** Year extracted from URL path segment, e.g. /2026/ or /2024/03/. */
function extractYearFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/(19|20)\d{2}\//);
  if (m) return parseInt(m[0].replace(/\//g, ''), 10);
  return null;
}

/** Parse a publishDate string into epoch ms (handles "July 24th, 2025" etc). */
function parseDateLoose(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/(\d+)(?:st|nd|rd|th)\b/g, '$1');
  const t = new Date(cleaned).getTime();
  return isNaN(t) ? null : t;
}

/** Show run window — earliest of firstPreview/firstPerformance/opening → closing (or now). */
function showRunWindow(show) {
  if (!show) return null;
  const candidates = [
    show.firstPreviewDate,
    show.firstPerformanceDate,
    show.openingDate,
    show.previewsStartDate,
  ].filter(Boolean).map(d => parseInt(String(d).slice(0, 4), 10)).filter(n => !isNaN(n));
  if (candidates.length === 0) return null;
  const openYear = Math.min(...candidates);
  const closeYear = show.closingDate
    ? parseInt(String(show.closingDate).slice(0, 4), 10)
    : new Date().getFullYear();
  // Precise ms window — earliest valid preview/opening through closing (+30d
  // grace for press lag) or now for open runs.
  const earlyDates = [
    show.firstPreviewDate,
    show.previewsStartDate,
    show.firstPerformanceDate,
    show.openingDate,
  ].map(parseDateLoose).filter(Boolean);
  const startMs = earlyDates.length > 0 ? Math.min(...earlyDates) : null;
  const closeMs = show.closingDate ? parseDateLoose(show.closingDate) : null;
  const endMs = closeMs ? closeMs + 30 * DAY_MS : Date.now();
  return { openYear, closeYear, startMs, endMs };
}

/** Strict year match — inclusive on open/close, 0 fudge. */
function yearInRunWindow(year, win) {
  if (!year || !win) return false;
  return year >= win.openYear && year <= win.closeYear;
}

/** ms-granular date window check. startMs has a 21-day pre-preview grace for
 *  legit press-preview coverage. endMs already includes 30-day post-close grace. */
function dateInRunWindow(ms, win) {
  if (!ms || !win || !win.startMs) return false;
  return ms >= (win.startMs - 21 * DAY_MS) && ms <= win.endMs;
}

const GENERIC_REASONS = new Set([
  'wrong_content',
  'partial_text',
  'Full review text',
  'Wrong production',
  'Missing proper ending or other signals',
  'Short but structurally complete review',
]);

function hasDiagnosticReason(data) {
  const candidates = [
    data.wrongProductionReason,
    data.wrongProductionNote,
    data._wrongProductionReason,       // underscore-prefixed variant used by cleanup-dedup scripts
    data._wrongProductionDetectedBy,
    data.wrongShowReason,
    data.incompleteReason,
    data.contentTierReason,
    data.tierReason,
    data.incompleteDetail,
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c !== 'string') continue;
    if (GENERIC_REASONS.has(c)) continue;
    if (/^Wrong production$/i.test(c)) continue;
    return true;
  }
  return false;
}

const results = {
  HIGH: [],
  MEDIUM: [],
  LOW: [],
  SKIP: [],  // had diagnostic reason or CV-invalid — not a candidate
};

const perShow = {};
let totalScanned = 0;
let totalWP = 0;

const dirs = fs.readdirSync(REVIEW_ROOT).filter(d => {
  try { return fs.statSync(path.join(REVIEW_ROOT, d)).isDirectory(); }
  catch { return false; }
});

for (const showId of dirs) {
  const show = showById[showId];
  const keywordSet = show ? buildShowKeywordSet(show) : null;
  const slugTokens = show ? showSlugTokens(show) : [];
  const runWindow = show ? showRunWindow(show) : null;
  const hasRevivalSiblings = show ? isRevivalByCanonicalTitle(showId, shows) : false;

  const files = fs.readdirSync(path.join(REVIEW_ROOT, showId)).filter(f => f.endsWith('.json'));
  for (const file of files) {
    totalScanned++;
    const fpath = path.join(REVIEW_ROOT, showId, file);
    let data;
    try { data = JSON.parse(fs.readFileSync(fpath, 'utf8')); }
    catch { continue; }

    if (data.wrongProduction !== true) continue;
    totalWP++;

    // Must have CV that explicitly vouched for it.
    const cv = data.contentVerification;
    if (!cv || cv.isValid !== true) continue;
    if (cv.wrongProduction === true) continue;
    if (cv.wrongArticle === true) continue;
    if (cv.isFilmTv === true) continue;

    // Human override already in play — leave it alone.
    if (data.wrongShow === true) continue;
    if (data.humanReviewedWrongProduction === true) continue;
    if (data.wrongProductionOverride === true) continue;

    // If there's a real diagnostic reason, this isn't the class of bug we're
    // recovering — it's a concrete flagged problem.
    if (hasDiagnosticReason(data)) {
      results.SKIP.push({ showId, file, reason: 'has-diagnostic-reason' });
      continue;
    }

    // Classify confidence.
    const text = String(data.fullText || data.wrongFullText || data.dtliExcerpt || '');
    const keywordHit = keywordSet ? findShowKeywordInText(text, keywordSet) : null;

    // Does the keyword hit come from something more discriminating than the
    // bare title? Title matches alone are weak for generic titles ("A Christmas
    // Carol", "Hamlet", "Cats"). Cast/crew surnames are far stronger signals.
    const title = (show && (show.canonicalTitle || show.title) || '').toLowerCase();
    const keywordIsTitleOnly =
      keywordHit && (keywordHit === title || title.split(/\s+/).includes(keywordHit));

    // URL slug check — does the URL contain any of the show's significant
    // title tokens? Avoids recovering files where the URL clearly points to
    // a different show.
    const url = (data.url || '').toLowerCase();
    const urlSlugHit = slugTokens.find(t => url.includes(t)) || null;

    // Year signals. pubYear = parsed from publishDate. urlYear = parsed from
    // URL path (/YYYY/). At least one must match the show's run window for HIGH.
    const pubYear = extractPubYearFromDate(data);
    const urlYear = extractYearFromUrl(url);
    const pubYearMatch = yearInRunWindow(pubYear, runWindow);
    const urlYearMatch = yearInRunWindow(urlYear, runWindow);

    // ms-granular precise check: is the publishDate inside the actual run
    // window? This catches 'review of transfer production filed under earlier
    // off-Broadway production that closed months before' bugs.
    const pubMs = parseDateLoose(data.publishDate);
    const pubMsInWindow = dateInRunWindow(pubMs, runWindow);

    // Strong year = any publicly-observable year indicator agrees with run window.
    const strongYearMatch = pubYearMatch || urlYearMatch;

    // Reject if a URL year is present and clearly disagrees — means the URL
    // points to a different-year article even if the slug matches.
    const urlYearDisagrees = urlYear && runWindow && !urlYearMatch;

    // Reject if we have a publishDate and it's outside the run window by ms
    // (even if the year technically matches).
    const pubMsDisagrees = pubMs && runWindow && runWindow.startMs && !pubMsInWindow;

    const active = isActiveShow(show);

    // Record.
    const entry = {
      showId,
      file,
      path: `${showId}/${file}`,
      url: data.url || '',
      outletId: data.outletId || '',
      criticName: data.criticName || '',
      publishDate: data.publishDate || '',
      pubYear,
      urlYear,
      runWindow: runWindow ? { openYear: runWindow.openYear, closeYear: runWindow.closeYear } : null,
      contentTier: data.contentTier,
      incompleteReason: data.incompleteReason || null,
      tierReason: data.tierReason || null,
      keywordHit,
      keywordIsTitleOnly,
      urlSlugHit,
      pubYearMatch,
      urlYearMatch,
      urlYearDisagrees,
      pubMsInWindow,
      pubMsDisagrees,
      hasRevivalSiblings,
      active,
      hasText: text.length > 0,
      textLen: text.length,
    };

    let bucket;
    // Any date disagreement at year or ms granularity → not a HIGH candidate.
    if (urlYearDisagrees || pubMsDisagrees) {
      bucket = 'LOW';
    } else if (
      keywordHit &&
      urlSlugHit &&
      strongYearMatch &&
      // For revival titles, require the non-title keyword OR strong year match
      // from BOTH signals (pubYear AND urlYear agreeing).
      (!hasRevivalSiblings || !keywordIsTitleOnly || (pubYearMatch && urlYearMatch))
    ) {
      bucket = 'HIGH';
    } else if (keywordHit && (urlSlugHit || strongYearMatch)) {
      bucket = 'MEDIUM';
    } else if (!keywordHit && urlSlugHit) {
      bucket = 'MEDIUM';
    } else {
      bucket = 'LOW';
    }

    results[bucket].push(entry);
    if (!perShow[showId]) perShow[showId] = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    perShow[showId][bucket]++;
  }
}

const summary = {
  generatedAt: new Date().toISOString(),
  totalScanned,
  totalWrongProduction: totalWP,
  candidates: results.HIGH.length + results.MEDIUM.length + results.LOW.length,
  high: results.HIGH.length,
  medium: results.MEDIUM.length,
  low: results.LOW.length,
  skipped: results.SKIP.length,
  activeShowAffected: Array.from(new Set(
    [...results.HIGH, ...results.MEDIUM, ...results.LOW]
      .filter(r => r.active)
      .map(r => r.showId)
  )).sort(),
  activeShowFiles: [...results.HIGH, ...results.MEDIUM, ...results.LOW]
    .filter(r => r.active),
};

console.log('=== wrongProduction CV-valid audit ===');
console.log('Scanned files:', summary.totalScanned);
console.log('wrongProduction=true:', summary.totalWrongProduction);
console.log('Candidates (no diagnostic reason + CV explicitly valid):', summary.candidates);
console.log('  HIGH   (auto-recoverable):', summary.high);
console.log('  MEDIUM (manual review):   ', summary.medium);
console.log('  LOW    (do not recover):  ', summary.low);
console.log('');
console.log('Active shows affected:', summary.activeShowAffected.length);
for (const s of summary.activeShowAffected) {
  const p = perShow[s];
  console.log(`  ${s}  H:${p.HIGH} M:${p.MEDIUM} L:${p.LOW}`);
}
console.log('');
console.log('Active-show files:', summary.activeShowFiles.length);
for (const f of summary.activeShowFiles) {
  console.log(`  [${f.keywordHit ? 'K' : ' '}${f.urlSlugHit ? 'U' : ' '}${f.yearMatch ? 'Y' : ' '}] ${f.path}  outlet=${f.outletId}  pub=${f.publishDate}`);
}

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({
    summary,
    HIGH: results.HIGH,
    MEDIUM: results.MEDIUM,
    LOW: results.LOW,
  }, null, 2));
  console.log(`\nJSON written to ${jsonOut}`);
}
