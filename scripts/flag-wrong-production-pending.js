#!/usr/bin/env node
/**
 * Flag files in data/review-texts/_pending/{show-id}/ as wrongProduction when
 * the URL date falls clearly outside the show's date window. Companion to
 * flag-wrong-production-by-url-date.js (which sweeps main show directories).
 *
 * _pending/ holds Unknown-byline SERP hits awaiting AUTHOR ENRICHMENT. When
 * enrichment promotes one into a show directory with a named critic, the
 * wrongProduction flag persists so rebuild-all-reviews.js excludes it.
 *
 * We flag rather than delete — flagged files keep the audit trail of "SERP
 * found this, here's why we rejected it." Rebuild ignores them either way.
 *
 * Uses the shared helper getWrongProductionReasonFromUrl() so ingest-time guard
 * (scripts/gather-reviews.js) and this post-hoc sweep apply identical rules.
 *
 * Usage:
 *   node scripts/flag-wrong-production-pending.js              # dry run, all shows
 *   node scripts/flag-wrong-production-pending.js --apply      # write flags
 *   node scripts/flag-wrong-production-pending.js --show=ID    # one show
 */
const fs = require('fs');
const path = require('path');
const { getWrongProductionReasonFromUrl } = require('./lib/review-guards');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const PENDING_DIR = path.join(__dirname, '..', 'data', 'review-texts', '_pending');
const APPLY = process.argv.includes('--apply');
const ONLY_SHOW = (process.argv.find(a => a.startsWith('--show=')) || '').split('=')[1];

if (!fs.existsSync(SHOWS_PATH)) {
  console.error(`shows.json not found at ${SHOWS_PATH}`);
  process.exit(1);
}
if (!fs.existsSync(PENDING_DIR)) {
  console.log(`_pending/ not found at ${PENDING_DIR} — nothing to do.`);
  process.exit(0);
}

const SHOWS = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
const showList = Array.isArray(SHOWS.shows) ? SHOWS.shows : Object.values(SHOWS.shows || SHOWS);
const showMap = {};
for (const s of showList) showMap[s.id] = s;

const showDirs = fs
  .readdirSync(PENDING_DIR)
  .filter((d) => fs.statSync(path.join(PENDING_DIR, d)).isDirectory());

let flaggedCount = 0;
let scannedCount = 0;
const flaggedDetails = [];
const skippedDetails = [];

for (const showId of showDirs) {
  if (ONLY_SHOW && showId !== ONLY_SHOW) continue;
  const show = showMap[showId];
  if (!show) {
    skippedDetails.push({ showId, file: '*', reason: 'show not in shows.json' });
    continue;
  }

  const showDir = path.join(PENDING_DIR, showId);
  const files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json'));

  for (const f of files) {
    scannedCount++;
    const fp = path.join(showDir, f);
    let d;
    try {
      d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {
      skippedDetails.push({ showId, file: f, reason: 'parse error' });
      continue;
    }

    // Skip if already flagged or manually cleared
    if (d.wrongProduction || d.wrongShow || d.manualClear || d.allowEarlyDate || d.allowLateDate) {
      continue;
    }

    const reason = getWrongProductionReasonFromUrl(d.url, show);
    if (!reason) continue;

    flaggedDetails.push({
      showId,
      file: f,
      url: d.url,
      outletId: d.outletId,
      reason,
    });
    flaggedCount++;

    if (APPLY) {
      d.wrongProduction = true;
      d.wrongProductionNote = reason;
      d.wrongProductionFlaggedAt = new Date().toISOString();
      d.wrongProductionFlaggedBy = 'script:flag-wrong-production-pending.js';
      fs.writeFileSync(fp, JSON.stringify(d, null, 2));
    }
  }
}

console.log(APPLY ? 'APPLIED' : 'DRY RUN');
console.log(`Scanned: ${scannedCount} files across ${showDirs.length} show dir(s)`);
console.log(`Flagged: ${flaggedCount}`);
if (flaggedDetails.length) {
  console.log('');
  console.log('Files flagged:');
  flaggedDetails.forEach((x) => {
    console.log(`  ${x.showId} | ${x.file} | ${x.outletId || '?'} | ${x.url}`);
    console.log(`    → ${x.reason}`);
  });
}
if (skippedDetails.length) {
  console.log('');
  console.log(`Skipped: ${skippedDetails.length}`);
  skippedDetails.forEach((x) => console.log(`  ${x.showId} | ${x.file} | ${x.reason}`));
}
