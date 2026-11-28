#!/usr/bin/env node
'use strict';
/**
 * BRO-3497: count and batch the stale Talkin' Broadway review files that the
 * BRO-912 extractor fix can still improve. Read-only: it never fetches a page,
 * never writes a review file and never dispatches a workflow.
 *
 * Usage:
 *   node scripts/re-extract-talkin-broadway-reviews.js [--dir=data/review-texts]
 *        [--fix-date=ISO] [--batch-size=25] [--batches] [--limit=N] [--json]
 *
 *   (default)   before/after counter: TB files, stale, eligible, drop reasons.
 *               Run it before and after the re-extract runs and compare.
 *   --batches   also print one cloud-dispatch command per batch
 *               (collect-review-texts.yml with review_filter=force:<showId/file>,...,
 *               show_filter, max_reviews). --limit=N keeps only the first N
 *               candidates (the card's "run 5 first" trial).
 *   --json      machine-readable { summary, candidates, batches }.
 *
 * Selection rules live in scripts/lib/tb-reextract-selection.js.
 */
const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { selectCandidates, buildBatches, DEFAULT_FIX_DATE, isTbFileName } = require('./lib/tb-reextract-selection');

function parseArgs(argv) {
  const opts = { dir: 'data/review-texts', fixDate: DEFAULT_FIX_DATE, batchSize: 25, batches: false, limit: 0, json: false };
  for (const a of argv) {
    if (a.startsWith('--dir=')) opts.dir = a.slice(6);
    else if (a.startsWith('--fix-date=')) opts.fixDate = a.slice(11);
    else if (a.startsWith('--batch-size=')) opts.batchSize = Number(a.slice(13));
    else if (a.startsWith('--limit=')) opts.limit = Number(a.slice(8));
    else if (a === '--batches') opts.batches = true;
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') { opts.help = true; }
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isFinite(Date.parse(opts.fixDate))) throw new Error(`--fix-date is not a date: ${opts.fixDate}`);
  if (!(opts.batchSize >= 1)) throw new Error('--batch-size must be >= 1');
  if (!(opts.limit >= 0)) throw new Error('--limit must be >= 0');
  return opts;
}

function loadEntries(dir) {
  const entries = [];
  let unreadable = 0;
  for (const showId of listShowDirs(dir, { silent: true })) {
    let files;
    try { files = fs.readdirSync(path.join(dir, showId)); } catch (e) { continue; }
    for (const file of files) {
      if (!isTbFileName(file)) continue;
      try {
        entries.push({ showId, file, data: JSON.parse(fs.readFileSync(path.join(dir, showId, file), 'utf8')) });
      } catch (e) { unreadable++; }
    }
  }
  return { entries, unreadable };
}

function dispatchCommand(b) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return `node scripts/cloud-dispatch.js collect-review-texts.yml -f max_reviews=${b.max_reviews} -f chain=false`
    + ` -f show_filter=${q(b.show_filter)} -f review_filter=${q(b.review_filter)}`;
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (opts.help) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 20).join('\n')); return; }
  if (!fs.existsSync(opts.dir)) {
    console.error(`review-texts dir not found: ${opts.dir} (run ./scripts/setup-local-data.sh or pass --dir=)`);
    process.exit(2);
  }
  const { entries, unreadable } = loadEntries(opts.dir);
  const { summary, candidates } = selectCandidates(entries, { fixDate: opts.fixDate });
  const picked = opts.limit > 0 ? candidates.slice(0, opts.limit) : candidates;
  const batches = opts.batches ? buildBatches(picked, opts.batchSize) : [];

  if (opts.json) {
    console.log(JSON.stringify({ fixDate: opts.fixDate, unreadable, summary, candidates: picked, batches }, null, 2));
    return;
  }
  console.log(`Talkin' Broadway files: ${summary.tbFiles}${unreadable ? ` (${unreadable} unreadable)` : ''}`);
  console.log(`Stale (truncated/invalid/excerpt/stub, not manual): ${summary.stale}`);
  console.log(`  by tier: ${JSON.stringify(summary.byTier)}`);
  console.log(`Eligible for re-extract (clean, real review page, fetched before ${opts.fixDate.slice(0, 10)}): ${summary.eligible}`);
  for (const [reason, n] of Object.entries(summary.byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${reason}`);
  }
  if (opts.batches) {
    console.log(`\n${batches.length} batch(es) covering ${picked.length} review(s):`);
    for (const b of batches) console.log(dispatchCommand(b));
  }
}

if (require.main === module) main();

module.exports = { parseArgs, dispatchCommand };
