/**
 * review-texts-checkpoint.js — commit and push ONLY the review files a run
 * wrote, treat a failed push as a failure, and report a review as landed only
 * once its text is on origin/main (BRO-7171 Stage 1).
 *
 * Replaces three hand-rolled checkpoints (browser-recovery-helpers.js,
 * recover-wsj-browser.js, recover-serp-text.js) that each ran `git add -A` in
 * the shared ~/broadway-review-texts checkout, sweeping up whatever any other
 * local writer had half-written, and then swallowed a failed push with a
 * console WARNING while the run went on counting "recovered" reviews that
 * existed only on this disk.
 *
 * Contract:
 *   - callers record every file they write in a tracker (createWriteTracker);
 *   - checkpointReviewTexts() stages and commits exactly those paths
 *     (`git add -A -- <paths>`, `git commit --only -- <paths>`), records a
 *     pending entry BEFORE pushing, pushes through push-with-retry.sh, then
 *     confirms each path's fullText is what origin/main holds;
 *   - a push failure throws ReviewTextsPushError and leaves the pending entry;
 *   - onLanded fires per path only after that confirmation (the Stage 2
 *     ledger's 'recovered' row hangs off it);
 *   - retryPendingPushes() runs at the start of the next run, before any new
 *     work: it pushes what is still unpushed and, when a concurrent
 *     `reset --hard` wiped the commit, restores the committed content from
 *     git's object store if neither the remote nor the working tree has moved
 *     on since.
 * All git work happens under the machine-wide review-texts lock.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { withReviewTextsLock } = require('./review-texts-lock');
const { countUnpushedCommits, decideCheckpointAction } = require('./review-texts-checkpoint-gate');

const PUSH_WITH_RETRY = path.join(__dirname, 'push-with-retry.sh');

class ReviewTextsPushError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ReviewTextsPushError';
    this.code = 'EREVIEWTEXTSPUSH';
    Object.assign(this, detail);
  }
}

function createWriteTracker() {
  return new Set();
}

function pendingPathDefault() {
  return process.env.REVIEW_TEXTS_PENDING_PATH
    || path.join(os.homedir(), '.broadwayscore-state', 'review-texts-pending-push.json');
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/** Hash of a review file's fullText (falls back to the whole content). */
function contentKey(text) {
  if (text == null) return null;
  try {
    const j = JSON.parse(text);
    return sha256(typeof j.fullText === 'string' ? j.fullText : text);
  } catch {
    return sha256(text);
  }
}

function git(repo, args, opts = {}) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts });
}

function gitOk(repo, args) {
  try { git(repo, args); return true; } catch { return false; }
}

function showOrNull(repo, rev, rel) {
  try { return git(repo, ['show', `${rev}:${rel}`]); } catch { return null; }
}

function blobOrNull(repo, rev, rel) {
  try { return git(repo, ['rev-parse', '--verify', '--quiet', `${rev}:${rel}`]).trim() || null; } catch { return null; }
}

/** Repo-relative path through the data/review-texts symlink. */
function relPath(realRepo, absPath) {
  let p;
  try { p = fs.realpathSync(absPath); } catch {
    p = path.join(fs.realpathSync(path.dirname(absPath)), path.basename(absPath));
  }
  const rel = path.relative(realRepo, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`review-texts-checkpoint: ${absPath} is outside ${realRepo}`);
  return rel.split(path.sep).join('/');
}

function readPending(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j.entries) ? j.entries : [];
  } catch { return []; }
}

