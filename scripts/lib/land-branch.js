/**
 * land-branch.js — the ONE landing actor: branch → origin/main (BRO-3873, step 2).
 *
 * Extracted from scripts/autonomous-merge.js's approve loop with every
 * Notion/card/email coupling removed. autonomous-merge.js keeps its card
 * wrapper (evidence, oscillation guard, staleness refusal, trailer stamping,
 * card transitions) and calls landBranch() for the git half, so there is
 * still exactly one merge actor; scripts/land.js is the thin hand-landing CLI
 * over the same function.
 *
 * CONTRACT
 *   - Works in an ISOLATED, throwaway `git worktree` (detached HEAD) created
 *     off `repoDir`, never in the shared checkout itself. Nothing here ever
 *     moves the shared checkout's HEAD, touches its index, or runs a
 *     `checkout`/`reset` there (memory: feedback_parallel_worktree_race.md —
 *     ~20 sessions share /Users/tompryor/Broadwayscore).
 *   - rebase the branch tip onto a fresh origin/main → run the check gauntlet
 *     → fast-forward push HEAD:main via push-with-retry.sh. NEVER rewrites
 *     history: if origin/main moved during the checks (or the push is
 *     rejected non-fast-forward) the loop re-fetches, re-rebases and RE-CHECKS,
 *     bounded by maxAttempts (default 3), then refuses.
 *   - red check → returns { landed: false, failedCheck } WITHOUT pushing; the
 *     branch ref is never modified on any path (the worktree is detached).
 *   - idempotent: a branch tip that is already an ancestor of origin/main
 *     returns landed:true without pushing; a branch whose commits rebase to
 *     nothing (patches already upstream) likewise.
 *
 * SEAMS (all injectable, so scripts/lib/land-branch.test.mjs drives the real
 * git plumbing against throwaway repos while faking the expensive parts):
 *   checks({ cwd, changedFiles, baseSha, repoDir, log }) → [{name, pass, detail}]
 *   pushMain({ cwd, sha, log })                           → throws on failure
 *   beforePush({ cwd, baseSha, git })                     → optional; may amend
 *                                                            HEAD's MESSAGE
 *                                                            (autonomous-merge
 *                                                            stamps trailers)
 *
 * The default gauntlet is scripts/lib/autonomous-checks.js's runSafeChecks
 * (colocated *.test.mjs per changed file + tsc when .ts/.tsx changed — the
 * same runner the nightly loop and the approve tap use, parity by identity)
 * plus a `node --check` syntax floor for changed scripts/**.js and
 * scripts/audit-workflow-concurrency.js as the cheap lint-workflows proxy
 * (~50ms). The default push is scripts/lib/push-with-retry.sh with ONE
 * attempt and the Git Data API fallback disabled: the retry policy lives in
 * THIS loop, where a retry re-runs the checks, not in the push layer, where
 * it would not.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runSafeChecks, checksEnv, CHECK_TIMEOUT_MS } = require('./autonomous-checks.js');
const { checkLanded } = require('./landing-verify.js');

const MAX_ATTEMPTS = 3;
const REPO_ROOT = path.join(__dirname, '..', '..');

// ── Pure decision helpers ───────────────────────────────────────────────────

/** The first failing check, or null when every check passed (or none ran). */
function firstFailedCheck(results) {
  for (const r of results || []) if (r && r.pass === false) return r;
  return null;
}

/** Whether a failed attempt gets another go. Bounded, never unbounded. */
function shouldRetry(attempt, maxAttempts = MAX_ATTEMPTS) {
  return attempt < maxAttempts;
}

/**
 * A branch name is passed to git as a positional ref; refuse anything that
 * could read as an option or contain whitespace/control characters. Not a
 * full refname validator — git's own `check-ref-format` does that below.
 */
