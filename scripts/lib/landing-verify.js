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

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_NET_TIMEOUT_SEC * 1000,
    }).trim();
  } catch {
    return null;
  }
}

function isShallowRepo(cwd) {
  return git(['rev-parse', '--is-shallow-repository'], cwd) === 'true';
}

function isAncestor(sha, ref, cwd) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, ref], {
      cwd,
      stdio: 'ignore',
      timeout: GIT_NET_TIMEOUT_SEC * 1000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.sha - commit to check
 * @param {string} [opts.branch='main']
 * @param {string} [opts.remote='origin']
 * @param {string} [opts.cwd=process.cwd()]
 * @param {(msg: string) => void} [opts.log]
 * @returns {{verdict: 'LANDED'|'NOT_LANDED'|'UNKNOWN', landed: boolean|null, shallow: boolean, reason: string|null}}
 */
function checkLanded({ sha, branch = 'main', remote = 'origin', cwd = process.cwd(), log = () => {} } = {}) {
  if (!sha) throw new Error('checkLanded requires sha');
  const remoteRef = `${remote}/${branch}`;

  if (isShallowRepo(cwd)) {
    log(
      `WARNING: local checkout is shallow — 'git merge-base --is-ancestor' can false-negative on commits genuinely on ${remoteRef}. Attempting 'git fetch --unshallow ${remote}' before checking (task #1489).`
    );
    git(['fetch', '--unshallow', remote], cwd);
    if (isShallowRepo(cwd)) {
      log(
        `WARNING: repo is STILL shallow after 'git fetch --unshallow' — a local ancestry check cannot be trusted. Reporting UNKNOWN, not NOT_LANDED. Verify via 'git ls-remote ${remote} ${branch}' or the GitHub compare API before concluding this did not land.`
      );
      return { verdict: 'UNKNOWN', landed: null, shallow: true, reason: 'unshallow-failed' };
    }
  }

  const landed = isAncestor(sha, remoteRef, cwd);
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
  const { sha, branch, remote, cwd } = parseArgs(process.argv.slice(2));
  if (!sha) {
    console.error('usage: landing-verify.js --sha=<sha> [--branch=main] [--remote=origin] [--cwd=.]');
    process.exit(2);
  }
  const result = checkLanded({
    sha,
    branch: branch || 'main',
    remote: remote || 'origin',
    cwd: cwd || process.cwd(),
    log: (m) => console.error(m),
  });
  console.log(JSON.stringify(result));
  // Exit codes: 0 = LANDED, 1 = NOT_LANDED, 2 = UNKNOWN — lets bash callers
  // branch on `$?` without parsing JSON.
  process.exit(result.verdict === 'LANDED' ? 0 : result.verdict === 'UNKNOWN' ? 2 : 1);
}

if (require.main === module) main();

module.exports = { checkLanded, isShallowRepo, isAncestor };
