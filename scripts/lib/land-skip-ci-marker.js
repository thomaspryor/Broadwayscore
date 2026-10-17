#!/usr/bin/env node
/**
 * BRO-4643: GitHub suppresses push-triggered workflows when the pushed TIP
 * commit's message carries a skip marker ([skip ci], skip-checks: true, ...).
 * A data-refresh commit ("audit: ... [skip ci]") on the tip of a branch being
 * landed therefore means land.yml NEVER starts for the land/<branch> push, and
 * the land script polls its full wait cap with no diagnosis.
 *
 * The fix is to push a synthetic EMPTY child of the tip (same tree, message
 * without any marker) to land/<branch>. land.yml's plain `git rebase` KEEPS
 * commits that start out empty, so the trigger commit lands on main too: a
 * tree-neutral no-op that also gives main a non-skip tip for push-triggered CI.
 * The branch's own tip commit and local branch ref are untouched.
 *
 * The commit is deterministic (author, committer, dates copied from the tip),
 * so a re-run of the land script after a timeout recomputes the SAME sha and
 * takes the "land/<branch> already at this tip" resume path instead of
 * force-pushing and cancelling the in-flight run.
 *
 * The marker predicate is landing-ci-coverage.js's hasSkipCiMarker (one source
 * of truth for what GitHub treats as a skip marker).
 *
 * CLI: land-skip-ci-marker.js --sha=<tip> [--cwd=dir]
 *   prints the trigger commit sha and exits 10 when the tip carries a marker;
 *   prints nothing and exits 0 when it does not; exits 2 on usage/git error.
 */
'use strict';
const { spawnSync } = require('child_process');
const { hasSkipCiMarker } = require('./landing-ci-coverage');

function triggerMessage(tipSha) {
  return `chore(land): empty trigger commit so land.yml runs (tip ${String(tipSha).slice(0, 10)} carries a CI-skip marker)`;
}

function git(args, cwd, env) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...(env || {}) } });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || '').trim()}`);
  return r.stdout.trim();
}

// Returns null when the tip has no skip marker, else the sha of the (possibly
// pre-existing) deterministic empty child commit. Writes only an object.
function ensureTriggerCommit(tip, cwd) {
  const message = git(['log', '-1', '--format=%B', tip], cwd);
  if (!hasSkipCiMarker(message)) return null;
  const [an, ae, ad, cn, ce, cd] = git(['log', '-1', '--format=%an%n%ae%n%aI%n%cn%n%ce%n%cI', tip], cwd).split('\n');
  const tree = git(['rev-parse', `${tip}^{tree}`], cwd);
  return git(['commit-tree', '--no-gpg-sign', tree, '-p', tip, '-m', triggerMessage(tip)], cwd, {
    GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad,
    GIT_COMMITTER_NAME: cn, GIT_COMMITTER_EMAIL: ce, GIT_COMMITTER_DATE: cd,
  });
}

function main(argv) {
  const arg = n => (argv.find(a => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
  const sha = arg('sha');
  if (!sha) { console.error('usage: land-skip-ci-marker.js --sha=<tip> [--cwd=dir]'); return 2; }
  try {
    const out = ensureTriggerCommit(sha, arg('cwd') || process.cwd());
    if (!out) return 0;
    console.log(out);
    return 10;
  } catch (e) { console.error(e.message); return 2; }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { ensureTriggerCommit, triggerMessage, hasSkipCiMarker };
