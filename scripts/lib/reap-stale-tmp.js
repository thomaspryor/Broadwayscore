'use strict';
/**
 * BRO-8179: reap stale top-level entries of /private/tmp.
 *
 * Why it exists: on 2026-11-23 /private/tmp held 384,253 top-level entries
 * (~40GB), growing ~200k items / ~20GB a day: mkdtemp dirs from `node --test`
 * suites (orj-*, merge-test-gate-*, manifest-paths-*, ...) and ad-hoc session
 * clones (/tmp/bro*, /tmp/bromain). macOS only clears /tmp at reboot and this
 * Mac rarely reboots, so disk exhaustion stalled dispatch repeatedly.
 * reap-temp-checkouts.js only knew makeFreshCheckout's named prefixes.
 *
 * An entry is removed only when ALL hold:
 *   - it sits directly under the root and is owned by this uid;
 *   - it is a plain file or a real directory (sockets, fifos, devices and
 *     symlinks are never touched);
 *   - its name is not a dotfile, not claude-* and not on KEEP_NAME_RE
 *     (system/launchd/tmux/ssh-agent style names), and not one of
 *     reap-temp-checkouts.js's own prefixes (that reaper owns those);
 *   - neither it nor anything under it (node_modules / .git/objects pruned)
 *     changed within maxAgeH (default 24h);
 *   - no process holds a file or cwd under it, per one lsof snapshot taken
 *     before the scan and a fresh one taken just before the deletes (an
 *     lsof failure keeps everything).
 *
 * Age tiers (the "maxAgeH" above is per entry; BRO-8179 review):
 *   - SHORT (3h): mkdtemp/mktemp-shaped names (prefix + 6 random chars with a
 *     digit or capital) that are not git checkouts. These are test fixtures;
 *     ~140k/day arrive, so a 24h-only reaper leaves /tmp at ~140k entries.
 *   - DEFAULT (24h): everything else, including clean git clones.
 *   - LONG (7d): per-session hook state (names carrying a session UUID or a
 *     known hook-state prefix), real lock files/dirs (*.lock, *-lock), and git
 *     clones with uncommitted or unpushed work (or whose status cannot be
 *     read). Losing these early breaks a long-idle tab or loses work.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { openPathSnapshot, TEMP_CHECKOUT_PREFIXES } = require('./reap-temp-checkouts.js');

const DEFAULT_ROOT = '/private/tmp';
const MAX_AGE_H = Number(process.env.TMP_REAP_MAX_AGE_H) > 0 ? Number(process.env.TMP_REAP_MAX_AGE_H) : 24;
const SHORT_AGE_H = 3;
const LONG_AGE_H = 7 * 24;
// Hook/session state the ~/.claude hooks key per session and read back later,
// plus other long-lived state that only lands here when TMPDIR is unset.
const HOOK_STATE_RE = /^(?:linear-issue-(?:claimed|reported)-|finish-line-|verify-edits-satisfied-|notion-card-|notion-create-failed|ctx-nudge-|pn-refresh-|owner-steps-|scoring-delta-baseline-|scoring-delta-stamps|bsc-compact-state|bsc-pending-waits|push-retry-|core-data-snapshot)|-launchd\.log$|-browser-profile$/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LOCK_RE = /(?:[.\-_]lock|\.lck)$/i;
// prefix + 6-char mkdtemp/mktemp suffix that has a digit or capital (an
// all-lowercase 6-letter word like "-review" is a hand-made name, not random).
const MKDTEMP_RE = /[-_.]([A-Za-z0-9]{6})$/;
// Names nothing in this repo creates but the OS, launchd agents or tools rely on.
const KEEP_NAME_RE = /^(?:\.|claude|com\.apple|launch|tmux-|ssh-|powerlog|KSOutOfProcessFetcher|MozillaUpdateLock|boost_interprocess)/i;
// Bounded walk. Hitting the cap means "unknown": the entry is kept unless it
// is itself a git checkout with no local work (tracked content is on a remote).
const WALK_LIMIT = 50000;
const PRUNE_DIRS = new Set(['node_modules', 'objects']);
// No index refresh write (would reset the idle clock); drop inherited repo
// pointers so `git -C` always inspects the checkout it is given.
const GIT_ENV = (() => {
  const e = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) delete e[k];
  return e;
})();

function hasGit(p) {
  try { fs.lstatSync(path.join(p, '.git')); return true; } catch { return false; }
}

/** Git checkouts at p or up to two levels below it (the mktemp -d + clone into $d/repo layout). */
function findGitRepos(p) {
  // Nested repos are searched even under a top-level repo: an ignored nested
  // clone (data/review-texts) is invisible to the outer repo's status.
  const out = hasGit(p) ? [p] : [];
  const visit = (d, depth) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || PRUNE_DIRS.has(e.name) || e.name === '.git') continue;
      const c = path.join(d, e.name);
      if (hasGit(c)) out.push(c); else if (depth < 2) visit(c, depth + 1);
    }
  };
  visit(p, 1);
  return out;
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024, env: GIT_ENV });
}

