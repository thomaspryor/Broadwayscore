#!/usr/bin/env node

/**
 * Standing audit for the autoclear-vs-ensemble defect class (#1146/#1156):
 * find review-text files where an auto-clear path (allowEarlyDate/
 * allowCrossMarket bypass, UK-URL/registry-region heuristic) stripped
 * wrongProduction or wrongShow off a file the LLM ensemble had already
 * unanimously rejected on content grounds. See scripts/lib/
 * autoclear-vs-ensemble-scan.js for the full defect writeup and the
 * exemption rules (stale/re-fetched rejection, human override).
 *
 * Usage:
 *   node scripts/audit-autoclear-vs-ensemble.js                # report only
 *   node scripts/audit-autoclear-vs-ensemble.js --strict        # exit 1 if any violations
 *   node scripts/audit-autoclear-vs-ensemble.js --fix           # restore the flag on genuine violations
 *   node scripts/audit-autoclear-vs-ensemble.js --dir=PATH      # alt review-texts dir (tests)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');
const { scanAutoclearVsEnsembleViolations } = require('./lib/autoclear-vs-ensemble-scan');

const USAGE = `audit-autoclear-vs-ensemble.js — autoclear-vs-ensemble defect audit (#1146/#1156)

Usage:
  node scripts/audit-autoclear-vs-ensemble.js [--strict] [--fix] [--dir=PATH]

  --strict   exit 1 when any violation is found (both wrongProduction + wrongShow)
  --fix      restore the auto-cleared flag on genuine violations and write the file
  --dir=PATH override the review-texts directory (default: data/review-texts)
`;

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { strict: false, fix: false, dir: path.join(ROOT, 'data', 'review-texts') };
  for (const a of argv) {
    if (a === '--strict') args.strict = true;
    else if (a === '--fix') args.fix = true;
    else if (a.startsWith('--dir=')) args.dir = a.split('=').slice(1).join('=');
  }
  return args;
}

function fixViolation(v, { flagField, autoClearedField, autoClearedAtField, reason }) {
  const data = JSON.parse(fs.readFileSync(v.filePath, 'utf8'));
  const orig = fs.readFileSync(v.filePath, 'utf8');
  const hadTrailingNewline = orig.endsWith('\n');
  data[flagField] = true;
  delete data[autoClearedField];
  delete data[autoClearedAtField];
  data[`${flagField}RestoredNote`] =
    `[${new Date().toISOString().slice(0, 10)}] restored by scripts/audit-autoclear-vs-ensemble.js --fix: ` +
    `unanimous ensemble rejectionReason='${reason}' (rejectedAt ${v.rejectedAt}) was silently overridden by ` +
    `an auto-clear (was: ${v.breadcrumb}). See scripts/lib/wrong-production-autoclear.js hasEnsembleRejection (#1156).`;
  fs.writeFileSync(v.filePath, JSON.stringify(data, null, 2) + (hadTrailingNewline ? '\n' : ''));
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const args = parseArgs(process.argv.slice(2));

  let corpusEntries = 0;
  try { corpusEntries = fs.readdirSync(args.dir).length; } catch { corpusEntries = 0; }
  try {
    assertCorpusScanned(corpusEntries, { gate: args.strict, label: args.dir });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`\nFAIL: ${e.message}`);
    process.exit(1);
  }

  const { scanned, wpViolations, wsViolations } = scanAutoclearVsEnsembleViolations({ reviewTextsDir: args.dir });

  console.log(`autoclear-vs-ensemble audit: ${scanned} files scanned.`);
  console.log(`  wrongProduction violations: ${wpViolations.length}`);
  for (const v of wpViolations) console.log(`    ${v.showId}/${v.file} :: ${v.breadcrumb}`);
  console.log(`  wrongShow violations: ${wsViolations.length}`);
  for (const v of wsViolations) console.log(`    ${v.showId}/${v.file} :: ${v.breadcrumb}`);

  if (args.fix) {
    for (const v of wpViolations) {
      fixViolation(v, {
        flagField: 'wrongProduction',
        autoClearedField: 'wrongProductionAutoCleared',
        autoClearedAtField: 'wrongProductionAutoClearedAt',
        reason: 'wrong_production',
      });
    }
    for (const v of wsViolations) {
      fixViolation(v, {
        flagField: 'wrongShow',
        autoClearedField: 'wrongShowAutoCleared',
        autoClearedAtField: 'wrongShowAutoClearedAt',
        reason: 'wrong_show',
      });
    }
    console.log(`\nFIXED: restored ${wpViolations.length} wrongProduction + ${wsViolations.length} wrongShow file(s).`);
    return;
  }

  const total = wpViolations.length + wsViolations.length;
  if (args.strict && total > 0) {
    console.error(`\nFAIL: ${total} autoclear-vs-ensemble violation(s) found.`);
    process.exit(1);
  }
}

main();
