#!/usr/bin/env node
/**
 * BRO-23: sweep for false-positive wrongProduction:true review-text files —
 * misparsed publishDate (date-guard flags contradicted by in-file
 * corroboration) and truncated wrongProductionReason strings (rebuild.js's
 * `substring(0, 200)` cutting mid-sentence, e.g.
 * gypsy-2024/culturesauce--thom-geier.json).
 *
 * READ-ONLY. Never clears a flag — each hit still needs a human check
 * (live-page date verification for misparsed-date; reading
 * contentVerification.reasoning or the source article for truncated-reason)
 * before correcting the record with the full manual-clear field set
 * (memory/feedback_manual_review_protection_fields.md).
 *
 * Corroboration guard: entries a human already adjudicated
 * (humanReviewedWrongProduction / wrongProductionProvenance:'manual' /
 * humanReviewScore) are never surfaced as candidates — see
 * scripts/lib/wrong-production-fp-signals.js.
 *
 * Usage:
 *   node scripts/sweep-false-positive-wrong-production.js [--out=PATH]
 */
const fs = require('fs');
const path = require('path');
const { classifyWrongProductionFPCandidate } = require('./lib/wrong-production-fp-signals');
const { listShowDirs } = require('./lib/list-show-dirs');

const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR
  || path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = process.env.SHOWS_PATH
  || path.join(__dirname, '..', 'data', 'shows.json');

const { hasHelpFlag } = require('./lib/cli-help.js');
const USAGE = `sweep-false-positive-wrong-production.js — find wrongProduction:true review-text files that look like false positives from a misparsed publishDate or a truncated wrongProductionReason (BRO-23).

Usage:
  node scripts/sweep-false-positive-wrong-production.js [--out=PATH]
  node scripts/sweep-false-positive-wrong-production.js --help, -h    print this usage and exit
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
  const outArg = process.argv.find((a) => a.startsWith('--out='));
  const reportPath = outArg
    ? outArg.split('=')[1]
    : path.join(__dirname, '..', 'data', 'audit', 'false-positive-wrong-production-sweep.json');

  const showMap = loadShows();
  // listShowDirs tolerates a dangling symlink or stray file among the show
  // dirs (warns + skips) instead of statSync throwing and crashing the whole
  // sweep (2026-05-27 incident — see scripts/lib/list-show-dirs.js header).
  const showDirs = listShowDirs(REVIEW_TEXTS_DIR).filter((d) => !d.startsWith('_'));

  const misparsedDate = [];
  const truncatedReason = [];
  let scanned = 0;
  let flaggedTotal = 0;

  for (const showDir of showDirs) {
    const show = showMap[showDir];
    if (!show) continue;
    const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      scanned++;
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8')); } catch { continue; }
      if (!data.wrongProduction) continue;
      flaggedTotal++;

      const candidate = classifyWrongProductionFPCandidate({ review: data, show });
      if (!candidate) continue;

      const entry = {
        showId: showDir,
        title: show.title,
        file,
        publishDate: data.publishDate || null,
        outlet: data.outlet || '?',
        url: data.url || null,
        wrongProductionNote: data.wrongProductionNote || null,
        wrongProductionReason: data.wrongProductionReason || null,
        strength: candidate.strength,
        signals: candidate.signals,
      };
      if (candidate.kind === 'misparsed-date') {
        misparsedDate.push(entry);
      } else {
        entry.fullReasoning = candidate.fullReasoning;
        truncatedReason.push(entry);
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    scanned,
    flaggedTotal,
    misparsedDateCount: misparsedDate.length,
    truncatedReasonCount: truncatedReason.length,
    misparsedDate,
    truncatedReason,
  };

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`Scanned ${scanned} review files (${flaggedTotal} wrongProduction:true).`);
  console.log(`Misparsed-publishDate candidates: ${misparsedDate.length}`);
  console.log(`Truncated-wrongProductionReason candidates: ${truncatedReason.length}`);
  console.log(`Report written to ${reportPath}`);
  if (misparsedDate.length) {
    console.log('\n--- misparsed-date candidates (verify live page before correcting) ---');
    for (const h of misparsedDate) {
      console.log(`  [${h.strength}] ${h.showId}/${h.file}  pub=${h.publishDate}  [${h.signals.join(', ')}]`);
    }
  }
  if (truncatedReason.length) {
    console.log('\n--- truncated-reason candidates (read full rationale before correcting) ---');
    for (const h of truncatedReason) {
      console.log(`  [${h.strength}] ${h.showId}/${h.file}  ${h.fullReasoning ? '(full reasoning recoverable)' : '(no fallback text)'}`);
    }
  }
}

run();