/**
 * Local work in one checkout. Returns null (none), or {files:[abs paths],
 * unique:bool, unknown:bool}. Commits on no remote (unpushed branch, branch
 * with no upstream, detached HEAD, repo with no remote) and stashes count.
 */
function gitLocalWork(repo) {
  try {
    // -z: raw paths (no quoting/octal escapes); -uall: every untracked file,
    // so an edit inside an untracked dir is seen. Rename entries carry the
    // source path as an extra NUL field, which lstat just skips if gone.
    const status = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const files = status.split('\0').filter(Boolean).map((f) => path.join(repo, /^.. /.test(f) ? f.slice(3) : f));
    let unique = false;
    let hasHead = true;
    try { git(repo, ['rev-parse', '-q', '--verify', 'HEAD']); } catch { hasHead = false; }
    // A linked worktree (.git is a file) shares the main repo's branches; only
    // its own HEAD matters, else every worktree of a repo with any unpushed
    // branch would count as local work.
    let linked = false;
    try { linked = fs.lstatSync(path.join(repo, '.git')).isFile(); } catch { /* none */ }
    const refs = linked ? ['HEAD'] : ['HEAD', '--branches', '--tags'];
    if (hasHead) unique = git(repo, ['rev-list', '-1', ...refs, '--not', '--remotes']).trim() !== '';
    try { git(repo, ['rev-parse', '-q', '--verify', 'refs/stash']); unique = true; } catch { /* no stash */ }
    return files.length || unique ? { files, unique, unknown: false } : null;
  } catch { return { files: [], unique: false, unknown: true }; }
}

/** A linked worktree someone ran `git worktree lock` on (gitdir/locked exists). */
function isLockedWorktree(repo) {
  try {
    const dotgit = path.join(repo, '.git');
    if (!fs.lstatSync(dotgit).isFile()) return false;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, 'utf8'));
    if (!m) return false;
    const gitdir = path.resolve(repo, m[1].trim());
    return fs.existsSync(path.join(gitdir, 'locked'));
  } catch { return false; }
}

/**
 * True when the checkout has a remote on a network host (https/ssh/git URL
 * or scp-style user@host:path). A test sandbox clones from a bare repo in the
 * same temp dir (a filesystem path) or has no remote; real session clones
 * point at GitHub. Unreadable config counts as no network remote.
 */
function hasNetworkRemote(repo) {
  let out = '';
  try { out = git(repo, ['config', '--get-regexp', '^remote\\..*\\.url$']); } catch { return false; }
  return out.split('\n').some((l) => /\s(?:(?:https?|ssh|git):\/\/|[\w.-]+@[\w.-]+:)/.test(l));
}

/** Back-compat boolean: any local work (or unreadable). */
function gitHasLocalWork(p) { return gitLocalWork(p) !== null; }

/** Newest mtime among a checkout's local-work evidence (dirty paths + git markers). */
function newestLocalWorkMs(repo, work) {
  let newest = 0;
  const paths = [...work.files, ...['.git/index', '.git/HEAD', '.git/logs/HEAD', '.git/refs/stash', '.git/logs/refs/stash'].map((m) => path.join(repo, m))];
  for (const f of paths) { try { newest = Math.max(newest, fs.lstatSync(f).mtimeMs); } catch { /* absent */ } }
  return newest;
}

