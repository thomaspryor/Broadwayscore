'use strict';
/**
 * Cross-machine persistence for the night lease (BRO-4786, BRO-4210 phase 2d).
 *
 * The lane is armed from a GitHub Actions job and from the Mac launchd backup. A lease file on
 * one disk cannot arbitrate between them, so the state lives in a git branch
 * (`opening-night-leases`, file data/opening-night/leases.json) and every change is a
 * compare-and-swap: build a commit on top of the remote tip, then push WITHOUT force. A push
 * that is not a fast-forward is rejected by the remote, which means someone else moved the
 * branch since we read it; we re-read, re-run the pure transition from lease.js and try again.
 * Exactly one of two simultaneous starters can win a given tip.
 *
 * Plumbing only (hash-object / update-index on a private index / commit-tree): the caller's
 * working tree, index and checked-out branch are never touched, so this is safe to run from
 * any checkout, including a dirty one.
 *
 * The branch is its own history (no shared ancestor with main) so a lease commit can never
 * ride along with a code merge and main's "no direct push" rule is not involved.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const lease = require('./lease');

const DEFAULT_BRANCH = 'opening-night-leases';
const DEFAULT_FILE = 'data/opening-night/leases.json';

function git(repoDir, args, { env, input, allowFail } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: repoDir, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(env || {}) },
    }).trim();
  } catch (e) {
    if (allowFail) return null;
    const err = new Error(`git ${args[0]} failed: ${String((e.stderr || e.message) || '').trim().slice(0, 300)}`);
    err.stderr = String(e.stderr || '');
    throw err;
  }
}

/** Tip of the remote branch as {sha, state}, or {sha:null, state: empty} when the branch does not exist yet. Throws on any other failure. */
function readRemote({ repoDir, remote = 'origin', branch = DEFAULT_BRANCH, file = DEFAULT_FILE }) {
  const listed = git(repoDir, ['ls-remote', '--heads', remote, `refs/heads/${branch}`]);
  if (!listed) return { sha: null, state: lease.emptyState() };
  git(repoDir, ['fetch', '--no-tags', '--quiet', remote, `+refs/heads/${branch}:refs/opening-night-lane/${branch}`]);
  const sha = git(repoDir, ['rev-parse', `refs/opening-night-lane/${branch}`]);
  const text = git(repoDir, ['show', `${sha}:${file}`], { allowFail: true });
  if (text === null) return { sha, state: lease.emptyState() };
  const parsed = JSON.parse(text); // corrupt state throws: refuse, never assume empty
  if (!parsed || typeof parsed.leases !== 'object' || !parsed.leases) throw new Error('remote lease state has no leases object');
  return { sha, state: parsed };
}

/** Commit `state` as the new content of `file` on top of `parentSha` (or as a root commit) without touching the work tree. */
function commitState({ repoDir, parentSha, state, file, message }) {
  const idx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ontl-idx-')), 'index');
  const env = {
    GIT_INDEX_FILE: idx,
    GIT_AUTHOR_NAME: 'opening-night-lane', GIT_AUTHOR_EMAIL: 'lane@broadwayscorecard.com',
    GIT_COMMITTER_NAME: 'opening-night-lane', GIT_COMMITTER_EMAIL: 'lane@broadwayscorecard.com',
  };
  try {
    const blob = git(repoDir, ['hash-object', '-w', '--stdin'], { input: JSON.stringify(state, null, 2) + '\n' });
    git(repoDir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { env });
    const tree = git(repoDir, ['write-tree'], { env });
    return git(repoDir, ['commit-tree', tree, ...(parentSha ? ['-p', parentSha] : []), '-m', message], { env });
  } finally {
    try { fs.rmSync(path.dirname(idx), { recursive: true, force: true }); } catch { /* temp only */ }
  }
}

/**
 * Apply one pure transition (acquire/heartbeat/release from lease.js, or any (state)=>{ok,state,...})
 * with compare-and-swap. Returns the transition result plus {attempts}. A refused transition
 * (held-by-other, expired, ...) never pushes. Network/state failures return {ok:false, reason}
 * and are never read as a grant: fail closed.
 */
function casTransition(opts, fn) {
  const { repoDir, remote = 'origin', branch = DEFAULT_BRANCH, file = DEFAULT_FILE, maxAttempts = 6, message = 'opening-night lease', sleep = defaultSleep } = opts;
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let tip;
    try { tip = readRemote({ repoDir, remote, branch, file }); } catch (e) {
      return { ok: false, reason: 'state-unreadable', detail: String(e.message).slice(0, 200), attempts: attempt };
    }
    const out = fn(tip.state);
    if (!out.ok) return { ...out, attempts: attempt };
    const next = lease.sweepExpired(out.state, { now: opts.now });
    let sha;
    try { sha = commitState({ repoDir, parentSha: tip.sha, state: next, file, message }); } catch (e) {
      return { ok: false, reason: 'commit-failed', detail: String(e.message).slice(0, 200), attempts: attempt };
    }
    try {
      git(repoDir, ['push', '--quiet', remote, `${sha}:refs/heads/${branch}`]); // no force: rejected unless fast-forward
      return { ...out, state: next, attempts: attempt };
    } catch (e) {
      last = e;
      if (!/rejected|non-fast-forward|fetch first|stale info|cannot lock ref|failed to update ref/i.test(e.stderr || e.message)) {
        return { ok: false, reason: 'push-failed', detail: String(e.message).slice(0, 200), attempts: attempt };
      }
      sleep(Math.floor(Math.random() * 400) * attempt); // lost the race: jittered retry against the new tip
    }
  }
  return { ok: false, reason: 'cas-contended', detail: last ? String(last.message).slice(0, 200) : '', attempts: maxAttempts };
}

function defaultSleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

const claim = (opts, args) => casTransition(opts, (s) => lease.acquire(s, { ...args, now: opts.now }));
const heartbeat = (opts, args) => casTransition(opts, (s) => lease.heartbeat(s, { ...args, now: opts.now }));
const release = (opts, args) => casTransition(opts, (s) => lease.release(s, args));

/** Write the remote state to the local file the skip guard reads. Branch missing = empty file. Throws if the remote cannot be read. */
function syncLocalFile(opts, localFile) {
  const { state } = readRemote(opts);
  fs.mkdirSync(path.dirname(localFile), { recursive: true });
  fs.writeFileSync(localFile, JSON.stringify(state, null, 2) + '\n');
  return state;
}

module.exports = { DEFAULT_BRANCH, DEFAULT_FILE, readRemote, commitState, casTransition, claim, heartbeat, release, syncLocalFile };
