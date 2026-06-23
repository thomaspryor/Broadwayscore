#!/usr/bin/env node
/**
 * Corpus-wide cross-show URL contamination audit.
 *
 * The ingest-time guard (gather-reviews.js createReviewFile →
 * detectCrossShowUrlMismatch) only runs on files written through that path and
 * never re-scans existing files. On 2026-06-23 a BWW scrape wrote 11 "Every
 * Brilliant Thing" reviews into schmigadoon-2026/ via a path that bypassed it.
 * This audit closes both gaps: it applies the SAME canonical guard to EVERY
 * existing review-texts file, regardless of which scraper wrote it.
 *
 * Catches the DISTINCTIVE-TITLE class (URL slug names a different long-titled
 * show). It does NOT catch short-titled shows (slug < 8 chars, e.g. "Care",
 * "Equus") — a bare short substring is too noisy to trust as a URL signal; those
 * need a content/date signal (audit-cross-attribution-by-critic.js).
 *
 * Usage:
 *   node scripts/audit-cross-show-url.js                 # report only
 *   node scripts/audit-cross-show-url.js --fix           # flag wrongShow + write
 *   node scripts/audit-cross-show-url.js --json          # machine-readable
 *   node scripts/audit-cross-show-url.js --strict        # exit 1 if unhandled > --max
 *   node scripts/audit-cross-show-url.js --strict --max=60  # CI monitor: fail only above baseline
 *
 * IMPORTANT — report-only by default, NEVER auto --fix the whole corpus.
 * As a blanket scan the canonical guard has a known false-positive tail:
 *   - franchise variants: "Bad Cinderella" / "R&H Cinderella" ← "Cinderella …"
 *   - substring collisions: "after-midnight" ← "midnight …"
 *   - same-show different-production not caught by the base-title skip
 * The ingest-time guard tolerates these because it pairs with reroute + per-
 * candidate context. The HIGH-CONFIDENCE real-contamination signature is a
 * CLUSTER: 2+ reviews in one show whose URLs all name the SAME other show
 * (e.g. 11 Every Brilliant Thing under Schmigadoon; 3 Once on This Island under
 * this-is-not-about-me). Triage clusters first; --fix only after verifying.
 * The --max baseline lets CI alert when the unhandled count GROWS (a new scrape
 * leak) without flapping on the stable FP tail.
 */
const fs = require('fs');
const path = require('path');
const { detectCrossShowUrlMismatch } = require('./lib/cross-show-url');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

const FIX = process.argv.includes('--fix');
const JSON_OUT = process.argv.includes('--json');
const STRICT = process.argv.includes('--strict');
const maxArg = process.argv.find(a => a.startsWith('--max='));
const MAX = maxArg ? parseInt(maxArg.split('=')[1], 10) : 0; // strict fails when unhandled > MAX

// A file is already handled if a guard/human has resolved its show membership.
// Mirrors shouldSkipCrossShowUrlFlag (review-guards.js) plus the exclusion flags
// the rebuild already honors, so the audit never re-flags resolved files.
function isAlreadyHandled(d) {
  if (!d || typeof d !== 'object') return false;
  return !!(
    d.wrongShow === true ||
    d.wrongProduction === true ||
    d.duplicateOf ||
    d.isRoundupArticle === true ||
    d.wrongProductionManualClear === true ||
    d.wrongProductionOverride === true ||
    d.humanReviewedWrongProduction === false ||
    d.allowCrossMarket === true ||
    (d.contentVerification && d.contentVerification.wrongProduction === false)
  );
}

function main() {
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error(`✗ review-texts not found at ${REVIEW_TEXTS_DIR} (worktree without data symlinks?)`);
    process.exit(2);
  }
  const showsPath = fs.existsSync(SHOWS_PATH) ? SHOWS_PATH : undefined;
  const dirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
    if (d === '_pending') return false;
    try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory(); } catch { return false; }
  });

  let scanned = 0;
  const hits = [];
  for (const showId of dirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try { files = fs.readdirSync(showDir).filter(f => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(showDir, f);
      let d;
      try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      const url = d.url || d.sourceUrl;
      if (!url) continue;
      scanned++;
      const mismatch = detectCrossShowUrlMismatch(showId, url, showsPath ? { showsPath } : {});
      if (!mismatch) continue;
      const handled = isAlreadyHandled(d);
      const scored = (d.score ?? d.normalizedScore ?? d.assignedScore) != null;
      hits.push({ showId, file: f, filePath: fp, matchedShowId: mismatch.matchedShowId, matchedTitle: mismatch.matchedTitle, handled, scored, url });
    }
  }

  const unhandled = hits.filter(h => !h.handled);

  if (FIX && unhandled.length) {
    for (const h of unhandled) {
      try {
        const d = JSON.parse(fs.readFileSync(h.filePath, 'utf8'));
        d.wrongShow = true;
        d.isValid = false;
        d.rejectionReason = 'wrong_show';
        d.wrongShowReason = `URL slug names "${h.matchedTitle}" (${h.matchedShowId}), not this show — cross-show URL audit`;
        d.wrongShowFlaggedDate = new Date().toISOString().slice(0, 10);
        fs.writeFileSync(h.filePath, JSON.stringify(d, null, 2) + '\n');
      } catch (e) {
        console.error(`  ✗ failed to fix ${h.filePath}: ${e.message}`);
      }
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ scanned, total: hits.length, handled: hits.length - unhandled.length, unhandled: unhandled.length, fixed: FIX ? unhandled.length : 0, hits: unhandled }, null, 2));
  } else {
    console.log(`Cross-show URL audit: scanned ${scanned} files with URLs`);
    console.log(`  mismatches: ${hits.length}  (already handled: ${hits.length - unhandled.length}, UNHANDLED: ${unhandled.length}, of which scored: ${unhandled.filter(h => h.scored).length})`);
    for (const h of unhandled.slice(0, 60)) {
      console.log(`  ${h.scored ? '[SCORED]   ' : '[unscored] '}${h.showId} <- ${h.matchedShowId} | ${h.file} | ${h.url.slice(0, 70)}`);
    }
    if (unhandled.length > 60) console.log(`  … ${unhandled.length - 60} more`);
    if (FIX) console.log(`\n✓ Flagged ${unhandled.length} file(s) as wrongShow.`);
  }

  if (STRICT && unhandled.length > MAX && !FIX) {
    console.error(`\n✗ STRICT: ${unhandled.length} unhandled cross-show URL mismatch(es) > baseline ${MAX}. A new scrape likely leaked cross-show URLs — triage the clusters (2+ reviews → same other show) and --fix the confirmed ones.`);
    process.exit(1);
  }
}

main();
