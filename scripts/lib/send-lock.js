/**
 * Cross-session send lock for the opening-night broadcast path.
 *
 * Problem: after PR #233 closed the UTC-day dedup + CLI/workflow state gap,
 * there's still a narrow race window where two senders (two CLI sessions, or
 * a CLI session + a concurrent workflow run) can both read origin state, both
 * pass dedup, and both hit Resend/Buttondown before either can write back.
 *
 * Solution: a GitHub Contents API lock file. Acquire with sha-based CAS before
 * any send, release after. TTL auto-heals if a holder crashes mid-send.
 *
 * Why the Contents API and not GitHub Variables: variables don't expose a
 * compare-and-swap primitive, so two concurrent writers can both "win". The
 * Contents API's sha field gives us atomic CAS semantics that scale across
 * local machines and CI runners.
 *
 * The lock file lives at `data/email-send.lock` in the public Broadwayscore
 * repo. Contents (session UUID, timestamps, purpose, holder) are non-sensitive.
 *
 * USAGE:
 *   const { acquireSendLock, releaseSendLock } = require('./lib/send-lock');
 *   const lock = acquireSendLock({ purpose: 'broadway-preview-titanique-2026' });
 *   if (!lock.acquired) { console.error(lock.reason); process.exit(1); }
 *   try {
 *     // ... do the send ...
 *   } finally {
 *     releaseSendLock(lock);
 *   }
 */

const { execSync } = require('child_process');
const crypto = require('crypto');

const REPO = 'thomaspryor/Broadwayscore';
const LOCK_PATH = 'data/email-send.lock';
const BRANCH = 'main';
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETRIES = 3;

/**
 * Run `gh api` and return the parsed result. Distinguishes 404 (file missing)
 * from other errors, and surfaces the raw stderr for diagnosis.
 */
function ghApi(args, { input = null } = {}) {
  try {
    const cmd = 'gh api ' + args;
    const opts = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] };
    if (input != null) opts.input = input;
    const out = execSync(cmd, opts);
    return { ok: true, body: out, status: 200 };
  } catch (err) {
    const stderr = String(err.stderr || err.message || '');
    // gh's HTTP errors include the status code in stderr, e.g.:
    //   "gh: Not Found (HTTP 404)"
    //   "gh: (HTTP 409)"
    const match = stderr.match(/HTTP (\d+)/);
    const status = match ? parseInt(match[1], 10) : null;
    return { ok: false, status, stderr: stderr.trim() };
  }
}

/**
 * GET the lock file. Returns:
 *   { exists: true, sha, parsed }  — file exists and parses cleanly
 *   { exists: false }              — 404 from gh api
 *   { exists: true, sha, parsed: null, raw } — file exists but content isn't JSON (treat as broken lock)
 *   { error: string }              — any other failure
 */
function fetchLock() {
  const r = ghApi(`repos/${REPO}/contents/${LOCK_PATH}?ref=${BRANCH}`);
  if (r.ok) {
    try {
      const meta = JSON.parse(r.body);
      const content = Buffer.from(meta.content, 'base64').toString('utf8');
      let parsed = null;
      try { parsed = JSON.parse(content); } catch { /* leave null */ }
      return { exists: true, sha: meta.sha, parsed, raw: content };
    } catch (e) {
      return { error: `gh api returned non-JSON meta: ${e.message}` };
    }
  }
  if (r.status === 404) return { exists: false };
  return { error: `gh api GET failed: ${r.stderr}` };
}

/**
 * PUT the lock file. `sha` may be null (create) or a string (update/takeover).
 * Returns { ok, sha?, status?, stderr? }.
 */
function putLock(lockBody, sha, message) {
  const payload = {
    message,
    content: Buffer.from(JSON.stringify(lockBody, null, 2) + '\n', 'utf8').toString('base64'),
    branch: BRANCH,
  };
  if (sha) payload.sha = sha;

  // Pipe payload via stdin to avoid shell escaping. gh accepts --input - for stdin.
  const r = ghApi(
    `--method PUT repos/${REPO}/contents/${LOCK_PATH} --input -`,
    { input: JSON.stringify(payload) }
  );
  if (r.ok) {
    try {
      const result = JSON.parse(r.body);
      return { ok: true, sha: result.content?.sha };
    } catch {
      return { ok: true, sha: null };
    }
  }
  return { ok: false, status: r.status, stderr: r.stderr };
}

/**
 * DELETE the lock file. Requires sha. 404 is treated as success (already gone).
 */
function deleteLock(sha, message) {
  const payload = { message, sha, branch: BRANCH };
  const r = ghApi(
    `--method DELETE repos/${REPO}/contents/${LOCK_PATH} --input -`,
    { input: JSON.stringify(payload) }
  );
  if (r.ok) return { ok: true };
  if (r.status === 404) return { ok: true, note: 'already gone' };
  return { ok: false, status: r.status, stderr: r.stderr };
}

