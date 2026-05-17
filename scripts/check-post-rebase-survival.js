#!/usr/bin/env node
/**
 * Post-rebase file-survival check.
 *
 * Sprint 5 of Opera Auto-Discovery V2. The pre-mortem secondary scenario
 * was: parallel CI jobs racing on `git push` with rebase + auto-conflict
 * resolution silently discard one job's newly-added files. Pattern:
 *
 *   1. Job A commits 5 new review-text files for show X.
 *   2. Job B commits 5 new files for show Y at the same time.
 *   3. Job A pushes first.
 *   4. Job B's push fails (non-fast-forward), retries via rebase.
 *   5. Rebase auto-resolves a conflict by accepting remote (`-X theirs`
 *      semantics) and silently drops Job B's commit changes.
 *   6. Job B pushes — its `git status` is clean, but its new files are
 *      gone from HEAD. No error surfaces.
 *
 * This script is invoked AFTER `git pull --rebase` succeeds. It compares
 * the file set added in the local commit (before rebase) against the file
 * set still added in HEAD (after rebase). If any file went missing, exit
 * non-zero with the list — push-with-retry.sh treats that as a hard
 * failure and surfaces it to the workflow.
 *
 * Usage:
 *   node scripts/check-post-rebase-survival.js \
 *     --before-sha=<sha before rebase> \
 *     [--path-prefix=data/review-texts/]
 *
 * --before-sha is required; it's the local HEAD before rebase
 * (the commit that contains the files we expect to survive).
 *
 * --path-prefix optionally restricts the check to files under that prefix
 * (defaults to data/review-texts/ — the file class this guard primarily
 * protects).
 *
 * Exit codes:
 *   0 — all originally-added files still present in HEAD
 *   1 — at least one file went missing during rebase
 *   2 — invalid arguments / git failure
 */

'use strict';

const { execFileSync } = require('child_process');

function arg(name) {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : null;
}

function gitDiffAddedFiles(fromSha, toRef, pathPrefix) {
  const args = ['diff', '--name-only', '--diff-filter=A', `${fromSha}..${toRef}`];
  if (pathPrefix) args.push('--', pathPrefix);
  try {
    const out = execFileSync('git', args, { encoding: 'utf8' });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    console.error(`[post-rebase-check] git diff failed: ${e.message}`);
    process.exit(2);
  }
}

(function main() {
  const beforeSha = arg('before-sha');
  if (!beforeSha) {
    console.error('Usage: node scripts/check-post-rebase-survival.js --before-sha=<sha> [--path-prefix=data/review-texts/]');
    process.exit(2);
  }
  // Default: no path filter — check every file added in the commit. Codex
  // P2 finding: hardcoding data/review-texts/ made dropped audit JSONs and
  // shows.json edits invisible. Callers can still pass a narrow prefix to
  // scope the check.
  const pathPrefix = arg('path-prefix') || '';

  // Files added between beforeSha~1 and beforeSha (i.e. in our pre-rebase commit).
  const expected = new Set(gitDiffAddedFiles(`${beforeSha}~1`, beforeSha, pathPrefix));
  if (expected.size === 0) {
    console.log(`[post-rebase-check] no files added${pathPrefix ? ' under ' + pathPrefix : ''} — skipping check`);
    process.exit(0);
  }
  // Files added between beforeSha~1 and HEAD (post-rebase). Anything in
  // `expected` that's not in `actual` was silently dropped.
  const actual = new Set(gitDiffAddedFiles(`${beforeSha}~1`, 'HEAD', pathPrefix));
  const missing = [...expected].filter((f) => !actual.has(f));

  if (missing.length === 0) {
    console.log(`[post-rebase-check] OK — all ${expected.size} added files survived rebase`);
    process.exit(0);
  }

  console.error(`[post-rebase-check] FAILED — ${missing.length} of ${expected.size} files silently dropped during rebase:`);
  for (const f of missing) console.error('  - ' + f);
  console.error('');
  console.error('Likely cause: auto-conflict-resolution (-X theirs) discarded local additions.');
  console.error('Inspect the merge in the workflow log and recover the dropped files before push.');
  process.exit(1);
})();
