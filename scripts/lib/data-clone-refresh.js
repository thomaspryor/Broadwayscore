// BRO-4830: refresh the private core-data clone before the Done gate copies it.
//
// prepareCheckWorkdir() COPIES data/*.json out of the main checkout, whose
// core-data files symlink into ~/broadway-scorecard-data. Nothing refreshed
// that clone first, so a card's corpus tests ran current code against old
// data and a correct card was refused as own-verify-failed.
//
// States (never throws):
//   skipped        no separate data clone resolved (hosted CI, data not symlinked)
//   current        HEAD already contains origin/main (or is ahead of it)
//   fast-forwarded behind and clean: merged ff-only
//   unknown        fetch/merge failed (offline, lock): proceed, same fail-open
//                  posture as a missing network anywhere else in the gate
//   unsafe         behind but dirty or diverged: the clone is NOT touched and the
//                  caller must report unverifiable, never fail
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FETCH_TIMEOUT_MS = 30000;
const GIT_TIMEOUT_MS = 10000;

const memo = new Map(); // once per process per clone: recheck batches don't fetch per card

function git(cwd, args, timeout = GIT_TIMEOUT_MS) {
  return execFileSync('git', args, { cwd, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * The clone the repo's core data actually comes from: the git toplevel of
 * wherever data/shows.json really lives, null when it cannot be resolved. null when that is the repo itself (data not
 * symlinked: nothing separate to refresh).
 */
function resolveDataClone(repo) {
  let clone = null;
  try {
    clone = git(path.dirname(fs.realpathSync(path.join(repo, 'data', 'shows.json'))), ['rev-parse', '--show-toplevel']);
  } catch { /* fall through to the default location */ }
  // No env/default-location fallback: a clone the copy doesn't read from is irrelevant.
  if (!clone) return null;
  try {
    clone = fs.realpathSync(clone);
    const own = fs.realpathSync(repo);
    if (clone === own || clone.startsWith(own + path.sep)) return null;
  } catch { return null; }
  return fs.existsSync(path.join(clone, '.git')) ? clone : null;
}

/** Pure decision from the clone's state, so the policy is unit-testable. */
function decideRefresh({ behind, headInOrigin, originInHead, dirty }) {
  if (!behind || originInHead) return 'current';
  if (headInOrigin && !dirty) return 'fast-forward';
  return 'unsafe';
}

// BRO-5332: name the dirty files. A disk-full ff-merge once left reviews.json
// truncated and the gate said only "stale and dirty/diverged" for ~5 hours.
const INSPECT_HINT = ' (inspect with git diff --stat first: a file torn by a failed merge can be restored with git checkout -- <path>, a real edit must be committed)';
function listDirty(statusOut, max = 5) {
  const paths = statusOut.split('\n').filter(Boolean).map((l) => l.replace(/^\s*\S+\s+/, ''));
  return paths.slice(0, max).join(', ') + (paths.length > max ? `, +${paths.length - max} more` : '');
}

function refreshDataClone(repo, { dataRepo = null, memoize = true } = {}) {
  const clone = dataRepo || resolveDataClone(repo);
  if (!clone) return { status: 'skipped', detail: 'no separate data clone' };
  if (memoize && memo.has(clone)) return memo.get(clone);
  // `unknown` (transient lock/offline) is never memoized: a later card retries.
  const done = (r) => {
    r.clone = clone;
    if (memoize && r.status !== 'unknown') memo.set(clone, r);
    // BRO-5332: an unsafe clone makes every acceptance check on this machine
    // unverifiable; say why once per process instead of only in a return value.
    if (r.status === 'unsafe') console.error(`[data-clone-refresh] ${r.detail}`);
    return r;
  };

  try { git(clone, ['fetch', '--quiet', 'origin', 'main'], FETCH_TIMEOUT_MS); }
  catch (e) { return done({ status: 'unknown', detail: `fetch failed: ${String(e.message).split('\n')[0]}` }); }

  const isAncestor = (a, b) => {
    try { git(clone, ['merge-base', '--is-ancestor', a, b]); return true; }
    catch (e) { if (e.status === 1) return false; throw e; }
  };
  let verdict;
  try {
    const headInOrigin = isAncestor('HEAD', 'origin/main');
    const originInHead = isAncestor('origin/main', 'HEAD');
    const behind = !originInHead;
    let statusOut = git(clone, ['status', '--porcelain', '--untracked-files=no']);
    if (statusOut !== '' && behind) {
      // BRO-5784: a fast-forward killed mid-checkout leaves origin/main's own bytes in the tree and every later
      // refresh then says "uncommitted changes". Cleared only when origin/main's bytes explain EVERY dirty file.
      const { reconcileInterruptedFastForward } = require('./code-checkout-staleness.js');
      const healed = reconcileInterruptedFastForward({ repoDir: clone, timeoutMs: 60000 });
      if (!healed.error && !healed.skipped) statusOut = git(clone, ['status', '--porcelain', '--untracked-files=no']);
    }
    const dirty = statusOut !== '';
    verdict = decideRefresh({ behind, headInOrigin, originInHead, dirty });
    if (verdict === 'unsafe') {
      return done({ status: 'unsafe', detail: `data clone ${clone} is behind origin/main but ${dirty ? `has uncommitted changes (${listDirty(statusOut)})` : 'has diverged'}; left untouched${dirty ? INSPECT_HINT : ''}` });
    }
    if (verdict === 'fast-forward') {
      try { git(clone, ['merge', '--ff-only', 'origin/main'], 60000); }
      catch (e) {
        // Known behind and could not advance (lock, untracked file in the way):
        // copying would reproduce the stale-data failure, so do not grade it.
        // BRO-5332: the cause ("No space left on device") is in stderr, not
        // e.message, and a half-applied merge leaves torn files behind.
        const errLines = String(e.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
        const why = errLines.find((l) => /^(fatal|error):/.test(l)) || errLines.pop() || String(e.message).split('\n')[0];
        let left = '';
        try { left = git(clone, ['status', '--porcelain', '--untracked-files=no']); } catch { /* report what we have */ }
        return done({ status: 'unsafe', detail: `data clone ${clone} is behind origin/main but ff-only merge failed: ${why}${left ? `; left uncommitted changes (${listDirty(left)})${INSPECT_HINT}` : ''}` });
      }
      return done({ status: 'fast-forwarded', detail: `data clone advanced to ${git(clone, ['rev-parse', '--short', 'HEAD'])}` });
    }
  } catch (e) {
    return done({ status: 'unknown', detail: `refresh failed: ${String(e.message).split('\n')[0]}` });
  }
  return done({ status: 'current', detail: 'data clone up to date' });
}

module.exports = { refreshDataClone, resolveDataClone, decideRefresh };
