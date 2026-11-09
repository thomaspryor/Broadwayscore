#!/usr/bin/env node
'use strict';

/**
 * audit-approved-fix-drift.js (BRO-7155): list review-text files whose newest
 * approved-fix stamp for an exclusion field (wrongShow, wrongProduction,
 * isNonReview, isRoundupArticle, duplicateOf, crossOutletDuplicate) no longer
 * matches the field, minus the drifts a later recorded decision explains.
 *
 * Usage:
 *   node scripts/audit-approved-fix-drift.js            # human summary
 *   node scripts/audit-approved-fix-drift.js --json     # machine output
 *   node scripts/audit-approved-fix-drift.js --all      # also list explained drifts
 *   node scripts/audit-approved-fix-drift.js --strict   # exit 1 when any unexplained drift
 *   node scripts/audit-approved-fix-drift.js --alert    # file/refresh a worker card via owner-alert-router
 *                                                       # (resolves the condition when clean; BRO-7179)
 *   --dir=<review-texts dir>                            # default data/review-texts
 *
 * Exit: 0 ok (or advisory), 1 unexplained drift with --strict, 2 no review texts.
 * Restore a real drift with a pending-fix plan (scripts/new-fix-plan.js
 * --review-edit), never by editing the private repo.
 */

const fs = require('fs');
const path = require('path');
const { classifyRecord, decideDriftAlert } = require('./lib/approved-fix-drift');
const { listShowDirs } = require('./lib/list-show-dirs');
const { routeAuditDecisions } = require('./lib/audit-alert');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const dirArg = args.find((a) => a.startsWith('--dir='));
const DIR = dirArg ? dirArg.slice(6) : path.join(__dirname, '..', 'data', 'review-texts');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

async function main() {
  if (!fs.existsSync(DIR)) {
    console.error(`audit-approved-fix-drift: no review texts at ${DIR}`);
    return 2;
  }
  const drifts = [];
  let scanned = 0;
  for (const show of listShowDirs(DIR, { silent: true }).sort()) {
    const sdir = path.join(DIR, show);
    let names;
    try { names = fs.readdirSync(sdir).filter((n) => n.endsWith('.json')); } catch (_) { continue; }
    const records = {};
    for (const n of names) records[n] = readJson(path.join(sdir, n));
    for (const n of names.sort()) {
      const rec = records[n];
      if (!rec || !Array.isArray(rec.approvedFixes)) continue;
      scanned++;
      // siblings: absent key = file missing; present but null = unreadable
      drifts.push(...classifyRecord(`${show}/${n}`, rec, { siblings: records }));
    }
  }
  const unexplained = drifts.filter((d) => !d.explained);
  const explained = drifts.filter((d) => d.explained);
  const byField = {};
  for (const d of unexplained) byField[d.field] = (byField[d.field] || 0) + 1;

  if (flag('--json')) {
    const slim = (d) => ({ file: d.file, field: d.field, approved: d.stamp.newValue, approvedAt: d.stamp.at, fixId: d.stamp.fixId, current: d.current, explained: d.explained });
    console.log(JSON.stringify({
      scannedWithApprovedFixes: scanned,
      drifts: drifts.length,
      unexplainedCount: unexplained.length,
      explainedCount: explained.length,
      unexplainedByField: byField,
      unexplained: unexplained.map(slim),
      ...(flag('--all') ? { explained: explained.map(slim) } : {}),
    }, null, 2));
  } else {
    console.log(`Approved-fix drift: ${scanned} files with approvedFixes, ${drifts.length} drifts, ${unexplained.length} unexplained, ${explained.length} explained.`);
    for (const d of unexplained) {
      console.log(`  UNEXPLAINED ${d.file} ${d.field}: approved ${JSON.stringify(d.stamp.newValue)} at ${d.stamp.at} (fix ${d.stamp.fixId}), now ${JSON.stringify(d.current)}`);
    }
    if (flag('--all')) for (const d of explained) console.log(`  explained   ${d.file} ${d.field}: ${d.explained}`);
    if (unexplained.length) console.log('Restore each with node scripts/new-fix-plan.js --review-edit=<show>/<file>.json:<field>=<value>, then find the writer that erased it.');
  }
  if (flag('--alert')) await routeAuditDecisions(decideDriftAlert(unexplained), 'audit-approved-fix-drift');
  return flag('--strict') && unexplained.length ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (err) => {
  console.error(`audit-approved-fix-drift: ${err.stack || err.message}`);
  process.exitCode = 3;
});
