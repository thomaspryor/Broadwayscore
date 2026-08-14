#!/usr/bin/env node
'use strict';
/**
 * Shallow-aware "did it land" ancestry check (task #1489).
 *
 * `git merge-base --is-ancestor <sha> <ref>` silently answers "not an
 * ancestor" when the local repo is shallow and the commit graph has been
 * truncated past <sha> — even when <sha>'s commit object is still present
 * locally (`git cat-file -e <sha>` succeeds) and it genuinely landed on
 * <ref>. That false negative is exactly what caused a 2026-08-14 incident:
 * a session's shared checkout went shallow, and every landing check after
 * that reported real commits as "not landed," nearly triggering a
 * re-push/force-push "recovery."
 *
 * checkLanded() refuses to return that false negative. If the repo is
 * shallow it first tries to restore full history (`git fetch --unshallow`);
 * if that fails it reports UNKNOWN — never NOT_LANDED — so callers can
 * escalate to a remote-side check (git ls-remote / GitHub compare API)
 * instead of assuming the work was reverted.
 *
 * The unshallow attempt is timeout-bounded via GIT_NET_TIMEOUT_SEC — the
 * same env knob scripts/lib/push-with-retry.sh's git_fetch wrapper uses —
 * so both the bash and Node fetch paths share one timeout value instead of
 * drifting apart.
 */
const { execFileSync } = require('child_process');

const GIT_NET_TIMEOUT_SEC = Number(process.env.GIT_NET_TIMEOUT_SEC || 90);

function git(args, cwd, timeoutMs = GIT_NET_TIMEOUT_SEC * 1000) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
    }).trim();
  } catch {
    return null;
  }
}

function isShallowRepo(cwd) {
  return git(['rev-parse', '--is-shallow-repository'], cwd) === 'true';
}

/**
 * Shared shallow-guard: if `cwd` is shallow, try once to restore full history
 * via `git fetch --unshallow`. Factored out of checkLanded() (task #1497) so
 * bulk callers doing many ancestry checks in one process (e.g.
 * review-gate.mjs's ancestorSet()) can call this ONCE up front instead of
 * paying a per-call shallow-detection cost, and so the same "attempt once,
 * report loudly if it's still shallow" behavior isn't reimplemented per site.
 * @returns {{shallow: boolean}} shallow: true if STILL shallow after the attempt
 */
function ensureFullHistory({ cwd = process.cwd(), remote = 'origin', log = () => {}, timeoutMs = null } = {}) {
  if (!isShallowRepo(cwd)) return { shallow: false };
  log(
    `WARNING: local checkout is shallow — 'git merge-base --is-ancestor' can false-negative on commits genuinely present. Attempting 'git fetch --unshallow ${remote}' (task #1489).`
  );
  // `timeoutMs` lets a LATENCY-BOUNDED caller cap this network fetch below the
  // 90s GIT_NET_TIMEOUT_SEC default. review-gate.mjs runs inside PreToolUse
  // hooks that are killed at 20s, so an unbounded-by-their-standards 90s fetch
  // is not a slow path there — it is a guaranteed kill. Timing out simply lands
  // on the STILL-shallow branch below, which is an outcome this function
  // already defines and every caller already handles.
  git(['fetch', '--unshallow', remote], cwd, timeoutMs || GIT_NET_TIMEOUT_SEC * 1000);
  const stillShallow = isShallowRepo(cwd);
  if (stillShallow) {
    log(
      `WARNING: repo is STILL shallow after 'git fetch --unshallow' — a local ancestry check cannot be trusted. Verify via 'git ls-remote ${remote} <branch>' or the GitHub compare API instead of concluding a commit did not land.`
    );
  }
  return { shallow: stillShallow };
}

