#!/usr/bin/env node

/**
 * Task #1075. CI lint: no script may read a LITERAL gitignored path out of a
 * git ref (`git show <ref>:<path>`, `git cat-file -e <ref>:<path>`).
 *
 * Core data (data/shows.json, data/reviews.json, data/review-texts/, …) lives
 * in a private repo and is gitignored here, so that read can never succeed in
 * THIS repo — and every caller that has hit it so far swallowed the failure
 * and let "found nothing" mean "clean". A monitor written on 2026-08-05 to
 * prove a live customer-facing ticket-link bug was fixed did exactly this and
 * would have reported the bug GONE forever; it was caught by luck.
 *
 * Blocking by design, like audit-gate-corpus-guard-coverage.js (#1069): this
 * is a mechanical source grep over literal paths, not a loop-shape heuristic.
 * A read that genuinely handles the unreadable case (returns CANNOT_OBSERVE
 * rather than a pass) can opt out with an inline `observability-ok: <reason>`
 * comment on the same line.
 *
 * Fix, don't exempt: route the check through scripts/lib/observable-before-absence.js
 * (probeGitPath / observePresence / assertObservable), which distinguishes
 * NOT-FOUND from CANNOT-OBSERVE, or read the file from the repo that owns it.
 *
 * Usage: node scripts/audit-invisible-verification.js [rootDir]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help');
const { findInvisibleVerifications } = require('./lib/invisible-verification-scan');

const USAGE = `Usage: node scripts/audit-invisible-verification.js [rootDir]

Blocking lint (task #1075): fails when any script reads a LITERAL gitignored
path out of a git ref — \`git show <ref>:<path>\`, \`git cat-file -e|-p|blob\`.
Such a read can never succeed here (core data lives in a private repo), so a
check built on it reports "nothing found" — i.e. success — forever.

  rootDir   repo to scan (default: this repo). Scans scripts/, tests/,
            .claude/hooks/, .claude/skills/, .github/workflows/.

Exit 0 = clean, 1 = violations found OR the scan could not answer (missing
files, git check-ignore unusable). Opt a handled call out with an inline
\`observability-ok: <reason>\` comment on that line or the line above.`;

if (hasHelpFlag(process.argv.slice(2))) {
  console.log(USAGE);
  process.exit(0);
}

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');

// Where verification/monitor code actually lives. node_modules and build output
// are never scanned.
const SCAN_DIRS = ['scripts', 'tests', '.claude/hooks', '.claude/skills', '.github/workflows'];
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.sh', '.yml', '.yaml', '']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'worktrees', 'dist', '.next', 'coverage']);
// Tests build the bad pattern on purpose as a fixture — flagging them would
// make the guard's own regression test unfixable except by weakening it.
const SKIP_FILE = /\.test\.(?:mjs|cjs|js|ts|sh)$/;

function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, acc);
    } else if (e.isFile() && SCAN_EXT.has(path.extname(e.name)) && !SKIP_FILE.test(e.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * git check-ignore, cached per distinct path.
 *
 * Exit codes are load-bearing: 0 = ignored, 1 = not ignored, anything else
 * (128 = not a repo / bad pathspec, 127 = no git) means the question was not
 * answered. Swallowing those as "not ignored" would make THIS auditor commit
 * the exact sin it exists to catch — a check that cannot see reporting clean.
 * Unanswerable probes are collected and fail the run loudly.
 */
function makeIsIgnored(root, unanswered) {
  const cache = new Map();
  return (p) => {
    if (cache.has(p)) return cache.get(p);
    const res = spawnSync('git', ['check-ignore', '-q', '--', p], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    if (res.error || res.status === null || (res.status !== 0 && res.status !== 1)) {
      unanswered.push({ path: p, status: res.status, error: res.error && res.error.message });
    }
    const ignored = res.status === 0;
    cache.set(p, ignored);
    return ignored;
  };
}

function main() {
  const files = [];
  for (const rel of SCAN_DIRS) {
    const dir = path.join(ROOT, rel);
    if (!fs.existsSync(dir)) continue;
    for (const full of walk(dir, [])) {
      let source;
      try {
        source = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      files.push({ path: path.relative(ROOT, full), source });
    }
  }

  if (files.length === 0) {
    // The auditor itself must not vacuously pass — that is the very class it
    // exists to prevent (task #1063 / #1069 precedent).
    console.error('❌ audit-invisible-verification: scanned 0 files — wrong root or a broken checkout.');
    process.exit(1);
  }

  const unanswered = [];
  const { violations, readsFound } = findInvisibleVerifications({
    files,
    isIgnored: makeIsIgnored(ROOT, unanswered),
  });

  if (unanswered.length > 0) {
    console.error('❌ audit-invisible-verification: git check-ignore could not answer for:\n');
    for (const u of unanswered) {
      console.error(`  • ${u.path} (exit ${u.status}${u.error ? `, ${u.error}` : ''})`);
    }
    console.error('\nThis audit cannot report clean on questions it never answered — that is the');
    console.error('very class it guards (task #1075). Fix the checkout/git availability and re-run.');
    process.exit(1);
  }

  if (violations.length === 0) {
    console.log(
      `✅ Invisible-verification audit: ${files.length} files, ${readsFound} literal git-ref read(s), ` +
        'none targets a gitignored path.'
    );
    process.exit(0);
  }

  console.error('❌ Invisible verification — git-ref read of a gitignored path:\n');
  console.error('These reads can NEVER succeed in this repo: the path is gitignored here (core');
  console.error('data lives in a private repo, CLAUDE.md §11), so `git show <ref>:<path>` always');
  console.error('fails. A check built on one reports "nothing found" — i.e. success — forever,');
  console.error('whether or not the thing it watches was ever fixed (task #1075).\n');
  for (const v of violations) {
    const how = v.literal ? '' : ` (interpolated path; gitignored directory ${v.probePath})`;
    console.error(`  • ${v.file}:${v.line} → ${v.ref}:${v.filePath}${how}`);
    console.error(`      ${v.raw}`);
  }
  console.error('\nFix: use scripts/lib/observable-before-absence.js (probeGitPath / observePresence /');
  console.error('assertObservable) so an unobservable target reports CANNOT-OBSERVE instead of a');
  console.error('clean pass, or read the file from the repo that actually owns it.');
  console.error('Deliberate and already handled? Add `observability-ok: <reason>` on that line.');
  process.exit(1);
}

main();
