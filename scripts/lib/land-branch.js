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
 *     ~20 sessions share /Users/tompryor/Broadwayscore). The only writes to
 *     the shared repo are ref-level: `git fetch` (remote-tracking refs and
 *     objects) and `git worktree add/remove` metadata.
 *   - rebase the branch tip onto a PINNED origin/main sha → run the check
 *     gauntlet → ONE fast-forward push of HEAD:main. NEVER rewrites history
 *     and never lets a push layer replay HEAD onto a newer base behind the
 *     checks' back: if origin/main moved during the checks, or the push is
 *     rejected non-fast-forward, THIS loop re-fetches, re-rebases and
 *     RE-CHECKS, bounded by maxAttempts (default 3), then refuses.
 *   - red check → returns { landed: false, failedCheck } WITHOUT pushing; the
 *     branch ref is never modified on any path (the worktree is detached).
 *   - idempotent: a branch tip that is already an ancestor of origin/main
 *     returns landed:true, pushed:false without pushing; a branch whose
 *     commits rebase to nothing (patches already upstream) likewise. Both
 *     carry a content note when the tip's files have since changed on main
 *     (a later edit or a revert — indistinguishable from here, so it is
 *     surfaced, not refused).
 *
 * SEAMS (all injectable, so scripts/lib/land-branch.test.mjs drives the real
 * git plumbing against throwaway repos while faking the expensive parts):
 *   checks({ cwd, changedFiles, baseSha, repoDir, log }) → [{name, pass, detail}]
 *   pushMain({ cwd, sha, log })                           → throws on failure;
 *                                                            MUST be push-only
 *                                                            (no rebase/merge)
 *   beforePush({ cwd, baseSha, git })                     → optional; may amend
 *                                                            HEAD's MESSAGE
 *                                                            (autonomous-merge
 *                                                            stamps trailers)
 *
 * DEFAULT GAUNTLET — the repo's existing verifiers, tier-3 strength:
 *   scripts/lib/autonomous-checks.js runSafeChecks at tier 3 (the same runner
 *   the nightly loop and the approve tap use, parity by identity): colocated
 *   *.test.mjs per changed file, `node --check` floor for changed scripts,
 *   tsc when .ts/.tsx changed, `next lint` + production `next build` for src/
 *   changes, and a REFUSAL when a substantive diff produced no check at all
 *   (fail closed, never "green because nothing ran"); plus `bash -n` for
 *   changed *.sh, scripts/audit-workflow-concurrency.js as the lint-workflows
 *   proxy, and scripts/lib/merge-post-merge-test-gate.js (the merged-tree
 *   test floor merge-worktree-to-main.sh runs — catches the cross-branch
 *   collision a per-file colocated run cannot, task #1149).
 *
 * DEFAULT PUSH — push-only, under the same cross-session mutex
 * push-with-retry.sh takes (scripts/lib/push-mutex.sh, keyed on the shared
 * git-common-dir), with the repo's pre-push hook running as on any push.
 * Deliberately NOT push-with-retry.sh: on a rejection that script fetches,
 * rebases/merges and pushes AGAIN inside one "attempt" — a replay the checks
 * never saw, which is exactly the unverified-code-on-main this lib exists to
 * prevent (adversarial review, BRO-3873). Retries live here, where a retry
 * re-runs the gauntlet.
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
const GIT_NET_TIMEOUT_MS = Number(process.env.GIT_NET_TIMEOUT_SEC || 90) * 1000;
// The merged-tree suite is minutes, not seconds (~4min for scripts/lib, per
// merge-post-merge-test-gate.js) — it gets the build's budget, not a check's.
const MERGED_TREE_TIMEOUT_MS = 20 * 60 * 1000;

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
    const notes = [];
    if (!result.pushed) notes.push('already on origin/main, no push');
    if (result.verified === 'UNKNOWN') notes.push('ancestry UNKNOWN — verify remotely');
    if (result.contentNote) notes.push(result.contentNote);
    const note = notes.length ? ` (${notes.join('; ')})` : '';
    return `LANDED: ${branch} → ${result.sha} in ${secs}s (attempts ${result.attempts})${note}`;
  }
  if (result.dryRun) return `DRY-RUN OK: ${branch} → ${result.sha} checks green in ${secs}s, push skipped`;
  const why = result.failedCheck ? `${result.failedCheck}: ${result.reason || ''}` : (result.reason || 'unknown');
  return `REFUSED: ${why} (attempts ${result.attempts}, ${secs}s)`;
}

