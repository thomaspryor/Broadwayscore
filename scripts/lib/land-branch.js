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
 *     checks' back: if origin/main moved during the checks across anything
 *     that could change a verdict, or the push is rejected non-fast-forward,
 *     THIS loop re-fetches, re-rebases and RE-CHECKS, bounded by maxAttempts
 *     (default 3), then refuses. A move across INERT paths only (bot data
 *     churn — see INERT_FOR_VERIFICATION_RE) is rebased over cleanly with
 *     the verdict kept, because on this repo main moves faster than the
 *     gauntlet runs and a strict re-check never converges (measured).
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

const { runSafeChecks, checksEnv, prepareCheckWorkdir, CHECK_TIMEOUT_MS } = require('./autonomous-checks.js');
const { checkLanded } = require('./landing-verify.js');

const MAX_ATTEMPTS = 3;
// Inert-churn re-rebases allowed per attempt before a full re-check is forced.
const MAX_CHURN_SKIPS = 10;
const REPO_ROOT = path.join(__dirname, '..', '..');
const GIT_NET_TIMEOUT_MS = Number(process.env.GIT_NET_TIMEOUT_SEC || 90) * 1000;
// The merged-tree suite is minutes, not seconds (~4min for scripts/lib, per
// merge-post-merge-test-gate.js) — it gets the build's budget, not a check's.
const MERGED_TREE_TIMEOUT_MS = 20 * 60 * 1000;
const CHECK_OUTPUT_MAX_BYTES = 256 * 1024 * 1024;

// ── Pure decision helpers ───────────────────────────────────────────────────

/**
 * The first check that did not PASS, or null when every check passed (or
 * none ran). Fails closed: a result without `pass: true` — `{name}` alone, a
 * malformed entry — counts as a failure, never as green.
 */
function firstFailedCheck(results) {
  for (const r of results || []) {
    if (!r || r.pass !== true) return r ? { name: r.name || 'malformed-check', ...r, pass: false } : { name: 'malformed-check', pass: false, detail: 'check result was empty' };
  }
  return null;
}

/**
 * Paths whose content cannot change a check verdict: bot-written data and
 * telemetry, generated public data, memory, prose. This repo pushes such
 * commits to main every minute or two (~200 workflows), while the gauntlet
 * takes ~2 minutes — a policy of "re-check on EVERY move" measured 3 moves
 * in 355s and never converged (BRO-3873 landing 1). A clean rebase across
 * commits that touch ONLY these paths keeps the verdict; anything else
 * re-runs the checks. Same judgement scripts/merge-worktree-to-main.sh and
 * memory/feedback_parallel_worktree_race.md already record.
 */
const INERT_FOR_VERIFICATION_RE = /^(data\/|public\/data\/|cloud-memory\/|memory\/|docs\/)|\.(md|jsonl|log|txt)$/;

function isInertForVerification(file) {
  return INERT_FOR_VERIFICATION_RE.test(String(file));
}

/** 'inert' when every intervening file is inert (and there is at least one), else 'substantive'. */
function classifyIntervening(files) {
  const list = (files || []).map(String);
  return list.length && list.every(isInertForVerification) ? 'inert' : 'substantive';
}

/**
 * A push failure is only worth a retry when origin/main actually moved —
 * anything else (a pre-push hook block, auth, a network error) would fail the
 * same way three times and be misreported as a lost race.
 */
