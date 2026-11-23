'use strict';
/**
 * BRO-8124: one reaper for the throwaway checkouts makeFreshCheckout
 * (acceptance-check-core.js) creates at <tmp>/<prefix>XXXXXX/main.
 *
 * Why it exists: a killed caller leaks its checkout (1-4GB each). The only
 * reaper used to live inside gc-merged-worktrees.sh's per-worktree loop,
 * behind one global lock; on 2026-11-23 a single GC pass took 10 hours, so
 * every hourly run and the dispatcher's disk-pressure self-heal hit SKIP-RUN
 * and 19GB piled up. And it only saw checkouts `git worktree list` still
 * registered, so 109 orphan parents (repo deleted under them) were never seen.
 *
 * Now every entry point calls this module: gc-merged-worktrees.sh (before its
 * lock, and per registered worktree), bsc-runner.js's disk-pressure self-heal,
 * makeFreshCheckout itself (dead-owner siblings of the same prefix), and
 * land-branch.js right after the merged-tree floor returns (a floor it just
 * killed leaves a dead owner behind).
 *
 * A parent is reaped only when ALL hold:
 *   - its realpath sits under a temp root, its name is <known prefix>XXXXXX,
 *     and it is not a symlink;
 *   - its recorded owner pid is gone (dead, after DEAD_GRACE_MIN), or it has
 *     no owner file and nothing in it changed for LEGACY_IDLE_MIN;
 *   - no process has a file or cwd open under it (one system lsof snapshot;
 *     an lsof failure keeps everything);
 *   - registered worktree: canReapCheckout (clean, no live lease/process) and
 *     HEAD already on origin/main, then a plain `git worktree remove`;
 *     standalone clone: clean and nothing ahead of origin/main;
 *     orphan (its repo is gone) or empty: removed outright.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ownerState, canReapCheckout, checkoutInUse, OWNER_FILE } = require('./acceptance-checkout-owner.js');

// Keep in step with every makeFreshCheckout({prefix}) caller;
// scripts/tests/gc-reap-stale-tmp-checkout.test.mjs fails on a new prefix.
const TEMP_CHECKOUT_PREFIXES = [
  'acceptance-check-', 'auto-recheck-', 'card-relevance-check-', 'close-verify-',
  'close-verify-dryrun-', 'done-evidence-', 'landed-but-open-', 'linear-done-verify-',
  'merge-test-gate-baseline-', 'open-backlog-sweep-', 'zombie-verify-',
];
const DEAD_GRACE_MIN = 10;
// Longest legitimate holder: the land floor (3 spawns at <=14 min + checkout)
// is capped by land-branch.js MERGED_TREE_TIMEOUT_MS = 30 min. Legacy
// (ownerless) checkouts predate the owner file, so 60 min idle is safe.
const LEGACY_IDLE_MIN = Number(process.env.TMP_CHECKOUT_MAX_AGE_MIN) > 0 ? Number(process.env.TMP_CHECKOUT_MAX_AGE_MIN) : 60;
const TEMP_ROOT_PREFIXES = ['/private/tmp/', '/private/var/folders/', '/tmp/', '/var/folders/'];
const GIT_TIMEOUT_MS = 60000;

const NAME_RE = new RegExp(`^(?:${TEMP_CHECKOUT_PREFIXES.map((p) => p.replace(/[-]/g, '\\-')).join('|')})[A-Za-z0-9]{6}$`);

function isTempCheckoutName(name) { return NAME_RE.test(name); }

function defaultRoots() {
  if (process.env.TEMP_CHECKOUT_REAP_ROOTS) return process.env.TEMP_CHECKOUT_REAP_ROOTS.split(':').filter(Boolean);
  return [os.tmpdir(), '/tmp'];
}

/** Real, de-duplicated temp roots. */
function resolveRoots(roots) {
  const out = new Set();
  for (const r of roots) { try { out.add(fs.realpathSync(r)); } catch { /* missing root */ } }
  return [...out];
}

