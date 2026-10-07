/**
 * code-checkout-staleness — warns when the CODE checkout itself (not a data
 * clone) is behind origin/main (BRO-2663).
 *
 * 2026-08-31 incident: a crown session read scripts/audit-regex-patterns.test.mjs
 * from the shared main ~/Broadwayscore checkout, 18 commits behind origin/main,
 * found 0 "opera" mentions where a landed commit (dd7ba875198, confirmed on
 * origin/main) had added 5 opera tests, and nearly concluded a correct worker
 * had reverted its own tests. `git merge --ff-only origin/main` fixed it. The
 * crown loop's own "am I ahead" check (`git rev-list --count
 * origin/main..HEAD`) reads 0 in both the current-checkout AND the
 * arbitrarily-behind case — it structurally cannot catch this; the missing
 * direction is `HEAD..origin/main`. session-start.sh already warns for two
 * staleness classes (data/review-texts, the core-data clone) but never for
 * the code repo itself. This closes that gap.
 *
 * Scope: the shared MAIN checkout only. A worktree branch is ahead of
 * origin/main by definition (its own commits) — the caller (session-start.sh)
 * skips this check inside a worktree, the same way the existing "WORKTREE
 * REMINDER" block does (`[[ "$PWD" != *"/.claude/worktrees/"* ]]`). This file
 * has no opinion on that; it just answers "how far behind/ahead is this
 * directory" (second-opinion review, BRO-2663 plan review).
 */
'use strict';

const { execFileSync } = require('child_process');

// Matches the CORE-DATA block's perl-alarm timeout (session-start.sh) — a
// network hang here must not block every session start indefinitely.
const FETCH_TIMEOUT_MS = 5000;

/**
 * Best-effort update of the local origin/main tracking ref. Fail-open: a
 * network hiccup or missing remote must not block session start — a stale
 * cached ref (whatever was last fetched) is strictly better than hanging.
 */
function fetchOriginMain(repoDir, execFn = execFileSync) {
  try {
    execFn('git', ['-C', repoDir, 'fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main', '-q'], {
      timeout: FETCH_TIMEOUT_MS,
      stdio: 'ignore',
    });
  } catch { /* fail-open */ }
}

/**
 * How far HEAD is behind/ahead of remoteRef. 0 on any failure (detached HEAD,
 * remote-ref never fetched, not a git repo, etc.) — fail-open, matching
 * fetchOriginMain.
 */
function getBehindAheadCounts(repoDir, remoteRef = 'refs/remotes/origin/main', execFn = execFileSync) {
  const count = (range) => {
    try {
      return Number(execFn('git', ['-C', repoDir, 'rev-list', '--count', range], { encoding: 'utf8' }).trim()) || 0;
    } catch {
      return 0;
    }
  };
  return {
    behind: count(`HEAD..${remoteRef}`),
    ahead: count(`${remoteRef}..HEAD`),
  };
}

/**
 * Pure — no fs/git. Behind-only is the incident's shape: the shared main
 * checkout drifted with nothing local to lose, so ff-only is always safe.
 */
function formatCodeCheckoutStaleMessage({ behind, ahead }, repoDir) {
  if (behind > 0 && ahead === 0) {
    return [
      `🔶 STALE CODE CHECKOUT: ${repoDir} is ${behind} commit(s) behind origin/main.`,
      `   Reading ANY file here (tests, scripts, CLAUDE.md) can produce a WRONG CONCLUSION —`,
      `   a checkout 18 commits behind once read a landed commit's 5 new tests as reverted (BRO-2663).`,
      `   Bring it current before trusting anything you read:`,
      `     git merge --ff-only origin/main`,
      `   If that's BLOCKED ("commit your changes or stash them before you merge"), it's almost`,
      `   always modified tracked telemetry under data/audit/ on the shared main checkout — commit`,
      `   it first (data: audit telemetry update [skip ci]), THEN merge. Do NOT \`git stash\` on the`,
      `   shared main checkout — it's shared with every other session on this machine.`,
    ].join('\n');
  }
  if (behind > 0 && ahead > 0) {
    return [
      `🚨 CODE CHECKOUT DIVERGED: ${repoDir} is ${behind} behind AND ${ahead} ahead of origin/main.`,
      `   Conclusions drawn from this checkout may be stale AND carry unmerged local commits.`,
      `   Reconcile before trusting anything you read:`,
      `     git merge origin/main`,
    ].join('\n');
  }
  return null;
}

/** Convenience wrapper: fetches (unless skipFetch), counts, formats. */
function runCodeCheckoutStalenessCheck({ repoDir, execFn = execFileSync, skipFetch = false } = {}) {
  if (!skipFetch) fetchOriginMain(repoDir, execFn);
  const { behind, ahead } = getBehindAheadCounts(repoDir, 'refs/remotes/origin/main', execFn);
  return { behind, ahead, message: formatCodeCheckoutStaleMessage({ behind, ahead }, repoDir) };
}