function classifyPushFailure({ baseSha, nowBase }) {
  return nowBase && baseSha && nowBase !== baseSha ? 'race' : 'rejected';
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

/**
 * Pure decision for a landing whose gauntlet ALREADY ran elsewhere against
 * `verifiedBase` (land.yml's `checks` job, BRO-3873 step 3): may the rebase
 * onto `baseSha` reuse that verdict? Yes when the base is the very sha that
 * was verified, or has moved past it across INERT paths only (the same
 * judgement the in-process loop applies after its own checks). Anything
 * else — a substantive move, a base that does not descend from the verified
 * one (force-moved main, wrong sha), unknown ancestry — is `skip: false`,
 * i.e. run the full gauntlet. Fails closed.
 * @param {{verifiedBase:string, baseSha:string, ancestor:boolean, intervening:string[]}} o
 *   ancestor: is verifiedBase an ancestor of baseSha (false/unknown → no skip)
 *   intervening: files changed verifiedBase..baseSha
 */
function decideVerifiedBaseSkip({ verifiedBase, baseSha, ancestor, intervening }) {
  if (!verifiedBase || !baseSha) return { skip: false, reason: 'no verified base' };
  if (verifiedBase === baseSha) return { skip: true, reason: `base ${baseSha.slice(0, 10)} is the verified base` };
  if (ancestor !== true) return { skip: false, reason: `verified base ${verifiedBase.slice(0, 10)} is not an ancestor of ${baseSha.slice(0, 10)}` };
  const files = (intervening || []).map(String);
  const kind = classifyIntervening(files);
  if (kind === 'inert') return { skip: true, reason: `main moved ${verifiedBase.slice(0, 10)} → ${baseSha.slice(0, 10)} across ${files.length} inert path(s) only` };
  return { skip: false, reason: `main moved ${verifiedBase.slice(0, 10)} → ${baseSha.slice(0, 10)} across ${files.length} file(s), substantive` };
}

/**
 * A checks seam that reuses an upstream verdict when decideVerifiedBaseSkip
 * allows it and otherwise runs `checks` (the full default gauntlet). On the
 * skip path the throwaway worktree is still prepared (node_modules link,
 * core-data copies) because the repo's pre-push hook runs from it on push.
 * `git` is injectable for tests; the default is a null-on-error runner.
 */
function makeVerifiedBaseChecks({ verifiedBase, checks = defaultChecks, git = null, prepare = prepareCheckWorkdir }) {
  if (!/^[0-9a-f]{40}$/.test(String(verifiedBase || ''))) throw new Error(`makeVerifiedBaseChecks: verifiedBase must be a full 40-hex sha (got ${JSON.stringify(verifiedBase)})`);
  const run = git || ((args, cwd) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_NET_TIMEOUT_MS }).trim();
    } catch { return null; }
  });
  return function verifiedBaseChecks(o) {
    const { cwd, baseSha, repoDir, log = () => {} } = o || {};
    const ancestor = run(['merge-base', '--is-ancestor', verifiedBase, baseSha], cwd) !== null;
    const intervening = ancestor ? (run(['diff', '--name-only', `${verifiedBase}..${baseSha}`], cwd) || '').split('\n').filter(Boolean) : [];
    const decision = decideVerifiedBaseSkip({ verifiedBase, baseSha, ancestor, intervening });
    if (!decision.skip) {
      log(`[land] verified-base: ${decision.reason} — running the full gauntlet`);
      return checks(o);
    }
    if (prepare && repoDir) {
      // repoDir may be a node_modules-less git worktree (BRO-3907) — prepare
      // (prepareCheckWorkdir by default) resolves the real install root
      // itself now, so every caller gets the fix without having to remember
      // to resolve first. See resolveInstallRoot()'s header in
      // autonomous-checks.js.
      const linked = prepare(cwd, repoDir);
      if (linked.length) log(`[land] linked ${linked.length} gitignored path(s) into the worktree (node_modules/core data)`);
    }
    log(`[land] verified-base: ${decision.reason} — reusing the upstream verdict, gauntlet skipped`);
    return [{ name: 'verified-upstream', pass: true, detail: decision.reason }];
  };
}

// ── Defaults for the seams ──────────────────────────────────────────────────