/**
 * Acquire the send lock.
 *
 * @param {object} opts
 * @param {string} opts.purpose  - Short human-readable label (used in commit messages + stderr).
 * @param {number} [opts.ttlMs] - Lock TTL in milliseconds. Default 5 minutes.
 * @param {number} [opts.now]   - Clock override for tests.
 * @returns {object} { acquired: boolean, sessionId?, sha?, expiresAt?, reason? }
 */
function acquireSendLock(opts = {}) {
  const { purpose = 'unknown', ttlMs = DEFAULT_TTL_MS, now = Date.now() } = opts;

  const sessionId = crypto.randomUUID();
  const acquiredAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs).toISOString();
  const holder = process.env.GITHUB_ACTIONS === 'true' ? 'workflow' : 'cli';
  const workflowRunId = process.env.GITHUB_RUN_ID || null;

  // Sanity: gh must be available and authed. `gh auth status` is a top-level
  // command, NOT under `gh api`, so we shell it directly.
  try {
    execSync('gh auth status', { stdio: 'ignore' });
  } catch (err) {
    return {
      acquired: false,
      reason: `gh CLI not available or not authenticated: ${String(err.stderr || err.message || '').slice(0, 200)}`,
    };
  }

  const lockBody = { sessionId, acquiredAt, expiresAt, purpose, holder, workflowRunId };

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const current = fetchLock();
    if (current.error) {
      return { acquired: false, reason: current.error };
    }

    if (!current.exists) {
      // No lock — create with no sha.
      const put = putLock(lockBody, null, `lock: acquire ${purpose} (${sessionId.slice(0, 8)})`);
      if (put.ok) {
        return { acquired: true, sessionId, sha: put.sha, expiresAt };
      }
      // Another session raced us and created first. Retry from GET.
      if (put.status === 422 || put.status === 409) continue;
      return { acquired: false, reason: `PUT failed (${put.status}): ${put.stderr}` };
    }

    // Lock exists. Check expiry.
    const existing = current.parsed;
    if (existing && existing.expiresAt) {
      const expMs = new Date(existing.expiresAt).getTime();
      if (!Number.isNaN(expMs) && expMs > now) {
        return {
          acquired: false,
          reason: `held by session ${existing.sessionId?.slice(0, 8) || '?'} (${existing.holder || '?'}) for "${existing.purpose || '?'}"`,
          heldBy: existing,
          expiresAt: existing.expiresAt,
        };
      }
    }

    // Expired or unparseable. Take over with the current sha.
    const put = putLock(
      lockBody,
      current.sha,
      `lock: takeover ${purpose} from expired/invalid (${sessionId.slice(0, 8)})`
    );
    if (put.ok) {
      return { acquired: true, sessionId, sha: put.sha, expiresAt };
    }
    if (put.status === 422 || put.status === 409) continue; // race — retry
    return { acquired: false, reason: `takeover PUT failed (${put.status}): ${put.stderr}` };
  }

  return { acquired: false, reason: `retry exhausted after ${MAX_RETRIES} attempts` };
}

/**
 * Release a previously-acquired lock. Idempotent — 404 is fine.
 *
 * @param {object} lockRef  - The object returned by acquireSendLock when acquired=true.
 * @returns {object} { released: boolean, reason?: string }
 */
function releaseSendLock(lockRef) {
  if (!lockRef || !lockRef.acquired) {
    return { released: false, reason: 'no lock to release' };
  }
  // Need the current sha to DELETE — our cached sha may be stale if someone
  // else took over (shouldn't happen while held, but defensive).
  const current = fetchLock();
  if (current.error) {
    return { released: false, reason: current.error };
  }
  if (!current.exists) {
    return { released: true, reason: 'already gone' };
  }
  // Only release if the lock is still ours.
  if (current.parsed && current.parsed.sessionId !== lockRef.sessionId) {
    return {
      released: false,
      reason: `lock taken over by ${current.parsed.sessionId?.slice(0, 8) || '?'}`,
    };
  }

  const del = deleteLock(
    current.sha,
    `lock: release ${lockRef.sessionId?.slice(0, 8) || '?'}`
  );
  if (del.ok) return { released: true };
  return { released: false, reason: `DELETE failed (${del.status}): ${del.stderr}` };
}

module.exports = {
  acquireSendLock,
  releaseSendLock,
  // Exposed for tests:
  fetchLock,
  putLock,
  deleteLock,
  LOCK_PATH,
  REPO,
  DEFAULT_TTL_MS,
};