/** Path shape check shared by every entry point. Returns the realpath or null. */
function validateParent(parent) {
  if (!parent || parent.includes('..')) return null;
  let st;
  try { st = fs.lstatSync(parent); } catch { return null; }
  if (st.isSymbolicLink() || !st.isDirectory()) return null;
  let real;
  try { real = fs.realpathSync(parent); } catch { return null; }
  if (!TEMP_ROOT_PREFIXES.some((p) => real.startsWith(p))) return null;
  if (!isTempCheckoutName(path.basename(real))) return null;
  return real;
}

/**
 * Every path any process holds open (files, cwds), from ONE lsof snapshot
 * (~0.25s, ~3MB on the Mac Studio). null = lsof failed -> caller keeps all.
 */
function openPathSnapshot() {
  try {
    const out = execFileSync('lsof', ['-n', '-w', '-F', 'n'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, maxBuffer: 256 * 1024 * 1024,
    });
    const paths = [];
    for (const line of out.split('\n')) if (line.startsWith('n/')) paths.push(line.slice(1));
    return paths;
  } catch (error) {
    // lsof exits 1 when some processes could not be listed; keep its output.
    if (error && typeof error.stdout === 'string' && error.stdout.length > 0) {
      return error.stdout.split('\n').filter((l) => l.startsWith('n/')).map((l) => l.slice(1));
    }
    return null;
  }
}

function hasOpenPathUnder(snapshot, real) {
  if (snapshot === null) return true;
  const prefix = `${real}/`;
  return snapshot.some((p) => p === real || p.startsWith(prefix));
}

function minutesSince(ms, now) { return (now - ms) / 60000; }

/** True when some file under dir (node_modules pruned) changed in the last `min` minutes. */
function recentlyTouched(dir, min) {
  try {
    const out = execFileSync('find', [dir, '-path', path.join(dir, 'main', 'node_modules'), '-prune', '-o', '-mmin', `-${min}`, '-print'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000,
    });
    return out.trim().length > 0;
  } catch { return true; }
}

/** registered | orphan | standalone | empty | other */
function checkoutKind(wt) {
  const dotGit = path.join(wt, '.git');
  let st;
  try { st = fs.lstatSync(wt); } catch { return 'empty'; }
  if (!st.isDirectory()) return 'other';
  try { st = fs.lstatSync(dotGit); } catch { return 'orphan'; }
  if (st.isDirectory()) return 'standalone';
  try {
    const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
    if (!m) return 'orphan';
    return fs.existsSync(m[1].trim()) ? 'registered' : 'orphan';
  } catch { return 'other'; }
}

