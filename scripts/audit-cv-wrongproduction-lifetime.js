#!/usr/bin/env node

/**
 * Lifetime corpus sweep for the cv-wrongproduction-unhandled bypass class (task #1731).
 *
 * scripts/lib/opening-night-checks/cv-wrongproduction-unhandled.check.js (built
 * after the Schmigadoon/juan-a-ramirez incident) catches reviews that ship
 * with contentVerification.wrongProduction=true but no clear-flag — the
 * "temporal-proximity confidence downgrade suppresses a correct
 * wrongProduction verdict" bypass. It only ever runs via
 * opening-night-checklist.js, which gates its target shows to
 * isWithinTwoDays(show.openingDate, now) — so a show more than 2 days past
 * opening is never checked again for the rest of its life.
 *
 * Task #1712's corpus audit (audit-flag-wipe-signature.js) found and fixed 3
 * live instances of exactly this bypass, all reintroduced weeks after opening
 * via an unrelated bug (#1695's maybeUpgradeUrl url-swap) — well outside the
 * ±2-day window the opening-night checklist covers. This script reuses the
 * SAME check function (no logic fork — a fork here would drift from the
 * checklist's definition of "unhandled") against every show in shows.json,
 * independent of opening date, so any FUTURE re-verification event (manual
 * recheck, other pipeline refetch) that reintroduces the bypass is caught
 * regardless of how the file got re-verified or how long ago the show opened.
 *
 * Usage:
 *   node scripts/audit-cv-wrongproduction-lifetime.js
 *   node scripts/audit-cv-wrongproduction-lifetime.js --json
 *   node scripts/audit-cv-wrongproduction-lifetime.js --show=ID
 *
 * Exit code: 1 if any unhandled CV.wrongProduction violation is found across
 * the corpus, 0 otherwise. Mirrors the check's own severity:'error' verdict —
 * this is the exact bypass class the check exists to catch, so a hit is
 * always a failure, never a warning.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard.js');
const cvWrongProductionUnhandled = require('./lib/opening-night-checks/cv-wrongproduction-unhandled.check.js');

const USAGE = `audit-cv-wrongproduction-lifetime.js — lifetime corpus sweep for the cv-wrongproduction-unhandled bypass class (task #1731)

Runs cv-wrongproduction-unhandled.check.js (the same check opening-night-checklist.js
uses, ±2-day window only) against EVERY show in shows.json, not just shows near
their opening date. Catches the juan-a-ramirez bypass class reappearing on
older shows via any future re-verification event.

Usage:
  node scripts/audit-cv-wrongproduction-lifetime.js [--json] [--show=ID]
                                                      [--review-texts-dir=PATH]
                                                      [--shows-path=PATH]
                                                      [--reviews-path=PATH]

  --json                machine-readable output
  --show=ID             scan a single show only
  --review-texts-dir=   override the corpus path (default data/review-texts)
  --shows-path=         override shows.json path (default data/shows.json)
  --reviews-path=       override reviews.json path (default data/reviews.json)
  --no-snapshot         skip writing data/audit/cv-wrongproduction-lifetime.json

Exit code: 1 if any unhandled violation is found, 0 otherwise. A full-corpus run
(no --show) also writes data/audit/cv-wrongproduction-lifetime.json — the dead-man
snapshot health-check.js's digest reads (same shape as
cross-outlet-attribution-drift.json). Shadow-mode by design: near-opening
temporal-override reasoning ("[OVERRIDE: review within Nd of opening, likely
correct production]") legitimately produces cv.wrongProduction=true + low
confidence for a large share of the corpus without a formal clear-flag ever
being stamped — that's the SAME population opening-night-checklist.js's ±2-day
version of this check already surfaces as a low-urgency digest-disposition
alert (see data/audit/alert-ledger.json), not a real-time page. This script
runs it corpus-wide so that population is visible at all for older shows, but
does not hard-fail CI on it (see data-health-check.yml step comment).
`;

const ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_PATH = path.join(ROOT, 'data', 'audit', 'cv-wrongproduction-lifetime.json');

function loadReviewsDoc(reviewsPath) {
  const doc = {};
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
  } catch {
    return doc;
  }
  for (const r of raw.reviews || []) {
    if (!doc[r.showId]) doc[r.showId] = [];
    doc[r.showId].push(r);
  }
  return doc;
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const json = argv.includes('--json');
  const showArg = (argv.find((a) => a.startsWith('--show=')) || '').split('=')[1] || null;
  const dirArg = argv.find((a) => a.startsWith('--review-texts-dir='));
  const REVIEW_TEXTS_DIR = dirArg ? dirArg.split('=')[1] : path.join(ROOT, 'data', 'review-texts');
  const showsArg = argv.find((a) => a.startsWith('--shows-path='));
  const SHOWS_PATH = showsArg ? showsArg.split('=')[1] : path.join(ROOT, 'data', 'shows.json');
  const reviewsArg = argv.find((a) => a.startsWith('--reviews-path='));
  const REVIEWS_PATH = reviewsArg ? reviewsArg.split('=')[1] : path.join(ROOT, 'data', 'reviews.json');

  let shows;
  try {
    shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows || [];
  } catch (e) {
    console.error(`FAIL: could not read ${SHOWS_PATH}: ${e.message}`);
    process.exit(1);
  }
  if (showArg) shows = shows.filter((s) => s.id === showArg);

  const reviewsDoc = loadReviewsDoc(REVIEWS_PATH);
  const context = { reviewTextsRoot: REVIEW_TEXTS_DIR, reviewsDoc };

  let scanned = 0;
  const hits = [];
  for (const show of shows) {
    if (fs.existsSync(path.join(REVIEW_TEXTS_DIR, show.id))) scanned++;
    const result = cvWrongProductionUnhandled.run(show, context);
    if (result.severity === 'error') {
      hits.push({
        showId: show.id,
        title: show.title || show.id,
        openingDate: show.openingDate || null,
        message: result.message,
        violations: (result.details && result.details.violations) || [],
      });
    }
  }

  try {
    assertCorpusScanned(scanned, { gate: !showArg, label: REVIEW_TEXTS_DIR });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`\nFAIL: ${e.message}`);
    process.exit(1);
  }

  const totalViolations = hits.reduce((n, h) => n + h.violations.length, 0);

  if (!showArg && !argv.includes('--no-snapshot')) {
    try {
      fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
      fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify({
        updatedAt: new Date().toISOString(),
        scanned,
        showsWithViolations: hits.length,
        totalViolations,
        hits,
      }, null, 2) + '\n');
    } catch (e) {
      console.error(`::warning::could not write snapshot to ${SNAPSHOT_PATH}: ${e.message}`);
    }
  }

  if (json) {
    console.log(JSON.stringify({
      scanned,
      showsWithViolations: hits.length,
      totalViolations,
      hits,
    }, null, 2));
  } else {
    console.log(`cv-wrongproduction-unhandled lifetime sweep (#1731): ${scanned} show(s) with review-texts scanned, ${hits.length} show(s) with unhandled violations (${totalViolations} review(s)).`);
    for (const h of hits) {
      console.log(`\n-- ${h.title} (${h.showId}), opened ${h.openingDate || 'unknown'} --`);
      console.log(`  ${h.message.split('\n').join('\n  ')}`);
    }
    if (hits.length > 0) {
      console.log('\nEach hit needs a manual re-verification against the outlet\'s current article — same remediation as task #1712\'s findings.');
    }
  }

  process.exit(totalViolations > 0 ? 1 : 0);
}

main();
