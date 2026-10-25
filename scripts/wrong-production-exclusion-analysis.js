#!/usr/bin/env node
/**
 * BRO-75: reports per-show `skippedWrongProduction` exclusion volume from
 * data/audit/exclusions-YYYY-MM-DD.jsonl, categorized as REPEATED_LOGGING
 * (already-known files re-logged across rebuild runs — not over-blocking)
 * vs NEEDS_REVIEW (genuinely new exclusions today — worth a content audit)
 * vs NORMAL.
 *
 * Cross-day ledger (data/audit/wrongproduction-seen-files.json, gitignored
 * like the rest of data/audit): each run diffs today's exclusion log against
 * files already known from prior runs, so "new file excluded today" and
 * "same file re-logged every rebuild pass" are told apart by actual history
 * instead of guessed from a single day's repeat count. Without a ledger yet
 * (first run), falls back to the same-day repeat-ratio heuristic.
 *
 * The exclusions-*.jsonl files are gitignored/ephemeral (written fresh by
 * each CI run), so this reads whatever is present locally or via --file.
 *
 * Usage:
 *   node scripts/wrong-production-exclusion-analysis.js [--date=YYYY-MM-DD] [--file=path] [--no-ledger]
 */

const fs = require('fs');
const path = require('path');
const { parseExclusionLog, analyzeExclusionLog, buildNextLedger } = require('./lib/wrong-production-exclusion-analysis');

const argv = process.argv.slice(2);
const dateArg = argv.find(a => a.startsWith('--date='))?.split('=')[1];
const fileArg = argv.find(a => a.startsWith('--file='))?.split('=')[1];
const useLedger = !argv.includes('--no-ledger');

const auditDir = process.env.EXCLUSION_LOGGER_AUDIT_DIR || path.join(__dirname, '../data/audit');
const targetFile = fileArg
  ? path.resolve(fileArg)
  : path.join(auditDir, `exclusions-${dateArg || new Date().toISOString().slice(0, 10)}.jsonl`);
const ledgerFile = path.join(auditDir, 'wrongproduction-seen-files.json');

let jsonlText;
try {
  jsonlText = fs.readFileSync(targetFile, 'utf8');
} catch (e) {
  console.error(`Could not read ${targetFile}: ${e.message}`);
  console.error('exclusions-*.jsonl is gitignored/ephemeral — pass --file=path to analyze an archived copy.');
  process.exit(1);
}

let previousLedger = {};
if (useLedger) {
  try {
    previousLedger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  } catch {
    // no ledger yet — first run falls back to the same-day heuristic
  }
}

const knownFilesByShow = useLedger && Object.keys(previousLedger).length > 0 ? previousLedger : undefined;
const results = analyzeExclusionLog(jsonlText, { knownFilesByShow });

if (results.length === 0) {
  console.log(`No skippedWrongProduction exclusions found in ${targetFile}`);
  process.exit(0);
}

console.log(`\n=== wrongProduction exclusion volume: ${path.basename(targetFile)} ===\n`);
if (!knownFilesByShow) {
  console.log('(no cross-day ledger yet — using same-day repeat-ratio heuristic; a ledger will be written for next time)\n');
}
for (const r of results) {
  const flag = r.category === 'NEEDS_REVIEW' ? '⚠️ ' : '';
  const newFilePart = r.newFileCount !== undefined ? `, ${r.newFileCount} new` : '';
  console.log(`${flag}${r.showId}: ${r.totalLines} lines, ${r.distinctFiles} distinct files${newFilePart}, ${r.repeatMultiplier}x repeat -> ${r.category}`);
}

const needsReview = results.filter(r => r.category === 'NEEDS_REVIEW');
if (needsReview.length > 0) {
  console.log(`\n${needsReview.length} show(s) flagged NEEDS_REVIEW — run scripts/audit-wrong-production.js --show=<id> for a content-level check.`);
}

if (useLedger) {
  const records = parseExclusionLog(jsonlText);
  const nextLedger = buildNextLedger(records, previousLedger);
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.writeFileSync(ledgerFile, JSON.stringify(nextLedger, null, 2));
}
