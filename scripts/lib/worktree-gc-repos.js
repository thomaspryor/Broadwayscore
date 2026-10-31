#!/usr/bin/env node
'use strict';
/**
 * Data-driven repo set for gc-merged-worktrees.sh (BRO-2540).
 *
 * Before this module existed, the GC hardcoded a single `REPO=` constant
 * and only ever touched ~/Broadwayscore/.claude/worktrees.
 * ~/BroadwayScorecard-app/.claude/worktrees was never garbage-collected by
 * anything and grew to 51GB across 34 worktrees — 34GB of it pure,
 * gitignored Xcode build output (`ios/build`, fully covered by that repo's
 * `.gitignore:42` /ios entry) — which is why disk hit a 5.0Gi free floor
 * on 2026-08-30 even while the web-repo GC ran hourly via launchd and
 * reported success every time.
 *
 * `buildArtifactDirs` are paths, relative to a worktree root, that are
 * gitignored and fully regenerable (npm install / xcodebuild output) — the
 * extension of the web repo's existing node_modules/.next strip to iOS's
 * build output. Nothing here does I/O; gc-merged-worktrees.sh reads the
 * `--list` output and does the actual fs/git work itself.
 */
const os = require('os');
const path = require('path');

const HOME = os.homedir();

const DEFAULT_REPOS = [
  {
    // gc-merged-worktrees.sh's strip_build_artifacts()/is_stale() already
    // hardcode node_modules/.next as universal defaults for every repo — do
    // NOT repeat them here. An earlier cut of this file did, which iterated
    // node_modules/.next twice for the web repo (harmless on a real run,
    // since the second pass finds the dir already removed, but it
    // double-logged WOULD-STRIP lines and double-counted freed_kb in
    // --dry-run's reporting — caught by a codebase review, BRO-2540).
    name: 'web',
    path: path.join(HOME, 'Broadwayscore'),
    worktreeDir: '.claude/worktrees',
    buildArtifactDirs: [],
  },
  {
    name: 'ios',
    path: path.join(HOME, 'BroadwayScorecard-app'),
    worktreeDir: '.claude/worktrees',
    buildArtifactDirs: ['ios/build', 'ios/Pods'],
  },
];

// A path-ish field is unsafe if it could walk outside the worktree it's
// meant to scope a `rm -rf` to: absolute, empty, or containing a `..`
// segment. Also bans control characters (tab/newline) and commas, which
// would corrupt the TSV/CSV wire format gc-merged-worktrees.sh parses this
// over (adversarial review, BRO-2540) — a directory name with an embedded
// comma would silently split into two bogus fields on the bash side.
function isUnsafePathSegment(s) {
  if (typeof s !== 'string' || s.length === 0) return true;
  if (s.startsWith('/')) return true;
  if (s.split('/').includes('..')) return true;
  if (/[\t\n,]/.test(s)) return true;
  return false;
}

/**
 * A repo entry is valid only if every path-ish field is a safe relative
 * path segment (see isUnsafePathSegment) — the wire format and the bash
 * consumer have no other defense against a config-supplied `../` or a
 * comma-embedded directory name reaching `rm -rf`.
 */
function isValidRepoEntry(r) {
  if (!r || typeof r !== 'object') return false;
  if (isUnsafePathSegment(r.name)) return false;
  if (typeof r.path !== 'string' || r.path.length === 0 || /[\t\n,]/.test(r.path)) return false;
  if (isUnsafePathSegment(r.worktreeDir)) return false;
  const dirs = r.buildArtifactDirs;
  if (dirs !== undefined) {
    if (!Array.isArray(dirs)) return false;
    if (dirs.some(isUnsafePathSegment)) return false;
  }
  return true;
}

/**
 * The repo set the GC operates over. Overridable via WORKTREE_GC_REPOS_JSON
 * (a JSON array of {name, path, worktreeDir, buildArtifactDirs}) so tests —
 * and any future repo — don't require a script edit. A malformed, empty, or
 * unsafe (path-traversal-shaped) override falls back to the defaults rather
 * than silently GC-ing nothing or handing bash a `../`-shaped delete target.
 */
function getGcRepos() {
  const override = process.env.WORKTREE_GC_REPOS_JSON;
  if (override) {
    try {
      const parsed = JSON.parse(override);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isValidRepoEntry)) {
        return parsed;
      }
    } catch {
      // malformed override — fall through to defaults
    }
  }
  return DEFAULT_REPOS;
}

/**
 * A build-artifact directory is reclaimable iff it exists, is gitignored
 * (never tracked — reclaiming a tracked dir would destroy real committed
 * work, not regenerable output), and has gone untouched for at least
 * staleDays — the same rule gc-merged-worktrees.sh already applies to
 * node_modules/.next. Pure function: callers gather the three facts from
 * fs.existsSync / git check-ignore / mtime and pass them in.
 */
function isReclaimableBuildDir({ exists, isGitIgnored, daysSinceModified, staleDays }) {
  if (!exists) return false;
  if (!isGitIgnored) return false;
  return daysSinceModified >= staleDays;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    for (const r of getGcRepos()) {
      console.log([r.name, r.path, r.worktreeDir, (r.buildArtifactDirs || []).join(',')].join('\t'));
    }
    return;
  }
  console.error('usage: worktree-gc-repos.js --list');
  process.exit(2);
}

if (require.main === module) main();

module.exports = { getGcRepos, isReclaimableBuildDir, isValidRepoEntry, DEFAULT_REPOS };
