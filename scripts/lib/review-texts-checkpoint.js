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

class ReviewTextsLandingError extends ReviewTextsPushError {
  constructor(message, detail = {}) {
    super(message, detail);
    this.name = 'ReviewTextsLandingError';
    this.code = 'EREVIEWTEXTSLANDING';
  }
}

/**
 * Set of absolute paths a run wrote. `.expected` maps a path to the landing
 * key of the record the run wrote there (gap-acceptance sets it), so the
 * checkpoint confirms OUR text + url landed, not whatever another writer left.
 */
function createWriteTracker() {
  const s = new Set();
  s.expected = new Map();
  // Paths the run deleted on purpose; also add them to the set itself.
  s.deleted = new Set();
  return s;
}

function pendingPathDefault() {
  return process.env.REVIEW_TEXTS_PENDING_PATH
    || path.join(os.homedir(), '.broadwayscore-state', 'review-texts-pending-push.json');
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/** Landing key of a review record: its fullText and url together. */
function landingKey(obj) {
  return sha256(JSON.stringify([typeof obj.fullText === 'string' ? obj.fullText : null, obj.url || null]));
}

/** Landing key of a review file's content (whole-content hash if not JSON). */
function contentKey(text) {
  if (text == null) return null;
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' ? landingKey(j) : sha256(text);
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

/**
 * Repo-relative path through the data/review-texts symlink. A deleted path's
 * parent may be gone too (a cleanup that removed the emptied show dir), so
 * resolve through the nearest ancestor that still exists.
 */
function relPath(realRepo, absPath) {
  let base = path.resolve(absPath);
  const tail = [];
  let p = null;
  while (p === null) {
    try { p = path.join(fs.realpathSync(base), ...tail); } catch {
      const up = path.dirname(base);
      if (up === base) throw new Error(`review-texts-checkpoint: cannot resolve ${absPath}`);
      tail.unshift(path.basename(base));
      base = up;
    }
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
    // BRO-5308: a CI job that pushed review-texts mid-run tells
    // push-review-texts so the scoring/rebuild gate still fires (no-op off CI).
    try { require('./review-texts-pushed-marker').markReviewTextsPushed(); } catch { /* fail-open */ }
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
    // A run that deleted a file (committed content null) has landed when
    // origin/main no longer has it either (BRO-7171 local writers delete files).
    const landed = p.fullTextHash == null && p.committedKey == null
      ? remote === null
      : remote !== null && contentKey(remote) === p.fullTextHash;
    return { ...p, landedBlob: blobOrNull(repo, 'origin/main', p.rel), landed };
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
    onLanded({ path: p.rel, absPath: p.abs, blob: p.landedBlob, fullTextHash: p.fullTextHash, commit: entry.commit, meta: entry.meta || null, ...(p.renamedFrom ? { renamedFrom: p.renamedFrom } : {}) });
  }
}

/**
 * BRO-8276: a path we committed content to that origin/main no longer has.
 * push-with-retry resolves a modify/delete rebase conflict by accepting the
 * deletion (a byline rename, thestage--unknown -> thestage--dave-fargnoli),
 * so our text is not lost in git but is not on origin either.
 */
function isGoneUpstream(r) {
  return !r.landed && r.landedBlob == null && r.committedKey != null && !!r.blob;
}

function groupBy(list, keyOf) {
  const m = new Map();
  for (const x of list) { const k = keyOf(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

function parseOrNull(text) {
  try { const j = JSON.parse(text); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
}

/**
 * Fast-forward the review-texts checkout to origin/main when it holds no
 * unpushed commit (never a reset, never a merge commit). A dirty file the
 * fast-forward would overwrite makes git refuse: reported, not forced.
 * Call under the review-texts lock.
 * @returns {{ok: boolean, reason: string}}
 */
function syncCheckoutToOrigin(repo, { fetch = true } = {}) {
  if (fetch) refreshOrigin(repo);
  const unpushed = countUnpushedCommits(repo);
  if (!Number.isFinite(unpushed)) return { ok: false, reason: 'cannot count unpushed commits' };
  if (unpushed > 0) return { ok: false, reason: `${unpushed} unpushed commit(s)` };
  try {
    git(repo, ['merge', '--ff-only', '--quiet', 'origin/main']);
    return { ok: true, reason: 'fast-forwarded' };
  } catch (e) {
    return { ok: false, reason: String(e.stderr || e.message).trim().split('\n')[0].slice(0, 200) };
  }
}

/**
 * The file a gone path's record lives in now: same show dir on origin/main,
 * stamped `_renamedFrom.file === rel` by safeRenameReview, else the same
 * outlet's record at the same article url (ours or the pre-push one). Never
 * an outlet-only match: that could be another critic's review.
 */
function findSuccessor(repo, rel, { ours, parent }) {
  const dir = path.posix.dirname(rel);
  let names = [];
  try { names = git(repo, ['ls-tree', '--name-only', 'origin/main', `${dir}/`]).split('\n').filter((n) => n.endsWith('.json')); } catch { return null; }
  const recs = names.filter((n) => n !== rel).map((n) => ({ rel: n, rec: parseOrNull(showOrNull(repo, 'origin/main', n)) })).filter((x) => x.rec);
  const stamped = recs.filter((x) => x.rec._renamedFrom && x.rec._renamedFrom.file === rel);
  if (stamped.length === 1) return stamped[0];
  const { urlCanonicallyChanged } = require('./url-change-invariant');
  const urls = [ours && ours.url, parent && parent.url].filter(Boolean);
  const outletId = (ours && ours.outletId) || (parent && parent.outletId) || path.posix.basename(rel).split('--')[0];
  const sameUrl = recs.filter((x) => x.rec.url && (x.rec.outletId || path.posix.basename(x.rel).split('--')[0]) === outletId
    && urls.some((u) => { try { return !urlCanonicallyChanged(u, x.rec.url); } catch { return false; } }));
  return sameUrl.length === 1 ? sameUrl[0] : null;
}

/**
 * Carry the text a run committed to a now-gone path onto its successor
 * (three-way merge: base = what origin held before our push, upstream = the
 * successor, ours = our commit) and write it through safeWriteReview.
 * Call under the review-texts lock with the checkout at origin/main.
 * @returns {{moved: {fromRel, rel, abs, key}[], superseded: {rel, why}[]}}
 */
function carryOntoSuccessors(repo, gone) {
  const moved = [];
  const superseded = [];
  if (!gone.length) return { moved, superseded };
  let synced = null;
  for (const g of gone) {
    const blobText = (sha) => { try { return sha ? git(repo, ['cat-file', 'blob', sha]) : null; } catch { return null; } };
    const ours = parseOrNull(blobText(g.blob));
    const parent = parseOrNull(blobText(g.parentBlob));
    if (!ours) { superseded.push({ rel: g.rel, why: 'committed blob no longer in the object store' }); continue; }
    const succ = findSuccessor(repo, g.rel, { ours, parent });
    if (!succ) { superseded.push({ rel: g.rel, why: 'removed upstream, no successor file' }); continue; }
    const abs = path.join(repo, succ.rel);
    // The checkout must hold origin's successor before we write over it.
    if (blobOrNull(repo, 'HEAD', succ.rel) !== blobOrNull(repo, 'origin/main', succ.rel)) {
      if (!synced) synced = syncCheckoutToOrigin(repo, { fetch: false });
      if (blobOrNull(repo, 'HEAD', succ.rel) !== blobOrNull(repo, 'origin/main', succ.rel)) {
        superseded.push({ rel: g.rel, why: `successor ${succ.rel} not in this checkout (${synced.reason})` });
        continue;
      }
    }
    const onDisk = fs.existsSync(abs) ? parseOrNull(fs.readFileSync(abs, 'utf8')) : null;
    if (!onDisk) { superseded.push({ rel: g.rel, why: `successor ${succ.rel} unreadable` }); continue; }
    if (landingKey(onDisk) === landingKey(ours)) { moved.push({ fromRel: g.rel, rel: succ.rel, abs, key: landingKey(onDisk), alreadyThere: true }); continue; }
    const { mergeReviewJson } = require('./review-json-three-way-merge');
    const { merged } = mergeReviewJson(parent, onDisk, ours, { tie: 'upstream' });
    if (merged.fullText !== ours.fullText) {
      superseded.push({ rel: g.rel, why: `successor ${succ.rel} holds a newer text` });
      continue;
    }
    const { safeWriteReview } = require('./review-write-guard');
    const w = safeWriteReview(abs, merged, { merge: false });
    const after = parseOrNull(fs.readFileSync(abs, 'utf8'));
    if ((w && w.wrote === false) || !after || after.fullText !== ours.fullText) {
      superseded.push({ rel: g.rel, why: `write to successor ${succ.rel} refused${w && w.skipped ? ` (${w.skipped})` : ''}` });
      continue;
    }
    moved.push({ fromRel: g.rel, rel: succ.rel, abs, key: landingKey(after) });
  }
  return { moved, superseded };
}

/**
 * Land carried-over text on the successor files (re-entrant under the lock).
 * onLanded fires for the successor with renamedFrom = the gone path.
 * @returns {{landed: object[], superseded: object[]}}
 */
function landOnSuccessors(repo, gone, { onLanded, meta, pendingPath, pushScript, pushEnv, retries }) {
  const { moved, superseded } = carryOntoSuccessors(repo, gone);
  if (!moved.length) return { landed: [], superseded };
  const res = checkpointReviewTexts({
    repoDir: repo,
    paths: moved.map((m) => m.abs),
    expected: new Map(moved.map((m) => [m.abs, m.key])),
    renamedFrom: new Map(moved.map((m) => [m.rel, m.fromRel])),
    message: `fix: land recovered text on ${moved.length} renamed review file(s) (BRO-8276)`,
    onLanded, meta, pendingPath, pushScript, pushEnv, retries,
  });
  return { landed: res.landed, superseded: [...superseded, ...(res.superseded || [])] };
}

/**
 * Commit + push exactly `paths`. Throws ReviewTextsPushError when the push
 * fails (pending entry kept for retryPendingPushes).
 *
 * @param {object} args
 * @param {string} args.repoDir         review-texts checkout (symlink ok)
 * @param {Iterable<string>} args.paths absolute paths this run wrote
 * @param {Iterable<string>} [args.deleted] paths the run deleted on purpose
 *                                      (default paths.deleted from createWriteTracker)
 * @param {string} args.message         commit message
 * @param {(landed: object) => void} [args.onLanded]
 * @param {object} [args.meta]          carried into the pending entry and onLanded
 * @param {string} [args.pendingPath]
 * @param {string} [args.pushScript]    test override of push-with-retry.sh
 * @param {object} [args.pushEnv]
 * @returns {{committed: boolean, pushed: boolean, commit: string|null, landed: object[], notLanded: object[]}}
 */
function checkpointReviewTexts({ repoDir, paths, expected, deleted, message, onLanded, meta, pendingPath = pendingPathDefault(), pushScript, pushEnv, retries, renamedFrom }) {
  const repo = fs.realpathSync(repoDir);
  const expectedByRel = new Map();
  const deletedSet = deleted || paths.deleted;
  const deletedRels = new Set(deletedSet ? [...deletedSet].map((p) => relPath(repo, p)) : []);
  const allRels = [...new Set([...paths, ...(deletedSet || [])].map((p) => {
    const rel = relPath(repo, p);
    if (expected && expected.has(p)) expectedByRel.set(rel, expected.get(p));
    return rel;
  }))].sort();
  if (!allRels.length) return { committed: false, pushed: false, commit: null, landed: [], notLanded: [] };
  return withReviewTextsLock(`checkpoint:${message.slice(0, 60)}`, () => {
    // A path that is gone and was never committed would make `git add` fail
    // and wedge every later checkpoint of the run; there is nothing to land.
    // That is a lost write, unless the run deleted it on purpose (`deleted`):
    // removing a file that was never committed is a no-op, not a failure.
    const rels = allRels.filter((rel) => fs.existsSync(path.join(repo, rel)) || blobOrNull(repo, 'HEAD', rel));
    const vanished = allRels.filter((rel) => !rels.includes(rel) && !deletedRels.has(rel)).map((rel) => ({ rel, abs: path.join(repo, rel), landed: false, why: 'file vanished before commit' }));
    if (!rels.length) return { committed: false, pushed: false, commit: null, landed: [], notLanded: vanished };
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
          fullTextHash: expectedByRel.get(rel) || contentKey(content),
          committedKey: contentKey(content),
          blob: blobOrNull(repo, 'HEAD', rel),
          // The baseline a wiped commit may be restored over: what origin/main
          // held before this push (HEAD~1 may itself be an unpushed commit).
          parentBlob: blobOrNull(repo, 'origin/main', rel),
          // BRO-8276: carried onto this successor from a path gone upstream;
          // kept in the journal so a later retry still reports the move.
          ...(renamedFrom && renamedFrom.has(rel) ? { renamedFrom: renamedFrom.get(rel) } : {}),
        };
      }),
    };
    // Another writer replaced our record between our write and this commit:
    // what got committed is not the recovery. Report it lost (it never existed
    // in git, so it cannot be restored) and keep it out of the landed set.
    const lost = entry.paths.filter((p) => expectedByRel.has(p.rel) && p.committedKey !== p.fullTextHash)
      .map((p) => ({ ...p, landed: false, why: 'overwritten by another writer before commit' }));
    const lostRels = new Set(lost.map((p) => p.rel));
    entry.paths = entry.paths.filter((p) => !lostRels.has(p.rel));
    const failLanding = (notLanded, landed, pushed) => {
      const all = [...lost, ...vanished, ...notLanded];
      throw new ReviewTextsLandingError(
        `review-texts: ${all.length} recovered file(s) did not land as written (${all.map((r) => `${r.rel}: ${r.why || 'not on origin/main after push'}`).join('; ').slice(0, 600)})`,
        { commit, pendingPath, pushed, landed, notLanded: all },
      );
    };
    const action = decideCheckpointAction({ hasStagedChanges: committed, unpushedCommits: countUnpushedCommits(repo) });
    if (action === 'skip') {
      // Nothing of ours to commit or push: another writer already committed
      // these files. Landed only if origin/main really has our text.
      const res = confirmLanding(repo, entry.paths);
      const landed = res.filter((r) => r.landed);
      const notLanded = res.filter((r) => !r.landed);
      fireLanded(onLanded, landed, entry);
      if (notLanded.length) {
        // Committed by someone else and not on origin yet: keep them pending
        // so the next run confirms (and reports) them instead of losing them.
        const keep = new Set(notLanded.map((r) => r.rel));
        writePending(pendingPath, [...readPending(pendingPath), { ...entry, paths: entry.paths.filter((p) => keep.has(p.rel)) }]);
      }
      if (lost.length || vanished.length) failLanding([], landed, false);
      return { committed: false, pushed: false, commit, landed, notLanded, renamed: [], superseded: [] };
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
    // BRO-8276: renamed or removed upstream between plan and push. Not a lost
    // write and never a reason to stop the run: carry it onto the successor.
    const gone = res.filter(isGoneUpstream);
    const notLanded = res.filter((r) => !r.landed && !isGoneUpstream(r));
    // Paths still missing from origin/main after a successful push stay in the
    // ledger for the next run's retry; only landed (or resolved) ones leave it.
    const keep = new Set(notLanded.map((r) => r.rel));
    writePending(pendingPath, readPending(pendingPath).map((e) => (e.id === entry.id ? { ...e, paths: e.paths.filter((p) => keep.has(p.rel)) } : e)).filter((e) => e.paths.length));
    fireLanded(onLanded, landed, entry);
    const moved = landOnSuccessors(repo, gone, { onLanded, meta: entry.meta, pendingPath, pushScript, pushEnv, retries });
    if (notLanded.length || lost.length || vanished.length) failLanding(notLanded, [...landed, ...moved.landed], true);
    return { committed, pushed: true, commit, landed, notLanded, renamed: moved.landed, superseded: moved.superseded };
  });
}

/**
 * Run before any new work. Pushes leftover commits, confirms pending paths by
 * content, restores wiped commits when safe. Throws ReviewTextsPushError when
 * the push still fails.
 * @returns {{entries: number, landed: object[], restored: object[], notLanded: object[]}}
 */
function retryPendingPushes({ repoDir, onLanded, pendingPath = pendingPathDefault(), pushScript, pushEnv, retries }) {
  const repo = fs.realpathSync(repoDir);
  return withReviewTextsLock('checkpoint:retry-pending', () => {
    const entries = readPending(pendingPath);
    // A run that died between its commit and its pending entry leaves an
    // unpushed commit with no record: push it even with no entries.
    const unpushed = countUnpushedCommits(repo);
    if (Number.isFinite(unpushed) && unpushed > 0) {
      const push = runPush(repo, { pushScript, pushEnv, retries });
      if (!push.ok) {
        throw new ReviewTextsPushError(`review-texts pending push still failing (exit ${push.status}); ${entries.length} pending checkpoint(s) in ${pendingPath}`, { pendingPath, output: push.output });
      }
    }
    const out = { entries: entries.length, landed: [], restored: [], notLanded: [], renamed: [], superseded: [] };
    if (!entries.length) return out;
    const toRestore = [];
    const gone = [];
    // Newest first: when two unpushed checkpoints wrote the same file, the
    // newer one is the record to restore and the older one is superseded.
    const claimed = new Set();
    for (const entry of [...entries].reverse()) {
      const res = confirmLanding(repo, entry.paths.filter((p) => !claimed.has(p.rel)));
      for (const p of entry.paths) claimed.add(p.rel);
      const landed = res.filter((r) => r.landed);
      out.landed.push(...landed);
      fireLanded(onLanded, landed, entry);
      // BRO-8276: gone from origin (renamed upstream): carried onto the successor below.
      gone.push(...res.filter(isGoneUpstream).map((r) => ({ ...r, entry })));
      for (const r of res.filter((x) => !x.landed && !isGoneUpstream(x))) {
        // The commit is gone (reset --hard) or never carried this path.
        // Restore only when nothing moved on since our commit's parent:
        // the remote still holds the parent blob and the working tree holds
        // either the parent or our committed content.
        const abs = path.join(repo, r.rel);
        // Hash the file by path (same filters `git add` applies); stdin is
        // closed in git() so `--stdin` would hash an empty blob.
        const wtBlob = fs.existsSync(abs) ? git(repo, ['hash-object', '--', abs]).trim() : null;
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
    // Entries with nothing to restore are resolved (landed or terminal). An
    // entry being restored leaves the journal only once the restore
    // checkpoint has recorded its own pending entry (it does so before
    // pushing, so a ReviewTextsPushError means it did): a crash or a git
    // failure before that keeps the original record for the next run.
    // Carried onto successors before the journal forgets the gone paths; a
    // push failure here throws with the journal still holding them.
    for (const list of groupBy(gone, (g) => g.entry.id).values()) {
      const moved = landOnSuccessors(repo, list, { onLanded, meta: list[0].entry.meta, pendingPath, pushScript, pushEnv, retries });
      out.renamed.push(...moved.landed);
      out.superseded.push(...moved.superseded);
    }
    const restoring = new Set(toRestore.map((r) => r.entry.id));
    const dropEntries = (ids) => writePending(pendingPath, readPending(pendingPath).filter((e) => !ids.has(e.id)));
    dropEntries(new Set(entries.filter((e) => !restoring.has(e.id)).map((e) => e.id)));
    if (toRestore.length) {
      let res;
      try {
        res = checkpointReviewTexts({
          repoDir: repo,
          paths: toRestore.map((r) => path.join(repo, r.rel)),
          expected: new Map(toRestore.map((r) => [path.join(repo, r.rel), r.fullTextHash])),
          message: `fix: restore ${toRestore.length} review file(s) whose pending commit was lost before push (BRO-7171)`,
          onLanded,
          meta: { restoredFrom: toRestore.map((r) => r.entry.id) },
          pendingPath, pushScript, pushEnv, retries,
        });
      } catch (e) {
        if (e instanceof ReviewTextsPushError) dropEntries(restoring);
        throw e;
      }
      dropEntries(restoring);
      out.restored.push(...res.landed);
    }
    return out;
  });
}

module.exports = {
  checkpointReviewTexts,
  retryPendingPushes,
  createWriteTracker,
  ReviewTextsPushError,
  ReviewTextsLandingError,
  contentKey,
  landingKey,
  readPending,
  pendingPathDefault,
  syncCheckoutToOrigin,
  findSuccessor,
};
