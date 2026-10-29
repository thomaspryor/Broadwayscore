#!/usr/bin/env node
/**
 * BRO-5582: stamp wrongProductionLegacyAudit on wrongProduction=true review files that have no
 * trail at all. Dry run unless --apply; --apply needs --expect=N (N > 0) and exits nonzero unless
 * exactly N files were written with none refused by the write guard. Output is counts and paths.
 * Writes go through safeWriteReview. Runs in CI via execute-approved-fix (run-script).
 */
const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const { AUDIT_FIELD, legacyAuditStamp } = require('./lib/wrongproduction-legacy-audit');

const REVIEW_DIR = path.join(__dirname, '../data/review-texts');

function backfill({ apply, reviewDir = REVIEW_DIR, at = new Date().toISOString() }) {
  const report = { scanned: 0, eligible: 0, written: 0, refused: [], dryRun: !apply };
  for (const showId of fs.readdirSync(reviewDir)) {
    const showDir = path.join(reviewDir, showId);
    if (!fs.statSync(showDir).isDirectory()) continue;
    for (const file of fs.readdirSync(showDir).filter(f => f.endsWith('.json'))) {
      const filePath = path.join(showDir, file);
      let record;
      try { record = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
      report.scanned++;
      const stamp = legacyAuditStamp(record, { at });
      if (!stamp) continue;
      report.eligible++;
      if (!apply) continue;
      const result = safeWriteReview(filePath, { ...record, [AUDIT_FIELD]: stamp });
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (result && result.wrote === true && saved[AUDIT_FIELD] && saved.wrongProduction === true) report.written++;
      else report.refused.push(`${showId}/${file}`);
    }
  }
  return report;
}

function problemWith(report, { apply, expect }) {
  if (!report.scanned) return 'no review files scanned (review-texts checkout empty?)';
  if (!apply) return null;
  if (report.refused.length) return `${report.refused.length} file(s) refused by the write guard`;
  if (report.written !== expect) return `wrote ${report.written} file(s), expected ${expect}`;
  return null;
}

function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const expectArg = argv.find(a => a.startsWith('--expect='));
  const expect = expectArg ? Number(expectArg.slice('--expect='.length)) : null;
  if (apply && !(Number.isInteger(expect) && expect > 0)) throw new Error('--apply requires --expect=N with N > 0');
  const report = backfill({ apply });
  console.log(JSON.stringify({ ...report, refused: report.refused.slice(0, 20) }, null, 2));
  const problem = problemWith(report, { apply, expect });
  if (problem) { console.error(`FAIL: ${problem}`); process.exit(1); }
}

if (require.main === module) main();
module.exports = { backfill, problemWith };
