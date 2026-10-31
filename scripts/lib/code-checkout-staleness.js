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
// BRO-5359: a cold cloud container fetching origin/main for the 35k-file repo can take well over 5s. The
// 5s budget made the fetch fail silently, the checkout stayed a day old, and every hook and lib (the review
// gates included) ran from stale code for the whole session. Cloud pays up to this once at startup.
const CLOUD_FETCH_TIMEOUT_MS = 40000;

/**
 * Best-effort update of the local origin/main tracking ref. Fail-open: a
 * network hiccup or missing remote must not block session start — a stale
 * cached ref (whatever was last fetched) is strictly better than hanging.
 */
function fetchOriginMain(repoDir, execFn = execFileSync, timeoutMs = FETCH_TIMEOUT_MS) {
  try {
    // unbounded-fetch-ok: session-start refresh of one ref with a hard timeout (never a workflow checkout step); it only ever deepens a clone the session already has
    execFn('git', ['-C', repoDir, 'fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main', '-q'], {
      timeout: timeoutMs,
      stdio: 'ignore',
    });
    return true;
  } catch { /* fail-open */ }
  return false;
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

// BRO-3006: local main more than this many commits ahead of origin/main is an
// unpushed backlog. A few is a session mid-push; 86 (BRO-2955) sat unnoticed.
const UNPUSHED_BACKLOG_THRESHOLD = 5;

/** Current branch name, or '' when detached / not a repo. Fail-open. */
function getCurrentBranch(repoDir, execFn = execFileSync) {
  try {
    return String(execFn('git', ['-C', repoDir, 'symbolic-ref', '--short', '-q', 'HEAD'], { encoding: 'utf8' })).trim();
  } catch {
    return '';
  }
}

/**
 * Pure — no fs/git. Behind-only is the incident's shape: the shared main
 * checkout drifted with nothing local to lose, so ff-only is always safe.
 * Ahead-only warns only when the checked-out branch is `main` (BRO-3006): a
 * feature or harness branch is ahead by design, local main is not.
 */
function formatCodeCheckoutStaleMessage({ behind, ahead, branch = '' }, repoDir) {
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
  if (behind === 0 && branch === 'main' && ahead > UNPUSHED_BACKLOG_THRESHOLD) {
    return [
      `🔶 UNPUSHED BACKLOG: local main in ${repoDir} is ${ahead} commit(s) ahead of origin/main.`,
      `   Work merged here has not reached origin, so CI, deploys and every other checkout`,
      `   cannot see it (86 commits once sat unpushed this way, BRO-2955). See what is waiting:`,
      `     git log --oneline origin/main..main`,
      `   Land it through the normal landing path; sessions cannot push main directly`,
      `   (cloud: git push origin main:refs/heads/land/<name>).`,
    ].join('\n');
  }
  return null;
}

/** Convenience wrapper: fetches (unless skipFetch), counts, formats. */
function runCodeCheckoutStalenessCheck({ repoDir, execFn = execFileSync, skipFetch = false, fetchTimeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const fetched = skipFetch ? true : fetchOriginMain(repoDir, execFn, fetchTimeoutMs);
  const { behind, ahead } = getBehindAheadCounts(repoDir, 'refs/remotes/origin/main', execFn);
  const branch = getCurrentBranch(repoDir, execFn);
  return { behind, ahead, branch, fetched, message: formatCodeCheckoutStaleMessage({ behind, ahead, branch }, repoDir) };
}

/** Pure: the cloud warning when origin/main could not be fetched, so the checkout (and its hooks) may be stale. */
function formatFetchFailedMessage(repoDir, headDate, bgPid = null) {
  return [
    `⚠️ HOOKS MAY BE STALE: could not fetch origin/main for ${repoDir} (timed out after ${CLOUD_FETCH_TIMEOUT_MS / 1000}s, or a network/auth error).`,
    `   This session's hooks, gates and scripts run from that checkout${headDate ? ` (HEAD is from ${headDate})` : ''}, so newer fixes`,
    `   (review gates, landing checks) may not be active. Refresh it now:`,
    `     git -C ${repoDir} fetch origin main && git -C ${repoDir} merge --ff-only origin/main`,
    ...(bgPid ? [`   A background catch-up is already running (pid ${bgPid}); do NOT run the merge by hand meanwhile. It retries the fetch and fast-forwards this checkout when it can; read /tmp/code-checkout-bg-sync.log for the outcome.`] : []),
  ].join('\n');
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
// Fast-forward, or reset --keep when every locally changed path already has
// exactly the same tree entry on main (BRO-4230). This also recognizes squash
// landings that git cherry cannot. Missing merge bases fail closed in shallow
// clones. Resetting rewrites branch history: its next push may require
// --force-with-lease if the remote branch still points at the old commits.

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
 * Undo the debris of a fast-forward that was killed part-way (BRO-5784). `git merge --ff-only` writes the new
 * files into the working tree (and index) BEFORE it moves HEAD, so a kill mid-checkout leaves hundreds of tracked
 * files modified (they already hold origin/main's bytes) plus untracked files that are really origin/main's new
 * files, and every later sync refused on "uncommitted changes".
 *
 * Plan first, apply second: a file counts as debris only when its raw bytes (no clean filters) equal origin/main's
 * blob, or it is absent on both sides. The plan is applied only when EVERY dirty tracked path (except those
 * `ignore` waves through) is debris; otherwise nothing at all is touched, so a refused sync still changes nothing.
 * Applying puts tracked debris back to HEAD's version (or drops it from the index if HEAD lacks it) and removes
 * untracked debris; the merge rewrites both. Literal pathspecs: 53 tracked paths contain `[slug]`, a glob otherwise.
 * Returns {reverted, removed}, {skipped, unmatched} (nothing touched) or {error}; never throws.
 */
function reconcileInterruptedFastForward({ repoDir, execFn = execFileSync, timeoutMs = SYNC_TIMEOUT_MS, ignore = () => false } = {}) {
  const fs = require('fs');
  const path = require('path');
  const z = (args, input) => String(execFn('git', ['--literal-pathspecs', '-C', repoDir, ...args], {
    encoding: 'utf8', timeout: timeoutMs, input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
  }));
  const list = (out) => out.split('\0').filter(Boolean);
  const isRegular = (p) => { try { return fs.lstatSync(path.join(repoDir, p)).isFile(); } catch { return false; } };
  // Gone, or now a directory (a file-to-directory change; its untracked children are judged on their own bytes).
  const goneOrDir = (p) => { try { return fs.lstatSync(path.join(repoDir, p)).isDirectory(); } catch { return true; } };
  // Raw-byte blob ids for regular files (no clean filters, so autocrlf/eol cannot make different bytes look equal).
  // Paths go in argv, chunked: --stdin-paths would C-unquote a path that starts with a quote.
  const rawShas = (paths) => {
    const out = new Map();
    for (let i = 0; i < paths.length; i += 200) {
      const chunk = paths.slice(i, i + 200);
      const shas = z(['hash-object', '--no-filters', '--', ...chunk]).split('\n').filter(Boolean);
      if (shas.length !== chunk.length) throw new Error('hash-object returned a different number of ids than paths');
      chunk.forEach((p, j) => out.set(p, shas[j]));
    }
    return out;
  };
  try {
    const dirty = list(z(['diff', '--name-only', '--no-renames', '-z', 'HEAD']));
    const untracked = list(z(['ls-files', '-o', '--exclude-standard', '-z'])).filter((p) => !/[\r\n]/.test(p));
    if (!dirty.length && !untracked.length) return { reverted: 0, removed: 0 };

    const remote = new Map(); // path -> blob id, regular files only (symlinks and submodules never match)
    for (const e of list(z(['ls-tree', '-r', '-z', REMOTE_MAIN]))) {
      const m = /^100(?:644|755) blob ([0-9a-f]+)\t([\s\S]*)$/.exec(e);
      if (m) remote.set(m[2], m[1]);
    }
    // BRO-6104: a kill that came before origin/main moved leaves bytes from an OLDER tip, which the current tip's blob
    // no longer equals (a file edited again since). Any blob a commit in HEAD..origin/main wrote to the path is debris
    // too: HEAD has no commits ahead (the sync preconditions), so none of that content can be the session's own.
    const history = new Map(); // path -> Set of blob ids those commits introduced
    try { // best effort: tip-only matching still heals when the history walk fails or times out
      const raw = z(['log', '--diff-merges=first-parent', '--no-show-signature', '--no-renames', '--raw', '--no-abbrev', '-z', '--format=', `HEAD..${REMOTE_MAIN}`]).split('\0');
      for (let i = 0; i + 1 < raw.length;) {
        const m = /^:\d+ 100(?:644|755) [0-9a-f]+ ([0-9a-f]+) [A-Z]\d*$/.exec(raw[i].trim());
        if (!raw[i].trim().startsWith(':')) { i += 1; continue; } // stray token (signature line): resync on the next meta record
        if (m && raw[i + 1]) {
          if (!history.has(raw[i + 1])) history.set(raw[i + 1], new Set());
          history.get(raw[i + 1]).add(m[1]);
        }
        i += 2;
      }
    } catch { history.clear(); }
    const known = (p, sha) => remote.get(p) === sha || (history.get(p) || new Set()).has(sha);
    // A path that is missing on disk is debris only when origin/main has no such file either: a session's own
    // deletion of a file that exists at the tip must still refuse the sync.
    const matches = (paths) => {
      const need = paths.filter((p) => (remote.has(p) || history.has(p)) && isRegular(p));
      const shas = rawShas(need);
      return paths.filter((p) => (remote.has(p) || history.has(p) ? (shas.has(p) && known(p, shas.get(p))) || (!remote.has(p) && goneOrDir(p)) : goneOrDir(p)));
    };

    const matchedTracked = new Set(matches(dirty));
    const unmatched = dirty.filter((p) => !matchedTracked.has(p) && !ignore(p));
    if (unmatched.length) return { skipped: 'dirty tracked file(s) that are not origin/main\'s bytes', unmatched: unmatched.length };

    const matchedUntracked = matches(untracked.filter((p) => remote.has(p)));
    const tracked = [...matchedTracked];
    let notInHead = [];
    if (tracked.length) {
      const inHead = new Set(list(z(['ls-tree', '-r', '-z', '--name-only', 'HEAD'])));
      notInHead = tracked.filter((p) => !inHead.has(p));
    }
    const dropped = new Set(notInHead);
    const restore = tracked.filter((p) => !dropped.has(p));

    // Untracked first: a file-to-directory change leaves untracked x/y in the way of restoring tracked x.
    for (const p of matchedUntracked) fs.rmSync(path.join(repoDir, p), { force: true });
    if (restore.length) z(['checkout', '-q', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'], `${restore.join('\0')}\0`);
    if (notInHead.length) {
      // Staged as an add by the killed merge: HEAD has no version to restore, so un-stage it and drop the written copy.
      z(['rm', '-q', '--cached', '--pathspec-from-file=-', '--pathspec-file-nul'], `${notInHead.join('\0')}\0`);
      for (const p of notInHead) fs.rmSync(path.join(repoDir, p), { force: true });
    }
    return { reverted: tracked.length, removed: matchedUntracked.length };
  } catch (err) {
    return { error: String(err.stderr || err.message).trim().split('\n')[0] };
  }
}

/**
 * Sync repoDir to origin/main when nothing can be lost. Never pushes.
 * Every precondition failure returns {synced:false, reason} and changes
 * nothing. Expects origin/main already fetched (runCodeCheckoutStalenessCheck).
 */
function trySyncCodeCheckout({ repoDir, behind, ahead, execFn = execFileSync, env = process.env, syncTimeoutMs = SYNC_TIMEOUT_MS, startBackground = startBackgroundSync } = {}) {
  const fs = require('fs');
  const path = require('path');
  const rawGit = (args) => String(execFn('git', ['-C', repoDir, ...args], {
    encoding: 'utf8', timeout: syncTimeoutMs, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const git = (args) => rawGit(args).trim();
  const no = (reason) => ({ synced: false, reason });

  if (env.CODE_SYNC_DISABLED === '1') return no('disabled (CODE_SYNC_DISABLED=1)');
  if (!(behind > 0)) return no('not behind origin/main');
  const alreadyLanded = ahead > 0;
  let branch;
  try {
    branch = git(['symbolic-ref', '-q', 'HEAD']);
  } catch {
    return no('detached HEAD');
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


  let healed = null;
  try {
    for (const marker of IN_PROGRESS_MARKERS) {
      const p = git(['rev-parse', '--git-path', marker]);
      if (fs.existsSync(path.isAbsolute(p) ? p : path.join(repoDir, p))) return no(`${marker} in progress`);
    }
    // A killed earlier fast-forward leaves origin/main's own bytes in the tree. Cleared only when that explains EVERY
    // dirty tracked file; otherwise nothing is touched and the refusal below changes nothing.
    // Diverged branches may contain session edits that happen to match main.
    // Do not treat those edits as interrupted fast-forward debris.
    if (!alreadyLanded) healed = reconcileInterruptedFastForward({ repoDir, execFn, timeoutMs: syncTimeoutMs });
    if (git(['status', '--porcelain', '--untracked-files=no'])) {
      return no(`uncommitted changes to tracked files${healed && healed.error ? ` (clearing an interrupted sync failed: ${healed.error})` : ''}`);
    }
  } catch (err) {
    return no(`could not read git state: ${String(err.message).split('\n')[0]}`);
  }

  let from;
  let to;
  let resetStarted = false;
  try {
    from = git(['rev-parse', 'HEAD']);
    const target = git(['rev-parse', REMOTE_MAIN]);
    if (alreadyLanded) {
      const base = git(['merge-base', from, target]);
      // NUL delimiters and no pathspecs: literal names (including newlines and
      // brackets), rename endpoints, deletions, modes and binary blobs all count.
      const changedPaths = (a, b) => new Set(rawGit(['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--no-renames', '--name-only', '-z', a, b]).split('\0').filter(Boolean));
      const local = changedPaths(base, from);
      const different = changedPaths(from, target);
      if ([...local].some((p) => different.has(p))) {
        return no(`${ahead} local commit(s) not on origin/main; fast-forward only (locally changed paths differ)`);
      }
      // A background check can overlap the session continuing its work. The
      // equivalence proof applies only to the branch and HEAD we inspected.
      if (git(['rev-parse', 'HEAD']) !== from || git(['symbolic-ref', '-q', 'HEAD']) !== branch) {
        return no('HEAD moved while checking already-landed commits');
      }
      resetStarted = true;
      git(['reset', '--keep', '-q', target]);
    } else {
      git(['merge', '--ff-only', '-q', REMOTE_MAIN]);
    }
    to = git(['rev-parse', 'HEAD']);
  } catch (err) {
    if (alreadyLanded && !resetStarted) return no(`already-landed check refused: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
    if (err && (err.killed || err.signal || err.code === 'ETIMEDOUT')) {
      // Killed mid-checkout: put the tree back to a clean state now rather than leave it half-written, and tell the
      // caller to retry with the long-budget background job (the same 20s kill would tear it again).
      const rb = reconcileInterruptedFastForward({ repoDir, execFn, timeoutMs: syncTimeoutMs });
      const clean = !rb.error && !rb.skipped;
      const bgPid = startBackground(repoDir);
      return {
        synced: false, timedOut: true, rolledBack: clean, bgPid,
        reason: `${alreadyLanded ? 'already-landed reset' : 'fast-forward'} timed out after ${syncTimeoutMs / 1000}s; ${clean ? 'tree rolled back' : `tree NOT fully rolled back (${rb.error || rb.skipped}); the next sync retries the cleanup`}; ${bgPid ? `background catch-up started, pid ${bgPid}` : `background catch-up could not be started: run git ${alreadyLanded ? 'reset --keep' : 'merge --ff-only'} origin/main by hand`}`,
      };
    }
    if (alreadyLanded) return no(`already-landed reset refused: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
    return no(`fast-forward refused: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
  }
  if (to === from) return no('fast-forward made no change');
  let changedWatched = [];
  try {
    const changed = new Set(git(['diff', '--name-only', from, to]).split('\n'));
    changedWatched = SYNC_WATCHED_FILES.filter((f) => changed.has(f));
  } catch { /* informational only */ }
  return { synced: true, reason: alreadyLanded ? 'already landed; reset with --keep' : 'fast-forwarded', ...(alreadyLanded ? { alreadyLanded: true } : {}), from, to, count: behind, changedWatched, reconciled: healed ? (healed.reverted || 0) + (healed.removed || 0) : 0 };
}

// ── Background catch-up (BRO-5359, CLOUD ONLY) ─────────────────────────────────────────────────────────
// A cached container can be days behind; fetching that delta takes minutes, far past the blocking startup budget,
// and the checkout it runs hooks from then stays stale for the whole session (the review gates silently off).
// When the startup fetch fails, a detached job keeps trying without a deadline and fast-forwards when it can.
//
// Lossless by construction: it never runs if the session already moved HEAD or has unlanded local commits, refuses when
// any tracked file OUTSIDE data/ is modified, and for modified tracked data/ files (the cloud core-data copy of
// audience-reviews-lbo.json is one; a plain `merge --ff-only` aborts on it) it copies the exact bytes aside,
// lets git put the file back, fast-forwards, and writes the bytes back, success or not.
const BG_ATTEMPTS = 6;
const BG_FETCH_TIMEOUT_MS = 300000;
const BG_SYNC_TIMEOUT_MS = 300000;
const BG_PAUSE_MS = 20000;
const bgPath = (name, dflt) => process.env[name] || dflt;

function backgroundCatchUp({ repoDir, expectHead = null, execFn = execFileSync, sleepFn = null, attempts = BG_ATTEMPTS,
  fetchTimeoutMs = BG_FETCH_TIMEOUT_MS, pauseMs = BG_PAUSE_MS, syncTimeoutMs = BG_SYNC_TIMEOUT_MS, env = process.env,
  log = () => {}, heartbeat = () => {} } = {}) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const git = (args, timeout = 60000) => String(execFn('git', ['-C', repoDir, ...args], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  const no = (reason) => ({ synced: false, reason });
  if (env.CODE_SYNC_DISABLED === '1') return no('disabled (CODE_SYNC_DISABLED=1)');
  const sleep = sleepFn || ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  let fetched = false;
  for (let i = 0; i < attempts && !fetched; i++) {
    heartbeat();
    fetched = fetchOriginMain(repoDir, execFn, fetchTimeoutMs);
    if (!fetched && i < attempts - 1) sleep(pauseMs);
  }
  if (!fetched) return no(`origin/main could not be fetched after ${attempts} attempt(s)`);
  let head;
  try { head = git(['rev-parse', 'HEAD']); } catch (e) { return no(`could not read HEAD: ${String(e.message).split('\n')[0]}`); }
  if (expectHead && head !== expectHead) return no('HEAD moved since startup (the session is working in this checkout)');
  const { behind, ahead } = getBehindAheadCounts(repoDir, REMOTE_MAIN, execFn);
  if (!(behind > 0)) return no('already current');
  // Share the foreground proof and safety checks; never back up or clear
  // uncommitted edits on a diverged branch before deciding it already landed.
  if (ahead > 0) return trySyncCodeCheckout({ repoDir, behind, ahead, execFn, env, syncTimeoutMs });
  // Data files are handled by the backup below; any other dirty tracked file must be explained by origin/main or it refuses.
  const healedBg = reconcileInterruptedFastForward({ repoDir, execFn, timeoutMs: syncTimeoutMs, ignore: (p) => p.startsWith('data/') });
  const healedBgCount = (healedBg.reverted || 0) + (healedBg.removed || 0);
  if (healedBg.error) log(`could not clear an interrupted sync: ${healedBg.error}`);
  let dirty;
  try {
    // Not trimmed: porcelain lines start with a space for an unstaged change.
    dirty = String(execFn('git', ['-C', repoDir, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }))
      .split('\n').filter(Boolean).map((l) => l.replace(/^\s*\S+\s+/, ''));
  } catch (e) { return no(`could not read git state: ${String(e.message).split('\n')[0]}`); }
  const outside = dirty.filter((p) => !p.startsWith('data/'));
  if (outside.length) return no(`uncommitted changes outside data/: ${outside.slice(0, 3).join(', ')}`);
  const kept = [];
  let backup = null;
  let result = null;
  try {
    if (dirty.length) {
      backup = fs.mkdtempSync(path.join(os.tmpdir(), 'code-sync-backup-'));
      // Logged BEFORE the checkout: if this process is killed mid-merge, the bytes are recoverable from here.
      log(`session's modified data files saved to ${backup} before the fast-forward: ${dirty.join(', ')}`);
      for (const p of dirty) {
        const dest = path.join(backup, p);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(repoDir, p), dest);
        kept.push(p);
      }
      git(['checkout', '-q', '--', ...dirty]);
    }
    heartbeat();
    result = trySyncCodeCheckout({ repoDir, behind, ahead, execFn, env, syncTimeoutMs });
    if (healedBgCount) result.reconciled = (result.reconciled || 0) + healedBgCount;
    return result;
  } catch (e) {
    result = no(`catch-up failed: ${String(e.message).split('\n')[0]}`);
    return result;
  } finally {
    // Always put the session's own bytes back, whether or not the fast-forward happened. The backup directory is
    // removed only when EVERY file was written back; otherwise it stays and its path is reported.
    if (backup) {
      const restored = [];
      const failed = [];
      for (const p of kept) {
        try {
          fs.mkdirSync(path.dirname(path.join(repoDir, p)), { recursive: true }); // an incoming commit may have removed the directory
          fs.copyFileSync(path.join(backup, p), path.join(repoDir, p));
          restored.push(p);
        } catch { failed.push(p); }
      }
      if (result) {
        result.preserved = restored.length;
        if (failed.length) { result.restoreFailed = failed; result.backupDir = backup; }
        // Files the incoming commits also changed now hold the session's older bytes (restored on purpose, so the
        // cloud core-data copies survive); say so, a later "commit first" of such a file would drop upstream's rows.
        if (result.synced && result.from && result.to) {
          try {
            const up = new Set(git(['diff', '--name-only', result.from, result.to]).split('\n'));
            const revert = restored.filter((p) => up.has(p));
            if (revert.length) result.upstreamChangedKept = revert;
          } catch { /* informational only */ }
        }
      }
      if (!failed.length) { try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  }
}

/** Start the catch-up as a detached process; returns its pid, or null if it could not be started. */
function startBackgroundSync(repoDir, { spawnFn = null, expectHead = null } = {}) {
  try {
    const { spawn } = require('child_process');
    if (!expectHead) { try { expectHead = String(execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).trim(); } catch { /* no head to pin */ } }
    const child = (spawnFn || spawn)(process.execPath, [__filename, '--bg-sync', repoDir, expectHead || ''], { detached: true, stdio: 'ignore' });
    if (child.unref) child.unref();
    return child.pid || null;
  } catch { return null; }
}

/** Process entry for `--bg-sync <repoDir> [expectHead]`: one job per checkout (mkdir lock, heartbeat, stale after 90 min without a heartbeat). */
function runBackgroundSyncMain(argv) {
  const fs = require('fs');
  const logPath = bgPath('CODE_CHECKOUT_BG_LOG', '/tmp/code-checkout-bg-sync.log');
  // One job per checkout (keyed by its path), so a second repo's catch-up is not skipped by the first's lock.
  const key = require('crypto').createHash('sha1').update((() => { try { return fs.realpathSync(String(argv[0])); } catch { return String(argv[0]); } })()).digest('hex').slice(0, 8);
  const lockPath = bgPath('CODE_CHECKOUT_BG_LOCK', `/tmp/code-checkout-bg-sync-${key}.lock`);
  const log = (m) => { try { fs.appendFileSync(logPath, `${new Date().toISOString()} ${m}\n`); } catch { /* ignore */ } };
  const take = () => { fs.mkdirSync(lockPath); };
  try {
    try { take(); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - fs.statSync(lockPath).mtimeMs < 90 * 60 * 1000) { log('another catch-up is already running; exiting'); return { skipped: true }; }
      fs.rmSync(lockPath, { recursive: true, force: true });
      take();
    }
  } catch (e) { log(`could not take the lock: ${e.message}`); return { skipped: true }; }
  try {
    log(`catch-up started for ${argv[0]}`);
    // The lock's mtime is its heartbeat: a job that is still working is never taken over as "stale".
    const heartbeat = () => { try { const now = new Date(); fs.utimesSync(lockPath, now, now); } catch { /* ignore */ } };
    const r = backgroundCatchUp({ repoDir: argv[0], expectHead: argv[1] || null, log, heartbeat });
    if (r.reconciled) log(`cleared ${r.reconciled} file(s) left by an interrupted fast-forward`);
    log(r.synced
      ? `synced ${String(r.from).slice(0, 9)} -> ${String(r.to).slice(0, 9)} (${r.count} commits); ${r.preserved || 0} local data file(s) kept as they were${r.changedWatched && r.changedWatched.length ? `; changed: ${r.changedWatched.join(', ')}` : ''}`
      : `no sync: ${r.reason}`);
    if (r.upstreamChangedKept) log(`NOTE: upstream also changed ${r.upstreamChangedKept.join(', ')}; this session's older copy was kept (run git diff on it before committing)`);
    if (r.restoreFailed) log(`WARNING: could not write back ${r.restoreFailed.join(', ')}; the session's bytes are in ${r.backupDir}`);
    return r;
  } finally {
    try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

if (require.main === module && process.argv[2] === '--bg-sync') runBackgroundSyncMain(process.argv.slice(3));

/** Pure: the SessionStart line for a successful sync, else null. */
function formatCodeCheckoutSyncMessage(result, repoDir) {
  if (!result || !result.synced) return null;
  const lines = [
    (result.alreadyLanded
      ? `🔄 CODE CHECKOUT SYNCED: local commits already landed; reset --keep ${repoDir} to origin/main `
      : `🔄 CODE CHECKOUT SYNCED: fast-forwarded ${repoDir} by ${result.count} commit(s) to origin/main `)
      + `(${result.to.slice(0, 11)}), so its hooks and scripts are current.`,
  ];
  if (result.alreadyLanded) lines.push('   Branch history was reset; the next push to an existing remote branch may require --force-with-lease.');
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
  CLOUD_FETCH_TIMEOUT_MS,
  formatFetchFailedMessage,
  SYNC_TIMEOUT_MS,
  fetchOriginMain,
  UNPUSHED_BACKLOG_THRESHOLD,
  getBehindAheadCounts,
  getCurrentBranch,
  formatCodeCheckoutStaleMessage,
  runCodeCheckoutStalenessCheck,
  registeredHookScripts,
  reconcileInterruptedFastForward,
  trySyncCodeCheckout,
  formatCodeCheckoutSyncMessage,
  backgroundCatchUp,
  startBackgroundSync,
  runBackgroundSyncMain,
};
