'use strict';
/**
 * BRO-8167: per-job memory cap for dispatched headless workers.
 *
 * Incident 2026-11-23: one headless claude worker (BRO-8124) grew to 34 GB RSS
 * and stalled the Mac; nothing capped it. Two enforcement points share this
 * pure module:
 *   1. claude-cli.js runClaudeCli samples its own child's process tree every
 *      SAMPLE_INTERVAL_MS (primary; no dependency on the watchdog tab, the
 *      network or a lock).
 *   2. dispatch-watchdog.js sweep runs runLeasePass() over every live job
 *      lease (backstop for a runner that is itself gone/wedged) and prints
 *      the same numbers via `--mem-report` (read-only).
 *
 * Decision logic is pure (evaluatePass); process/ledger I/O is injected so the
 * tests drive the real functions with a fake process table.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_CAP_GB = 8;
const REQUIRED_STRIKES = 2;          // consecutive over-cap passes before a kill
const SAMPLE_INTERVAL_MS = 30 * 1000;
const KILL_GRACE_MS = 10 * 1000;
const GB = 1024 * 1024 * 1024;

/** BSC_JOB_MEMORY_CAP_GB -> GB. Blank/invalid/<=0 falls back to the default (a typo must not disable the guard). */
function parseCapGB(raw, warn = console.error) {
  const trimmed = String(raw == null ? '' : raw).trim();
  if (trimmed === '') return DEFAULT_CAP_GB;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) {
    warn(`[job-memory-cap] BSC_JOB_MEMORY_CAP_GB="${raw}" is not a positive number — using default ${DEFAULT_CAP_GB}GB`);
    return DEFAULT_CAP_GB;
  }
  return n;
}

/** `ps -axo pid=,ppid=,pgid=,rss=` text -> [{pid, ppid, pgid, rssKB}] */
function parsePsTable(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], rssKB: +m[4] });
  }
  return rows;
}

/** I/O boundary. null when ps fails (fail open: never kill on no data). */
function sampleProcessTable(execFn = execFileSync) {
  try {
    return parsePsTable(execFn('ps', ['-axo', 'pid=,ppid=,pgid=,rss='], { encoding: 'utf8', timeout: 10000, maxBuffer: 32 * 1024 * 1024 }));
  } catch { return null; }
}

/**
 * Process tree of rootPid: the pid, every ppid-descendant, and every process
 * in rootPid's process group (catches children reparented to launchd that
 * kept the group). Returns [] when rootPid is not in the table.
 */
function treeOf(rootPid, rows) {
  const root = rows.find(r => r.pid === rootPid);
  if (!root) return [];
  const members = new Map([[root.pid, root]]);
  const kids = new Map();
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r); }
  const stack = [root.pid];
  while (stack.length) {
    for (const c of kids.get(stack.pop()) || []) {
      if (!members.has(c.pid)) { members.set(c.pid, c); stack.push(c.pid); }
    }
  }
  // Process group of the root counts only when the root leads its own group
  // (pgid === pid); otherwise the group is the dispatcher's/shell's and
  // would sweep in unrelated processes.
  if (root.pgid === root.pid && root.pid > 1) {
    for (const r of rows) if (r.pgid === root.pgid && !members.has(r.pid)) members.set(r.pid, r);
  }
  return [...members.values()];
}

function treeRssBytes(rootPid, rows) {
  return treeOf(rootPid, rows).reduce((s, r) => s + r.rssKB * 1024, 0);
}

/**
 * One pass over live jobs. Pure.
 * @param {{jobs:{key:string,pid:number,taskId?:string,jobId?:string}[], rows:object[], prevStrikes:Object<string,number>, capGB:number, requiredStrikes?:number}} a
 * @returns {{perJob:object[], kills:object[], nextStrikes:Object<string,number>}}
 *   Over-cap jobs strike +1; at requiredStrikes consecutive they are in `kills`.
 *   Under-cap or vanished jobs drop their strikes (one pass over never kills).
 */
function evaluatePass({ jobs, rows, prevStrikes = {}, capGB = DEFAULT_CAP_GB, requiredStrikes = REQUIRED_STRIKES }) {
  const capBytes = capGB * GB;
  const perJob = [];
  const kills = [];
  const nextStrikes = {};
  for (const j of jobs) {
    const tree = treeOf(j.pid, rows);
    if (!tree.length) continue; // dead / unknown pid: not ours to judge
    const rssBytes = tree.reduce((s, r) => s + r.rssKB * 1024, 0);
    const over = rssBytes > capBytes;
    const strikes = over ? (prevStrikes[j.key] || 0) + 1 : 0;
    if (over) nextStrikes[j.key] = strikes;
    const entry = { ...j, rssBytes, rssGB: rssBytes / GB, over, strikes, pids: tree.map(r => r.pid) };
    perJob.push(entry);
    if (strikes >= requiredStrikes) kills.push(entry);
  }
  return { perJob, kills, nextStrikes };
}