function defaultChecks({ cwd, changedFiles, baseSha, repoDir, log = () => {} }) {
  const files = (changedFiles || []).map(String);
  // Fill the worktree's gitignored gaps (node_modules link, core-data copies)
  // up front, unconditionally: runSafeChecks only prepares when its own plan
  // is non-empty, but the merged-tree floor below and the repo's pre-push
  // hook (which runs from this worktree on push) need them regardless.
  // repoDir may itself be a node_modules-less git worktree (BRO-3907) —
  // prepareCheckWorkdir (called here, and again internally by runSafeChecks
  // below via prepareFrom) resolves the real install root itself, so passing
  // the same repoDir to both is safe and never silently drops the fix.
  const linked = prepareCheckWorkdir(cwd, repoDir);
  if (linked.length) log(`[land] linked ${linked.length} gitignored path(s) into the worktree (node_modules/core data)`);
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
          // The merged-tree floor emits ~50k TAP lines (>1MB). Node's default
          // 1MB maxBuffer kills the child with ENOBUFS mid-stream, which then
          // reads as a failed check — exactly what refused the first real
          // dry-run of this lib (BRO-3873).
          maxBuffer: CHECK_OUTPUT_MAX_BYTES,
        });
        extra.push({ name, pass: true });
      } catch (err) {
        if (err && err.code === 'ENOBUFS') err.stderr = `${err.stderr || ''}\ncheck output exceeded CHECK_OUTPUT_MAX_BYTES (${CHECK_OUTPUT_MAX_BYTES}) — the check was killed, this is NOT a verdict on the code`;
        // Keep the full output: the detail string is a summary, and a merged-
        // tree run is ~50k TAP lines that a 600-char detail cannot explain.
        let logPath = null;
        try {
          logPath = path.join(os.tmpdir(), `land-branch-${name.replace(/[^\w.-]+/g, '_')}-${Date.now()}.log`);
          fs.writeFileSync(logPath, `# ${argv.join(' ')}\n# exit ${err.status}${err.signal ? ` signal ${err.signal}` : ''}\n\n${err.stdout || ''}\n--- stderr ---\n${err.stderr || ''}\n`);
        } catch { logPath = null; }
        extra.push({ name, pass: false, detail: `${(opts.detail || defaultDetail)(err)}${logPath ? ` [full output: ${logPath}]` : ''}` });
      }
    };
    const defaultDetail = (err) => String(err.stderr || err.stdout || err.message).slice(0, 400);
    // TAP output: the failing subtests are the signal, not the passing head.
    const tapDetail = (err) => {
      const out = String(err.stdout || '');
      const failing = out.split('\n').filter(l => /^\s*not ok\b/.test(l)).map(l => l.trim());
      const summary = `${err.stderr || ''}\n${out.split('\n').slice(-40).join('\n')}`.split('\n').filter(l => /FAILED|test floor|ENOBUFS|exceeded/.test(l)).slice(-1)[0] || '';
      return [summary, ...failing.slice(0, 8), failing.length > 8 ? `… ${failing.length - 8} more` : ''].filter(Boolean).join(' | ').slice(0, 600) || defaultDetail(err);
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
        detail: tapDetail,
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
    // No bypass marker on purpose (BRO-3425): outside CI this push is
    // refused by scripts/hooks/pre-push like any other direct push to main
    // (surfaced as failedCheck 'push' with the hook's message). Sessions
    // land through land/** + land.yml; land.yml runs this lib under
    // GITHUB_ACTIONS, which the hook allows. A local landing that wrote no
    // landings.jsonl row would otherwise read as a bypass to the detector.
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
 * @param {string} [o.expectSha]   refuse unless the resolved tip IS this sha
 *                                 (land.yml: the tip its checks job verified —
 *                                 a newer push to the branch supersedes this
 *                                 landing rather than landing unverified code)
 * @param {boolean} [o.dryRun]     rebase + checks only, never push
 * @returns {{landed:boolean, sha:string|null, attempts:number, wallMs:number, failedCheck:string|null, reason:string|null, pushed:boolean, files:string[], verified:'LANDED'|'UNKNOWN'|null, contentNote:string|null, baseSha:string|null}}
 */
function landBranch(o) {
  const {
    branch, repoDir = REPO_ROOT, checks = defaultChecks, pushMain = defaultPushMain,
    beforePush = null, log = () => {}, maxAttempts = MAX_ATTEMPTS, maxChurnSkips = MAX_CHURN_SKIPS,
    remote = 'origin', target = 'main', source = 'auto', dryRun = false, expectSha = null,
  } = o || {};
  const t0 = Date.now();
  const done = (patch) => ({
    landed: false, sha: null, attempts: 0, wallMs: Date.now() - t0,
    failedCheck: null, reason: null, pushed: false, files: [], verified: null, contentNote: null,
    baseSha: null, verifiedBase: null, churnSkips: 0, ...patch,
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
  if (expectSha && sha !== expectSha) {
    return done({ failedCheck: 'resolve', reason: `${branch} tip is ${sha.slice(0, 10)} (${from}), not the verified tip ${String(expectSha).slice(0, 10)} — a newer push superseded this landing; nothing pushed` });
  }
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
    // Checks are allowed to dirty the throwaway tree (a prebuild regenerates
    // tracked files, tests write data/audit/*.json) and a dirty tree makes
    // any later rebase refuse ("You have unstaged changes") — which is how
    // the first two real landings through this lib were lost, once at the
    // retry and once at the churn re-rebase (BRO-3873). Nothing in this
    // worktree is anyone's work: HEAD is the verified commit, everything
    // else is check residue. Discard it, loudly, before EVERY rebase.
    // Ignored files (node_modules link, core-data copies) are kept.
    const discardResidue = (label) => {
      // The git helper trims, so the first line loses its leading status
      // column — strip the XY code by pattern, not by position.
      const dirty = (gitOrNull(['status', '--porcelain'], workdir) || '').split('\n').filter(Boolean)
        .map(l => l.replace(/^[ MADRCUT?!]{1,2}\s+/, ''));
      if (!dirty.length) return;
      log(`[land] ${label}: discarding ${dirty.length} check-residue path(s) in the throwaway worktree: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}`);
      git(['reset', '-q', '--hard', 'HEAD'], workdir);
      git(['clean', '-fdq'], workdir);
    };

    let lastReason = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      discardResidue(`attempt ${attempt}`);
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

      if (dryRun) {
        head = git(['rev-parse', 'HEAD'], workdir);
        log(`[land] dry-run: checks green at ${head.slice(0, 10)} — push skipped`);
        return done({ landed: false, dryRun: true, sha: head, attempts: attempt, baseSha, verifiedBase: baseSha, pushed: false, reason: 'dry-run: checks green, push skipped', files });
      }

      // Did origin/main move while the checks ran? A move across INERT
      // paths only (bot data churn) keeps the verdict: re-rebase cleanly and
      // carry on. A substantive move means this tree was verified against a
      // stale base — re-rebase and re-check. Bounded so a firehose of churn
      // cannot spin here forever.
      let landBase = baseSha;
      let churnSkips = 0;
      let restart = false;
      for (;;) {
        git(['fetch', remote, target], workdir);
        const nowBase = git(['rev-parse', targetRef], workdir);
        if (nowBase === landBase) break;
        const intervening = git(['diff', '--name-only', `${landBase}..${nowBase}`], workdir).split('\n').filter(Boolean);
        const kind = classifyIntervening(intervening);
        if (kind !== 'inert' || churnSkips >= maxChurnSkips) {
          lastReason = `${targetRef} moved during checks (${landBase.slice(0, 10)} → ${nowBase.slice(0, 10)}, ${intervening.length} file(s), ${kind}${churnSkips >= maxChurnSkips ? `, churn budget ${maxChurnSkips} spent` : ''})`;
          log(`[land] attempt ${attempt}: ${lastReason}${shouldRetry(attempt, maxAttempts) ? ' — re-rebasing and re-checking' : ''}`);
          restart = true;
          break;
        }
        discardResidue(`attempt ${attempt} (churn re-rebase)`);
        try {
          git(['rebase', nowBase], workdir);
        } catch (err) {
          gitOrNull(['rebase', '--abort'], workdir);
          return done({ attempts: attempt, baseSha: nowBase, verifiedBase: baseSha, failedCheck: 'rebase', reason: `branch would not rebase cleanly onto ${targetRef} @ ${nowBase.slice(0, 10)} (inert churn since ${landBase.slice(0, 10)}): ${String(err.stderr || err.message).slice(0, 300)}`, files });
        }
        churnSkips++;
        log(`[land] attempt ${attempt}: ${targetRef} moved across ${intervening.length} inert path(s) only (${landBase.slice(0, 10)} → ${nowBase.slice(0, 10)}: ${intervening.slice(0, 3).join(', ')}${intervening.length > 3 ? ', …' : ''}) — verdict kept, rebased without re-checking (${churnSkips}/${maxChurnSkips})`);
        landBase = nowBase;
      }
      if (restart) continue;

      // Trailers/amends go on the commit that will actually be pushed, with
      // the base it actually sits on (autonomous-merge's Auto-merge-base
      // must be the pushed commit's real parent for revert() to be exact).
      if (beforePush) beforePush({ cwd: workdir, baseSha: landBase, verifiedBase: baseSha, git: (args) => git(args, workdir) });
      head = git(['rev-parse', 'HEAD'], workdir);

      try {
        pushMain({ cwd: workdir, sha: head, log });
      } catch (err) {
        const errText = String(err.stderr || err.message || '');
        const errLine = errText.split('\n').map(l => l.trim()).filter(l => l && !/^remote:\s*$/.test(l)).slice(-1)[0] || 'push failed';
        gitOrNull(['fetch', remote, target], workdir);
        const kind = classifyPushFailure({ baseSha: landBase, nowBase: gitOrNull(['rev-parse', targetRef], workdir) });
        if (kind !== 'race') {
          // Not a race: origin/main is where we verified it. Retrying would
          // hit the same wall (hook, auth, network) and misreport it.
          const blocked = /PRE-PUSH BLOCKED/.test(errText) ? 'pre-push hook: ' : '';
          return done({ attempts: attempt, baseSha: landBase, verifiedBase: baseSha, failedCheck: 'push', reason: `${blocked}${errText.match(/=== PRE-PUSH BLOCKED: ([^=]+) ===/)?.[1]?.trim() || errLine}`.slice(0, 500), files });
        }
        lastReason = `push rejected after ${targetRef} moved: ${errLine}`.slice(0, 200);
        log(`[land] attempt ${attempt}: ${lastReason}${shouldRetry(attempt, maxAttempts) ? ' — re-rebasing and re-checking' : ''}`);
        continue;
      }

      // Prove it, don't assume it. The push seam is push-only, so HEAD is
      // still the verified commit; anything else is a contract violation.
      const headAfter = git(['rev-parse', 'HEAD'], workdir);
      if (headAfter !== head) {
        return done({ attempts: attempt, baseSha: landBase, verifiedBase: baseSha, failedCheck: 'push-contract', reason: `the push step moved HEAD (${head.slice(0, 10)} → ${headAfter.slice(0, 10)}) — a push seam must be push-only; whatever is on ${targetRef} was not what the checks verified`, files });
      }
      git(['fetch', remote, target], workdir);
      const verdict = checkLanded({ sha: head, branch: target, remote, cwd: workdir, log });
      if (verdict.verdict === 'NOT_LANDED') {
        return done({ attempts: attempt, baseSha: landBase, verifiedBase: baseSha, failedCheck: 'landing-verify', reason: `push reported success but ${head.slice(0, 10)} is not an ancestor of ${targetRef}`, files });
      }
      log(`[land] LANDED ${head.slice(0, 10)} on ${targetRef} (attempt ${attempt}, verified at ${baseSha.slice(0, 10)}${landBase !== baseSha ? `, fast-forwarded across inert churn to ${landBase.slice(0, 10)}` : ''}, verify=${verdict.verdict}${verdict.reason ? `: ${verdict.reason}` : ''})`);
      return done({
        landed: true, sha: head, attempts: attempt, baseSha: landBase, verifiedBase: baseSha, churnSkips, pushed: true, files, verified: verdict.verdict,
        reason: verdict.verdict === 'UNKNOWN' ? `push succeeded; local ancestry check UNKNOWN (${verdict.reason}) — confirm via git ls-remote / the GitHub compare API` : null,
      });
    }
    return done({
      attempts: maxAttempts, failedCheck: 'race',
      reason: `${targetRef} kept moving — ${maxAttempts} rebase+check+push attempt(s) all lost the race (last: ${lastReason}); refusing rather than rewriting history`,
    });
  } finally {
    cleanup();
  }
}

module.exports = {
  MAX_ATTEMPTS,
  MAX_CHURN_SKIPS,
  INERT_FOR_VERIFICATION_RE,
  isInertForVerification,
  classifyIntervening,
  landBranch,
  defaultChecks,
  decideVerifiedBaseSkip,
  makeVerifiedBaseChecks,
  defaultPushMain,
  firstFailedCheck,
  classifyPushFailure,
  shouldRetry,
  isPlausibleBranchName,
  formatLandLine,
};