/** Age tier for one entry name. SHORT never applies to anything holding a git checkout. */
function ageTierH(name, isDir, p, maxAgeH = MAX_AGE_H) {
  if (HOOK_STATE_RE.test(name) || UUID_RE.test(name) || LOCK_RE.test(name)) return Math.max(LONG_AGE_H, maxAgeH);
  const m = MKDTEMP_RE.exec(name);
  if (m && /[0-9A-Z]/.test(m[1]) && !(isDir && findGitRepos(p).length)) return Math.min(SHORT_AGE_H, maxAgeH);
  return maxAgeH;
}

function isProtectedName(name) {
  if (KEEP_NAME_RE.test(name)) return true;
  return TEMP_CHECKOUT_PREFIXES.some((p) => name.startsWith(p));
}

/** Top-level names under root that some process holds open. null = lsof failed. */
function openTopNames(snapshot, root) {
  if (snapshot === null) return null;
  const prefix = `${root}/`;
  const names = new Set();
  for (const p of snapshot) {
    if (!p.startsWith(prefix)) continue;
    names.add(p.slice(prefix.length).split('/')[0]);
  }
  return names;
}

/**
 * 'recent' when anything under dir changed after cutoffMs (early exit),
 * 'limit' when the walk hit `limit` entries first (unknown), else 'idle'.
 * Unreadable subtrees count as recent (keep).
 */
function walkAge(dir, cutoffMs, limit = WALK_LIMIT, acc = null) {
  for (const marker of ['.git/index', '.git/HEAD', '.git/logs/HEAD']) {
    try { if (fs.lstatSync(path.join(dir, marker)).mtimeMs > cutoffMs) return 'recent'; } catch { /* absent */ }
  }
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') continue; return 'recent'; }
    for (const ent of ents) {
      if (++seen > limit) return 'limit';
      const p = path.join(d, ent.name);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.mtimeMs > cutoffMs) return 'recent';
      if (acc) acc.bytes += (st.blocks || 0) * 512;
      if (ent.isDirectory() && !PRUNE_DIRS.has(ent.name)) stack.push(p);
    }
  }
  return 'idle';
}

/** True when anything under dir changed after cutoffMs, or the walk could not finish. */
function touchedSince(dir, cutoffMs, limit = WALK_LIMIT, acc = null) {
  return walkAge(dir, cutoffMs, limit, acc) !== 'idle';
}

