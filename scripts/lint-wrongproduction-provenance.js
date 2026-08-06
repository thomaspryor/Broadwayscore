#!/usr/bin/env node
/**
 * Lint: every `.wrongProduction = true` write in scripts/ must also record a
 * provenance signal (why it flagged — url/date/content/manual), not just the
 * flag itself.
 *
 * This is the P1 follow-up to task #1108 (main red, 2026-08-06):
 * mergeReviews() treated a MISSING provenance breadcrumb as "URL-based, safe
 * to auto-clear" and put a 2016 Broadway Cats review on the 2026 West End
 * show page. That was fixed directly, but nothing stopped the NEXT writer
 * from being added with no breadcrumb at all — this lint is that stop.
 *
 * Modeled on scripts/lint-resend-calls.js / scripts/lint-committed-pii.js:
 * pure scan logic lives in scripts/lib/wrongproduction-provenance.js
 * (require()able + unit-tested there), this file is the CLI walk + report.
 *
 * Scans every .js and .ts file under scripts/, recursively — a ship-check
 * adversarial review caught the first pass scanning .js only, missing a live
 * unprovenanced writer at scripts/llm-scoring/index.ts (also fixed alongside
 * this lint landing).
 *
 * An audit of every current `.wrongProduction = true` write site in scripts/
 * (see scripts/lib/wrongproduction-provenance.js's scanFileForViolations)
 * found only 4 files genuinely missing a provenance signal, and all 4 were
 * fixed alongside this lint landing (fix-wrong-reviews.js, classify-wrong-
 * production.js, audit-pre2005-reviews.js, llm-scoring/index.ts) —
 * EXEMPT_FILES below is not a grandfather list for those, it's a one-entry
 * exemption for a report script's in-memory replay fixtures, which are
 * never written to disk.
 *
 * Usage: node scripts/lint-wrongproduction-provenance.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { scanFileForViolations } = require('./lib/wrongproduction-provenance');
const { hasHelpFlag } = require('./lib/cli-help.js');

const REPO_ROOT = path.join(__dirname, '..');
const SCAN_DIR = 'scripts';
const SKIP_DIR_NAMES = new Set(['node_modules', '.git']);

// Fixture/regression scripts, not real writers — `scripts/test-*.js` is this
// repo's convention for standalone regression harnesses (e.g.
// test-temporal-override-regression.js) that construct example objects with
// wrongProduction as a literal, never write them to disk. A second-opinion
// review of this lint's plan flagged that these would trip on the
// object-literal form for no real reason if a future fixture used it.
const SELF_PATH = 'scripts/lint-wrongproduction-provenance.js';

// Files confirmed non-writers by direct read, same ALLOWLIST-with-reason
// idiom as scripts/lint-resend-calls.js / scripts/lint-committed-pii.js —
// a new addition needs a one-line justification, not a silent skip.
const EXEMPT_FILES = new Set([
  // shadow-autoclear-report.js's REPLAY fixtures (grace/cyrano) construct
  // { wrongProduction: true, ... } in-memory objects to replay through
  // wouldAutoClear() for a report — never written to disk as a real flag.
  'scripts/shadow-autoclear-report.js',
]);

function isExempt(relPath) {
  if (relPath === SELF_PATH) return true;
  if (EXEMPT_FILES.has(relPath)) return true;
  if (relPath.endsWith('.test.js') || relPath.endsWith('.test.mjs') || relPath.endsWith('.test.ts')) return true;
  const base = path.basename(relPath);
  if (base.startsWith('test-') && relPath.startsWith('scripts/')) return true;
  return false;
}

function walk(dir, files) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
}

const USAGE = `lint-wrongproduction-provenance.js — every wrongProduction
writer in scripts/ must also record why (task #1109).

Usage:
  node scripts/lint-wrongproduction-provenance.js   scan every scripts/ .js/.ts file
  --help, -h                                        show this message

Blocking by design: a wrongProduction write with no provenance signal is
exactly the shape of bug that caused the 2026-08-06 main-red (#1108). Set one
of wrongProductionProvenance / wrongProductionReason / wrongProductionNote /
wrongProductionDetectedBy (or the _-prefixed legacy forms) alongside the
flag — see scripts/lib/wrongproduction-provenance.js.
`;

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }

  const files = [];
  walk(path.join(REPO_ROOT, SCAN_DIR), files);

  const violations = [];
  let scanned = 0;
  for (const absPath of files) {
    const relPath = path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
    if (isExempt(relPath)) continue;
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }
    scanned++;
    violations.push(...scanFileForViolations(content, relPath));
  }

  if (violations.length > 0) {
    console.error(`::error::${violations.length} wrongProduction write(s) with no provenance signal:`);
    for (const v of violations) {
      console.error(`  - ${v.file}:${v.line}: ${v.text}`);
    }
    console.error(
      '\nEvery `.wrongProduction = true` write must also set a provenance field ' +
      'within a few lines — wrongProductionProvenance (preferred: \'url\'|\'date\'|' +
      '\'content\'|\'manual\'), or a legacy wrongProductionReason/Note/DetectedBy. ' +
      'See scripts/lib/wrongproduction-provenance.js.'
    );
    process.exit(1);
  }

  console.log(`OK — ${scanned} scripts/ .js/.ts file(s) scanned, every wrongProduction write carries a provenance signal.`);
}

if (require.main === module) main();

module.exports = { main, walk, isExempt };
