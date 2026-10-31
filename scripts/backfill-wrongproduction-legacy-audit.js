#!/usr/bin/env node
/**
 * BRO-5582: stamp wrongProductionLegacyAudit on wrongProduction=true review files that have no
 * trail at all. Dry run unless --apply; --apply needs --expect=N (N > 0) and exits nonzero unless
 * exactly N files were written with nothing else changed in any of them. Output is counts and paths.
 * safeWriteReview is deliberately NOT used: its write-time self-heals (duplicate marking, url cleanup,
 * byline fixes) rewrite other fields on ~70 of these files. The file is written raw with only the new
 * key added, and every file is re-read to prove nothing else changed. A counting pass runs first, so a
 * wrong --expect refuses before any write (the workflow pushes review-texts even after a failure).
 * Runs in CI via execute-approved-fix (run-script).
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { AUDIT_FIELD, legacyAuditStamp } = require('./lib/wrongproduction-legacy-audit');

const REVIEW_DIR = path.join(__dirname, '../data/review-texts');

function sameExceptStamp(before, after) {
  const { [AUDIT_FIELD]: _stamp, ...rest } = after;
  return JSON.stringify(before) === JSON.stringify(rest) && !!_stamp;
}

function backfill({ apply, reviewDir = REVIEW_DIR, at = new Date().toISOString(), expect = null }) {
  const report = { scanned: 0, eligible: 0, written: 0, refused: [], dryRun: !apply };
  const targets = [];
  for (const showId of listShowDirs(reviewDir, { silent: true })) {
    const showDir = path.join(reviewDir, showId);
    for (const file of fs.readdirSync(showDir).filter(f => f.endsWith('.json'))) {
      const filePath = path.join(showDir, file);
      let record;
      try { record = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
      report.scanned++;
      const stamp = legacyAuditStamp(record, { at });
      if (stamp) targets.push({ label: `${showId}/${file}`, filePath, record, stamp });
    }
  }
  report.eligible = targets.length;
  if (!apply || (expect !== null && targets.length !== expect)) return report;
  for (const t of targets) {
    // RAW-WRITE-OK (BRO-5582): safeWriteReview self-heals rewrite unrelated fields; this adds one key.
    fs.writeFileSync(t.filePath, JSON.stringify({ ...t.record, [AUDIT_FIELD]: t.stamp }, null, 2) + '\n');
    const saved = JSON.parse(fs.readFileSync(t.filePath, 'utf8'));
    if (saved.wrongProduction === true && sameExceptStamp(t.record, saved)) report.written++;
    else report.refused.push(t.label);
  }
  return report;
}

function problemWith(report, { apply, expect }) {
  if (!report.scanned) return 'no review files scanned (review-texts checkout empty?)';
  if (!apply) return null;
  if (report.eligible !== expect) return `found ${report.eligible} eligible file(s), expected ${expect}; nothing written`;
  if (report.refused.length) return `${report.refused.length} file(s) changed beyond the audit stamp`;
  if (report.written !== expect) return `wrote ${report.written} file(s), expected ${expect}`;
  return null;
}

function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const expectArg = argv.find(a => a.startsWith('--expect='));
  const expect = expectArg ? Number(expectArg.slice('--expect='.length)) : null;
  if (apply && !(Number.isInteger(expect) && expect > 0)) throw new Error('--apply requires --expect=N with N > 0');
  const report = backfill({ apply, expect });
  console.log(JSON.stringify({ ...report, refused: report.refused.slice(0, 20) }, null, 2));
  const problem = problemWith(report, { apply, expect });
  if (problem) { console.error(`FAIL: ${problem}`); process.exit(1); }
}

if (require.main === module) main();
module.exports = { backfill, problemWith };