/**
 * Tri-state, not boolean: `git merge-base --is-ancestor` exits 1 SPECIFICALLY
 * for "genuinely not an ancestor" — any other nonzero exit (128 for a
 * missing/invalid object, a timeout, a corrupt ref) is an ERROR, not a
 * verdict (ship-check finding, task #1489). Collapsing both into `false`
 * meant a fetch that silently left `origin/<branch>` unresolved, or a
 * timed-out check, read as NOT_LANDED just as wrongly as the shallow-graph
 * case this module exists to fix.
 * @returns {boolean|null} true/false = definitive verdict, null = error (caller must not treat as NOT_LANDED)
 */
function isAncestor(sha, ref, cwd) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, ref], {
      cwd,
      stdio: 'ignore',
      timeout: GIT_NET_TIMEOUT_SEC * 1000,
    });
    return true;
  } catch (err) {
    if (err && err.status === 1) return false;
    return null;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.sha - commit to check
 * @param {string} [opts.branch='main']
 * @param {string} [opts.remote='origin']
 * @param {string} [opts.ref] - explicit target to check ancestry against
 *   (any commit-ish: a raw SHA, a tag, another branch). Overrides
 *   `${remote}/${branch}` — for callers comparing two arbitrary commits
 *   rather than "is this on a remote-tracking branch" (task #1497, e.g.
 *   check-prod-deploy.js comparing a commit-ish against a deployed SHA, or
 *   scripts/hooks/pre-push comparing a push's remote_oid against local_oid).
 * @param {string} [opts.cwd=process.cwd()]
 * @param {(msg: string) => void} [opts.log]
 * @returns {{verdict: 'LANDED'|'NOT_LANDED'|'UNKNOWN', landed: boolean|null, shallow: boolean, reason: string|null}}
 *
 * PRECONDITION: reads the LOCAL `<remote>/<branch>` tracking ref (or `ref`,
 * if given) as-is — it does not fetch it (except to unshallow, see below).
 * Callers that need a fresh remote-side answer must `git fetch <remote>
 * <branch>` immediately before calling this, same as
 * scripts/merge-worktree-to-main.sh's two call sites do; a stale local ref
 * can read LANDED against a tip the remote has since moved past.
 */
function checkLanded({ sha, branch = 'main', remote = 'origin', ref, cwd = process.cwd(), log = () => {} } = {}) {
  if (!sha) throw new Error('checkLanded requires sha');
  const targetRef = ref || `${remote}/${branch}`;

  const { shallow } = ensureFullHistory({ cwd, remote, log });
  if (shallow) {
    return { verdict: 'UNKNOWN', landed: null, shallow: true, reason: 'unshallow-failed' };
  }

  const landed = isAncestor(sha, targetRef, cwd);
  if (landed === null) {
    log(
      `WARNING: ancestry check for ${sha} against ${targetRef} errored (not a definitive "not an ancestor" — a timeout, missing ref, or invalid object). Reporting UNKNOWN, not NOT_LANDED.`
    );
    return { verdict: 'UNKNOWN', landed: null, shallow: false, reason: 'ancestor-check-error' };
  }
  return { verdict: landed ? 'LANDED' : 'NOT_LANDED', landed, shallow: false, reason: null };
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function main() {
  const { sha, branch, remote, ref, cwd } = parseArgs(process.argv.slice(2));
  if (!sha) {
    console.error('usage: landing-verify.js --sha=<sha> [--branch=main] [--remote=origin] [--ref=<commit-ish>] [--cwd=.]');
    process.exit(2);
  }
  const result = checkLanded({
    sha,
    branch: branch || 'main',
    remote: remote || 'origin',
    ref: ref || undefined,
    cwd: cwd || process.cwd(),
    log: (m) => console.error(m),
  });
  console.log(JSON.stringify(result));
  // Exit codes: 0 = LANDED, 1 = NOT_LANDED, 2 = UNKNOWN — lets bash callers
  // branch on `$?` without parsing JSON.
  process.exit(result.verdict === 'LANDED' ? 0 : result.verdict === 'UNKNOWN' ? 2 : 1);
}

if (require.main === module) main();

module.exports = { checkLanded, isShallowRepo, isAncestor, ensureFullHistory };
