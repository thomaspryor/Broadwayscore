/**
 * bsc-runner — headless job execution for auto-dispatched Claude sessions.
 * Autopilot v5 R2 (task #459). Replaces cmux tabs for BOT work only; owner
 * tabs are untouched. Named bsc-* so the Tier-3 dispatcher-integrity guard
 * (autonomous-eligibility.js prefix exclusions) covers it with no list edit.
 *
 * Responsibilities (deliberately small — the spawn itself lives in
 * scripts/lib/claude-cli.js, shared with every other headless caller):
 *   1. LEASE  — one live job per task, cross-dispatcher, via atomic mkdir.
 *   2. LEDGER — every lifecycle transition appended to dispatch-ledger.jsonl
 *      (job-spawned BEFORE the spawn, terminal state written by us — never
 *      inferred from tab titles or scraped process tables).
 *   3. ISOLATION — optional per-job git worktree (kept if dirty, removed if
 *      clean), same contract as notion-action-poll's provisionActionWorktree.
 *
 * Kill switch: BSC_RUNNER_DISABLED=1 refuses all spawns (callers fall back
 * to their pre-headless behavior).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runClaudeCli } = require('./claude-cli.js');
const ledger = require('./dispatch-ledger.js');

// Hardcoded for the same reason as dispatch-ledger.js: callers routinely run
// from inside worktrees, and leases/logs must be one canonical set.
const REPO = '/Users/tompryor/Broadwayscore';
const LEASE_ROOT = path.join(REPO, 'data', 'audit', 'job-leases');
const LOG_ROOT = path.join(os.homedir(), 'Library', 'Logs', 'bsc-jobs');

function leaseDir(taskId) { return path.join(LEASE_ROOT, String(taskId)); }
function leaseFile(taskId) { return path.join(leaseDir(taskId), 'lease.json'); }

function readLease(taskId) {
  try { return JSON.parse(fs.readFileSync(leaseFile(taskId), 'utf8')); }
  catch { return null; }
}

function pidLooksLikeClaude(pid) {
  if (!pid) return false;
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    // argv check, not bare kill -0: PIDs recycle, and a recycled PID must not
    // read as "job still running" (plan-review structure finding).
    return /(^|\/)claude(\s|$)/.test(cmd);
  } catch { return false; }
}

/**
 * Acquire the per-task lease. Returns {ok:true} or {ok:false, reason, holder}.
 * A holder whose recorded PID is dead (or not a claude process) is stale and
 * gets stolen; a live holder wins.
 */
function acquireLease(taskId, meta) {
  fs.mkdirSync(LEASE_ROOT, { recursive: true }); // parent first; the LEAF mkdir is the atomic claim
  try {
    fs.mkdirSync(leaseDir(taskId)); // atomic: EEXIST means someone holds it
  } catch (e) {
    if (e.code !== 'EEXIST') return { ok: false, reason: `lease mkdir failed: ${e.message}`, holder: null };
    const holder = readLease(taskId);
    if (holder && pidLooksLikeClaude(holder.pid)) {
      return { ok: false, reason: 'task already has a live job', holder };
    }
    // Stale lease (crashed holder / dead pid): steal.
    try { fs.rmSync(leaseDir(taskId), { recursive: true, force: true }); fs.mkdirSync(leaseDir(taskId)); }
    catch (e2) { return { ok: false, reason: `stale-lease steal failed: ${e2.message}`, holder }; }
  }
  fs.writeFileSync(leaseFile(taskId), JSON.stringify({ ...meta, acquiredAt: new Date().toISOString() }, null, 2));
  return { ok: true };
}

function updateLease(taskId, patch) {
  const cur = readLease(taskId) || {};
  try { fs.writeFileSync(leaseFile(taskId), JSON.stringify({ ...cur, ...patch }, null, 2)); }
  catch { /* lease updates are best-effort; ledger is the source of truth */ }
}

function releaseLease(taskId) {
  try { fs.rmSync(leaseDir(taskId), { recursive: true, force: true }); } catch { /* reconciler sweeps stragglers */ }
}

// Per-job worktree: deterministic path, branch from origin/main, kept if dirty.
function provisionJobWorktree(jobId) {
  const wtPath = path.join(REPO, '.claude', 'worktrees', `job-${jobId}`);
  execFileSync('git', ['-C', REPO, 'worktree', 'add', wtPath, '-b', `job/${jobId}`, 'origin/main'], { stdio: 'pipe' });
  return wtPath;
}