// ── Auto-sync (BRO-4229, CLOUD ONLY) ────────────────────────────────────────
// A cloud session runs the repo's hooks from its own checkout
// ($CLAUDE_PROJECT_DIR/.claude/hooks), so a long-running or resumed session
// never sees hook fixes that landed on main: on 2026-09-28 one ran a Stop hook
// 381 commits old that still demanded Notion close-outs. A cloud container is
// one session, so fast-forwarding its checkout at SessionStart is safe. The
// Mac's shared checkout (~20 concurrent sessions) must never be touched: only
// the cloud .claude/hooks/session-start.sh calls this, and that file self-skips
// on the Mac.
//
// Fast-forward ONLY (plan review): a diverged branch keeps the DIVERGED
// warning. Cloud clones are shallow, so a real merge can lack its merge base,
// and a merge commit on the harness branch mid-task is not ours to make.

const SYNC_TIMEOUT_MS = 20000;
const REMOTE_MAIN = 'refs/remotes/origin/main';
// Already in the session's context, so a change to them needs a re-read.
const SYNC_WATCHED_FILES = ['CLAUDE.md', '.claude/CLOUD.md', '.claude/settings.json'];
const IN_PROGRESS_MARKERS = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];

/** Pure: every .claude/hooks/*.sh a settings.json registers. */
function registeredHookScripts(settingsText) {
  const out = new Set();
  for (const m of String(settingsText || '').matchAll(/\.claude\/hooks\/([A-Za-z0-9._-]+\.sh)/g)) {
    out.add(`.claude/hooks/${m[1]}`);
  }
  return [...out];
}

/**
 * Fast-forward repoDir to origin/main when nothing can be lost. Never pushes.
 * Every precondition failure returns {synced:false, reason} and changes
 * nothing. Expects origin/main already fetched (runCodeCheckoutStalenessCheck).
 */
function trySyncCodeCheckout({ repoDir, behind, ahead, execFn = execFileSync, env = process.env } = {}) {
  const fs = require('fs');
  const path = require('path');
  const git = (args) => String(execFn('git', ['-C', repoDir, ...args], {
    encoding: 'utf8', timeout: SYNC_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
  })).trim();
  const no = (reason) => ({ synced: false, reason });

  if (env.CODE_SYNC_DISABLED === '1') return no('disabled (CODE_SYNC_DISABLED=1)');
  if (!(behind > 0)) return no('not behind origin/main');
  if (ahead > 0) return no(`${ahead} local commit(s) not on origin/main; fast-forward only`);
  try {
    git(['symbolic-ref', '-q', 'HEAD']);
  } catch {
    return no('detached HEAD');
  }
  try {
    for (const marker of IN_PROGRESS_MARKERS) {
      const p = git(['rev-parse', '--git-path', marker]);
      if (fs.existsSync(path.isAbsolute(p) ? p : path.join(repoDir, p))) return no(`${marker} in progress`);
    }
    if (git(['status', '--porcelain', '--untracked-files=no'])) return no('uncommitted changes to tracked files');
  } catch (err) {
    return no(`could not read git state: ${String(err.message).split('\n')[0]}`);
  }

  // Hook registration is snapshotted at session start; only script CONTENTS
  // are re-read. If main deleted a script this session still has registered,
  // its wrapper would exit 2 on every tool call after the sync.
  let settings = '';
  try { settings = git(['show', 'HEAD:.claude/settings.json']); } catch { /* none registered */ }
  const missing = registeredHookScripts(settings).filter((p) => {
    try { git(['cat-file', '-e', `${REMOTE_MAIN}:${p}`]); return false; } catch { return true; }
  });
  if (missing.length) return no(`origin/main removes registered hook script(s): ${missing.join(', ')}`);

  let from;
  let to;
  try {
    from = git(['rev-parse', 'HEAD']);
    git(['merge', '--ff-only', '-q', REMOTE_MAIN]);
    to = git(['rev-parse', 'HEAD']);
  } catch (err) {
    return no(`fast-forward refused: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
  }
  if (to === from) return no('fast-forward made no change');
  let changedWatched = [];
  try {
    const changed = new Set(git(['diff', '--name-only', from, to]).split('\n'));
    changedWatched = SYNC_WATCHED_FILES.filter((f) => changed.has(f));
  } catch { /* informational only */ }
  return { synced: true, reason: 'fast-forwarded', from, to, count: behind, changedWatched };
}

/** Pure: the SessionStart line for a successful sync, else null. */
function formatCodeCheckoutSyncMessage(result, repoDir) {
  if (!result || !result.synced) return null;
  const lines = [
    `🔄 CODE CHECKOUT SYNCED: fast-forwarded ${repoDir} by ${result.count} commit(s) to origin/main `
      + `(${result.to.slice(0, 11)}), so its hooks and scripts are current.`,
  ];
  const watched = result.changedWatched || [];
  const docs = watched.filter((f) => f !== '.claude/settings.json');
  if (docs.length) lines.push(`   Changed since this session loaded them: ${docs.join(', ')}. Re-read them now.`);
  if (watched.includes('.claude/settings.json')) {
    lines.push('   .claude/settings.json changed: new hook wiring only takes effect in a new session.');
  }
  lines.push(`   Undo: git -C ${repoDir} reset --keep ${result.from.slice(0, 11)}   (disable: CODE_SYNC_DISABLED=1)`);
  return lines.join('\n');
}

module.exports = {
  FETCH_TIMEOUT_MS,
  SYNC_TIMEOUT_MS,
  fetchOriginMain,
  getBehindAheadCounts,
  formatCodeCheckoutStaleMessage,
  runCodeCheckoutStalenessCheck,
  registeredHookScripts,
  trySyncCodeCheckout,
  formatCodeCheckoutSyncMessage,
};