// ── Defaults for the seams ──────────────────────────────────────────────────

function defaultChecks({ cwd, changedFiles, baseSha, repoDir, log = () => {} }) {
  const files = (changedFiles || []).map(String);
  const results = runSafeChecks({
    cwd,
    changedFiles: files,
    checkableDone: null,
    // No card-authored command on this path, so the validator is never
    // consulted; failing closed keeps the dependency rule (node built-ins +
    // sibling libs only — no executor world pulled into a hand landing).
    isSafeCheckCommand: () => false,
    tier: 3,
    buildCheck: process.env.LAND_SKIP_BUILD !== '1',
    prepareFrom: repoDir,
  });

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'land-branch-home-'));
  try {
    const env = checksEnv({ home });
    const extra = [];
    const run = (name, argv, opts = {}) => {
      try {
        execFileSync(argv[0], argv.slice(1), {
          cwd, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8',
          timeout: opts.timeoutMs || CHECK_TIMEOUT_MS, env: opts.env || env, input: opts.input,
        });
        extra.push({ name, pass: true });
      } catch (err) {
        extra.push({ name, pass: false, detail: String(err.stderr || err.stdout || err.message).slice(0, 400) });
      }
    };
    // Syntax floor for shell — tier 3's node --check has no shell counterpart.
    for (const f of files.filter(f => /\.sh$/.test(f)).sort()) {
      if (fs.existsSync(path.join(cwd, f))) run(`bash -n ${f}`, ['bash', '-n', f]);
    }
    // lint-workflows proxy: the push-to-main cancellation guard test.yml runs.
    if (files.some(f => f.startsWith('.github/workflows/')) && fs.existsSync(path.join(cwd, 'scripts', 'audit-workflow-concurrency.js'))) {
      run('audit-workflow-concurrency', ['node', 'scripts/audit-workflow-concurrency.js']);
    }
    // Merged-tree test floor (task #1149 / BRO-2785 / BRO-3063): the whole
    // scripts/lib suite, workflow guards, and basename-matched tests/unit
    // tests against the REBASED tree, blocking only on failures new since
    // baseSha. Same gate merge-worktree-to-main.sh runs before its push.
    const gate = path.join(cwd, 'scripts', 'lib', 'merge-post-merge-test-gate.js');
    if (process.env.LAND_SKIP_MERGED_TREE_TESTS !== '1' && fs.existsSync(gate)) {
      run('merged-tree-tests', ['node', 'scripts/lib/merge-post-merge-test-gate.js'], {
        input: `${files.join('\n')}\n`,
        timeoutMs: MERGED_TREE_TIMEOUT_MS,
        env: { ...env, MERGE_TEST_GATE_BASELINE_SHA: baseSha || '' },
      });
    }

    // tier 3's "no runnable check" refusal is right when NOTHING proved the
    // diff; an extra check that actually ran (and passed) is that proof.
    const proven = extra.some(r => r.pass) ;
    const merged = results.filter(r => !(r.name === 'no-checks' && proven)).concat(extra);
    log(`[land] checks: ${merged.length ? merged.map(r => `${r.name}=${r.pass ? 'ok' : 'FAIL'}`).join(', ') : 'none applicable'}`);
    return merged;
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ONE push, nothing else: `git push origin HEAD:main` under the cross-session
// push mutex (scripts/lib/push-mutex.sh — the same lock push-with-retry.sh
// and merge-worktree-to-main.sh take, keyed on the shared git-common-dir so a
// worktree and the main checkout contend on one lock). The repo's pre-push
// hook (scripts/hooks/pre-push) runs as on any push: non-fast-forward guard,
// push audits, tsc on .ts changes. A rejection surfaces as a thrown error the
// caller's bounded loop turns into a re-rebase + re-check.
function defaultPushMain({ cwd, log = () => {} }) {
  const mutex = path.join(__dirname, 'push-mutex.sh');
  const script = [
    'set -euo pipefail',
    `source "$1"`,
    'push_mutex_acquire',
    'trap push_mutex_release EXIT',
    'git push origin HEAD:main',
  ].join('\n');
  log('[land] push: git push origin HEAD:main (push-only, under the push mutex)');
  execFileSync('bash', ['-c', script, '_', mutex], {
    cwd,
    stdio: ['ignore', 'inherit', 'pipe'],
    encoding: 'utf8',
    timeout: GIT_NET_TIMEOUT_MS + Number(process.env.PUSH_LOCK_TIMEOUT_SEC || 900) * 1000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

// ── The landing ─────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {string} o.branch        branch to land (local ref, or origin/<branch>)
 * @param {string} [o.repoDir]     the checkout whose object store/remote to use (default: this repo)
 * @param {function} [o.checks]    see SEAMS
 * @param {function} [o.pushMain]  see SEAMS
 * @param {function} [o.beforePush]
 * @param {function} [o.log]
 * @param {number} [o.maxAttempts]
 * @param {'auto'|'local'|'origin'} [o.source]  where the branch tip comes from
 * @param {boolean} [o.dryRun]     rebase + checks only, never push
 * @returns {{landed:boolean, sha:string|null, attempts:number, wallMs:number, failedCheck:string|null, reason:string|null, pushed:boolean, files:string[], verified:'LANDED'|'UNKNOWN'|null, contentNote:string|null, baseSha:string|null}}
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
    failedCheck: null, reason: null, pushed: false, files: [], verified: null, contentNote: null, baseSha: null, ...patch,
  });

  if (!isPlausibleBranchName(branch)) return done({ failedCheck: 'args', reason: `not a usable branch name: ${JSON.stringify(branch)}` });
  if (branch === target) return done({ failedCheck: 'args', reason: `branch is ${target} itself — nothing to land` });

  const git = (args, cwd = repoDir, extra = {}) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_NET_TIMEOUT_MS, ...extra }).trim();
  const gitOrNull = (args, cwd) => { try { return git(args, cwd); } catch { return null; } };

  if (gitOrNull(['check-ref-format', '--branch', branch]) === null) return done({ failedCheck: 'args', reason: `git rejects "${branch}" as a branch name` });

  const targetRef = `${remote}/${target}`;
  git(['fetch', remote, target]);

  // Resolve the tip to land. 'local' = refs/heads/<branch> only; 'origin' =
  // the remote's copy; 'auto' = local if it exists, else origin. The remote
  // case pins the sha via ls-remote and fetches THAT sha — never FETCH_HEAD,
  // which is one shared file per repo that any concurrent session's fetch
  // overwrites between our fetch and our read (adversarial review).
  let sha = null;
  let from = null;
  if (source !== 'origin') {
    sha = gitOrNull(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    if (sha) from = `refs/heads/${branch}`;
  }
  if (!sha && source !== 'local') {
    const line = gitOrNull(['ls-remote', '--exit-code', remote, `refs/heads/${branch}`]);
    const remoteSha = line ? line.split(/\s+/)[0] : null;
    if (!remoteSha || !/^[0-9a-f]{40}$/.test(remoteSha)) return done({ failedCheck: 'resolve', reason: `branch "${branch}" is neither a local branch nor on ${remote}` });
    if (gitOrNull(['cat-file', '-e', `${remoteSha}^{commit}`]) === null && gitOrNull(['fetch', remote, remoteSha]) === null) {
      return done({ failedCheck: 'resolve', reason: `could not fetch ${remoteSha.slice(0, 10)} (${remote}/${branch}) from ${remote}` });
    }
    if (gitOrNull(['cat-file', '-e', `${remoteSha}^{commit}`]) === null) return done({ failedCheck: 'resolve', reason: `${remoteSha.slice(0, 10)} (${remote}/${branch}) is not present after fetch` });
    sha = remoteSha;
    from = `${remote}/${branch}`;
  }
  if (!sha) return done({ failedCheck: 'resolve', reason: `branch "${branch}" not found (${source})` });
  log(`[land] ${branch} @ ${sha.slice(0, 10)} (${from}) → ${targetRef} @ ${git(['rev-parse', targetRef]).slice(0, 10)}`);

  // The tip commit's own files vs origin/main NOW. A difference is a later
  // edit or a revert — not distinguishable from here, so it is a note the
  // caller sees, never a silent "landed".
  const contentNoteFor = (tip) => {
    const touched = (gitOrNull(['diff-tree', '--no-commit-id', '--name-only', '-r', tip]) || '').split('\n').filter(Boolean);
    if (!touched.length) return null;
    const changed = (gitOrNull(['diff', '--name-only', tip, targetRef, '--', ...touched]) || '').split('\n').filter(Boolean);
    return changed.length ? `${changed.length} of the tip commit's ${touched.length} file(s) have since changed on ${targetRef}: ${changed.slice(0, 5).join(', ')}` : null;
  };

  // Idempotent: already on main → nothing to do, nothing to push.
  const already = checkLanded({ sha, branch: target, remote, cwd: repoDir, log });
  if (already.verdict === 'LANDED') {
    const contentNote = contentNoteFor(sha);
    log(`[land] ${sha.slice(0, 10)} is already an ancestor of ${targetRef} — nothing to push${contentNote ? ` (${contentNote})` : ''}`);
    return done({ landed: true, sha, attempts: 0, pushed: false, verified: 'LANDED', contentNote, reason: `already an ancestor of ${targetRef}` });
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
      // Pin the base: every later step (rebase, diff, moved-check, trailer)
      // uses THIS sha, never the tracking ref another session's fetch may
      // have advanced in the meantime.
      const baseSha = git(['rev-parse', targetRef], workdir);

      try {
        git(['rebase', baseSha], workdir);
      } catch (err) {
        gitOrNull(['rebase', '--abort'], workdir);
        return done({ attempts: attempt, baseSha, failedCheck: 'rebase', reason: `branch would not rebase cleanly onto ${targetRef} @ ${baseSha.slice(0, 10)}: ${String(err.stderr || err.message).slice(0, 300)}` });
      }
      let head = git(['rev-parse', 'HEAD'], workdir);
      if (head === baseSha) {
        // Every commit's patch was already upstream — rebase dropped them all.
        const contentNote = contentNoteFor(sha);
        log(`[land] rebase onto ${targetRef} left nothing to land — the branch's changes are already on ${target}${contentNote ? ` (${contentNote})` : ''}`);
        return done({ landed: true, sha: baseSha, attempts: attempt, baseSha, pushed: false, verified: 'LANDED', contentNote, reason: `rebased to empty — changes already on ${targetRef}` });
      }
      const files = git(['diff', '--name-only', `${baseSha}...HEAD`], workdir).split('\n').filter(Boolean);
      log(`[land] attempt ${attempt}/${maxAttempts}: rebased onto ${baseSha.slice(0, 10)}, ${files.length} file(s) changed — running checks`);

      const results = checks({ cwd: workdir, changedFiles: files, baseSha, repoDir, log }) || [];
      const failed = firstFailedCheck(results);
      if (failed) {
        return done({ attempts: attempt, baseSha, failedCheck: failed.name, reason: String(failed.detail || 'check failed').slice(0, 500), files });
      }

      if (beforePush) beforePush({ cwd: workdir, baseSha, git: (args) => git(args, workdir) });
      head = git(['rev-parse', 'HEAD'], workdir);

      if (dryRun) {
        log(`[land] dry-run: checks green at ${head.slice(0, 10)} — push skipped`);
        return done({ landed: false, dryRun: true, sha: head, attempts: attempt, baseSha, pushed: false, reason: 'dry-run: checks green, push skipped', files });
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
        lastReason = `push rejected: ${String(err.stderr || err.message).split('\n').filter(Boolean).slice(-1)[0] || ''}`.slice(0, 200);
        log(`[land] attempt ${attempt}: ${lastReason}${shouldRetry(attempt, maxAttempts) ? ' — re-rebasing and re-checking' : ''}`);
        continue;
      }

      // Prove it, don't assume it. The push seam is push-only, so HEAD is
      // still the verified commit; anything else is a contract violation.
      const headAfter = git(['rev-parse', 'HEAD'], workdir);
      if (headAfter !== head) {
        return done({ attempts: attempt, baseSha, failedCheck: 'push-contract', reason: `the push step moved HEAD (${head.slice(0, 10)} → ${headAfter.slice(0, 10)}) — a push seam must be push-only; whatever is on ${targetRef} was not what the checks verified`, files });
      }
      git(['fetch', remote, target], workdir);
      const verdict = checkLanded({ sha: head, branch: target, remote, cwd: workdir, log });
      if (verdict.verdict === 'NOT_LANDED') {
        return done({ attempts: attempt, baseSha, failedCheck: 'landing-verify', reason: `push reported success but ${head.slice(0, 10)} is not an ancestor of ${targetRef}`, files });
      }
      log(`[land] LANDED ${head.slice(0, 10)} on ${targetRef} (attempt ${attempt}, verify=${verdict.verdict}${verdict.reason ? `: ${verdict.reason}` : ''})`);
      return done({
        landed: true, sha: head, attempts: attempt, baseSha, pushed: true, files, verified: verdict.verdict,
        reason: verdict.verdict === 'UNKNOWN' ? `push succeeded; local ancestry check UNKNOWN (${verdict.reason}) — confirm via git ls-remote / the GitHub compare API` : null,
      });
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
