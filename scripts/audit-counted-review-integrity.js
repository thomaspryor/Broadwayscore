#!/usr/bin/env node
'use strict';

/**
 * audit-counted-review-integrity.js (BRO-4886)
 *
 * Corpus-wide check of the counted review set (data/reviews.json) against
 * data/shows.json. See scripts/lib/counted-review-integrity.js for the seven
 * invariants and the incident that produced them.
 *
 * Read-only. Exit 0 when the total is at or under --max (or no --max is
 * given), 1 when it grew above the baseline, 2 when the data is missing.
 *
 * Usage:
 *   node scripts/audit-counted-review-integrity.js
 *   node scripts/audit-counted-review-integrity.js --max=250 --max-junk-outlet=4
 *   node scripts/audit-counted-review-integrity.js --check=junk-outlet --verbose
 *   node scripts/audit-counted-review-integrity.js --show=private-lives-2002
 *   node scripts/audit-counted-review-integrity.js --json=/tmp/out.json
 *   node scripts/audit-counted-review-integrity.js --flagged [--max=450]
 *
 * --flagged switches to the other direction: review-text files excluded as wrong
 * production or wrong show although their date and URL year sit inside the run
 * (recovery leads, needs data/review-texts).
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { CHECKS, detectCountedReviewIssues, findFlaggedGenuineCandidates } = require('./lib/counted-review-integrity.js');
const { listShowDirs } = require('./lib/list-show-dirs');

const DATA = path.join(__dirname, '..', 'data');

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

let unreadableFiles = 0;

function* iterateReviewFiles() {
  const root = process.env.REVIEW_TEXTS_DIR || path.join(DATA, 'review-texts');
  for (const showId of listShowDirs(root)) {
    const dir = path.join(root, showId);
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      let data;
      try { data = readJson(path.join(dir, file)); } catch { unreadableFiles += 1; continue; }
      yield { showId, file, data };
    }
  }
}

function runFlagged(shows) {
  const root = process.env.REVIEW_TEXTS_DIR || path.join(DATA, 'review-texts');
  if (!fs.existsSync(root)) {
    console.error(`audit-counted-review-integrity --flagged: ${root} is missing`);
    return 2;
  }
  const hits = findFlaggedGenuineCandidates({ shows, files: iterateReviewFiles() });
  console.log(`Excluded but dated and URL-dated inside the run: ${hits.length} file(s) across ${new Set(hits.map((h) => h.showId)).size} show(s)`);
  if (unreadableFiles > 0) {
    // A half-written file during a concurrent rebuild would otherwise just shrink the count.
    console.log(`  note: ${unreadableFiles} review file(s) could not be parsed and were skipped`);
  }
  if (process.argv.includes('--verbose')) {
    for (const h of hits) console.log(`  ${h.showId}/${h.file} | ${h.outlet || '-'} | ${h.reason || h.detail}`);
  }
  const jsonOut = argValue('json');
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(hits, null, 2));
  const max = argValue('max');
  if (max !== null && hits.length > Number(max)) {
    console.error(`Over baseline: ${hits.length} > ${max}.`);
    return 1;
  }
  return 0;
}

function main() {
  if (hasHelpFlag(process.argv)) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[^]*?\/\*\*/, '').replace(/^ \* ?/gm, ''));
    return 0;
  }
  let shows;
  let reviews;
  let outletRegistry = null;
  try {
    shows = readJson(path.join(DATA, 'shows.json')).shows;
    reviews = readJson(path.join(DATA, 'reviews.json')).reviews;
  } catch (e) {
    console.error(`audit-counted-review-integrity: cannot read data/shows.json or data/reviews.json (${e.message})`);
    return 2;
  }
  try { outletRegistry = readJson(path.join(DATA, 'outlet-registry.json')); } catch { /* junk-outlet check degrades to topic URLs */ }

  if (process.argv.includes('--flagged')) return runFlagged(shows);
  const result = detectCountedReviewIssues({ shows, reviews, outletRegistry });
  const onlyCheck = argValue('check');
  const onlyShow = argValue('show');
  const shown = result.issues.filter((i) => (!onlyCheck || i.check === onlyCheck) && (!onlyShow || i.showId === onlyShow));

  console.log(`Counted-review integrity: ${result.total} issue(s) across ${new Set(result.issues.map((i) => i.showId)).size} show(s)`);
  for (const c of CHECKS) console.log(`  ${c.padEnd(24)} ${result.counts[c]}`);
  if (process.argv.includes('--verbose') || onlyCheck || onlyShow) {
    for (const i of shown) {
      console.log(`  [${i.check}] ${i.showId} | ${i.outlet || '-'} | ${i.critic || '-'} | ${i.score ?? '-'} | ${i.detail}`);
    }
  }
  const jsonOut = argValue('json');
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(result, null, 2));

  // One total baseline lets a noisy check hide growth in a quiet one, so each check can also
  // carry its own: --max-junk-outlet=4. Any breach is drift.
  const breaches = [];
  const max = argValue('max');
  if (max !== null && result.total > Number(max)) breaches.push(`total ${result.total} > ${max}`);
  for (const c of CHECKS) {
    const perCheck = argValue(`max-${c}`);
    if (perCheck !== null && result.counts[c] > Number(perCheck)) breaches.push(`${c} ${result.counts[c]} > ${perCheck}`);
  }
  if (breaches.length) {
    console.error(`Over baseline: ${breaches.join('; ')}. Triage the new rows with --check=<name> --verbose, fix the cause, or re-baseline after a cleanup pass.`);
    return 1;
  }
  return 0;
}

process.exitCode = main();