function isPlausibleBranchName(name) {
  const s = String(name || '');
  return s.length > 0 && !s.startsWith('-') && !/[\s~^:?*[\\]/.test(s) && !s.includes('..');
}

/** The one-line verdict scripts/land.js prints. */
function formatLandLine(branch, result) {
  const secs = (Number(result.wallMs || 0) / 1000).toFixed(1);
  if (result.landed) {
    const note = result.pushed ? '' : ' (already on origin/main, no push)';
    return `LANDED: ${branch} → ${result.sha} in ${secs}s (attempts ${result.attempts})${note}`;
  }
  const why = result.failedCheck ? `${result.failedCheck}: ${result.reason || ''}` : (result.reason || 'unknown');
  return `REFUSED: ${why} (attempts ${result.attempts}, ${secs}s)`;
}

// ── Defaults for the seams ──────────────────────────────────────────────────

function defaultChecks({ cwd, changedFiles, repoDir, log = () => {} }) {
  const results = runSafeChecks({
    cwd,
    changedFiles,
    checkableDone: null,
    // No card-authored command on this path, so the validator is never
    // consulted; failing closed keeps the dependency rule (node built-ins +
    // sibling libs only — no executor world pulled into a hand landing).
    isSafeCheckCommand: () => false,
    tier: 1,
    prepareFrom: repoDir,
  });

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'land-branch-home-'));
  try {
    const env = checksEnv({ home });
    const run = (name, argv) => {
      try {
        execFileSync(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, env });
        results.push({ name, pass: true });
      } catch (err) {
        results.push({ name, pass: false, detail: String(err.stderr || err.stdout || err.message).slice(0, 400) });
      }
    };
    // Syntax floor for scripts with no colocated test (tier-3's rule, applied
    // to every hand landing — cheap, and "it parses" is the least we can say).
    for (const f of (changedFiles || []).filter(f => /^scripts\/.*\.(js|mjs|cjs)$/.test(f) && !/\.test\.m?js$/.test(f)).sort()) {
      if (fs.existsSync(path.join(cwd, f))) run(`node --check ${f}`, ['node', '--check', f]);
    }
    // lint-workflows proxy: the push-to-main cancellation guard test.yml runs.
    if (fs.existsSync(path.join(cwd, 'scripts', 'audit-workflow-concurrency.js'))) {
      run('audit-workflow-concurrency', ['node', 'scripts/audit-workflow-concurrency.js']);
    }
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  log(`[land] checks: ${results.length ? results.map(r => `${r.name}=${r.pass ? 'ok' : 'FAIL'}`).join(', ') : 'none applicable'}`);
  return results;
}

// ONE push attempt through the repo's push primitive (mutex, stall guards,
// content-survival verify, failure ledger). Retries are this module's job.
function defaultPushMain({ cwd }) {
  const script = path.join(__dirname, 'push-with-retry.sh');
  execFileSync('bash', [script, '1', 'main'], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, PUSH_API_FALLBACK_DISABLE: '1' },
  });
}

// ── The landing ─────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {string} o.branch        branch to land (local ref, or origin/<branch> after a fetch)
 * @param {string} [o.repoDir]     the checkout whose object store/remote to use (default: this repo)
 * @param {function} [o.checks]    see SEAMS
 * @param {function} [o.pushMain]  see SEAMS
 * @param {function} [o.beforePush]
 * @param {function} [o.log]
 * @param {number} [o.maxAttempts]
 * @param {'auto'|'local'|'origin'} [o.source]  where the branch tip comes from
 * @param {boolean} [o.dryRun]     rebase + checks only, never push
 * @returns {{landed:boolean, sha:string|null, attempts:number, wallMs:number, failedCheck:string|null, reason:string|null, pushed:boolean, files:string[]}}
 */
