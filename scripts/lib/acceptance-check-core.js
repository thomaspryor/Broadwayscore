/**
 * acceptance-check-core.js — run a card's OWN acceptance-criteria command
 * against a fresh, detached checkout of origin/main.
 *
 * Extracted from scripts/autonomous-acceptance-recheck.js (task #1003) because
 * a second caller now needs the identical behaviour at a different moment:
 *
 *   - autonomous-acceptance-recheck.js — nightly, shadow, many cards, one
 *     shared checkout.
 *   - notion-brain.js `update --status Done` — synchronous, one card, at the
 *     instant the card would close.
 *
 * Two copies of "check out origin/main and run the card's command" would drift
 * the moment one of them learned something (the exit-3 convention, the
 * retry-once rule, the shallow-clone fetch bound) — CLAUDE.md §15: one
 * implementation, require()d by both, and by the tests.
 *
 * Safety properties carried over verbatim from the recheck:
 *   - The command is UNTRUSTED text off a Notion card. It is re-validated
 *     against isSafeCheckCommand at RUN time, not just at capture time.
 *   - It runs with the secret-free, fake-HOME env the check gauntlet uses.
 *   - The worktree is disposable and DETACHED: it creates no branch and cannot
 *     disturb the calling checkout's state.
 *   - One retry before believing a failure — a transient flake must never
 *     manufacture "your finished work is broken".
 *   - Exit 3 is the repo's "cannot verify" convention and is reported as
 *     unverifiable, never as a failure.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { shallowFetchArgs } = require('./shallow-fetch-args.js');
const { isSafeCheckCommand } = require('./autonomous-triage-core.js');
const { checksEnv, cardCheckArgv, prepareCheckWorkdir, CHECK_TIMEOUT_MS } = require('./autonomous-checks.js');

const DEFAULT_REPO = path.join(__dirname, '..', '..');
// Per-git-call ceiling. Generous enough for a cold fetch on a large repo,
// short enough that a synchronous caller can promise a bound.
const GIT_TIMEOUT_MS = 120000;

// Where node_modules and the gitignored core data actually live. A caller
// running from a git WORKTREE (every code session in this repo does — CLAUDE.md
// makes worktrees mandatory) has no node_modules of its own: node resolves them
// by walking up to the canonical checkout, which a fresh /tmp worktree cannot
// do. Linking from the worktree root would hand every close an unprepared
// checkout (measured: prepared=false on the first real run), so resolve the
// canonical checkout via git's common dir and link from there.
function resolveInstallRoot(repo) {
  if (fs.existsSync(path.join(repo, 'node_modules'))) return repo;
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: repo, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim();
    const mainRoot = path.dirname(common);
    if (mainRoot && fs.existsSync(path.join(mainRoot, 'node_modules'))) return mainRoot;
  } catch { /* not a worktree, or old git — fall through */ }
  return repo;
}

/**
 * ONE disposable worktree per run: every card verifies against the same
 * origin/main, so N checkouts would be N copies of one tree.
 * @param {{repo?:string, prefix?:string, sha?:string|null}} o - `sha` pins the
 *   checkout to a caller-supplied commit instead of "origin/main at fetch
 *   time" (card #1433's merge-post-merge-test-gate.js needs the EXACT origin
 *   tip a specific merge pulled in, not whatever origin/main has drifted to
 *   by the time the gate runs — a later concurrent push landing a NEW,
 *   unfixed regression between those two moments must not read as
 *   "pre-existing").
 * @returns {{dir:string, wt:string, repo:string}}
 */