/** Pure-ish decision for one top-level entry. Never deletes. */
function decideEntry(root, name, { now = Date.now(), maxAgeH = MAX_AGE_H, openNames, uid = process.getuid() } = {}) {
  if (!name || name.includes('/') || name === '.' || name === '..') return { reap: false, reason: 'bad name' };
  if (isProtectedName(name)) return { reap: false, reason: 'protected name' };
  const p = path.join(root, name);
  let st;
  try { st = fs.lstatSync(p); } catch { return { reap: false, reason: 'gone' }; }
  if (st.uid !== uid) return { reap: false, reason: 'not ours' };
  if (st.isSymbolicLink()) return { reap: false, reason: 'symlink' };
  const isDir = st.isDirectory();
  if (!isDir && !st.isFile()) return { reap: false, reason: 'socket/fifo/device' };
  const ageH = ageTierH(name, isDir, p, maxAgeH);
  const cutoff = now - ageH * 3600 * 1000;
  if (st.mtimeMs > cutoff) return { reap: false, reason: `younger than ${ageH}h` };
  if (!openNames || openNames.has(name)) return { reap: false, reason: 'open handle under it (or lsof failed)' };
  // acc: on-disk bytes seen by the walk (pruned node_modules/.git objects not
  // counted) = a cheap lower bound on freed space.
  const acc = { bytes: (st.blocks || 0) * 512 };
  if (!isDir) return { reap: true, path: p, isDir, cutoff, bytes: acc.bytes, reason: `idle >${ageH}h, nothing open` };
  const walk = walkAge(p, cutoff, WALK_LIMIT, acc);
  if (walk === 'recent') return { reap: false, reason: `something inside changed within ${ageH}h` };
  const repos = findGitRepos(p);
  if (walk === 'limit' && !(repos.length === 1 && repos[0] === p)) return { reap: false, reason: 'too big to judge (walk limit), not a clean checkout' };
  const longCutoff = now - LONG_AGE_H * 3600 * 1000;
  // mkdtemp-named entry = made by a program; its checkouts with no network
  // remote are test sandboxes (brh-checkpoint-*, scratch repos), so their
  // "unpushed" commits get no 7d grace. Measured 2026-11-23: these were
  // ~16.7k of the entries the 7d rule kept.
  const mkdtempNamed = (() => { const m = MKDTEMP_RE.exec(name); return !!(m && /[0-9A-Z]/.test(m[1])); })();
  for (const repo of repos) {
    if (isLockedWorktree(repo)) return { reap: false, reason: 'locked git worktree' };
    if (mkdtempNamed && !hasNetworkRemote(repo)) continue;
    const work = gitLocalWork(repo);
    if (!work) continue;
    // Unreadable status (fake .git fixture, orphaned worktree, timeout) gets
    // the same 7d grace as real local work, not forever.
    if (st.mtimeMs > longCutoff || newestLocalWorkMs(repo, work) > longCutoff) return { reap: false, reason: 'git checkout with local work, younger than 7d' };
  }
  return { reap: true, path: p, isDir, cutoff, bytes: acc.bytes, reason: `idle >${ageH}h, nothing open` };
}

function duKb(p) {
  try { return Number(execFileSync('du', ['-sk', p], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\s/)[0]) || 0; }
  catch { return 0; }
}

/**
 * Reap every eligible entry. Never throws.
 * @returns {{scanned:number, removed:number, freedKb:number, kept:object, skipped?:string}}
 */