function landBranch(o) {
  const {
    branch, repoDir = REPO_ROOT, checks = defaultChecks, pushMain = defaultPushMain,
    beforePush = null, log = () => {}, maxAttempts = MAX_ATTEMPTS,
    remote = 'origin', target = 'main', source = 'auto', dryRun = false,
  } = o || {};
  const t0 = Date.now();
  const done = (patch) => ({
    landed: false, sha: null, attempts: 0, wallMs: Date.now() - t0,
    failedCheck: null, reason: null, pushed: false, files: [], ...patch,
  });

  if (!isPlausibleBranchName(branch)) return done({ failedCheck: 'args', reason: `not a usable branch name: ${JSON.stringify(branch)}` });
  if (branch === target) return done({ failedCheck: 'args', reason: `branch is ${target} itself — nothing to land` });

  const git = (args, cwd = repoDir, extra = {}) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...extra }).trim();
  const gitOrNull = (args, cwd) => { try { return git(args, cwd); } catch { return null; } };

  if (gitOrNull(['check-ref-format', '--branch', branch]) === null) return done({ failedCheck: 'args', reason: `git rejects "${branch}" as a branch name` });

  const targetRef = `${remote}/${target}`;
  git(['fetch', remote, target]);

  // Resolve the tip to land. 'local' = refs/heads/<branch> only; 'origin' =
  // fetch and use the remote's copy; 'auto' = local if it exists, else origin.
  let sha = null;
  let from = null;
  if (source !== 'origin') {
    sha = gitOrNull(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    if (sha) from = `refs/heads/${branch}`;
  }
  if (!sha && source !== 'local') {
    if (gitOrNull(['fetch', remote, branch]) === null) return done({ failedCheck: 'resolve', reason: `branch "${branch}" is neither a local branch nor fetchable from ${remote}` });
    sha = gitOrNull(['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}']);
    if (sha) from = `${remote}/${branch}`;
  }
  if (!sha) return done({ failedCheck: 'resolve', reason: `branch "${branch}" not found (${source})` });
  log(`[land] ${branch} @ ${sha.slice(0, 10)} (${from}) → ${targetRef} @ ${git(['rev-parse', targetRef]).slice(0, 10)}`);

  // Idempotent: already on main → nothing to do, nothing to push.
  const already = checkLanded({ sha, branch: target, remote, cwd: repoDir, log });
  if (already.verdict === 'LANDED') {
    log(`[land] ${sha.slice(0, 10)} is already an ancestor of ${targetRef} — nothing to push`);
    return done({ landed: true, sha, attempts: 0, pushed: false, reason: `already an ancestor of ${targetRef}` });
  }

  // Isolated, detached worktree off the same object store. Detached on
  // purpose: the branch ref itself is never checked out here, so no path
  // through this function can move it.
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-branch-'));
  git(['worktree', 'add', '--detach', workdir, sha]);
  const cleanup = () => {
    gitOrNull(['worktree', 'remove', '--force', workdir]);
    gitOrNull(['worktree', 'prune']);
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  try {
    let lastReason = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      git(['fetch', remote, target], workdir);
      const baseSha = git(['rev-parse', targetRef], workdir);

      try {
        git(['rebase', targetRef], workdir);
      } catch (err) {
        gitOrNull(['rebase', '--abort'], workdir);
        return done({ attempts: attempt, failedCheck: 'rebase', reason: `branch would not rebase cleanly onto ${targetRef}: ${String(err.stderr || err.message).slice(0, 300)}` });
      }
      let head = git(['rev-parse', 'HEAD'], workdir);
      if (head === baseSha) {
        // Every commit's patch was already upstream — rebase dropped them all.
        log(`[land] rebase onto ${targetRef} left nothing to land — the branch's changes are already on ${target}`);
        return done({ landed: true, sha: baseSha, attempts: attempt, pushed: false, reason: `rebased to empty — changes already on ${targetRef}` });
      }
      const files = git(['diff', '--name-only', `${baseSha}...HEAD`], workdir).split('\n').filter(Boolean);
      log(`[land] attempt ${attempt}/${maxAttempts}: rebased onto ${baseSha.slice(0, 10)}, ${files.length} file(s) changed — running checks`);

      const results = checks({ cwd: workdir, changedFiles: files, baseSha, repoDir, log }) || [];
      const failed = firstFailedCheck(results);
      if (failed) {
        return done({ attempts: attempt, failedCheck: failed.name, reason: String(failed.detail || 'check failed').slice(0, 500), files });
      }

      if (beforePush) beforePush({ cwd: workdir, baseSha, git: (args) => git(args, workdir) });
      head = git(['rev-parse', 'HEAD'], workdir);

      if (dryRun) {
        log(`[land] dry-run: checks green at ${head.slice(0, 10)} — push skipped`);
        return done({ landed: false, sha: head, attempts: attempt, pushed: false, reason: 'dry-run: checks green, push skipped', files });
      }

      // Did origin/main move while the checks ran? Then this tree was verified
      // against a stale base — re-rebase and re-check rather than push.
      git(['fetch', remote, target], workdir);
      const nowBase = git(['rev-parse', targetRef], workdir);
      if (nowBase !== baseSha) {
        lastReason = `${targetRef} moved during checks (${baseSha.slice(0, 10)} → ${nowBase.slice(0, 10)})`;
        log(`[land] attempt ${attempt}: ${lastReason}${shouldRetry(attempt, maxAttempts) ? ' — re-rebasing and re-checking' : ''}`);
        continue;
      }

      try {
        pushMain({ cwd: workdir, sha: head, log });
      } catch (err) {
        lastReason = `push rejected: ${String(err.stderr || err.message).split('\n')[0].slice(0, 200)}`;
        log(`[land] attempt ${attempt}: ${lastReason}${shouldRetry(attempt, maxAttempts) ? ' — re-rebasing and re-checking' : ''}`);
        continue;
      }

      // Prove it, don't assume it: fresh fetch, then ancestry.
      git(['fetch', remote, target], workdir);
      const headAfter = git(['rev-parse', 'HEAD'], workdir);
      const verdict = checkLanded({ sha: headAfter, branch: target, remote, cwd: workdir, log });
      if (verdict.verdict === 'NOT_LANDED') {
        return done({ attempts: attempt, failedCheck: 'landing-verify', reason: `push reported success but ${headAfter.slice(0, 10)} is not an ancestor of ${targetRef}`, files });
      }
      const note = headAfter !== head ? ` (push layer replayed HEAD onto a newer ${targetRef}: ${head.slice(0, 10)} → ${headAfter.slice(0, 10)})` : '';
      log(`[land] LANDED ${headAfter.slice(0, 10)} on ${targetRef} (attempt ${attempt}, verify=${verdict.verdict})${note}`);
      return done({ landed: true, sha: headAfter, attempts: attempt, pushed: true, files, reason: verdict.verdict === 'UNKNOWN' ? 'push succeeded; local ancestry check UNKNOWN (shallow)' : null });
    }
    return done({
      attempts: maxAttempts, failedCheck: 'push',
      reason: `${targetRef} kept moving — ${maxAttempts} rebase+check+push attempt(s) all lost the race (last: ${lastReason}); refusing rather than rewriting history`,
    });
  } finally {
    cleanup();
  }
}

module.exports = {
  MAX_ATTEMPTS,
  landBranch,
  defaultChecks,
  defaultPushMain,
  firstFailedCheck,
  shouldRetry,
  isPlausibleBranchName,
  formatLandLine,
};
