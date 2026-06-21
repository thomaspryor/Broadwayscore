#!/usr/bin/env node
/**
 * One-shot remediation for the 2026-06-21 operator-trust contamination
 * (Notion 386637c5).
 *
 * Root cause: ingest-review-from-url.js (driven by the automated
 * audit-aggregator-gap workflow) and poll-loureviews.js called
 * buildManualReviewFields WITHOUT operatorTrust:false, stamping the full operator
 * override set (allowEarlyDate / allowCrossMarket / wrongProductionOverride /
 * wrongProductionManualClear / manual-entry markers) onto machine-ingested
 * aggregator URLs. Those overrides exempted the reviews from the date,
 * cross-market and wrong-production guards, so reviews of a DIFFERENT production
 * of the same title (West End run, out-of-town tryout, original Broadway run,
 * even the film) leaked onto the wrong show entry and counted toward its critic
 * score — re-admitted on every rebuild because shouldAutoClearWrongProduction
 * trusts the override fields.
 *
 * The code fix (operatorTrust gate in manual-review-fields.js) stops NEW
 * contamination. This script cleans the EXISTING corpus.
 *
 * Discriminator is the OBJECTIVE date signal (the flag fields were all faked, so
 * they can't be trusted): a review is contamination when its publishDate is
 * >90 days outside the show's [earliest-14d, close+7d] window, it is NOT within
 * a declared priorRuns window, and it has NO genuine operator humanReviewScore.
 * (90d here is stricter than the validate-data CHECK 0 backstop at 180d, so the
 * corpus passes CI with margin after this runs.)
 *
 * For each match: set wrongProduction:true + a manual wrongProductionReason
 * (which makes the flag durable — shouldAutoClearWrongProduction respects a
 * manual reason regardless of the allow* fields), and strip the bogus operator
 * override fields (and prune them from the per-file protectedFields lock) so the
 * file no longer masquerades as a human submission. Written raw on purpose: this
 * is an intentional clear of protected fields.
 *
 * Usage:
 *   node scripts/fix-aggregator-gap-override-contamination.js            # dry run
 *   node scripts/fix-aggregator-gap-override-contamination.js --apply    # write
 */

const fs = require('fs');
const path = require('path');
const { parseDate } = require('./lib/date-utils');
const { extractDateFromUrl } = require('./lib/rebuild-helpers');
const { earliestShowDate, DAYS_AFTER_CLOSE } = require('./lib/date-guard');
const { isWithinPriorRun } = require('./lib/wrong-production-autoclear');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = !process.argv.includes('--apply');
const THRESHOLD_DAYS = 90;

// Operator-trust override fields wrongly stamped by automated ingest.
const OVERRIDE_FIELDS = [
  'wrongProductionManualClear', 'wrongProductionOverride',
  'wrongShowManualClear', 'wrongArticleManualClear',
  'allowEarlyDate', 'allowLateDate', 'allowCrossMarket',
  'allowTourSignal', 'allowFilmSignal',
];

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = data.shows || data;
  const map = {};
  for (const s of Object.values(shows)) map[s.id] = s;
  return map;
}

// Best available date: publishDate, else a FULL YYYY-MM-DD parsed from the URL
// (mirrors flag-wrong-production-by-date.js — month/year-only defaults to the 1st
// and would trip near-boundary reviews).
function bestDate(data) {
  let d = parseDate(data.publishDate);
  if (d && !isNaN(d.getTime())) return d;
  if (data.url) {
    const u = extractDateFromUrl(data.url);
    if (u && u.date && /^\d{4}-\d{2}-\d{2}$/.test(u.date)) {
      const pd = parseDate(u.date);
      if (pd && !isNaN(pd.getTime())) return pd;
    }
  }
  return null;
}

