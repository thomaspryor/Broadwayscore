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
const { shouldRefuseDispatch } = require('./worktree-gc-reclaim.js');

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
 *
 * `isAliveFn` (test-only seam, defaults to the real pidLooksLikeClaude):
 * faking a genuinely-alive holder process to test the "lease already held"
 * branch is unsafe to do via real subprocesses (card #1454's own test tried
 * spawning a process literally named `claude` and it either got killed by
 * this environment's own process monitoring or raced into looking dead
 * exactly when runJob's real check ran, which once let a stolen "stale"
 * lease fall through to a REAL claude-cli spawn). Threading the liveness
 * predicate through as a parameter — same idiom as this file's own `nowMs`
 * threading elsewhere in the dispatch subsystem — lets a test drive the real
 * acquireLease()/runJob() control flow deterministically with zero risk of
 * an actual process spawn.
 */
function acquireLease(taskId, meta, { isAliveFn = pidLooksLikeClaude } = {}) {
  fs.mkdirSync(LEASE_ROOT, { recursive: true }); // parent first; the LEAF mkdir is the atomic claim
  try {
    fs.mkdirSync(leaseDir(taskId)); // atomic: EEXIST means someone holds it
  } catch (e) {
    if (e.code !== 'EEXIST') return { ok: false, reason: `lease mkdir failed: ${e.message}`, holder: null };
    const holder = readLease(taskId);
    if (holder && isAliveFn(holder.pid)) {
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

// Ownership-checked release: pass the jobId you own and the lease is only
// removed if it still belongs to that job — a stale runner/reconciler can
// never delete a REPLACEMENT job's live lease (ship-check Codex blocker).
// Omit jobId only for stale-sweep paths that have already verified the pid
// is dead.
function releaseLease(taskId, jobId = null) {
  if (jobId) {
    const cur = readLease(taskId);
    if (cur && cur.jobId && cur.jobId !== jobId) return false;
  }
  try { fs.rmSync(leaseDir(taskId), { recursive: true, force: true }); return true; }
  catch { return false; /* reconciler sweeps stragglers */ }
}

// Per-job worktree: deterministic path, branch from origin/main, kept if dirty.
// jobId is sanitized for the git ref and path: namespaced task ids like
// `linear:BRO-284` (linear-next.js's ledgerTaskId) contain a colon, which git
// rejects in ref names — the 2026-08-12 canary died at `worktree add -b
// job/linear:BRO-284-…` with worktree-error. Ledger identity keeps the colon;
// only the ref/path component is renamed.
function gitSafeJobId(jobId) {
  return String(jobId).replace(/[^A-Za-z0-9._-]/g, '-');
}
// Pure path formula, factored out of provisionJobWorktree so runJob can
// record the lease's `cwd` BEFORE the worktree exists (BRO-2319 adversarial
// review finding): a lease with no `cwd` yet is invisible to
// worktree-live-lease-check.js, and a freshly-provisioned worktree is
// trivially "merged" (zero commits, forked straight off origin/main) — the
// single highest-risk moment for GC to race this job. Recording the
// (not-yet-created) expected path at lease-acquire time, before
// `git worktree add` even runs, closes that window instead of narrowing it.
function jobWorktreePath(jobId) {
  return path.join(REPO, '.claude', 'worktrees', `job-${gitSafeJobId(jobId)}`);
}
function provisionJobWorktree(jobId) {
  const safe = gitSafeJobId(jobId);
  const wtPath = jobWorktreePath(jobId);
  execFileSync('git', ['-C', REPO, 'worktree', 'add', wtPath, '-b', `job/${safe}`, 'origin/main'], { stdio: 'pipe' });
  return wtPath;
}

function teardownJobWorktree(wtPath, jobId) {
  try {
    const dirty = execFileSync('git', ['-C', wtPath, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    const ahead = execFileSync('git', ['-C', wtPath, 'rev-list', '--count', 'origin/main..HEAD'], { encoding: 'utf8' }).trim();
    if (dirty || ahead !== '0') return false; // work present — keep for review/merge
    execFileSync('git', ['-C', REPO, 'worktree', 'remove', '--force', wtPath], { stdio: 'pipe' });
    try { execFileSync('git', ['-C', REPO, 'branch', '-D', `job/${gitSafeJobId(jobId)}`], { stdio: 'pipe' }); } catch { /* branch may be gone */ }
    return true;
  } catch { return false; }
}

// Dispatch disk-pressure floor (BRO-2319): worktrees hit 84GB/99 dirs and
// disk free hit 4.7Gi with GC unable to reclaim (all 82 unmerged) — under
// that condition dispatch didn't fail loudly, it failed INVISIBLY (lease
// mkdir / worktree checkout / ledger append can all silently no-op or throw
// under ENOSPC, and the caller's own pre-runJob ledger "launch" write in
// bsc-next.js/linear-next.js already wraps its own failure in a non-fatal
// console.error). This is the one shared choke point both dispatchers call
// through, so the check lives here rather than duplicated in each caller.
const DEFAULT_DISPATCH_DISK_FLOOR_GB = 5;
const GC_SCRIPT = path.join(REPO, 'scripts', 'gc-merged-worktrees.sh');

// Same `df -Pk` parse as scripts/lib/disk-floor-check.sh's ensure_disk_floor,
// reimplemented in JS because that helper is bash-sourced (push-with-retry.sh/
// merge-worktree-to-main.sh) and this call site is Node. Fails to null (never
// throws) so a missing/broken `df` never blocks dispatch on its own — same
// fail-open contract as ensure_disk_floor.
function freeDiskGB(repoPath) {
  try {
    const out = execFileSync('df', ['-Pk', repoPath], { encoding: 'utf8', timeout: 10000 });
    const cols = (out.trim().split('\n')[1] || '').trim().split(/\s+/);
    const availableKb = Number(cols[3]);
    return Number.isFinite(availableKb) ? availableKb / 1024 / 1024 : null;
  } catch { return null; }
}

// Try the same self-heal ensure_disk_floor already performs for push/merge
// BEFORE refusing dispatch — a transient low-disk moment the GC can clear in
// seconds (stripping node_modules/.next from stale worktrees, reclaiming
// already-merged ones) must not page the owner for nothing. Best-effort:
// any failure here (lock held by a concurrent run, script missing) falls
// through to the refusal check below with freeGB re-measured regardless.
function selfHealDiskPressure() {
  try { execFileSync('bash', [GC_SCRIPT], { stdio: 'ignore', timeout: 5 * 60 * 1000 }); } catch { /* best-effort */ }
}

// Cooldown so a fleet-wide low-disk window pages the owner once per
// condition, not once per refused dispatch attempt (adversarial review
// finding: many concurrent dispatchers can each independently measure
// still-low disk and each fire a critical email — sendAlert itself has no
// dedupe). File-mtime based, not in-memory: each dispatch is typically a
// separate process, so an in-process timestamp wouldn't be shared across
// dispatchers anyway.
const DISK_PRESSURE_ALERT_MARKER = path.join(REPO, 'data', 'audit', 'disk-pressure-alert-last-sent.json');
const DISK_PRESSURE_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
function diskPressureAlertDue() {
  try {
    const stat = fs.statSync(DISK_PRESSURE_ALERT_MARKER);
    if (Date.now() - stat.mtimeMs < DISK_PRESSURE_ALERT_COOLDOWN_MS) return false;
  } catch { /* no marker yet — due */ }
  try {
    fs.mkdirSync(path.dirname(DISK_PRESSURE_ALERT_MARKER), { recursive: true });
    fs.writeFileSync(DISK_PRESSURE_ALERT_MARKER, JSON.stringify({ ts: new Date().toISOString() }));
  } catch (e) { console.error(`[bsc-runner] disk-pressure alert marker write failed (non-fatal, will re-alert next attempt): ${e.message}`); }
  return true;
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
 * @param {number} [opts.timeoutMs]      default 120 min (owner decision 2026-08-10, task #1184)
 * @param {string} [opts.resumeSessionId] reconciler/owner-driven resume
 * @returns {Promise<{ok, jobId, stage, sessionId, resultText, logFile, cwd, keptWorktree}>}
 */

// 30 min killed every non-trivial fix session with its work unrecoverable
// (digest-autofix ledger 8/5-8/9: timeout was the top failure stage; the
// sessions were SIGKILLed mid-work with no session id captured). Owner
// approved 120 min on 2026-08-10 ("A, but with 120 min sessions").
const DEFAULT_JOB_TIMEOUT_MS = 120 * 60 * 1000;

// Told to the session up front so it can plan for the wall: commit early,
// commit often, leave a resumable trail. This is a REQUEST to the model, not
// a guarantee — resume-on-timeout (bsc-reconcile) is the actual backstop.
function buildBudgetPreamble(timeoutMs) {
  const min = Math.round(timeoutMs / 60000);
  return `[UNATTENDED TIME BUDGET] This headless session is hard-killed after ${min} minutes of wall-clock time. `
    + `Commit work-in-progress to your worktree branch after each meaningful step (never leave >15 min of work uncommitted). `
    + `By minute ${Math.max(5, min - 10)}, stop starting new work: commit everything and write a short STATE.md at the repo root `
    + `(what is done, what remains, exact next command) so a resumed session can continue without re-deriving context.\n\n`;
}

async function runJob(opts) {
  const { taskId, subject = '', prompt, model, isolate = true, timeoutMs = DEFAULT_JOB_TIMEOUT_MS, graceMs, resumeSessionId, killSwitchEnv = 'BSC_RUNNER_DISABLED', isAliveFn } = opts;
  // Each DISPATCHER is governed by its own kill switch at the runner level
  // (BRO-286): bsc-next-path callers keep the default; linear-next.js passes
  // killSwitchEnv:'LINEAR_NEXT_DISABLED'. Without this, the morning-digest
  // plist's BSC_RUNNER_DISABLED=1 (set only to keep the retired Notion-side
  // auto-fix loop off, task #1311) leaks into child spawns and would
  // silently kill the NEW Linear dispatch path too.
  if (process.env[killSwitchEnv] === '1') {
    return { ok: false, jobId: null, stage: 'runner-disabled', sessionId: null, resultText: '', logFile: null, cwd: null, keptWorktree: false };
  }
  if (!taskId || !prompt) throw new Error('runJob requires taskId and prompt');

  const jobId = `${taskId}-${Date.now().toString(36)}`;
  const logFile = path.join(LOG_ROOT, `${jobId}.log`);

  // Disk-pressure preflight (BRO-2319), before any lease/worktree I/O that
  // could fail silently under ENOSPC. freeGB === null (df unavailable/erred)
  // never refuses — same fail-open contract as ensure_disk_floor. Validate
  // the env override: a typo (e.g. a non-numeric or negative value) must not
  // silently disable the guard, and Infinity/NaN must not refuse every
  // dispatch (adversarial review finding) — fall back to the default and say
  // so once, rather than trusting an unparseable value either direction.
  let dispatchFloorGB = Number(process.env.BSC_DISPATCH_DISK_FLOOR_GB);
  if (!Number.isFinite(dispatchFloorGB) || dispatchFloorGB < 0) {
    if (process.env.BSC_DISPATCH_DISK_FLOOR_GB !== undefined) {
      console.error(`[bsc-runner] BSC_DISPATCH_DISK_FLOOR_GB="${process.env.BSC_DISPATCH_DISK_FLOOR_GB}" is not a valid non-negative number — using default ${DEFAULT_DISPATCH_DISK_FLOOR_GB}GB`);
    }
    dispatchFloorGB = DEFAULT_DISPATCH_DISK_FLOOR_GB;
  }
  let freeGB = freeDiskGB(REPO);
  if (freeGB !== null && shouldRefuseDispatch({ freeGB, floorGB: dispatchFloorGB })) {
    selfHealDiskPressure();
    freeGB = freeDiskGB(REPO);
  }
  if (freeGB !== null && shouldRefuseDispatch({ freeGB, floorGB: dispatchFloorGB })) {
    const detail = `disk free ${freeGB.toFixed(1)}GB < floor ${dispatchFloorGB}GB after self-heal GC — refusing dispatch for task ${taskId}`;
    console.error(`[bsc-runner] REFUSING dispatch: ${detail}`);
    // ABANDONED, not FAILED: disk pressure is infra, not a defect in this
    // task — JOB_EVENTS.FAILED counts toward a task's dead-attempt strikes
    // (isDeadlikeEvent in dispatch-ledger.js), and a transient fleet-wide
    // disk condition must not permanently park an otherwise-healthy task.
    // Same "task is fine, this attempt just didn't run" semantics as the
    // lease-held case below.
    try { ledger.appendEntry({ event: ledger.JOB_EVENTS.ABANDONED, taskId, jobId, subject, reason: `disk-pressure: ${detail}` }); } catch (e) { console.error(`[bsc-runner] ledger write failed (non-fatal): ${e.message}`); }
    // Fire-and-forget: dispatch must not block on alert delivery. Routed
    // through owner-alert-router.js's routeAlert() (disposition 'digest')
    // rather than a direct sendAlert(email:true) — disk pressure is not on
    // page-worthy-alerts.js's allowlist (owner mandate 2026-07-28, card
    // #611: no sender emails the owner directly outside that list), and
    // self-heal GC already ran above, so this is a digest-tier "the owner
    // should know" condition, not an immediate page. Locally cooldown-gated
    // (adversarial review finding): a fleet-wide low-disk moment means MANY
    // dispatch attempts refuse near-simultaneously — without this, one
    // disk-pressure window would fire routeAlert once per refused task
    // instead of once per condition (routeAlert's own ledger cooldown
    // defaults to 7 days, too coarse for this fast-moving local signal).
    if (diskPressureAlertDue()) {
      try {
        require('./owner-alert-router.js').routeAlert({
          conditionKey: 'bsc-runner:disk-pressure',
          title: 'Dispatch refused — disk pressure',
          description: detail,
          severity: 'critical',
          disposition: 'digest',
          cooldownHours: 1,
        }).catch((e) => console.error(`[bsc-runner] disk-pressure alert send failed: ${e.message}`));
      } catch (e) { console.error(`[bsc-runner] disk-pressure alert require failed: ${e.message}`); }
    } else {
      console.error(`[bsc-runner] disk-pressure alert suppressed (within cooldown): ${detail}`);
    }
    return { ok: false, jobId, stage: 'disk-pressure', sessionId: null, resultText: '', logFile: null, cwd: null, keptWorktree: false };
  }

  // Card #1454: acquireLease() (mkdirSync-based) can throw (e.g. LEASE_ROOT
  // unwritable) before ever returning ok/not-ok — without this catch, that
  // exception propagated straight to the caller's own .catch(), which only
  // console.errors. The launch's ledger row would then have no jobId-bearing
  // event at all, forever (same invisibility JOB_EVENTS.ABANDONED exists to
  // close for the lease-held case below).
  // Recorded from the FIRST lease write, before any worktree exists (see
  // jobWorktreePath's own comment) — computeLiveLeaseCwds treats a lease
  // with pid:null as live specifically so this window is protected too.
  const initialCwd = (isolate && !resumeSessionId) ? jobWorktreePath(jobId) : (opts.cwd || REPO);
  let lease;
  try {
    lease = acquireLease(taskId, { jobId, subject, pid: null, cwd: initialCwd }, isAliveFn ? { isAliveFn } : undefined);
  } catch (e) {
    ledger.appendEntry({ event: ledger.JOB_EVENTS.ABANDONED, taskId, jobId, subject, reason: `acquireLease threw: ${String(e.message).slice(0, 200)}` });
    throw e;
  }
  if (!lease.ok) {
    // A DIFFERENT job is already running this task (lease.reason ===
    // 'task already has a live job') — this attempt did no work, but its own
    // `launch` ledger row still needs a terminal event or it sits open
    // forever (card #1454). Not deadlike (see JOB_EVENTS.ABANDONED's own
    // comment): the task itself is fine, just doubly-dispatched.
    ledger.appendEntry({ event: ledger.JOB_EVENTS.ABANDONED, taskId, jobId, subject, reason: `${lease.reason}${lease.holder && lease.holder.jobId ? ` (held by ${lease.holder.jobId})` : ''}` });
    return { ok: false, jobId, stage: 'lease-held', sessionId: null, resultText: '', logFile: null, cwd: null, keptWorktree: false, holder: lease.holder, reason: lease.reason };
  }

  let cwd = opts.cwd || REPO;
  let wtPath = null;
  let out = null; // returned object; finally patches keptWorktree onto it
  try {
    if (isolate && !resumeSessionId) {
      try {
        wtPath = provisionJobWorktree(jobId);
        cwd = wtPath;
      } catch (e) {
        // Provisioning failure must leave a ledger trace — an invisible throw
        // here is exactly the F2 class this module exists to kill.
        ledger.appendEntry({ event: ledger.JOB_EVENTS.FAILED, taskId, jobId, stage: 'worktree-error', detail: String(e.message).slice(0, 300) });
        out = { ok: false, jobId, stage: 'worktree-error', sessionId: null, resultText: '', logFile, cwd: null, keptWorktree: false };
        return out;
      }
    } else if (resumeSessionId && opts.cwd) {
      cwd = opts.cwd; // resume is cwd-scoped: caller must pass the original cwd
    }

    // Ledger record BEFORE spawn: a crash between here and the spawn leaves a
    // visible open job for the reconciler, never an invisible failure (F2).
    // resumeOfSession makes retry-chain attribution CAUSAL (dispatch-ledger.
    // followRetryChain matches it against the RETRIED entry's sessionId) — a
    // manual headless job spawned in the gap can never be credited as the resume.
    ledger.appendEntry({ event: ledger.JOB_EVENTS.SPAWNED, taskId, jobId, subject, cwd, logFile, model: model || null, resumed: Boolean(resumeSessionId), resumeOfSession: resumeSessionId || null });

    const res = await runClaudeCli({
      // Budget preamble on every job, resume included: the resumed session
      // has a fresh clock and needs the same commit-early contract.
      prompt: buildBudgetPreamble(timeoutMs) + prompt,
      cwd, model, resumeSessionId, timeoutMs, graceMs, logFile,
      onSpawn: (pid) => updateLease(taskId, { pid, cwd }),
      // Persisted the moment the stream's first event lands (~1s in), so a
      // later kill — timeout, crash, power loss — leaves a resumable session
      // id on the lease AND lets bsc-reconcile resume instead of restarting.
      onSessionId: (sessionId) => updateLease(taskId, { sessionId }),
    });

    if (res.sessionId) updateLease(taskId, { sessionId: res.sessionId });
    if (res.ok) {
      ledger.appendEntry({ event: ledger.JOB_EVENTS.DONE, taskId, jobId, sessionId: res.sessionId, costUSD: res.costUSD });
    } else {
      // sessionId + cwd + cost ride the FAILED entry (task #1184 S1): the
      // resume path keys off exactly these fields, and the spend breaker
      // stops reading killed sessions as $0 (costEstimated marks the ones
      // computed from streamed usage rather than the CLI's own total).
      ledger.appendEntry({
        event: ledger.JOB_EVENTS.FAILED, taskId, jobId, stage: res.stage,
        sessionId: res.sessionId, cwd, model: model || null,
        costUSD: res.costUSD, costEstimated: res.costEstimated || undefined,
        detail: (res.errorDetail || '').slice(0, 300),
      });
    }
    out = { ok: res.ok, jobId, stage: res.stage, sessionId: res.sessionId, resultText: res.resultText, logFile, cwd, keptWorktree: false };
    return out;
  } finally {
    // finally runs after the return expression is evaluated but before the
    // value is delivered — patching the SAME object keeps the field truthful.
    // A timed-out job keeps its worktree even when clean: resume is
    // cwd-scoped, so tearing it down here would make the recorded sessionId
    // unresumable (Codex plan-review finding — the original resume design
    // "would start in a deleted workspace").
    const timedOutJob = out && out.stage === 'timeout';
    const kept = wtPath ? (timedOutJob || !teardownJobWorktree(wtPath, jobId)) : false;
    if (out) out.keptWorktree = kept;
    releaseLease(taskId, jobId);
  }
}

module.exports = {
  gitSafeJobId,
  runJob, acquireLease, releaseLease, readLease, updateLease, pidLooksLikeClaude,
  LEASE_ROOT, LOG_ROOT, REPO, leaseDir, leaseFile,
  DEFAULT_JOB_TIMEOUT_MS, buildBudgetPreamble,
};