/** `git worktree lock` writes <gitdir>/locked; a locked tree is never reaped. */
function isGitLocked(wt) {
  try {
    const m = fs.readFileSync(path.join(wt, '.git'), 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
    return !!m && fs.existsSync(path.join(m[1].trim(), 'locked'));
  } catch { return true; }
}

function git(wt, args) {
  return execFileSync('git', ['-C', wt, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function duKb(dir) {
  try { return Number(execFileSync('du', ['-sk', dir], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\s/)[0]) || 0; }
  catch { return 0; }
}

/**
 * Pure-ish decision for one parent dir. Reads the filesystem and git; never deletes.
 * @returns {{reap:boolean, kind?:string, reason:string, real?:string}}
 */
function decide(parent, { now = Date.now(), snapshot, deadGraceMin = DEAD_GRACE_MIN, legacyIdleMin = LEGACY_IDLE_MIN, deadOnly = false } = {}) {
  const real = validateParent(parent);
  if (!real) return { reap: false, reason: 'not a temp checkout parent' };
  const wt = path.join(real, 'main');
  const owner = ownerState(real);
  let why;
  const ageMin = minutesSince(fs.statSync(real).mtimeMs, now);
  if (owner === 'dead') {
    if (ageMin < deadGraceMin) return { reap: false, reason: `dead owner, only ${Math.round(ageMin)}m old` };
    why = `dead owner, older than ${deadGraceMin}m`;
  } else if (owner === 'legacy' && !deadOnly) {
    if (ageMin < legacyIdleMin || recentlyTouched(real, legacyIdleMin)) return { reap: false, reason: `ownerless, touched within ${legacyIdleMin}m` };
    why = `ownerless, idle >${legacyIdleMin}m`;
  } else {
    return { reap: false, reason: `owner ${owner}` };
  }
  if (hasOpenPathUnder(snapshot === undefined ? openPathSnapshot() : snapshot, real)) return { reap: false, reason: 'a process holds a file under it (or lsof failed)' };
  const kind = checkoutKind(wt);
  if (kind === 'registered') {
    if (isGitLocked(wt)) return { reap: false, kind, reason: 'git worktree is locked' };
    if (!canReapCheckout(wt)) return { reap: false, kind, reason: 'dirty, ignored work, live lease or process' };
    try { execFileSync('git', ['-C', wt, 'merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { timeout: GIT_TIMEOUT_MS, stdio: 'ignore' }); }
    catch { return { reap: false, kind, reason: 'HEAD not on origin/main' }; }
    return { reap: true, kind, real, reason: `${why}, HEAD on origin/main` };
  }
  if (kind === 'standalone') {
    if (checkoutInUse(wt)) return { reap: false, kind, reason: 'in use' };
    try {
      if (git(wt, ['status', '--porcelain', '--untracked-files=all'])) return { reap: false, kind, reason: 'dirty standalone clone' };
      if (git(wt, ['rev-list', '--count', 'origin/main..HEAD']) !== '0') return { reap: false, kind, reason: 'standalone clone has commits not on origin/main' };
    } catch { return { reap: false, kind, reason: 'standalone clone unreadable' }; }
    return { reap: true, kind, real, reason: `${why}, standalone clone on origin/main` };
  }
  if (kind === 'orphan' || kind === 'empty') {
    if (kind === 'orphan' && checkoutInUse(wt)) return { reap: false, kind, reason: 'in use' };
    return { reap: true, kind, real, reason: `${why}, ${kind === 'orphan' ? 'its repo is gone (unregistered orphan)' : 'no checkout inside'}` };
  }
  return { reap: false, kind, reason: 'unrecognised layout' };
}

/** Remove one decided parent. Returns freed KB or null when git refused. */
function removeParent(d) {
  const wt = path.join(d.real, 'main');
  const kb = duKb(d.real);
  if (d.kind === 'registered') {
    const common = path.resolve(wt, git(wt, ['rev-parse', '--git-common-dir']));
    // Plain remove, no --force: canReapCheckout proved it clean; a write that
    // lands after that check makes git refuse, which keeps the tree.
    execFileSync('git', ['--git-dir', common, 'worktree', 'remove', wt], { timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    fs.rmSync(path.join(d.real, OWNER_FILE), { force: true });
    fs.rmdirSync(d.real);
  } else {
    fs.rmSync(d.real, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return kb;
}

/** Decide + (unless dryRun) remove one parent. */
function reapOne(parent, { dryRun = false, ...opts } = {}) {
  const d = decide(parent, opts);
  if (!d.reap) return { removed: false, ...d };
  if (dryRun) return { removed: false, wouldRemove: true, kb: duKb(d.real), ...d };
  try { return { removed: true, kb: removeParent(d), ...d }; }
  catch (error) { return { removed: false, ...d, reap: false, reason: `removal failed: ${String(error.message || error).split('\n')[0]}` }; }
}

/** Parents of known prefix directly under each root, plus registered tmp worktrees of `repos`. */
function listCandidates({ roots = defaultRoots(), repos = [], prefix = null } = {}) {
  const out = new Set();
  for (const root of resolveRoots(roots)) {
    let names;
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) if (isTempCheckoutName(n) && (!prefix || n.startsWith(prefix))) out.add(path.join(root, n));
  }
  for (const repo of repos) {
    try {
      const list = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const m of list.matchAll(/^worktree (.+)\/main$/gm)) {
        if (isTempCheckoutName(path.basename(m[1])) && (!prefix || path.basename(m[1]).startsWith(prefix))) out.add(m[1]);
      }
    } catch { /* repo unreadable: roots still scanned */ }
  }
  return [...out];
}

/**
 * Reap every eligible temp checkout. Never throws.
 * @returns {{removed:number, freedKb:number, results:object[], skipped?:string}}
 */
function reapTempCheckouts({ roots, repos, prefix = null, deadOnly = false, deadGraceMin = DEAD_GRACE_MIN, dryRun = false, now = Date.now(), log = () => {} } = {}) {
  const summary = { removed: 0, freedKb: 0, results: [] };
  if (process.env.TEMP_CHECKOUT_REAP_DISABLED === '1') return { ...summary, skipped: 'TEMP_CHECKOUT_REAP_DISABLED=1' };
  try {
    const candidates = listCandidates({ roots, repos, prefix });
    if (!candidates.length) return summary;
    const snapshot = openPathSnapshot();
    if (snapshot === null) { log('lsof failed; keeping every temp checkout this run'); return { ...summary, skipped: 'lsof failed' }; }
    for (const parent of candidates) {
      const r = reapOne(parent, { dryRun, snapshot, now, deadOnly, deadGraceMin });
      summary.results.push({ parent, ...r });
      if (r.removed) { summary.removed++; summary.freedKb += r.kb || 0; log(`REMOVE-TMP ${parent} — freed ${r.kb}KB, ${r.reason}`); }
      else if (r.wouldRemove) log(`WOULD-REMOVE-TMP ${parent} — ${r.kb}KB, ${r.reason}`);
    }
  } catch (error) {
    log(`temp checkout reap failed (non-fatal): ${error.message}`);
  }
  return summary;
}

module.exports = {
  TEMP_CHECKOUT_PREFIXES, DEAD_GRACE_MIN, LEGACY_IDLE_MIN,
  isTempCheckoutName, validateParent, openPathSnapshot, hasOpenPathUnder, checkoutKind,
  decide, reapOne, listCandidates, reapTempCheckouts,
};

// CLI:
//   --one <wt>      one checkout (gc-merged-worktrees.sh delegate). Prints
//                   "REAPED <kb> <reason>" / "WOULD <kb> <reason>", exit 0; else exit 1.
//   --all [--repo R]... [--dry-run]   every eligible checkout; prints log lines.
if (require.main === module) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const oneIdx = argv.indexOf('--one');
  if (oneIdx !== -1) {
    const wt = argv[oneIdx + 1];
    if (!wt || path.basename(wt) !== 'main') process.exit(1);
    const r = reapOne(path.dirname(wt), { dryRun });
    if (r.removed) { console.log(`REAPED ${r.kb} ${r.reason}`); process.exit(0); }
    if (r.wouldRemove) { console.log(`WOULD ${r.kb} ${r.reason}`); process.exit(0); }
    process.exit(1);
  }
  if (argv.includes('--all')) {
    const repos = [];
    argv.forEach((a, i) => { if (a === '--repo' && argv[i + 1]) repos.push(argv[i + 1]); });
    const s = reapTempCheckouts({ repos, dryRun, log: (l) => console.log(l) });
    console.log(`TEMP-CHECKOUT-REAP removed=${s.removed} freed=${s.freedKb}KB${s.skipped ? ` skipped=${s.skipped}` : ''}${dryRun ? ' (dry_run)' : ''}`);
    process.exit(0);
  }
  console.error('usage: reap-temp-checkouts.js --one <tmp>/<prefix>XXXXXX/main [--dry-run] | --all [--repo R]... [--dry-run]');
  process.exit(2);
}
