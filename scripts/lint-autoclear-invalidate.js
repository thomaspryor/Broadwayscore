#!/usr/bin/env node
/**
 * Lint: every `.wrongProduction = true` / `.wrongShow = true` write in
 * scripts/ must call the matching invalidateWrongProductionAutoClear /
 * invalidateWrongShowAutoClear (scripts/lib/review-write-guard.js) nearby.
 *
 * BRO-3908 cousin sweep to BRO-3895 (main-red, 2026-09-xx): BRO-3895 fixed
 * the 3 writers in scripts/lib/review-file-writer.js that skipped the
 * invalidate call, letting a re-flagged file carry `wrongProduction:true`
 * beside a stale `wrongProductionAutoCleared` breadcrumb — the exact
 * self-contradictory-clear shape audit-self-contradictory-clear-drained.test.mjs
 * gates on. A full grep sweep found the SAME gap at 25 more wrongProduction
 * writers and 8 wrongShow writers across scripts/, all fixed alongside this
 * lint. Without this lint, the next new writer reintroduces the gap exactly
 * the way each of those 33 did.
 *
 * Modeled directly on scripts/lint-wrongproduction-provenance.js: pure scan
 * logic lives in scripts/lib/autoclear-invalidate.js (require()able + unit-
 * tested there), this file is the CLI walk + report.
 *
 * Usage: node scripts/lint-autoclear-invalidate.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { scanFileForInvalidateViolations } = require('./lib/autoclear-invalidate');
const { hasHelpFlag } = require('./lib/cli-help.js');

const REPO_ROOT = path.join(__dirname, '..');
const SCAN_DIR = 'scripts';
const SKIP_DIR_NAMES = new Set(['node_modules', '.git']);

const SELF_PATH = 'scripts/lint-autoclear-invalidate.js';

// Files confirmed non-writers or structurally-exempt by direct read, same
// ALLOWLIST-with-reason idiom as scripts/lint-wrongproduction-provenance.js —
// a new addition needs a one-line justification, not a silent skip.
const EXEMPT_FILES = new Set([
  // shadow-autoclear-report.js's REPLAY fixtures (grace/cyrano) construct
  // { wrongProduction: true, ... } in-memory objects to replay through
  // wouldAutoClear() for a report — never written to disk as a real flag.
  // Same exemption as lint-wrongproduction-provenance.js.
  'scripts/shadow-autoclear-report.js',
  // review-file-writer.js's 3 wrongProduction=true writers (classifyMarketRouting
  // accept-with-flag, Guard J, Guard K) stamp `fields.wrongProduction` on a
  // caller-owned patch object inside createOrMergeReviewFile(); the actual
  // invalidate call fires once, in a DIFFERENT function
  // (_mergeIntoExisting's post-merge-loop `wrongProductionNewlyFlagged`
  // check) — the BRO-3895 fix. A line-window scan can't see across that
  // function boundary. Verified by direct read (BRO-3908 audit,
  // 2026-09-20): all 3 sites route through that one deferred invalidate.
  // This is a one-entry exemption for a verified-safe cross-function
  // pattern, not a grandfather list — a NEW writer added to this file still
  // needs its own nearby invalidate call or this exemption stops being
  // accurate and must be revisited.
  'scripts/lib/review-file-writer.js',
]);

// Flag-scoped exemptions: `${relPath}::${flag}` — for a file where ONE flag
// (wrongProduction or wrongShow) is provably safe via a centralized
// mechanism the line-window scan can't see, but the OTHER flag on the same
// file still needs the normal per-site check.
const EXEMPT_FLAG_SITES = new Set([
  // audit-cross-show-url-collisions.js centralizes BOTH invalidations inside
  // its single atomicWriteJSON() write helper (`if (data.wrongShow === true)
  // invalidateWrongShowAutoClear(data);` / same for wrongProduction),
  // checked against each flag's FINAL state after the stale-flag-withholding
  // pass earlier in that function. All 13 wrongShow=true sites and both
  // wrongProduction=true sites in this file call atomicWriteJSON, so all are
  // covered. This centralization is load-bearing, not optional: a Codex
  // adversarial ship-check review (BRO-3908, 2026-09-20) caught that an
  // earlier pass of this same fix called invalidateWrongProductionAutoClear
  // INLINE right after each `data.wrongProduction = true` site — which ran
  // BEFORE the withholding pass could decide whether the flag write even
  // survives. If withholding then deleted the flag, the inline call had
  // already deleted the record's legitimate wrongProductionAutoCleared
  // breadcrumb for a flag that never actually got written, stripping real
  // clearance evidence from a record that ends up unflagged. The centralized
  // check (same pattern BRO-3225 already used for wrongShow) avoids the race
  // by only invalidating once the final written state is known.
  'scripts/audit-cross-show-url-collisions.js::wrongShow',
  'scripts/audit-cross-show-url-collisions.js::wrongProduction',
]);

function isExempt(relPath, flag) {
  if (relPath === SELF_PATH) return true;
  if (EXEMPT_FILES.has(relPath)) return true;
  if (flag && EXEMPT_FLAG_SITES.has(`${relPath}::${flag}`)) return true;
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

const USAGE = `lint-autoclear-invalidate.js — every wrongProduction/wrongShow
writer in scripts/ must also call the matching invalidate*AutoClear helper
(BRO-3908, cousin sweep to BRO-3895).

Usage:
  node scripts/lint-autoclear-invalidate.js   scan every scripts/ .js/.ts file
  --help, -h                                  show this message

Blocking by design: a wrongProduction/wrongShow write with no nearby
invalidate call reintroduces the exact self-contradictory-clear shape that
caused 31 consecutive main-red pushes (BRO-3895). Call
invalidateWrongProductionAutoClear(record) / invalidateWrongShowAutoClear(record)
(scripts/lib/review-write-guard.js) immediately after setting the flag. See
scripts/lib/autoclear-invalidate.js.
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
    for (const v of scanFileForInvalidateViolations(content, relPath)) {
      if (isExempt(relPath, v.flag)) continue;
      violations.push(v);
    }
  }

  if (violations.length > 0) {
    console.error(`::error::${violations.length} wrongProduction/wrongShow write(s) with no invalidate call nearby:`);
    for (const v of violations) {
      console.error(`  - ${v.file}:${v.line}: ${v.text} (needs ${v.fn})`);
    }
    console.error(
      '\nEvery `.wrongProduction = true` write must call ' +
      'invalidateWrongProductionAutoClear(record) nearby, and every ' +
      '`.wrongShow = true` write must call invalidateWrongShowAutoClear(record) ' +
      'nearby — both from scripts/lib/review-write-guard.js. See ' +
      'scripts/lib/autoclear-invalidate.js.'
    );
    process.exit(1);
  }

  console.log(`OK — ${scanned} scripts/ .js/.ts file(s) scanned, every wrongProduction/wrongShow write calls the matching invalidate helper.`);
}

if (require.main === module) main();

module.exports = { main, walk, isExempt };