function reapStaleTmp({ root = process.env.TMP_REAP_ROOT || DEFAULT_ROOT, maxAgeH = MAX_AGE_H, dryRun = false, now = Date.now(),
  budgetMs = Infinity, snapshotFn = openPathSnapshot, measure = true, batchSize = 500, log = () => {}, removedLog } = {}) {
  const summary = { scanned: 0, removed: 0, freedKb: 0, kept: {} };
  if (process.env.TMP_REAP_DISABLED === '1') return { ...summary, skipped: 'TMP_REAP_DISABLED=1' };
  const started = Date.now();
  let lockDir = null;
  let removedFd = null;
  try {
    const real = fs.realpathSync(root);
    // One reaper at a time (hourly runs can overlap a slow pass). Dot-named,
    // so this reaper never reaps it; a dead holder's lock is taken over.
    lockDir = path.join(real, '.bro-reap-stale-tmp.lock');
    try { fs.mkdirSync(lockDir); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = 0;
      try { holder = Number(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8')); } catch { /* none */ }
      let alive = false;
      try { if (holder > 0) { process.kill(holder, 0); alive = true; } } catch (k) { alive = k.code === 'EPERM'; }
      if (alive) { lockDir = null; return { ...summary, skipped: `another reaper running (pid ${holder})` }; }
    }
    fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid));
    // What was deleted, by name, so a bad pass can be traced (real root only
    // by default; tests pass their own path or nothing).
    const logPath = removedLog !== undefined ? removedLog
      : (real === fs.realpathSync(DEFAULT_ROOT) && !dryRun ? (process.env.TMP_REAP_LOG || path.join(os.homedir(), 'Library', 'Logs', 'bro-reap-stale-tmp.log')) : null);
    if (logPath) {
      try {
        try { if (fs.statSync(logPath).size > 50 * 1024 * 1024) fs.renameSync(logPath, `${logPath}.1`); } catch { /* new */ }
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        removedFd = fs.openSync(logPath, 'a');
      } catch (e) { log(`removed-log unavailable (${e.message}); continuing`); }
    }
    let names = fs.readdirSync(real);
    const openNames = openTopNames(snapshotFn({ excludePid: process.pid }), real);
    if (openNames === null) { log('lsof failed; keeping everything this run'); return { ...summary, skipped: 'lsof failed' }; }
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      // Fresh lsof right before deleting: the scan may be minutes old.
      const fresh = openTopNames(snapshotFn({ excludePid: process.pid }), real);
      for (const d of batch) {
        if (fresh === null || fresh.has(path.basename(d.path))) { summary.kept['opened since scan'] = (summary.kept['opened since scan'] || 0) + 1; continue; }
        // Touched (not held open) since the scan: keep.
        let now2; try { now2 = fs.lstatSync(d.path).mtimeMs; } catch { continue; }
        if (now2 > d.cutoff) { summary.kept['touched since scan'] = (summary.kept['touched since scan'] || 0) + 1; continue; }
        const kb = measure && d.isDir ? duKb(d.path) : Math.ceil(d.bytes / 1024);
        if (dryRun) { summary.removed++; summary.freedKb += kb; continue; }
        try {
          fs.rmSync(d.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
          summary.removed++; summary.freedKb += kb;
          if (removedFd !== null) { try { fs.writeSync(removedFd, `${new Date().toISOString()} ${d.reason} ${d.path}\n`); } catch { /* best effort */ } }
        } catch (e) { summary.kept['removal failed'] = (summary.kept['removal failed'] || 0) + 1; log(`rm failed ${d.path}: ${e.message}`); }
      }
      batch = [];
    };
    for (const name of names) {
      if (Date.now() - started > budgetMs) { summary.skipped = `budget ${budgetMs}ms spent`; break; }
      summary.scanned++;
      const d = decideEntry(real, name, { now, maxAgeH, openNames });
      if (!d.reap) { summary.kept[d.reason] = (summary.kept[d.reason] || 0) + 1; continue; }
      batch.push(d);
      if (batch.length >= batchSize) flush();
    }
    flush();
    names = null;
  } catch (e) {
    log(`stale tmp reap failed (non-fatal): ${e.message}`);
    summary.skipped = `error: ${e.message}`;
  } finally {
    if (removedFd !== null) { try { fs.closeSync(removedFd); } catch { /* closed */ } }
    if (lockDir) { try { fs.rmSync(lockDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* gone */ } }
  }
  return summary;
}

function formatSummary(s, dryRun) {
  const gb = (s.freedKb / 1024 / 1024).toFixed(2); // --no-measure: walk lower bound
  const kept = Object.entries(s.kept).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}=${v}`).join('; ');
  return `STALE-TMP-REAP scanned=${s.scanned} ${dryRun ? 'would_remove' : 'removed'}=${s.removed} freed=${gb}GB (${Math.round(s.freedKb / 1024)}MB)${s.skipped ? ` skipped=${s.skipped}` : ''} kept: ${kept || 'none'}`;
}

module.exports = { hasNetworkRemote, DEFAULT_ROOT, MAX_AGE_H, SHORT_AGE_H, LONG_AGE_H, ageTierH, gitHasLocalWork, gitLocalWork, findGitRepos, walkAge, isProtectedName, openTopNames, touchedSince, decideEntry, reapStaleTmp, formatSummary };

// CLI: node scripts/lib/reap-stale-tmp.js [--dry-run] [--root DIR] [--max-age-h N] [--budget-min N] [--no-measure]
if (require.main === module) {
  const argv = process.argv.slice(2);
  const val = (f) => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1]; };
  const dryRun = argv.includes('--dry-run');
  const opts = { dryRun, measure: !argv.includes('--no-measure'), log: (l) => console.log(l) };
  if (val('--root')) opts.root = val('--root');
  if (Number(val('--max-age-h')) > 0) opts.maxAgeH = Number(val('--max-age-h'));
  if (Number(val('--budget-min')) > 0) opts.budgetMs = Number(val('--budget-min')) * 60000;
  console.log(formatSummary(reapStaleTmp(opts), dryRun));
}
