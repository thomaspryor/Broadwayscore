#!/usr/bin/env node
/**
 * BRO-75: reports per-show `skippedWrongProduction` exclusion volume from
 * data/audit/exclusions-YYYY-MM-DD.jsonl, categorized as REPEATED_LOGGING
 * (same already-flagged files re-logged across rebuild runs — not
 * over-blocking) vs NEEDS_REVIEW (many distinct newly-excluded files —
 * worth a content audit) vs NORMAL.
 *
 * The exclusions-*.jsonl files are gitignored/ephemeral (written fresh by
 * each CI run), so this reads whatever is present locally or via --file.
 *
 * Usage:
 *   node scripts/wrong-production-exclusion-analysis.js [--date=YYYY-MM-DD] [--file=path]
 */

const fs = require('fs');
const path = require('path');
const { analyzeExclusionLog } = require('./lib/wrong-production-exclusion-analysis');

const argv = process.argv.slice(2);
const dateArg = argv.find(a => a.startsWith('--date='))?.split('=')[1];
const fileArg = argv.find(a => a.startsWith('--file='))?.split('=')[1];

const auditDir = process.env.EXCLUSION_LOGGER_AUDIT_DIR || path.join(__dirname, '../data/audit');
const targetFile = fileArg
  ? path.resolve(fileArg)
  : path.join(auditDir, `exclusions-${dateArg || new Date().toISOString().slice(0, 10)}.jsonl`);

let jsonlText;
try {
  jsonlText = fs.readFileSync(targetFile, 'utf8');
} catch (e) {
  console.error(`Could not read ${targetFile}: ${e.message}`);
  console.error('exclusions-*.jsonl is gitignored/ephemeral — pass --file=path to analyze an archived copy.');
  process.exit(1);
}

const results = analyzeExclusionLog(jsonlText);

if (results.length === 0) {
  console.log(`No skippedWrongProduction exclusions found in ${targetFile}`);
  process.exit(0);
}

console.log(`\n=== wrongProduction exclusion volume: ${path.basename(targetFile)} ===\n`);
for (const r of results) {
  const flag = r.category === 'NEEDS_REVIEW' ? '⚠️ ' : '';
  console.log(`${flag}${r.showId}: ${r.totalLines} lines, ${r.distinctFiles} distinct files, ${r.repeatMultiplier}x repeat -> ${r.category}`);
}

const needsReview = results.filter(r => r.category === 'NEEDS_REVIEW');
if (needsReview.length > 0) {
  console.log(`\n${needsReview.length} show(s) flagged NEEDS_REVIEW — run scripts/audit-wrong-production.js --show=<id> for a content-level check.`);
}
