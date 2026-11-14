#!/usr/bin/env node
'use strict';
/**
 * audit-body-date-mismatch.js (BRO-2770): review-texts files whose own byline
 * date disagrees with publishDate by more than 3 days.
 *
 * That mismatch means the body and the metadata describe different articles
 * (a body replaced in place while url/publishDate/stars stayed, or a stale
 * body under a correct url), or simply a wrong publishDate. Either way the
 * date guards judge the file on a date that is not its own.
 *
 * A hit is "explained" when the record is already excluded from scores for
 * a reason the byline does not contradict (wrongShow, duplicateOf,
 * isNonReview, isRoundupArticle, a content-based wrongProduction), or its
 * corrected url is awaiting re-fetch. A DATE-based wrongProduction whose
 * byline is inside the run is unexplained: the real review is excluded off a
 * stale date. Body swaps the shared writer marked needsUrlRepair are listed
 * too, until their url is repaired.
 *
 * Usage:
 *   node scripts/audit-body-date-mismatch.js [--max-unexplained=N] [--json] [--dir=PATH]
 * Exit: 0 unexplained <= N (default 0) / 1 above / 3 bad --max-unexplained, corpus missing or unreadable.
 * Runs daily (non-blocking) in check-corpus-drift.js.
 */
const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { detectBodyDateMismatch, isUrlRepairPending } = require('./lib/body-date-mismatch');
const { evaluateCurrentRunCorroboration } = require('./lib/wrong-production-corroboration');
const { isDateClaimWrongProduction } = require('./lib/stale-flag-neutralization');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `audit-body-date-mismatch.js — byline date vs publishDate (>3 days apart)
Usage:
  node scripts/audit-body-date-mismatch.js [--max-unexplained=N] [--json] [--dir=PATH]
  node scripts/audit-body-date-mismatch.js --help, -h    print this usage and exit
`;

/**
 * Why a mismatching record is already handled, or null (= unexplained).
 * A wrongProduction flag only explains it when the flag is about the content:
 * a DATE-based flag whose own byline sits inside the run window is exactly the
 * stale-date victim this audit exists to surface (BRO-2770).
 */
function explainedBy(d, show) {
  if (d.crossOutletDuplicate === true) return 'crossOutletDuplicate';
  if (d.wrongProduction === true) {
    // A content reason (set by a person or a verifier) stands whatever the date says.
    if (d.wrongProductionReason && !isDateClaimWrongProduction({ wrongProductionReason: d.wrongProductionReason })) return 'wrongProduction';
    const dateBased = isDateClaimWrongProduction(d);
    const corrob = show ? evaluateCurrentRunCorroboration({ review: d, show }) : { signals: [] };
    if (dateBased && corrob.signals.some((sig) => sig.startsWith('body-byline-date:'))) return null;
    return 'wrongProduction';
  }
  if (d.wrongShow === true) return 'wrongShow';
  if (d.duplicateOf) return 'duplicateOf';
  if (d.isNonReview === true) return 'isNonReview';
  if (d.isRoundupArticle === true) return 'isRoundupArticle';
  // Excluded on the text or the attribution, which a byline date can't contradict.
  if (d.isNotReview === true) return 'isNotReview';
  if (d.wrongAttribution === true) return 'wrongAttribution';
  if (d.rejectedAt || d.rejectionReason) return 'rejected';
  // url already corrected, body not yet re-fetched: the stale body is queued
  // for replacement (isAwaitingUrlCorrectionRefetch's state).
  if (d.needsRefetch === true && d.urlCorrectedFrom) return 'awaiting-url-refetch';
  return null;
}

function loadShowsById(showsPath) {
  try {
    const shows = JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows || [];
    return new Map(shows.map((s) => [s.id, s]));
  } catch {
    return new Map();
  }
}

/**
 * hits: byline/publishDate mismatches (with explainedBy).
 * repairPending: body swaps whose url still names the old article
 * (review-write-guard.js stamps needsUrlRepair; nothing else reads it, so this
 * daily list is the repair queue). Both count as unexplained until fixed.
 */
function scanCorpus(root, { showsById = new Map() } = {}) {
  const hits = [];
  const repairPending = [];
  let files = 0;
  for (const showId of listShowDirs(root, { silent: true, skipHolding: true })) {
    const dir = path.join(root, showId);
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch { continue; }
    for (const file of entries) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      files++;
      if (isUrlRepairPending(d)) repairPending.push({ showId, file, url: d.url, swap: d.bodySwapDetected });
      const m = detectBodyDateMismatch(d);
      if (!m) continue;
      hits.push({ showId, file, ...m, explainedBy: explainedBy(d, showsById.get(showId)) });
    }
  }
  return { files, hits, repairPending };
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const arg = (k) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : null; };
  const maxArg = arg('max-unexplained');
  const max = maxArg != null ? Number(maxArg) : 0;
  if ((maxArg != null && !/^\d+$/.test(maxArg)) || !Number.isInteger(max)) {
    console.error(`audit-body-date-mismatch: --max-unexplained must be a whole number >= 0, got "${maxArg}"`);
    return 3;
  }
  const root = arg('dir') || path.join(__dirname, '..', 'data', 'review-texts');
  if (!fs.existsSync(root)) {
    console.error(`audit-body-date-mismatch: corpus missing at ${root}`);
    return 3;
  }
  const showsById = loadShowsById(arg('shows') || path.join(__dirname, '..', 'data', 'shows.json'));
  const { files, hits, repairPending } = scanCorpus(root, { showsById });
  if (files === 0) {
    console.error(`audit-body-date-mismatch: no review files under ${root}`);
    return 3;
  }
  const unexplained = hits.filter((h) => !h.explainedBy);
  const problems = unexplained.length + repairPending.length;
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ files, hits: hits.length, unexplained: unexplained.length, repairPending, rows: hits }, null, 2));
  } else {
    console.log(`Scanned ${files} files: ${hits.length} byline/publishDate mismatches (>3d), ${unexplained.length} unexplained, ${repairPending.length} body swap(s) awaiting url repair (max ${max} combined)`);
    for (const h of hits) {
      console.log(`  ${h.explainedBy ? `[${h.explainedBy}]` : '[UNEXPLAINED]'} ${h.showId}/${h.file}: publishDate ${h.publishDate}, byline ${h.bodyDate} (${h.deltaDays > 0 ? '+' : ''}${h.deltaDays}d)`);
    }
    for (const r of repairPending) {
      console.log(`  [URL-REPAIR] ${r.showId}/${r.file}: body replaced in place (byline ${r.swap.oldBodyDate} -> ${r.swap.newBodyDate}); url still ${r.url}`);
    }
    if (unexplained.length || repairPending.length) {
      console.log('Fix: check the body is this review; correct publishDate (review-field-edit plan) or, if the body is another article, exclude it and refetch the url. A date-based wrongProduction contradicted by the byline: fix publishDate, then clear the flag. URL-REPAIR: set the url of the article the body now holds (review-field-edit url repair).');
    }
  }
  return problems > max ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { explainedBy, scanCorpus };
