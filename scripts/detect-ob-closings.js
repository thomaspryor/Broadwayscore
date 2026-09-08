#!/usr/bin/env node
/**
 * Off-Broadway closing-date detector.
 *
 * Off-Broadway shows have no closing-date automation (Broadway-only via
 * update-show-status.js / audit-closing-dates.js). OB runs are typically
 * 1-6 week limited engagements, so a stale `status=open` is the common case,
 * not the exception (see memory/feedback_closing_date_audit_gaps.md).
 *
 * Produces a report at data/audit/ob-closing-candidates.json, and auto-applies
 * the subset where both signals below agree (see selectAutoApplyClosures).
 * Everything else stays alert-only for human review. Signals, both of which
 * require no new scraping:
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
 * --dry-run reports what it would close without touching shows.json. The audit
 * report is written either way.
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
  selectAutoApplyClosures,
} = require('./lib/ob-closing-detector');
const { createShowsWriteGuard } = require('./lib/shows-write-guard');
const { writeClosingDate } = require('./lib/closing-date-guard');

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
      const candidatesForReview = extractClosingDateCandidates(data.fullText, data.publishDate, {
        title: show.title,
      });
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

/**
 * Writes the two-signal-confirmed closures to shows.json. Anything short of
 * both signals is left for the alert path.
 */
function applyConfirmedClosures(showsData, candidates, dryRun, todaytixSkipped) {
  // Without a fresh TodayTix feed the staleness counters are whatever the last
  // successful run committed, which is not a second signal — it is the same
  // signal replayed. Fall back to alert-only.
  if (todaytixSkipped) return [];

  const showsById = Object.fromEntries((showsData.shows || []).map((s) => [s.id, s]));
  const missingState = loadJson(STATE_PATH, {});
  const selected = selectAutoApplyClosures(candidates, showsById, missingState, todayISO());
  if (selected.length === 0 || dryRun) return selected;

  const { loadShows, saveShows } = createShowsWriteGuard(SHOWS_PATH);
  const snapshot = loadShows();
  const byId = Object.fromEntries(snapshot.shows.map((s) => [s.id, s]));
  const written = [];
  for (const closure of selected) {
    const show = byId[closure.showId];
    // Re-check under the write lock: a concurrent writer may have set a date
    // between our read and this save.
    if (!show || show.status !== 'open' || show.closingDate) continue;
    // writeClosingDate honours humanCorrectedClosingDate and stamps
    // closingDateSource/closingDateUpdatedAt — the same guard every other
    // automated closing-date writer goes through.
    if (!writeClosingDate(show, closure.closingDate, 'ob-closing-detector', { todayStr: todayISO() })) continue;
    show.status = 'closed';
    written.push(closure);
  }
  if (written.length > 0) saveShows(snapshot);
  // Report only what actually landed: a report claiming a closure the write
  // lock rejected would read as fixed while the site still says open.
  return written;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const showsData = loadJson(SHOWS_PATH, null);
  if (!showsData) {
    console.error(`::error::${SHOWS_PATH} not found — cannot run detector.`);
    process.exit(1);
  }

  const obShows = getOpenOffBroadwayShows(showsData);
  console.log(`Off-Broadway open shows: ${obShows.length}`);

  const reviewTextSweep = runReviewTextSweep(obShows);
  const todaytixStaleness = runTodayTixStalenessDiff(obShows);
  const autoApplied = applyConfirmedClosures(
    showsData,
    reviewTextSweep.candidates,
    dryRun,
    todaytixStaleness.skipped
  );

  const report = {
    generatedAt: new Date().toISOString(),
    mode: dryRun ? 'dry-run' : 'apply',
    autoApplied,
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