function run() {
  const showMap = loadShows();
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d =>
    fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory());

  let flagged = 0, skippedFlagged = 0, skippedOperator = 0, skippedNoDate = 0, skippedInWindow = 0, skippedPriorRun = 0, noShow = 0, noWindow = 0;
  const details = [];

  for (const showDir of showDirs) {
    const show = showMap[showDir];
    if (!show) { noShow++; continue; }
    const earliestStr = earliestShowDate(show);
    if (!earliestStr) { noWindow++; continue; }
    const earliest = parseDate(earliestStr);
    const close = show.closingDate ? parseDate(show.closingDate) : null;

    const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
    for (const file of fs.readdirSync(dirPath).filter(f => f.endsWith('.json'))) {
      const filePath = path.join(dirPath, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }

      // Already excluded — nothing to do.
      if (data.wrongProduction === true || data.wrongShow === true) { skippedFlagged++; continue; }
      // Genuine operator entry with a typed score — never touch.
      if (data.humanReviewScore != null) { skippedOperator++; continue; }

      const pub = bestDate(data);
      if (!pub) { skippedNoDate++; continue; }
      if (isWithinPriorRun(pub, show.priorRuns)) { skippedPriorRun++; continue; }

      const lateBound = close ? new Date(close.getTime() + DAYS_AFTER_CLOSE * 86400000) : null;
      const daysBefore = earliest ? (earliest.getTime() - 14 * 86400000 - pub.getTime()) / 86400000 : -1;
      const daysAfter = lateBound ? (pub.getTime() - lateBound.getTime()) / 86400000 : -1;

      const outOfWindow = daysBefore > THRESHOLD_DAYS || daysAfter > THRESHOLD_DAYS;
      if (!outOfWindow) { skippedInWindow++; continue; }

      const dir = daysBefore > THRESHOLD_DAYS ? 'EARLY' : 'LATE';
      const diff = dir === 'EARLY' ? Math.round(daysBefore) : Math.round(daysAfter);
      details.push({ showDir, file, date: data.publishDate || pub.toISOString().slice(0, 10), dir, diff, outlet: data.outlet || '?', score: data.assignedScore });
      flagged++;

      if (!DRY_RUN) {
        data.wrongProduction = true;
        data.wrongProductionReason = 'audit-2026-06-21-prior-production-contamination';
        data.wrongProductionNote = `Operator-trust contamination remediation (Notion 386637c5): review dated ${data.publishDate || pub.toISOString().slice(0, 10)} is ${diff}d ${dir === 'EARLY' ? 'before show window start' : 'after show close'} ${earliestStr} and not within any declared priorRun — different production leaked onto this entry by automated ingest stamping operator override fields.`;
        for (const f of OVERRIDE_FIELDS) delete data[f];
        if (Array.isArray(data.protectedFields)) {
          data.protectedFields = data.protectedFields.filter(f => !OVERRIDE_FIELDS.includes(f));
        }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      }
    }
  }

  // Report
  const byShow = {};
  for (const d of details) (byShow[d.showDir] = byShow[d.showDir] || []).push(d);
  const sorted = Object.entries(byShow).sort((a, b) => b[1].length - a[1].length);
  console.log(`\n--- ${DRY_RUN ? 'Would flag' : 'Flagged'} wrongProduction (prior-production contamination) ---`);
  for (const [showDir, items] of sorted.slice(0, 40)) {
    console.log(`\n  ${showDir}: ${items.length}`);
    for (const d of items.slice(0, 6)) console.log(`    ${d.dir} ${d.diff}d  ${String(d.outlet).padEnd(24)} ${d.date}  score=${d.score ?? '-'}`);
    if (items.length > 6) console.log(`    ... and ${items.length - 6} more`);
  }

  console.log(`\n--- Summary (threshold ${THRESHOLD_DAYS}d outside [earliest-14d, close+${DAYS_AFTER_CLOSE}d]) ---`);
  console.log(`Shows affected:                 ${sorted.length}`);
  console.log(`${DRY_RUN ? 'Would flag' : 'Flagged'} (contamination):       ${flagged}`);
  console.log(`Skipped — already flagged:      ${skippedFlagged}`);
  console.log(`Skipped — operator humanScore:  ${skippedOperator}`);
  console.log(`Skipped — within priorRun:      ${skippedPriorRun}`);
  console.log(`Skipped — within window:        ${skippedInWindow}`);
  console.log(`Skipped — no usable date:       ${skippedNoDate}`);
  console.log(`No show entry / no window:      ${noShow} / ${noWindow}`);
  if (DRY_RUN && flagged > 0) console.log(`\nRun with --apply to write flags.`);
}

run();
