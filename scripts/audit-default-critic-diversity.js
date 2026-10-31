#!/usr/bin/env node
/**
 * audit-default-critic-diversity.js (BRO-6056)
 *
 * Lists outlets whose registry `defaultCritic` would fill blank bylines even
 * though their review-text files show several other named critics. Each one
 * listed is an outlet where a byline-less review gets credited to the wrong
 * person. Fix: set `multiAuthor: true` (plus a `multiAuthorNote`) in
 * data/outlet-registry.json, or `multiAuthor: false` after checking that the
 * default really does write nearly everything.
 *
 * The rule lives in scripts/lib/default-critic-diversity.js.
 *
 * Usage:
 *   node scripts/audit-default-critic-diversity.js            report
 *   node scripts/audit-default-critic-diversity.js --all      also list every defaultCritic outlet's verdict
 *   node scripts/audit-default-critic-diversity.js --json     machine-readable
 *   node scripts/audit-default-critic-diversity.js --strict   exit 1 when any outlet is listed
 *
 * Exit: 0 clean (or no review-texts checkout, with a warning), 1 --strict and
 * outlets listed, 2 bad input (unreadable registry, or a checkout with no files).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { listShowDirs } = require('./lib/list-show-dirs');
const {
  summarizeOutletBylines,
  classifyOutlet,
  findUnflaggedMultiAuthorOutlets,
} = require('./lib/default-critic-diversity');

const ROOT = path.join(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'data', 'outlet-registry.json');

function loadRecords(dir) {
  const records = [];
  let unreadable = 0;
  for (const show of listShowDirs(dir, { skipHolding: true })) {
    if (show.startsWith('.')) continue;
    const showDir = path.join(dir, show);
    let files;
    try { files = fs.readdirSync(showDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
        records.push({
          outletId: d.outletId,
          criticName: d.criticName,
          publishDate: d.publishDate,
          wrongAttribution: d.wrongAttribution,
          wrongShow: d.wrongShow,
          wrongProduction: d.wrongProduction,
          isRoundupArticle: d.isRoundupArticle,
        });
      } catch { unreadable++; /* validate-review-texts reports the file itself */ }
    }
  }
  records.unreadable = unreadable;
  return records;
}

function fmtOthers(others, n = 6) {
  return others.slice(0, n).map((o) => {
    const yrs = o.firstYear == null ? '' : o.firstYear === o.lastYear ? ` ${o.firstYear}` : ` ${o.firstYear}-${o.lastYear}`;
    return `${o.name} x${o.count}${yrs}`;
  }).join(', ') + (others.length > n ? `, +${others.length - n} more` : '');
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const strict = args.includes('--strict');
  const all = args.includes('--all');

  let outlets;
  try {
    outlets = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')).outlets;
  } catch (e) {
    console.error(`Cannot read ${REGISTRY_PATH}: ${e.message}`);
    return 2;
  }
  const dir = resolveReviewTextsDir();
  if (!fs.existsSync(dir)) {
    console.warn(`No review-texts checkout at ${dir}; nothing to audit.`);
    return 0;
  }
  const records = loadRecords(dir);
  if (records.length === 0) {
    console.error(`No review-text files read from ${dir}: an empty checkout cannot pass this audit.`);
    return 2;
  }
  const rows = findUnflaggedMultiAuthorOutlets(records, outlets);

  if (asJson) {
    console.log(JSON.stringify({ reviewTextsDir: dir, files: records.length, unreadable: records.unreadable, unflagged: rows }, null, 2));
  } else {
    console.log(`Default-critic diversity audit: ${records.length} review-text files in ${dir}${records.unreadable ? ` (${records.unreadable} unreadable, skipped)` : ''}`);
    if (all) {
      for (const s of summarizeOutletBylines(records, outlets).values()) {
        const c = classifyOutlet(s);
        const flag = s.multiAuthor === true ? 'multiAuthor' : s.multiAuthor === false ? 'reviewed-single' : 'fills';
        console.log(`  [${c.verdict}/${flag}] ${s.outletId} (${s.defaultCritic}): ${c.reason}`);
      }
    }
    if (rows.length === 0) {
      console.log('OK: every defaultCritic outlet with several other named critics is marked multiAuthor.');
    } else {
      console.log(`\n${rows.length} outlet(s) fill blank bylines with a defaultCritic who is one of several critics:`);
      for (const r of rows) {
        const dy = r.defaultYears[0] == null ? '' : ` (${r.defaultYears[0]}-${r.defaultYears[1]})`;
        console.log(`  ${r.outletId}: default ${r.defaultCritic} x${r.defaultCount}${dy}, unnamed ${r.unnamedCount}; others: ${fmtOthers(r.others)}`);
      }
      console.log('\nFix: set "multiAuthor": true with a "multiAuthorNote" in data/outlet-registry.json, or "multiAuthor": false after checking the default writes nearly all of them.');
    }
  }
  return strict && rows.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { loadRecords, main };
