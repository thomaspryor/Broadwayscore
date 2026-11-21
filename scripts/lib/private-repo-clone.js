'use strict';
/**
 * BRO-7890 item 8: how to clone a private repo (core data, review texts) from any machine.
 * manual-review-direct.js used `gh repo clone`, which goes through GitHub's GraphQL API and 403s in a cloud
 * session (the proxy only authenticates git itself). Same order as scripts/setup-local-data.sh:
 *   1. token (REVIEW_TEXTS_TOKEN / GH_TOKEN): git clone with x-access-token
 *   2. cloud session (CLAUDE_CODE_REMOTE=true): tokenless git clone through the GitHub proxy
 *   3. gh CLI on PATH: gh repo clone (local Mac)
 * Returns the argv to run (no shell), so callers never interpolate a token into a shell string.
 */
const { execFileSync } = require('child_process');

function hasGhCli() {
  try { execFileSync('gh', ['--version'], { stdio: 'ignore', timeout: 10000 }); return true; } catch { return false; }
}

function planPrivateRepoClone(repo, dir, { env = process.env, ghAvailable } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`bad repo slug: ${repo}`);
  const token = env.REVIEW_TEXTS_TOKEN || env.GH_TOKEN || '';
  if (token) {
    return { method: 'token', cmd: 'git', args: ['clone', '--depth', '1', `https://x-access-token:${token}@github.com/${repo}.git`, dir] };
  }
  if (env.CLAUDE_CODE_REMOTE === 'true') {
    return { method: 'proxy', cmd: 'git', args: ['clone', '--depth', '1', `https://github.com/${repo}.git`, dir], env: { GIT_TERMINAL_PROMPT: '0' } };
  }
  if (ghAvailable === undefined ? hasGhCli() : ghAvailable) {
    return { method: 'gh', cmd: 'gh', args: ['repo', 'clone', repo, dir, '--', '--depth', '1'] };
  }
  return null;
}

function clonePrivateRepo(repo, dir, opts = {}) {
  const plan = planPrivateRepoClone(repo, dir, opts);
  if (!plan) throw new Error('No way to clone a private repo: set REVIEW_TEXTS_TOKEN, run in a cloud session, or install gh.');
  try {
    execFileSync(plan.cmd, plan.args, { stdio: 'pipe', env: { ...process.env, ...(plan.env || {}) } });
  } catch (e) {
    // execFileSync's message and stderr echo the argv, which holds the token on the token path: redact for every caller.
    const redact = (v) => String(v || '').replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
    throw new Error(`${plan.method} clone of ${repo} failed: ${redact(e.message)} ${redact(e.stderr)}`.trim());
  }
  // Do not leave the token in <dir>/.git/config, where any later git command or log could print it (review P2).
  if (plan.method === 'token') execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', `https://github.com/${repo}.git`], { stdio: 'ignore' });
  return plan.method;
}

module.exports = { planPrivateRepoClone, clonePrivateRepo };