function teardownJobWorktree(wtPath, jobId) {
  try {
    const dirty = execFileSync('git', ['-C', wtPath, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    const ahead = execFileSync('git', ['-C', wtPath, 'rev-list', '--count', 'origin/main..HEAD'], { encoding: 'utf8' }).trim();
    if (dirty || ahead !== '0') return false; // work present — keep for review/merge
    execFileSync('git', ['-C', REPO, 'worktree', 'remove', '--force', wtPath], { stdio: 'pipe' });
    try { execFileSync('git', ['-C', REPO, 'branch', '-D', `job/${jobId}`], { stdio: 'pipe' }); } catch { /* branch may be gone */ }
    return true;
  } catch { return false; }
}

/**
 * Run a task as a headless job. Resolves when the session finishes.
 * @param {object} opts
 * @param {string|number} opts.taskId    required — lease + ledger key
 * @param {string} opts.subject          short human label for ledger/status
 * @param {string} opts.prompt           seed prompt
 * @param {string} [opts.model]          e.g. 'sonnet'/'opus' (fable refused by claude-cli)
 * @param {string} [opts.cwd]            working dir; ignored when isolate=true
 * @param {boolean} [opts.isolate=true]  run in a fresh per-job worktree
 * @param {number} [opts.timeoutMs]      default 30 min
 * @param {string} [opts.resumeSessionId] reconciler/owner-driven resume
 * @returns {Promise<{ok, jobId, stage, sessionId, resultText, logFile, cwd, keptWorktree}>}
 */
async function runJob(opts) {
  const { taskId, subject = '', prompt, model, isolate = true, timeoutMs, resumeSessionId } = opts;
  if (process.env.BSC_RUNNER_DISABLED === '1') {
    return { ok: false, jobId: null, stage: 'runner-disabled', sessionId: null, resultText: '', logFile: null, cwd: null, keptWorktree: false };
  }
  if (!taskId || !prompt) throw new Error('runJob requires taskId and prompt');

  const jobId = `${taskId}-${Date.now().toString(36)}`;
  const logFile = path.join(LOG_ROOT, `${jobId}.log`);

  const lease = acquireLease(taskId, { jobId, subject, pid: null });
  if (!lease.ok) {
    return { ok: false, jobId, stage: 'lease-held', sessionId: null, resultText: '', logFile: null, cwd: null, keptWorktree: false, holder: lease.holder, reason: lease.reason };
  }

  let cwd = opts.cwd || REPO;
  let wtPath = null;
  let out = null; // returned object; finally patches keptWorktree onto it
  try {
    if (isolate && !resumeSessionId) {
      wtPath = provisionJobWorktree(jobId);
      cwd = wtPath;
    } else if (resumeSessionId && opts.cwd) {
      cwd = opts.cwd; // resume is cwd-scoped: caller must pass the original cwd
    }

    // Ledger record BEFORE spawn: a crash between here and the spawn leaves a
    // visible open job for the reconciler, never an invisible failure (F2).
    ledger.appendEntry({ event: ledger.JOB_EVENTS.SPAWNED, taskId, jobId, subject, cwd, logFile, model: model || null, resumed: Boolean(resumeSessionId) });

    const res = await runClaudeCli({
      prompt, cwd, model, resumeSessionId, timeoutMs, logFile,
      onSpawn: (pid) => updateLease(taskId, { pid, cwd }),
    });

    if (res.sessionId) updateLease(taskId, { sessionId: res.sessionId });
    if (res.ok) {
      ledger.appendEntry({ event: ledger.JOB_EVENTS.DONE, taskId, jobId, sessionId: res.sessionId, costUSD: res.costUSD });
    } else {
      ledger.appendEntry({ event: ledger.JOB_EVENTS.FAILED, taskId, jobId, stage: res.stage, sessionId: res.sessionId, detail: (res.errorDetail || '').slice(0, 300) });
    }
    out = { ok: res.ok, jobId, stage: res.stage, sessionId: res.sessionId, resultText: res.resultText, logFile, cwd, keptWorktree: false };
    return out;
  } finally {
    // finally runs after the return expression is evaluated but before the
    // value is delivered — patching the SAME object keeps the field truthful.
    const kept = wtPath ? !teardownJobWorktree(wtPath, jobId) : false;
    if (out) out.keptWorktree = kept;
    releaseLease(taskId);
  }
}

module.exports = {
  runJob, acquireLease, releaseLease, readLease, updateLease, pidLooksLikeClaude,
  LEASE_ROOT, LOG_ROOT, REPO, leaseDir, leaseFile,
};