function makeFreshCheckout({ repo = DEFAULT_REPO, prefix = 'acceptance-check-', sha: pinnedSha = null } = {}) {
  // Depth-bound the fetch when repo is a SHALLOW clone (task #420/#466). This
  // is reachable from shallow-checkout workflows; there an unbounded fetch
  // makes upload-pack send the whole ~2.1 GB / 165k-commit repo instead of the
  // delta. Anchor the window on the local boundary commit so
  // `worktree add origin/main` below still resolves. A complete clone (the
  // owner's Mac, the usual case) gets no extra flags — bounding it would
  // truncate a full clone into a shallow one.
  let isShallow = false;
  try {
    isShallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: repo, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim() === 'true';
  } catch { /* fail open — treat as complete */ }
  let oldestCommitEpoch = 0;
  if (isShallow) {
    try {
      const sha = execFileSync('git', ['rev-list', 'HEAD'], { cwd: repo, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim().split('\n').pop();
      oldestCommitEpoch = Number(execFileSync('git', ['log', '-1', '--format=%ct', sha], { cwd: repo, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim());
    } catch { /* helper falls back to a bounded --deepen */ }
  }
  const depthArgs = shallowFetchArgs({ isShallow, oldestCommitEpoch });
  // Every git call here is TIME-BOXED. A synchronous caller (notion-brain's
  // close-time check) is holding a person or a sync sweep hostage while this
  // runs, and an unbounded `fetch`/`worktree add` can wait forever on a
  // contended lock or a stalled remote — a hang is worse than a failure,
  // because a failure fails OPEN and a hang does not (Codex ship-check P0).
  // unbounded-fetch-ok: depthArgs IS the bound; the lint can't evaluate a spread.
  execFileSync('git', ['fetch', ...depthArgs, 'origin', 'main'], { cwd: repo, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  // Pin to the SHA we just fetched, not the moving ref: between this fetch and
  // the worktree add, a parallel session's push can advance origin/main, and
  // the card would then be judged against a commit that landed after it
  // (Codex ship-check P1). The pinned sha is returned so callers can report it.
  // A caller-supplied `pinnedSha` skips the rev-parse entirely and checks out
  // that exact commit instead — the fetch above still runs first so the sha
  // is guaranteed reachable even if it only just landed on origin.
  const sha = pinnedSha || execFileSync('git', ['rev-parse', 'origin/main'], { cwd: repo, timeout: GIT_TIMEOUT_MS, encoding: 'utf8' }).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const wt = path.join(dir, 'main');
  try {
    execFileSync('git', ['worktree', 'add', '--detach', wt, sha], { cwd: repo, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    prepareCheckWorkdir(wt, resolveInstallRoot(repo));
  } catch (err) {
    // Clean up our OWN tempdir before rethrowing. The caller's `finally` can
    // only remove a checkout it was handed, and it was never handed this one —
    // so without this, every failed `worktree add` (a lock contended by another
    // session, a full disk) leaks a directory. Once per night was tolerable;
    // once per card close is not (ship-check finding).
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }
  // prepareCheckWorkdir is best-effort by design (it swallows link failures),
  // so a checkout can come back without node_modules. Running `node --test` or
  // `npx tsc` there fails on the ENVIRONMENT, exit 1, indistinguishable from a
  // real assertion failure — which at close time refuses an innocent card
  // (Codex ship-check P1). Report the state instead of hiding it; runVerify
  // downgrades to unverifiable.
  // node_modules only. prepareCheckWorkdir also copies core data and swallows
  // ITS failures, so a checkout can be prepared:true and still be missing a
  // data file a command needs — that residual case still reads as FAIL
  // (Codex, second pass). node_modules is the one that breaks EVERY command.
  const prepared = fs.existsSync(path.join(wt, 'node_modules'));
  return { dir, wt, repo, sha, prepared };
}

/** Best effort: a leftover worktree is picked up by `git worktree prune`. */
function removeCheckout(co) {
  if (!co) return;
  const repo = co.repo || DEFAULT_REPO;
  try { execFileSync('git', ['worktree', 'remove', '--force', co.wt], { cwd: repo, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { /* leave for git worktree prune */ }
  try { fs.rmSync(co.dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Run one card's acceptance command in `cwd`.
 * @param {string} cwd - the fresh checkout (or any directory, for tests)
 * @param {string} cmd - the card's safe-form command, UNTRUSTED
 * @param {{attempts?:number, timeoutMs?:number}} o
 * @returns {{status:'pass'|'fail'|'unverifiable', detail:string|null}}
 */
function runVerify(cwd, cmd, { attempts = 2, timeoutMs = CHECK_TIMEOUT_MS, prepared = true } = {}) {
  const argv = cardCheckArgv(cmd, isSafeCheckCommand);
  if (!argv) return { status: 'unverifiable', detail: `command failed safe-form re-validation at run time: ${String(cmd).slice(0, 120)}` };
  if (!prepared) {
    return { status: 'unverifiable', detail: 'checkout has no node_modules — any result would measure the environment, not the card' };
  }
  const env = checksEnv();
  const maxAttempts = Math.max(1, attempts);
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      execFileSync(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, encoding: 'utf8', env });
      return { status: 'pass', detail: attempt > 1 ? 'passed on retry (first run flaked)' : null };
    } catch (err) {
      // Exit 3 is the repo convention for "cannot verify" (infrastructure
      // missing/stale — e.g. check-health-row-absent.js with a stale
      // snapshot). Reporting it as FAIL would claim finished work broke when
      // the evidence merely wasn't available (Codex finding, 2026-08-02).
      if (err.status === 3) {
        return { status: 'unverifiable', detail: `check exited 3 (cannot verify — evidence unavailable): ${String(err.stderr || err.stdout || '').slice(0, 200)}` };
      }
      // A timeout kill (SIGTERM, no exit status) is infrastructure, not a
      // verdict: at close time it would refuse a card because the machine was
      // busy. Report it as unverifiable so every caller fails OPEN.
      // (Behaviour change vs the recheck's pre-extraction copy, which counted a
      // timeout as a FAIL and fed it to shouldExitShadow. A timeout is the
      // absence of an answer, not a failing answer, in both callers.)
      if (err.signal && err.status == null) {
        return { status: 'unverifiable', detail: `check killed by ${err.signal} after ${timeoutMs}ms (timeout — no verdict)` };
      }
      // The command never STARTED (binary missing, bad interpreter, permission
      // denied). Node reports these as spawn errors with no exit status. That
      // is not evidence the work is broken, and a close-time caller that read
      // it as FAIL would refuse a card over a typo in its own verify string
      // (ship-check finding — it violated this module's fail-open contract).
      if (err.status == null && err.code) {
        return { status: 'unverifiable', detail: `command could not be started (${err.code}): ${argv[0]}` };
      }
      last = String(err.stderr || err.stdout || err.message).slice(0, 400);
    }
  }
  return { status: 'fail', detail: last };
}

module.exports = { makeFreshCheckout, removeCheckout, runVerify, DEFAULT_REPO, CHECK_TIMEOUT_MS };
