#!/usr/bin/env node
/**
 * audit-url-collisions.js — BRO-62: audit multi-critic URL collisions.
 *
 * A "collision" is 2+ review-text files, filed under the same show directory
 * and the same outlet, that share the exact same review `url`. Most are
 * legitimate multi-critic aggregator pages (BWW Reviews Roundup, DTLI, Show
 * Score, Playbill Verdict, …) or explicitly-flagged combined/roundup
 * articles. The rest are the NYSR-type contamination this audit exists to
 * surface: critic B's file was written with critic A's actual review text,
 * so the two files are byte-identical under different criticName values.
 *
 * Classification logic lives in scripts/lib/url-collision-classify.js (pure,
 * unit-tested in tests/unit/audit-url-collisions.test.mjs) — this file only
 * does the filesystem walk, grouping, reporting, and (optionally) applying
 * the one auto-fixable subset.
 *
 * Usage:
 *   node scripts/audit-url-collisions.js
 *   node scripts/audit-url-collisions.js --apply          # fix contamination-fixable group
 *   node scripts/audit-url-collisions.js --review-texts-dir=/path
 *   node scripts/audit-url-collisions.js --report-path=/path/to/report.json
 *   node scripts/audit-url-collisions.js --verbose
 */

const fs = require('fs');
const path = require('path');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { listShowDirs } = require('./lib/list-show-dirs');
const { classifyCollisionGroup } = require('./lib/url-collision-classify');

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const m = args.find((a) => a.startsWith(`--${name}=`));
  return m ? m.split('=').slice(1).join('=') : fallback;
}
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');

const REVIEW_TEXTS_DIR = arg('review-texts-dir', null) || resolveReviewTextsDir();
console.log(`[audit-url-collisions] review-texts: ${REVIEW_TEXTS_DIR}`);

const REPORT_PATH = arg(
  'report-path',
  path.join(__dirname, '..', 'data', 'audit', 'url-collisions-report.json')
);

function log(...m) {
  if (VERBOSE) console.log(...m);
}

if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
  console.error(`Review-texts dir not found: ${REVIEW_TEXTS_DIR}`);
  console.error('Pass --review-texts-dir=/path to override.');
  process.exit(2);
}

function atomicWriteJSON(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Walk review-texts, group by (showDir, outletId, url), classify each group
// ---------------------------------------------------------------------------

const showDirs = listShowDirs(REVIEW_TEXTS_DIR).filter((d) => !d.startsWith('_'));

let totalFiles = 0;
const byCategory = Object.create(null);
const groupsByCategory = Object.create(null);
let totalGroups = 0;

for (const showId of showDirs) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  let files;
  try {
    files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json');
  } catch {
    continue;
  }

  const byKey = new Map(); // "outletId:url" -> [{file, data, outletId}]
  for (const file of files) {
    totalFiles++;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
    } catch {
      continue;
    }
    if (!data.url) continue;
    const outletId = data.outletId || file.split('--')[0];
    const key = `${outletId}:${data.url}`;
    const arr = byKey.get(key);
    if (arr) arr.push({ file, data, outletId });
    else byKey.set(key, [{ file, data, outletId }]);
  }

  for (const [key, entries] of byKey) {
    if (entries.length < 2) continue;
    totalGroups++;
    const outletId = entries[0].outletId;
    const result = classifyCollisionGroup(outletId, entries);

    byCategory[result.category] = (byCategory[result.category] || 0) + 1;
    if (!groupsByCategory[result.category]) groupsByCategory[result.category] = [];
    groupsByCategory[result.category].push({
      showId,
      outletId,
      url: entries[0].data.url,
      files: entries.map((e) => e.file),
      ...result,
    });

    log(`  [${result.category}] ${showId} (${outletId}): ${entries.map((e) => e.file).join(', ')}`);
  }
}

console.log('');
console.log(`Files scanned:      ${totalFiles}`);
console.log(`Collision groups:   ${totalGroups}`);
for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat.padEnd(28)} ${count}`);
}

// ---------------------------------------------------------------------------
// Write report
// ---------------------------------------------------------------------------

fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  config: { reviewTextsDir: REVIEW_TEXTS_DIR },
  summary: { totalFiles, totalGroups, byCategory },
  groups: groupsByCategory,
};
atomicWriteJSON(REPORT_PATH, report);
console.log(`\nReport written: ${REPORT_PATH}`);

// ---------------------------------------------------------------------------
// Apply: fix the unambiguous contamination-fixable subset
// ---------------------------------------------------------------------------

const fixable = groupsByCategory['contamination-fixable'] || [];
if (APPLY) {
  console.log(`\n=== APPLYING ${fixable.length} contamination-fixable group(s) ===`);
  console.log(`Writing to: ${REVIEW_TEXTS_DIR}`);
  console.log('Run git status / commit / push there afterwards.');

  let fixed = 0;
  for (const group of fixable) {
    const showDir = path.join(REVIEW_TEXTS_DIR, group.showId);
    for (const contaminatedFile of group.contaminated) {
      try {
        const filePath = path.join(showDir, contaminatedFile);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (data.duplicateOf || data.duplicateTextOf) continue; // already resolved since the scan
        data.duplicateTextOf = group.canonical;
        data.duplicateClearReason = `audit-url-collisions.js (BRO-62): identical fullText to ${group.canonical} under outlet '${group.outletId}', this file's criticName was unresolved`;
        atomicWriteJSON(filePath, data);
        fixed++;
        console.log(`  [FIXED] ${group.showId}/${contaminatedFile} -> duplicateTextOf ${group.canonical}`);
      } catch (e) {
        console.error(`  ERROR: ${group.showId}/${contaminatedFile}: ${e.message}`);
      }
    }
  }
  console.log(`Fixed ${fixed} file(s).`);
} else if (fixable.length) {
  console.log(`\n${fixable.length} contamination-fixable group(s) found. Run with --apply to fix.`);
}

const needsReview = (groupsByCategory['contamination-needs-review'] || []).length;
if (needsReview) {
  console.log(`\n${needsReview} contamination-needs-review group(s) require manual verification (see report).`);
}
