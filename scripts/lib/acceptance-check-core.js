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

/**
 * ONE disposable worktree per run: every card verifies against the same
 * origin/main, so N checkouts would be N copies of one tree.
 * @param {{repo?:string, prefix?:string}} o
 * @returns {{dir:string, wt:string, repo:string}}
 */
function makeFreshCheckout({ repo = DEFAULT_REPO, prefix = 'acceptance-check-' } = {}) {
  // Depth-bound the fetch when repo is a SHALLOW clone (task #420/#466). This
  // is reachable from shallow-checkout workflows; there an unbounded fetch
  // makes upload-pack send the whole ~2.1 GB / 165k-commit repo instead of the
  // delta. Anchor the window on the local boundary commit so
  // `worktree add origin/main` below still resolves. A complete clone (the
  // owner's Mac, the usual case) gets no extra flags — bounding it would
  // truncate a full clone into a shallow one.
  let isShallow = false;
  try {
    isShallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: repo, encoding: 'utf8' }).trim() === 'true';
  } catch { /* fail open — treat as complete */ }
  let oldestCommitEpoch = 0;
  if (isShallow) {
    try {
      const sha = execFileSync('git', ['rev-list', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').pop();
      oldestCommitEpoch = Number(execFileSync('git', ['log', '-1', '--format=%ct', sha], { cwd: repo, encoding: 'utf8' }).trim());
    } catch { /* helper falls back to a bounded --deepen */ }
  }
  const depthArgs = shallowFetchArgs({ isShallow, oldestCommitEpoch });
  // unbounded-fetch-ok: depthArgs IS the bound; the lint can't evaluate a spread.
  execFileSync('git', ['fetch', ...depthArgs, 'origin', 'main'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const wt = path.join(dir, 'main');
  execFileSync('git', ['worktree', 'add', '--detach', wt, 'origin/main'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  prepareCheckWorkdir(wt, repo);
  return { dir, wt, repo };
}

/** Best effort: a leftover worktree is picked up by `git worktree prune`. */
function removeCheckout(co) {
  if (!co) return;
  const repo = co.repo || DEFAULT_REPO;
  try { execFileSync('git', ['worktree', 'remove', '--force', co.wt], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }); }
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
function runVerify(cwd, cmd, { attempts = 2, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const argv = cardCheckArgv(cmd, isSafeCheckCommand);
  if (!argv) return { status: 'unverifiable', detail: `command failed safe-form re-validation at run time: ${String(cmd).slice(0, 120)}` };
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
      if (err.signal && err.status == null) {
        return { status: 'unverifiable', detail: `check killed by ${err.signal} after ${timeoutMs}ms (timeout — no verdict)` };
      }
      last = String(err.stderr || err.stdout || err.message).slice(0, 400);
    }
  }
  return { status: 'fail', detail: last };
}

module.exports = { makeFreshCheckout, removeCheckout, runVerify, DEFAULT_REPO, CHECK_TIMEOUT_MS };
