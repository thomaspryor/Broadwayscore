'use strict';

// Shared origin/main oracle. Fetch once before a batch of path probes; a failed
// fetch must stop that batch rather than trusting a stale remote-tracking ref.
const path = require('path');
const { execFileSync } = require('child_process');
const { repoDepthArgs } = require('./shallow-fetch-args.js');

const REPO = path.join(__dirname, '..', '..');

/**
 * Pure classifier for a `git cat-file -e <tree-ish>:<path>` failure: does
 * this error mean the path is CONFIRMED absent from the tree (as opposed to
 * a transient/unexpected git or network failure)? Exit code is NOT a
 * reliable signal: missing paths and invalid refs can both exit 128. Match
 * the stderr text Git actually prints for a missing path.
 * @returns {boolean}
 */
function isPathAbsentFromTreeError(err) {
  const stderrText = err && err.stderr ? String(err.stderr) : '';
  return /does not exist in/.test(stderrText);
}

/**
 * Probe a previously fetched tree without a network request.
 * @returns {boolean|null} true=present, false=confirmed absent (or not a
 *   blob when fileOnly=true), null=unresolved git error.
 * `fileOnly` preserves file assertions such as `test -f`: a tree object
 * exists in Git but cannot satisfy those assertions.
 */
function pathExistsOnOriginMain(relPath, { repo = REPO, ref = 'origin/main', fileOnly = false, log = () => {} } = {}) {
  try {
    const type = execFileSync('git', ['cat-file', fileOnly ? '-t' : '-e', `${ref}:${relPath}`], {
      cwd: repo, timeout: 10000, stdio: 'pipe', encoding: 'utf8',
    }).trim();
    return fileOnly ? type === 'blob' : true;
  } catch (err) {
    if (isPathAbsentFromTreeError(err)) return false;
    log(`[origin-main-path-check] WARN could not check ${ref} for ${relPath}: ${String(err.message).slice(0, 120)}`);
    return null;
  }
}

// Depth-bound the fetch: most CI checkouts are shallow, and an unbounded
// `git fetch origin main` from one pulls the whole repo instead of the delta.
function fetchOriginMain({ repo = REPO, log = () => {}, attempts = 3, sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  const depthArgs = repoDepthArgs({ repoRoot: repo });
  // ~20 worktrees share one .git, so a concurrent fetch can hold
  // refs/remotes/origin/main.lock; one collision must not become a spurious
  // "unverified" refusal downstream (BRO-3435). Retry only lock collisions,
  // with jitter; any other failure returns false at once.
  for (let i = 1; i <= attempts; i++) {
    try {
      // unbounded-fetch-ok: depthArgs IS the bound; the lint can't evaluate a spread.
      execFileSync('git', ['fetch', ...depthArgs, '--quiet', 'origin', 'main'], { cwd: repo, timeout: 30000, stdio: 'pipe' });
      return true;
    } catch (err) {
      const text = `${err.message || ''} ${err.stderr || ''}`;
      if (i < attempts && /\.lock|cannot lock ref|Unable to create/i.test(text)) {
        sleepMs(200 + Math.floor(Math.random() * 600));
        continue;
      }
      log(`[origin-main-path-check] WARN could not fetch origin/main: ${String(err.message).slice(0, 120)}`);
      return false;
    }
  }
  return false;
}

module.exports = { fetchOriginMain, pathExistsOnOriginMain, isPathAbsentFromTreeError };
