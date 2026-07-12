#!/usr/bin/env node
/**
 * Off-Broadway closing-date detector — ALERT ONLY.
 *
 * Off-Broadway shows have no closing-date automation (Broadway-only via
 * update-show-status.js / audit-closing-dates.js). OB runs are typically
 * 1-6 week limited engagements, so a stale `status=open` is the common case,
 * not the exception (see memory/feedback_closing_date_audit_gaps.md).
 *
 * This script never writes to shows.json. It only produces a report at
 * data/audit/ob-closing-candidates.json for human review, using two signals
 * that require no new scraping:
 *
 *   1. Review-text sweep — scans data/review-texts/<show>/*.json fullText
 *      for closing-date boilerplate, corroborated across reviews.
 *   2. TodayTix staleness diff — an open OB show with a todaytixId that has
 *      dropped out of data/todaytix-showtimes.json for 2+ consecutive
 *      weekly checks is a candidate-closed signal.
 *
 * Usage:
 *   node scripts/detect-ob-closings.js [--dry-run]
 *
 * --dry-run is accepted for forward compatibility with a future write-mode;
 * this version has no write-to-shows.json path at all, so it has no effect
 * on behavior yet. The audit report is always written (that IS the alert).
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const {
  extractClosingDateCandidates,
  aggregateClosingDateCandidates,
  shouldSuppressCandidate,
  updateTodayTixMissingState,
  decideTodayTixCandidates,
} = require('./lib/ob-closing-detector');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const TODAYTIX_PATH = path.join(ROOT, 'data', 'todaytix-showtimes.json');
const STATE_PATH = path.join(ROOT, 'data', 'audit', 'ob-todaytix-missing-state.json');
const REPORT_PATH = path.join(ROOT, 'data', 'audit', 'ob-closing-candidates.json');

const TODAYTIX_MISSING_THRESHOLD_CHECKS = 2;

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function getOpenOffBroadwayShows(showsData) {
  return (showsData.shows || []).filter(
    (s) => s.category === 'off-broadway' && s.status === 'open'
  );
}

function runReviewTextSweep(obShows) {
  const candidates = [];
  const unconfirmed = [];
  const suppressed = [];
  let scanned = 0;
  let showsWithNoTexts = 0;

  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.warn(`::warning::${REVIEW_TEXTS_DIR} not found — skipping review-text sweep entirely.`);
    return { scanned: 0, showsWithNoTexts: obShows.length, candidates, unconfirmed };
  }

  for (const show of obShows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, show.id);
    if (!fs.existsSync(showDir)) {
      showsWithNoTexts++;
      continue;
    }
    scanned++;

    let files;
    try {
      files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json'));
    } catch (e) {
      console.warn(`::warning::Could not read ${showDir}: ${e.message}`);
      continue;
    }

    const reviewMentions = [];
    for (const file of files) {
      const filePath = path.join(showDir, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        continue;
      }
      if (!data.fullText) continue;
      const reviewId = `${show.id}/${file}`;
      const candidatesForReview = extractClosingDateCandidates(data.fullText, data.publishDate);
      for (const c of candidatesForReview) {
        reviewMentions.push({ reviewId, isoDate: c.isoDate, quote: c.quote });
      }
    }

    if (reviewMentions.length === 0) continue;

    const proposal = aggregateClosingDateCandidates(show.id, show.openingDate, reviewMentions);
    if (proposal) {
      const suppress = shouldSuppressCandidate(show, proposal.proposedClosingDate, new Date().toISOString().slice(0, 10));
      if (suppress) {
        suppressed.push({ showId: show.id, proposedClosingDate: proposal.proposedClosingDate, reason: suppress });
        continue;
      }
    }
    if (proposal) {
      candidates.push(proposal);
    } else {
      unconfirmed.push({ showId: show.id, mentions: reviewMentions });
    }
  }

  return { scanned, showsWithNoTexts, candidates, unconfirmed, suppressed };
}

function runTodayTixStalenessDiff(obShows) {
  const candidateShows = obShows.filter((s) => s.todaytixId);
  const candidateShowIds = candidateShows.map((s) => s.id);

  const todaytixData = loadJson(TODAYTIX_PATH, null);
  if (!todaytixData) {
    console.warn(`::warning::${TODAYTIX_PATH} not found — skipping TodayTix staleness diff.`);
    return { checked: 0, candidates: [], skipped: true };
  }

  const presentShowIds = new Set(Object.keys(todaytixData.shows || {}));
  const prevState = loadJson(STATE_PATH, {});
  const nextState = updateTodayTixMissingState(prevState, candidateShowIds, presentShowIds, todayISO());

  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(nextState, null, 2));

  const candidates = decideTodayTixCandidates(nextState, TODAYTIX_MISSING_THRESHOLD_CHECKS);
  return { checked: candidateShowIds.length, candidates, skipped: false };
}

function main() {
  const showsData = loadJson(SHOWS_PATH, null);
  if (!showsData) {
    console.error(`::error::${SHOWS_PATH} not found — cannot run detector.`);
    process.exit(1);
  }

  const obShows = getOpenOffBroadwayShows(showsData);
  console.log(`Off-Broadway open shows: ${obShows.length}`);

  const reviewTextSweep = runReviewTextSweep(obShows);
  const todaytixStaleness = runTodayTixStalenessDiff(obShows);

  const report = {
    generatedAt: new Date().toISOString(),
    // Alert-only version: there is no write-to-shows.json path yet, so this is
    // always 'dry-run' regardless of the --dry-run flag (accepted for forward
    // compatibility with a future write-mode).
    mode: 'dry-run',
    reviewTextSweep: {
      scanned: reviewTextSweep.scanned,
      showsWithNoTexts: reviewTextSweep.showsWithNoTexts,
      candidates: reviewTextSweep.candidates,
      unconfirmed: reviewTextSweep.unconfirmed,
      suppressed: reviewTextSweep.suppressed,
    },
    todaytixStaleness: {
      checked: todaytixStaleness.checked,
      skipped: todaytixStaleness.skipped,
      candidates: todaytixStaleness.candidates,
    },
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log('\n=== Review-text closing-date candidates ===');
  if (reviewTextSweep.candidates.length === 0) {
    console.log('  (none)');
  }
  for (const c of reviewTextSweep.candidates) {
    console.log(`  ${c.showId} → ${c.proposedClosingDate} [${c.confidence}] (${c.reason})`);
    for (const e of c.evidence) {
      console.log(`      ${e.reviewId}: "${e.quote}"`);
    }
  }

  console.log('\n=== TodayTix staleness candidates ===');
  if (todaytixStaleness.candidates.length === 0) {
    console.log('  (none)');
  }
  for (const c of todaytixStaleness.candidates) {
    console.log(`  ${c.showId} — missing ${c.consecutiveMissingChecks} consecutive checks (since ${c.firstMissingDate})`);
  }

  console.log(`\nReport written to ${path.relative(ROOT, REPORT_PATH)}`);
}

main();
