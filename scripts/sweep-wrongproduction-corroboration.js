#!/usr/bin/env node
/**
 * One-time sweep for card #1572: find wrongProduction:true review-text files
 * whose OWN in-file corroboration (Theatre Record archive month, or current-run
 * roundup excerpts) contradicts the date that got them flagged by
 * flag-wrong-production-by-date.js — candidates for a misparsed publishDate
 * (care-west-end-2026 incident, 2026-07-11) rather than a genuine
 * wrong-production review.
 *
 * Scope, matching flag-wrong-production-by-date.js's own corroboration guard:
 *   - Only files flagged by the DATE guard itself (wrongProductionNote starts
 *     with "Date guard:") — other flaggers (cross-market routing, wrongShow
 *     content mismatch, manual review) aren't misparse candidates.
 *   - Only 'before_preview' date-guard flags. An 'after_close' TR-month match
 *     is more likely a successor production mislinked back (can share the TR
 *     month near closing) than a misparse — see wrong-production-corroboration.js.
 *   - 'theatre-record-month' is the actionable STRONG signal. 'cv-affirms-production'
 *     is deliberately EXCLUDED from the strong bucket here (unlike the live
 *     flagger, which does treat it as strong for single-production shows):
 *     on the 2026-08-16 sweep it produced 700+ hits almost all on curated
 *     historical revivals, where CV affirms "a valid review of this TITLE"
 *     without knowing which YEAR's production — exactly the false-positive
 *     mode the guard's own code comments warn about for multi-production
 *     titles. Reported separately as `cvOnlyInformational` for awareness, not
 *     as sweep-actionable candidates.
 *   - 'roundup-excerpt' is WEAK by design (guard: "flag as usual but warn");
 *     reported for human review, never auto-clear material.
 *
 * This is a READ-ONLY candidate finder. It does not clear any flags — each
 * STRONG hit still needs the live-page date verified before correcting
 * publishDate + clearing wrongProduction with the full manual-clear field set
 * (memory/feedback_manual_review_protection_fields.md).
 *
 * Usage:
 *   node scripts/sweep-wrongproduction-corroboration.js [--out=PATH]
 */
const fs = require('fs');
const path = require('path');
const { evaluateCurrentRunCorroboration, bucketDateGuardCandidate } = require('./lib/wrong-production-corroboration');

const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR
  || path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = process.env.SHOWS_PATH
  || path.join(__dirname, '..', 'data', 'shows.json');

const { hasHelpFlag } = require('./lib/cli-help.js');
const USAGE = `sweep-wrongproduction-corroboration.js — find date-guard wrongProduction:true files whose in-file corroboration contradicts the flag date (card #1572).

Usage:
  node scripts/sweep-wrongproduction-corroboration.js [--out=PATH]
  node scripts/sweep-wrongproduction-corroboration.js --help, -h    print this usage and exit
`;
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = data.shows || data;
  const map = {};
  for (const show of Object.values(shows)) map[show.id] = show;
  return map;
}

function run() {
  const outArg = process.argv.find(a => a.startsWith('--out='));
  const reportPath = outArg
    ? outArg.split('=')[1]
    : path.join(__dirname, '..', 'data', 'audit', 'wrongproduction-corroboration-sweep.json');

  const showMap = loadShows();
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
    const full = path.join(REVIEW_TEXTS_DIR, d);
    return fs.statSync(full).isDirectory() && !d.startsWith('_');
  });

  const strong = [];
  const weak = [];
  const cvOnlyInformational = [];
  let scanned = 0, flaggedTotal = 0, dateGuardFlagged = 0;

  for (const showDir of showDirs) {
    const show = showMap[showDir];
    if (!show) continue;
    const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      scanned++;
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8')); } catch { continue; }
      if (!data.wrongProduction) continue;
      flaggedTotal++;

      const note = data.wrongProductionNote || '';
      if (!note.startsWith('Date guard:')) continue;
      dateGuardFlagged++;
      const isBeforePreview = / is \d+d before /.test(note);

      const corrob = evaluateCurrentRunCorroboration({ review: data, show });
      if (!corrob.strength) continue;

      const entry = {
        showId: showDir,
        title: show.title,
        file,
        publishDate: data.publishDate || null,
        outlet: data.outlet || '?',
        url: data.url || null,
        wrongProductionNote: note,
        signals: corrob.signals,
        theatreRecordUrl: data.theatreRecordUrl || null,
      };

      const bucket = bucketDateGuardCandidate({ corrob, isBeforePreview });
      if (bucket === 'strong') {
        strong.push(entry);
      } else if (bucket === 'weak') {
        weak.push(entry);
      } else {
        // strong on cv-affirms-production alone, or an after_close TR-month
        // match — neither is sweep-actionable here (see header).
        cvOnlyInformational.push(entry);
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    scanned,
    flaggedTotal,
    dateGuardFlagged,
    strongCount: strong.length,
    weakCount: weak.length,
    cvOnlyInformationalCount: cvOnlyInformational.length,
    strong,
    weak,
    cvOnlyInformational,
  };

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`Scanned ${scanned} review files (${flaggedTotal} wrongProduction:true, ${dateGuardFlagged} from the date guard).`);
  console.log(`STRONG candidates (theatre-record-month, before_preview only): ${strong.length}`);
  console.log(`WEAK candidates (roundup excerpt only — flag as usual, warn for review): ${weak.length}`);
  console.log(`Informational only (cv-affirms-production / after_close TR-month — not sweep-actionable): ${cvOnlyInformational.length}`);
  console.log(`Report written to ${reportPath}`);
  if (strong.length) {
    console.log('\n--- STRONG candidates (verify live page before correcting) ---');
    for (const h of strong) {
      console.log(`  ${h.showId}/${h.file}  pub=${h.publishDate}  [${h.signals.join(', ')}]`);
    }
  }
}

run();
