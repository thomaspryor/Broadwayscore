#!/usr/bin/env node
/**
 * Lint guard: every workflow step that pushes through push-with-retry.sh AND
 * commits a union-merged managed JSON file (commercial.json,
 * commercial-pending-review.json, commercial-research-queue.json,
 * diary-shows.json, social-post-history.json) must set
 * PUSH_RECONCILE_MERGED_JSON=1 on that step. Task #574.
 *
 * WHY THIS EXISTS
 * ---------------
 * push-with-retry.sh rebases with `-X theirs`, which resolves conflicting
 * hunks in favour of our replayed commits WITHOUT ever reporting a conflict —
 * so resolve_conflicts()'s per-slug union mergers never fire on the common
 * path, and a concurrent writer's nearby-slug edit is silently dropped.
 * scripts/lib/reconcile-merged-json.js is the fix, gated behind
 * PUSH_RECONCILE_MERGED_JSON=1 (task #420) because flipping the default for
 * ~114 callers wholesale was out of scope for that card. This guard is the
 * generalization: it keeps every NEW step that commits a managed file from
 * silently joining the 9-of-10 that shipped without the flag.
 *
 * Detection is pure + colocated-tested in scripts/lib/reconcile-coverage.js
 * (see that file's header for why the check is step-scoped rather than a
 * whole-file grep); this file only walks .github/workflows/*.yml and
 * formats the report.
 *
 * Usage:
 *   node scripts/audit-reconcile-coverage.js            # blocking lint (exit 1 on violation)
 *
 * Waive a reviewed false positive with an inline "push-reconcile-ok: <reason>"
 * anywhere in the step.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { findCoverageGaps } = require('./lib/reconcile-coverage.js');

const USAGE = `Audit: PUSH_RECONCILE_MERGED_JSON coverage on push-with-retry.sh callers (task #574)

Usage:
  node scripts/audit-reconcile-coverage.js

Exit codes: 0 = clean, 1 = at least one step pushes a managed JSON file without the flag.
Waive a reviewed false positive with an inline "push-reconcile-ok: <reason>".`;

if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

function main() {
  if (!fs.existsSync(WORKFLOWS_DIR)) { console.log('No .github/workflows dir — nothing to audit.'); return; }

  const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
  const fileMap = files.map((f) => {
    const rel = path.relative(REPO_ROOT, path.join(WORKFLOWS_DIR, f));
    return [rel, fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8')];
  });

  const gaps = [];
  for (const [file, content] of fileMap) gaps.push(...findCoverageGaps(file, content));

  if (gaps.length === 0) {
    console.log(`Audit — reconcile coverage: clean (${files.length} workflow(s) scanned).`);
    return;
  }

  console.error(`::error::Audit — reconcile coverage: ${gaps.length} step(s) push a union-merged JSON file through push-with-retry.sh without PUSH_RECONCILE_MERGED_JSON=1:`);
  for (const g of gaps) {
    console.error(`  ${g.file}:${g.line} — step "${g.step}" commits [${g.managedFiles.join(', ')}]`);
  }
  console.error('Fix: set `env: PUSH_RECONCILE_MERGED_JSON: \'1\'` on the step, or waive a reviewed false positive with an inline "push-reconcile-ok: <reason>".');
  process.exit(1);
}

main();
