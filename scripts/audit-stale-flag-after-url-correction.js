#!/usr/bin/env node

/**
 * Standing CI sweep for the #483 corpus signature: flag=true (wrongProduction
 * /wrongShow) + `_urlChangedClear` breadcrumb present + empty fullText + no
 * manual clear. 112 corpus files matched this exact shape on 2026-07-26 —
 * a stale maybeUpgradeUrl escape (fixed in scripts/lib/review-normalization.js
 * maybeUpgradeUrl + scripts/lib/url-change-invariant.js's force option) left
 * the OLD article's exclusion flag attached to a file that had already
 * started a URL correction and was waiting on refetch, permanently blocking
 * rebuild of the corrected URL.
 *
 * Detector: scripts/lib/stale-flag-after-url-correction.js
 * (detectStaleFlagAfterUrlCorrection) — chokepoint-agnostic, so it also
 * catches any FUTURE write path that reintroduces the same escape.
 *
 * Usage:
 *   node scripts/audit-stale-flag-after-url-correction.js                    # report
 *   node scripts/audit-stale-flag-after-url-correction.js --gate             # exit 1 on any match
 *   node scripts/audit-stale-flag-after-url-correction.js --fix              # remediate backlog matches
 *   node scripts/audit-stale-flag-after-url-correction.js --json
 *   node scripts/audit-stale-flag-after-url-correction.js --review-texts-dir=/path  # override corpus location
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs.js');
const { detectStaleFlagAfterUrlCorrection, remediateStaleFlagAfterUrlCorrection } = require('./lib/stale-flag-after-url-correction.js');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard.js');

const USAGE = `audit-stale-flag-after-url-correction.js — stale flag + URL-correction breadcrumb sweep (#483)

Usage:
  node scripts/audit-stale-flag-after-url-correction.js [--gate] [--fix] [--json] [--review-texts-dir=PATH]

  --gate               exit 1 if any match is found (CI gate mode)
  --fix                remediate matches in place (clears the stale flag + contentVerification,
                        extends the existing _urlChangedClear breadcrumb, sets needsRefetch)
  --json               machine-readable output
  --review-texts-dir=  override the corpus path (default data/review-texts)
`;

const ROOT = path.resolve(__dirname, '..');

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const gate = argv.includes('--gate');
  const json = argv.includes('--json');
  const fix = argv.includes('--fix');
  const dirArg = argv.find((a) => a.startsWith('--review-texts-dir='));
  const REVIEW_TEXTS_DIR = dirArg ? dirArg.split('=')[1] : path.join(ROOT, 'data', 'review-texts');

  let showDirs = [];
  try {
    showDirs = listShowDirs(REVIEW_TEXTS_DIR, { silent: true });
  } catch {
    showDirs = [];
  }
  try {
    assertCorpusScanned(showDirs.length, { gate });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`\nFAIL: ${e.message}`);
    process.exit(1);
  }

  const hits = [];
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
      const flags = detectStaleFlagAfterUrlCorrection(data);
      if (!flags.length) continue;
      hits.push({ showId, file, flags });
      if (fix) {
        remediateStaleFlagAfterUrlCorrection(data);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({ scanned: showDirs.length, count: hits.length, fixed: fix, hits }, null, 2));
  } else {
    console.log(`Stale-flag-after-URL-correction sweep: ${showDirs.length} shows scanned, ${hits.length} match(es)${fix ? ' (remediated)' : ''}.`);
    for (const h of hits) {
      console.log(`  [${h.flags.join('+')}] ${h.showId}/${h.file}`);
    }
  }

  if (gate && !fix && hits.length > 0) {
    console.error(`\nFAIL: ${hits.length} file(s) match the #483 stale-flag-after-URL-correction signature.`);
    process.exit(1);
  }
}

main();
