#!/usr/bin/env node

/**
 * Standing CI sweep + fixer for the #1655 class: a review-text record
 * carrying BOTH a live `duplicateOf` pointer AND its own stale
 * `_duplicateOfCleared` breadcrumb, where the pointer targets a sibling
 * sharing the exact same URL the breadcrumb was cleared for. Full derivation:
 * scripts/lib/duplicate-of-cleared-contradiction.js docblock.
 *
 * Unlike audit-self-contradictory-clears.js's --fix (which excludes 438
 * scored reviews and is explicitly NOT a safe bulk drain), --fix here IS safe
 * to run in bulk: `_duplicateOfCleared` has zero readers anywhere in the
 * inclusion/scoring path (only review-write-guard.js's write-time collision
 * heuristic reads it) and is not itself a PROTECTED_FIELDS entry, so
 * retracting it changes nothing about which review lands in reviews.json —
 * `duplicateOf` already governs that outcome today, with or without the
 * breadcrumb. See the module header for the full argument.
 *
 * Usage:
 *   node scripts/audit-duplicate-of-cleared-contradiction.js                 # report
 *   node scripts/audit-duplicate-of-cleared-contradiction.js --gate --max=0  # CI gate
 *   node scripts/audit-duplicate-of-cleared-contradiction.js --fix          # retract stale breadcrumbs
 *   node scripts/audit-duplicate-of-cleared-contradiction.js --show=ID
 *   node scripts/audit-duplicate-of-cleared-contradiction.js --json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs.js');
const {
  detectDuplicateOfClearedContradiction,
  retractDuplicateOfCleared,
} = require('./lib/duplicate-of-cleared-contradiction.js');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard.js');
const { parseMaxArgOrExit } = require('./lib/parse-max-arg.js');

const USAGE = `audit-duplicate-of-cleared-contradiction.js — duplicateOf + stale _duplicateOfCleared sweep (#1655)

Finds review-text files whose duplicateOf points at a same-URL sibling while
the file ALSO carries a _duplicateOfCleared breadcrumb claiming that exact
collision was reviewed and is NOT a duplicate. Both cannot be true at once.

Usage:
  node scripts/audit-duplicate-of-cleared-contradiction.js [--gate] [--max=N] [--fix] [--show=ID] [--json] [--review-texts-dir=PATH]

  --gate                 exit 1 when the match count exceeds --max
  --max=N                gate ceiling (default 0) — no expected steady-state
                        backlog: _duplicateOfCleared has zero live writers, so
                        a new hit only appears if a FUTURE writer reintroduces
                        this exact shape. Any hit is real signal.
  --fix                 retract the stale _duplicateOfCleared breadcrumb,
                        leaving duplicateOf (the live verdict) intact. Safe to
                        run in bulk — see the module docblock in
                        scripts/lib/duplicate-of-cleared-contradiction.js for
                        why this is NOT the same risk class as
                        audit-self-contradictory-clears.js --fix.
  --show=ID              scope the sweep to one show directory
  --json                 machine-readable output
  --review-texts-dir=    override the corpus path (default data/review-texts)
`;

const ROOT = path.resolve(__dirname, '..');

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const gate = argv.includes('--gate');
  const fix = argv.includes('--fix');
  const json = argv.includes('--json');
  const max = parseMaxArgOrExit(argv, { scriptName: 'audit-duplicate-of-cleared-contradiction' });
  const dirArg = argv.find((a) => a.startsWith('--review-texts-dir='));
  const REVIEW_TEXTS_DIR = dirArg ? dirArg.split('=')[1] : path.join(ROOT, 'data', 'review-texts');
  const showArg = argv.find((a) => a.startsWith('--show='));
  const showFilter = showArg ? showArg.split('=')[1] : null;

  let showDirs = [];
  try {
    showDirs = listShowDirs(REVIEW_TEXTS_DIR, { silent: true });
  } catch {
    showDirs = [];
  }
  if (showFilter) showDirs = showDirs.filter((s) => s === showFilter);

  try {
    assertCorpusScanned(showDirs.length, { gate });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`\nFAIL: ${e.message}`);
    process.exit(1);
  }

  const hits = [];
  let fixed = 0;
  let scanned = 0;

  for (const showId of showDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try {
      files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = path.join(showDir, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        continue;
      }
      scanned++;

      // Only load the target when this file even has a chance of matching —
      // avoids a second readFileSync per file for the overwhelming majority
      // that carry no _duplicateOfCleared at all.
      if (!data._duplicateOfCleared || !data.duplicateOf) continue;

      let target = null;
      if (typeof data.duplicateOf === 'string' && data.duplicateOf.endsWith('.json')) {
        try {
          target = JSON.parse(fs.readFileSync(path.join(showDir, data.duplicateOf), 'utf8'));
        } catch {
          target = null;
        }
      }

      const verdict = detectDuplicateOfClearedContradiction({ review: data, target });
      if (!verdict.contradicted) continue;

      hits.push({
        showId,
        file,
        duplicateOf: verdict.duplicateOf,
        ownUrl: verdict.ownUrl,
      });

      if (fix) {
        if (retractDuplicateOfCleared(data, verdict)) {
          fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
          fixed++;
        }
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({ scanned, count: hits.length, fixed, hits }, null, 2));
  } else {
    console.log(`Duplicate-of-cleared contradiction sweep: ${scanned} review file(s) scanned, ${hits.length} match(es).`);
    for (const h of hits.slice(0, 20)) {
      console.log(`  ${h.showId}/${h.file} -> ${h.duplicateOf} (both claim/deny the same URL)`);
    }
    if (hits.length > 20) console.log(`  ...and ${hits.length - 20} more`);
    if (fix) console.log(`\nRetracted stale _duplicateOfCleared on ${fixed} file(s).`);
  }

  if (gate && hits.length > max) {
    console.error(`\nFAIL: ${hits.length} review file(s) carry a duplicateOf pointer AND a _duplicateOfCleared breadcrumb for the same URL (> max ${max}).`);
    console.error('This is the #1655 class: two contradictory verdicts about the same URL collision on one record.');
    console.error('Fix: node scripts/audit-duplicate-of-cleared-contradiction.js --fix (retracts the dead breadcrumb; duplicateOf already governs inclusion — see the module docblock for why this is safe in bulk).');
    process.exit(1);
  }
}

main();