function writePending(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ entries, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function runPush(repo, opts) {
  const env = {
    ...process.env,
    // Bound the hold: push-with-retry's own mutex wait defaults to 900s and
    // its loop to 240s; the review-texts lock is held across this call.
    PUSH_LOCK_TIMEOUT_SEC: process.env.PUSH_LOCK_TIMEOUT_SEC || '300',
    PUSH_DEADLINE_SEC: process.env.PUSH_DEADLINE_SEC || '240',
    ...(opts.pushEnv || {}),
  };
  try {
    const out = execFileSync('bash', [opts.pushScript || PUSH_WITH_RETRY, String(opts.retries || 5)], {
      cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.pushTimeoutMs || 12 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, output: out };
  } catch (e) {
    return { ok: false, status: e.status, output: `${e.stdout || ''}${e.stderr || ''}`.slice(-4000) };
  }
}

function refreshOrigin(repo) {
  let depth = [];
  try { depth = require('./shallow-fetch-args').repoDepthArgs({ repoRoot: repo }); } catch { depth = ['--deepen=200']; }
  gitOk(repo, ['fetch', '--quiet', ...depth, 'origin', 'main']);
}

/** Paths whose origin/main fullText equals what we committed. */
function confirmLanding(repo, paths) {
  const check = () => paths.map((p) => {
    const remote = showOrNull(repo, 'origin/main', p.rel);
    return { ...p, landedBlob: blobOrNull(repo, 'origin/main', p.rel), landed: remote !== null && contentKey(remote) === p.fullTextHash };
  });
  let res = check();
  if (res.some((r) => !r.landed)) {
    // The Git Data API fallback can land content without moving our
    // tracking ref; look at the real remote before calling anything lost.
    refreshOrigin(repo);
    res = check();
  }
  return res;
}

function fireLanded(onLanded, landed, entry) {
  if (!onLanded) return;
  for (const p of landed) {
    onLanded({ path: p.rel, absPath: p.abs, blob: p.landedBlob, fullTextHash: p.fullTextHash, commit: entry.commit, meta: entry.meta || null });
  }
}

/**
 * Commit + push exactly `paths`. Throws ReviewTextsPushError when the push
 * fails (pending entry kept for retryPendingPushes).
 *
 * @param {object} args
 * @param {string} args.repoDir         review-texts checkout (symlink ok)
 * @param {Iterable<string>} args.paths absolute paths this run wrote
 * @param {string} args.message         commit message
 * @param {(landed: object) => void} [args.onLanded]
 * @param {object} [args.meta]          carried into the pending entry and onLanded
 * @param {string} [args.pendingPath]
 * @param {string} [args.pushScript]    test override of push-with-retry.sh
 * @param {object} [args.pushEnv]
 * @returns {{committed: boolean, pushed: boolean, commit: string|null, landed: object[], notLanded: object[]}}
 */
function checkpointReviewTexts({ repoDir, paths, message, onLanded, meta, pendingPath = pendingPathDefault(), pushScript, pushEnv, retries }) {
  const repo = fs.realpathSync(repoDir);
  const rels = [...new Set([...paths].map((p) => relPath(repo, p)))].sort();
  if (!rels.length) return { committed: false, pushed: false, commit: null, landed: [], notLanded: [] };
  return withReviewTextsLock(`checkpoint:${message.slice(0, 60)}`, () => {
    git(repo, ['add', '-A', '--', ...rels]);
    const hasStagedChanges = !gitOk(repo, ['diff', '--cached', '--quiet', '--', ...rels]);
    let committed = false;
    if (hasStagedChanges) {
      git(repo, ['commit', '--quiet', '-m', message, '--only', '--', ...rels]);
      committed = true;
    }
    const commit = git(repo, ['rev-parse', 'HEAD']).trim();
    const entry = {
      id: `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      message,
      commit,
      meta: meta || null,
      paths: rels.map((rel) => {
        const content = showOrNull(repo, 'HEAD', rel);
        return {
          rel,
          abs: path.join(repo, rel),
          fullTextHash: contentKey(content),
          blob: blobOrNull(repo, 'HEAD', rel),
          parentBlob: committed ? blobOrNull(repo, 'HEAD~1', rel) : null,
        };
      }),
    };
    const action = decideCheckpointAction({ hasStagedChanges: committed, unpushedCommits: countUnpushedCommits(repo) });
    if (action === 'skip') {
      // Nothing of ours to commit or push: another writer already committed
      // these files. Landed only if origin/main really has our text.
      const res = confirmLanding(repo, entry.paths);
      const landed = res.filter((r) => r.landed);
      fireLanded(onLanded, landed, entry);
      return { committed: false, pushed: false, commit, landed, notLanded: res.filter((r) => !r.landed) };
    }
    const pending = readPending(pendingPath);
    pending.push(entry);
    writePending(pendingPath, pending);

    const push = runPush(repo, { pushScript, pushEnv, retries });
    if (!push.ok) {
      throw new ReviewTextsPushError(`review-texts push failed (exit ${push.status}); ${rels.length} file(s) committed locally as ${commit.slice(0, 11)} and recorded pending in ${pendingPath}`, { commit, pendingPath, paths: rels, output: push.output });
    }
    const res = confirmLanding(repo, entry.paths);
    const landed = res.filter((r) => r.landed);
    const notLanded = res.filter((r) => !r.landed);
    writePending(pendingPath, readPending(pendingPath).filter((e) => e.id !== entry.id));
    fireLanded(onLanded, landed, entry);
    return { committed, pushed: true, commit, landed, notLanded };
  });
}

/**
 * Run before any new work. Pushes leftover commits, confirms pending paths by
 * content, restores wiped commits when safe. Throws ReviewTextsPushError when
 * the push still fails.
 * @returns {{entries: number, landed: object[], restored: object[], notLanded: object[]}}
 */
function retryPendingPushes({ repoDir, onLanded, pendingPath = pendingPathDefault(), pushScript, pushEnv, retries }) {
  const entries = readPending(pendingPath);
  if (!entries.length) return { entries: 0, landed: [], restored: [], notLanded: [] };
  const repo = fs.realpathSync(repoDir);
  return withReviewTextsLock('checkpoint:retry-pending', () => {
    const unpushed = countUnpushedCommits(repo);
    if (Number.isFinite(unpushed) && unpushed > 0) {
      const push = runPush(repo, { pushScript, pushEnv, retries });
      if (!push.ok) {
        throw new ReviewTextsPushError(`review-texts pending push still failing (exit ${push.status}); ${entries.length} pending checkpoint(s) in ${pendingPath}`, { pendingPath, output: push.output });
      }
    }
    const out = { entries: entries.length, landed: [], restored: [], notLanded: [] };
    const toRestore = [];
    for (const entry of entries) {
      const res = confirmLanding(repo, entry.paths);
      const landed = res.filter((r) => r.landed);
      out.landed.push(...landed);
      fireLanded(onLanded, landed, entry);
      for (const r of res.filter((x) => !x.landed)) {
        // The commit is gone (reset --hard) or never carried this path.
        // Restore only when nothing moved on since our commit's parent:
        // the remote still holds the parent blob and the working tree holds
        // either the parent or our committed content.
        const abs = path.join(repo, r.rel);
        let wt = null;
        try { wt = fs.readFileSync(abs, 'utf8'); } catch { /* deleted */ }
        const wtBlob = wt === null ? null : git(repo, ['hash-object', '--stdin'], { input: wt }).trim();
        const remoteUnmoved = r.landedBlob === r.parentBlob;
        const wtUnmoved = wtBlob === r.parentBlob || wtBlob === r.blob;
        const haveBlob = !!r.blob && gitOk(repo, ['cat-file', '-e', `${r.blob}^{blob}`]);
        if (remoteUnmoved && wtUnmoved && haveBlob) {
          if (wtBlob !== r.blob) fs.writeFileSync(abs, git(repo, ['cat-file', 'blob', r.blob]));
          toRestore.push({ ...r, entry });
        } else {
          out.notLanded.push({ ...r, why: !remoteUnmoved ? 'remote changed the file since our commit' : !wtUnmoved ? 'working tree changed the file since our commit' : 'committed blob no longer in the object store' });
        }
      }
    }
    // Every pending entry is now resolved (landed, terminal, or re-queued
    // below through a fresh checkpoint with its own pending entry).
    writePending(pendingPath, readPending(pendingPath).filter((e) => !entries.some((x) => x.id === e.id)));
    if (toRestore.length) {
      const res = checkpointReviewTexts({
        repoDir: repo,
        paths: toRestore.map((r) => path.join(repo, r.rel)),
        message: `fix: restore ${toRestore.length} review file(s) whose pending commit was lost before push (BRO-7171)`,
        onLanded,
        meta: { restoredFrom: toRestore.map((r) => r.entry.id) },
        pendingPath, pushScript, pushEnv, retries,
      });
      out.restored.push(...res.landed);
      out.notLanded.push(...res.notLanded.map((r) => ({ ...r, why: 'restored but not on origin/main after push' })));
    }
    return out;
  });
}

module.exports = {
  checkpointReviewTexts,
  retryPendingPushes,
  createWriteTracker,
  ReviewTextsPushError,
  contentKey,
  readPending,
  pendingPathDefault,
};
