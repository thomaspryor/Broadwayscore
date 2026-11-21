#!/usr/bin/env node
/**
 * check-remote-branch-absent.js — acceptance check for "delete branch X" cards
 * (BRO-5456).
 *
 * Exit 0 iff refs/heads/<branch> is ABSENT from origin. Before the work the
 * branch exists (exit 1); after the delete it is gone (exit 0), so the command
 * can tell done from not done, unlike a `test -f` on a file already on main.
 *
 * Read-only: one `git ls-remote --heads origin refs/heads/<branch>` through
 * execFileSync (argv array, no shell). The branch name is validated before it
 * reaches git; SAFE_CHECK_FORMS in scripts/lib/check-paths.js admits the same
 * token shape.
 *
 * Exit codes: 0 absent · 1 present · 2 usage error or git could not answer
 * (network, no remote). An unanswered probe is never a pass.
 *
 * Usage: node scripts/check-remote-branch-absent.js --branch=<name>
 */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

// Same shape the safe form admits: path segments of [A-Za-z0-9._-], each
// starting with an alphanumeric (so no leading '-' option injection), no '..'.
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

function isValidBranchName(name) {
  const s = String(name || '');
  return s.length > 0 && s.length <= 200 && BRANCH_RE.test(s) && !s.includes('..') && !s.endsWith('.lock');
}

/**
 * PURE. Exit code for a `git ls-remote --exit-code --heads` result.
 * git exits 2 when no ref matched, 0 when one did; anything else is an error.
 */
function exitCodeForLsRemote(gitStatus, stdout, branch) {
  if (gitStatus === 0) {
    const want = `refs/heads/${branch}`;
    const listed = String(stdout || '').split('\n').some((l) => l.split('\t')[1] === want);
    return listed ? 1 : 0;
  }
  if (gitStatus === 2) return 0;
  return 2;
}

function main(argv) {
  if (hasHelpFlag(argv)) {
    console.log('Usage: node scripts/check-remote-branch-absent.js --branch=<name>\nExit 0 when the branch is not on origin, 1 when it is, 2 on a usage or git error.');
    return 0;
  }
  const arg = argv.find((a) => a.startsWith('--branch='));
  const branch = arg ? arg.slice('--branch='.length) : '';
  if (!isValidBranchName(branch)) {
    console.error('Usage: node scripts/check-remote-branch-absent.js --branch=<name>  (letters, digits, . _ - and /; no "..")');
    return 2;
  }
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
    });
  } catch (err) {
    status = typeof err.status === 'number' ? err.status : -1;
    stdout = err.stdout || '';
    if (status !== 2) console.error(`[check-remote-branch-absent] git ls-remote failed: ${String(err.stderr || err.message).trim().slice(0, 200)}`);
  }
  const code = exitCodeForLsRemote(status, stdout, branch);
  if (code === 0) console.log(`[check-remote-branch-absent] PASS: ${branch} is not on origin`);
  else if (code === 1) console.log(`[check-remote-branch-absent] FAIL: ${branch} is still on origin`);
  else console.error(`[check-remote-branch-absent] could not verify ${branch} (git exit ${status})`);
  return code;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { isValidBranchName, exitCodeForLsRemote, BRANCH_RE };
