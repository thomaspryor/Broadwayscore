#!/usr/bin/env node
/**
 * bsc-reconcile — the "expected running vs actually running" tick for headless
 * jobs (Autopilot v5 R3, task #459). Runs every 5 min from its OWN launchd job
 * (com.broadwayscore.bsc-reconcile) — deliberately NOT the action-dispatcher
 * tick, whose 35-min card lock would delay orphan detection exactly when jobs
 * are running (plan-review Codex + design findings).
 *
 * What it does, in order:
 *   1. Fold dispatch-ledger job events → open (non-terminal) jobs.
 *   2. For each open job: lease PID alive and still a claude process? If not,
 *      append job-orphaned (PID-liveness with argv match is the PRIMARY signal —
 *      never heartbeat staleness; a busy job is not a dead job).
 *   3. Optional resume-retry of orphans — OFF by default (BSC_RECONCILE_RETRY=1
 *      to enable) and hard-capped at 2/tick, 6/24h. Detection ships a week
 *      before automation: the pre-mortem's spawn-storm scenario dies here.
 *   4. Sweep lease dirs whose task has no open job (crash stragglers).
 *   5. Report: orphans/retries append one line each to the Mac-local morning
 *      digest queue (data/audit/reconcile-report.jsonl, gitignored) — NEVER the
 *      git-tracked alert-ledger (a Mac-local writer there hits last-writer-wins
 *      clobber against CI pushes).
 *
 * Detection quality note: "PID alive" alone is not enough — PIDs recycle — so
 * liveness = kill-style existence AND ps argv contains `claude`
 * (bsc-runner.pidLooksLikeClaude).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const USAGE = `Usage: node scripts/bsc-reconcile.js [--dry-run]
Marks headless jobs whose process died as orphaned, sweeps stale leases,
queues digest lines. Retry of orphans requires BSC_RECONCILE_RETRY=1.`;

// --help before ANY side effect (house rule: --help fall-through incidents).
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const ledger = require('./lib/dispatch-ledger.js');
const { readLease, releaseLease, pidLooksLikeClaude, runJob, LEASE_ROOT, REPO } = require('./lib/bsc-runner.js');

const REPORT_PATH = path.join(REPO, 'data', 'audit', 'reconcile-report.jsonl');
const DRY = process.argv.includes('--dry-run');
const MAX_RETRIES_PER_TICK = 2;
const MAX_RETRIES_PER_DAY = 6;
const GRACE_MS = 2 * 60 * 1000; // startup window before pid:null counts as dead

function report(line) {
  const entry = { ts: new Date().toISOString(), ...line };
  console.log(`[bsc-reconcile] ${entry.kind}: ${entry.detail}`);
  if (DRY) return;
  try {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.appendFileSync(REPORT_PATH, JSON.stringify(entry) + '\n');
  } catch (e) { console.error(`[bsc-reconcile] report write failed: ${e.message}`); }
}

function retriesInLast24h(entries) {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  return entries.filter(e => e.event === ledger.JOB_EVENTS.RETRIED && Date.parse(e.ts) > cutoff).length;
}

async function main() {
  const entries = ledger.readEntries();
  const open = ledger.openJobs(entries);
  let orphaned = 0;
  const orphans = [];

  for (const job of open) {
    const lease = readLease(job.taskId);
    // STARTUP GRACE (ship-check Codex blocker): a freshly-acquired lease has
    // pid:null until claude-cli's onSpawn lands. Treating that window as dead
    // would orphan a healthy job at t+0 and let a duplicate dispatch in.
    // Anything younger than the grace window is presumed starting.
    const leaseAgeMs = lease && lease.acquiredAt ? Date.now() - Date.parse(lease.acquiredAt) : Infinity;
    const starting = lease && lease.jobId === job.jobId && leaseAgeMs < GRACE_MS;
    const alive = lease && lease.jobId === job.jobId && pidLooksLikeClaude(lease.pid);
    if (alive || starting) continue;
    orphaned++;
    orphans.push({ job, lease });
    if (!DRY) {
      ledger.appendEntry({ event: ledger.JOB_EVENTS.ORPHANED, taskId: job.taskId, jobId: job.jobId, subject: job.subject || '', hadLease: Boolean(lease) });
      releaseLease(job.taskId, job.jobId); // ownership-checked: never removes a replacement job's lease
    }
    report({ kind: 'orphan', taskId: job.taskId, jobId: job.jobId, detail: `job ${job.jobId} (task #${job.taskId} ${job.subject || ''}) has no live claude process` });
  }

  // Optional, capped resume-retry (default OFF — detection first, automation later).
  if (process.env.BSC_RECONCILE_RETRY === '1' && !DRY && orphans.length) {
    const dayCount = retriesInLast24h(entries);
    let budget = Math.min(MAX_RETRIES_PER_TICK, MAX_RETRIES_PER_DAY - dayCount);
    for (const { job, lease } of orphans) {
      if (budget <= 0) {
        report({ kind: 'retry-cap', taskId: job.taskId, detail: `retry cap reached (tick ${MAX_RETRIES_PER_TICK}, day ${MAX_RETRIES_PER_DAY}) — remaining orphans left for the digest` });
        break;
      }
      const alreadyRetried = entries.some(e => e.event === ledger.JOB_EVENTS.RETRIED && e.jobId === job.jobId);
      const sessionId = (lease && lease.sessionId) || job.sessionId;
      // Resume is cwd-scoped: no session, no cwd, or a torn-down worktree ⇒
      // resuming is impossible — leave it orphaned for the digest instead of
      // logging a doomed "resuming" line (ship-check Codex finding).
      if (alreadyRetried || !sessionId || !job.cwd || !fs.existsSync(job.cwd)) continue;
      budget--;
      ledger.appendEntry({ event: ledger.JOB_EVENTS.RETRIED, taskId: job.taskId, jobId: job.jobId, sessionId });
      report({ kind: 'retry', taskId: job.taskId, jobId: job.jobId, detail: `resuming session ${sessionId} for task #${job.taskId}` });
      // Sequential on purpose: one resumed job at a time per tick keeps the
      // blast radius of a bad retry to a single session.
      await runJob({
        taskId: job.taskId, subject: job.subject || '', isolate: false, cwd: job.cwd,
        resumeSessionId: sessionId,
        prompt: 'Your previous headless run was interrupted (process died). Continue exactly where you left off and finish the task.',
        model: job.model || undefined,
        // Short leash: a retry blocking this tick for the full 30-min default
        // would stall orphan detection (launchd skips overlapping runs).
        timeoutMs: 10 * 60 * 1000,
      });
    }
  }

  // Sweep stale lease dirs (task has no open job → nothing should hold it).
  let sweptLeases = 0;
  const openTasks = new Set(ledger.openJobs(ledger.readEntries()).map(j => String(j.taskId)));
  let leaseDirs = [];
  try { leaseDirs = fs.readdirSync(LEASE_ROOT); } catch { /* none yet */ }
  for (const dir of leaseDirs) {
    if (openTasks.has(dir)) continue;
    const lease = readLease(dir);
    if (lease && pidLooksLikeClaude(lease.pid)) continue; // live process, not ours to sweep
    // Same startup grace as the orphan loop (Opus ship-check P0): runJob
    // acquires the lease BEFORE provisioning the worktree and appending
    // job-spawned, so a young pid:null lease with no open job is a healthy
    // job mid-startup, not a straggler.
    const ageMs = lease && lease.acquiredAt ? Date.now() - Date.parse(lease.acquiredAt) : Infinity;
    if (ageMs < GRACE_MS) continue;
    sweptLeases++;
    if (!DRY) releaseLease(dir);
  }

  console.log(`[bsc-reconcile] open=${open.length} orphaned=${orphaned} sweptLeases=${sweptLeases}${DRY ? ' (dry-run)' : ''}`);
}

if (require.main === module) {
  main().catch(err => { console.error('bsc-reconcile crashed:', err); process.exit(1); });
}

module.exports = { main, retriesInLast24h, USAGE, REPORT_PATH, MAX_RETRIES_PER_TICK, MAX_RETRIES_PER_DAY };