/** SIGTERM the whole tree, SIGKILL survivors after graceMs. Deps injected for tests. */
async function killTree(pids, { kill = process.kill.bind(process), sleep = (ms) => new Promise(r => setTimeout(r, ms)), graceMs = KILL_GRACE_MS, alive = (p) => { try { kill(p, 0); return true; } catch { return false; } } } = {}) {
  const send = (sig) => { for (const p of pids) { try { kill(p, sig); } catch { /* gone */ } } };
  send('SIGTERM');
  await sleep(graceMs);
  const survivors = pids.filter(alive);
  for (const p of survivors) { try { kill(p, 'SIGKILL'); } catch { /* gone */ } }
  return { signalled: pids.length, sigkilled: survivors.length };
}

function memoryCapReason(entry, capGB) {
  return `memory-cap ${capGB}GB (tree RSS ${entry.rssGB.toFixed(1)}GB over ${entry.strikes} consecutive passes)`;
}

// ── watchdog backstop ───────────────────────────────────────────────────────

/** Live job leases that recorded a pid: [{key, pid, taskId, jobId}]. */
function liveJobsFromLeases(leaseRoot, { isAlive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } } } = {}) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(leaseRoot); } catch { return out; }
  for (const d of dirs) {
    try {
      const lease = JSON.parse(fs.readFileSync(path.join(leaseRoot, d, 'lease.json'), 'utf8'));
      if (lease && Number.isInteger(lease.pid) && lease.pid > 1 && isAlive(lease.pid)) {
        out.push({ key: lease.jobId || d, pid: lease.pid, taskId: d, jobId: lease.jobId || null });
      }
    } catch { /* unreadable lease: skip */ }
  }
  return out;
}

function readStrikes(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')).strikes || {}; } catch { return {}; }
}
function writeStrikes(statePath, strikes) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ ts: new Date().toISOString(), strikes }, null, 2));
  } catch { /* best effort; worst case the next pass re-strikes */ }
}

/**
 * One watchdog pass. dryRun / report-only prints and kills nothing and does
 * not touch state. Returns { perJob, killed }.
 */
async function runLeasePass({ jobs, rows, statePath, capGB, dryRun = false, ledger, killFn = killTree, alert = null, log = console.log }) {
  if (!rows) return { perJob: [], killed: [], skipped: 'ps-unavailable' };
  const { perJob, kills, nextStrikes } = evaluatePass({ jobs, rows, prevStrikes: dryRun ? {} : readStrikes(statePath), capGB });
  for (const j of perJob) log(`[memory-cap] ${j.taskId} job=${j.jobId || '?'} pid=${j.pid} tree=${j.pids.length} proc RSS=${j.rssGB.toFixed(2)}GB cap=${capGB}GB${j.over ? ` OVER (strike ${j.strikes})` : ''}`);
  if (dryRun) return { perJob, killed: [] };
  const killed = [];
  for (const k of kills) {
    const reason = memoryCapReason(k, capGB);
    await killFn(k.pids);
    // stage stays the shared 'error' spelling (claude-cli.js STAGES contract);
    // the cap rides as fields so retry/breaker classification is unchanged.
    try {
      ledger.appendEntry({ event: ledger.JOB_EVENTS.FAILED, taskId: k.taskId, jobId: k.jobId, stage: 'implementer-error', reason, memoryCapGB: capGB, rssGB: Number(k.rssGB.toFixed(2)), detail: reason, killedBy: 'watchdog-memory-cap' });
    } catch (e) { log(`[memory-cap] ledger write failed: ${e.message}`); }
    if (alert) { try { alert({ taskId: k.taskId, jobId: k.jobId, reason }); } catch { /* alert is best effort */ } }
    delete nextStrikes[k.key];
    killed.push(k);
  }
  writeStrikes(statePath, nextStrikes);
  return { perJob, killed };
}

module.exports = {
  DEFAULT_CAP_GB, REQUIRED_STRIKES, SAMPLE_INTERVAL_MS, KILL_GRACE_MS,
  parseCapGB, parsePsTable, sampleProcessTable, treeOf, treeRssBytes, evaluatePass,
  killTree, memoryCapReason, liveJobsFromLeases, runLeasePass,
};
