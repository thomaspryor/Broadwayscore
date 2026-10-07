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

function refreshDataClone(repo, { dataRepo = null, memoize = true } = {}) {
  const clone = dataRepo || resolveDataClone(repo);
  if (!clone) return { status: 'skipped', detail: 'no separate data clone' };
  if (memoize && memo.has(clone)) return memo.get(clone);
  // `unknown` (transient lock/offline) is never memoized: a later card retries.
  const done = (r) => { r.clone = clone; if (memoize && r.status !== 'unknown') memo.set(clone, r); return r; };

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
    const dirty = git(clone, ['status', '--porcelain', '--untracked-files=no']) !== '';
    verdict = decideRefresh({ behind, headInOrigin, originInHead, dirty });
    if (verdict === 'unsafe') {
      return done({ status: 'unsafe', detail: `data clone is behind origin/main but ${dirty ? 'has uncommitted changes' : 'has diverged'}; left untouched` });
    }
    if (verdict === 'fast-forward') {
      try { git(clone, ['merge', '--ff-only', 'origin/main'], 60000); }
      catch (e) {
        // Known behind and could not advance (lock, untracked file in the way):
        // copying would reproduce the stale-data failure, so do not grade it.
        return done({ status: 'unsafe', detail: `known behind origin/main but ff-only merge failed: ${String(e.message).split('\n')[0]}` });
      }
      return done({ status: 'fast-forwarded', detail: `data clone advanced to ${git(clone, ['rev-parse', '--short', 'HEAD'])}` });
    }
  } catch (e) {
    return done({ status: 'unknown', detail: `refresh failed: ${String(e.message).split('\n')[0]}` });
  }
  return done({ status: 'current', detail: 'data clone up to date' });
}

module.exports = { refreshDataClone, resolveDataClone, decideRefresh };
