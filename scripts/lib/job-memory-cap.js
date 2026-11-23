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
// BRO-8175: two writers share the strike state (the 60s launchd agent and the
// 90s cmux dashboard sweep). An over-cap pass only ADVANCES a job's strike
// count when its last strike is at least this old, so two passes a second
// apart are one sample, never two.
const MIN_STRIKE_GAP_MS = 30 * 1000;
const FOOTPRINT_TIMEOUT_MS = 5000;
const KILL_GRACE_MS = 10 * 1000;
const GB = 1024 * 1024 * 1024;

/** BSC_JOB_MEMORY_CAP_OFF=1 turns BOTH enforcement points off (rollback switch). */
function capDisabled(env = process.env) { return String(env.BSC_JOB_MEMORY_CAP_OFF || '').trim() === '1'; }

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
 * BRO-8175: `footprint -f bytes --noCategories -p A -p B` text -> Map pid->bytes.
 * Keys ONLY on the per-process header `name [pid]: ... Footprint: N B`
 * (never the trailing `Summary Footprint`), and prefers the block's
 * `phys_footprint: N B` line when present. A pid footprint could not find
 * prints to stderr and simply has no entry (caller falls back to RSS).
 */
function parseFootprintOutput(text) {
  const out = new Map();
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const h = line.match(/^\S.*\[(\d+)\]:.*\bFootprint:\s*(\d+)\s*B\b/);
    if (h && !/^Summary Footprint/.test(line)) { cur = +h[1]; out.set(cur, +h[2]); continue; }
    if (/^Summary Footprint/.test(line)) { cur = null; continue; }
    const pf = line.match(/^\s*phys_footprint:\s*(\d+)\s*B\b/);
    if (pf && cur !== null) out.set(cur, +pf[1]);
  }
  return out;
}

/** I/O boundary. Map pid->footprint bytes; empty Map on any failure (RSS fallback). */
function sampleFootprints(pids, execFn = execFileSync) {
  const ids = [...new Set(pids)].filter(p => Number.isInteger(p) && p > 1);
  if (!ids.length) return new Map();
  const args = ['-f', 'bytes', '--noCategories'];
  for (const p of ids) args.push('-p', String(p));
  let text = '';
  try {
    text = execFn('/usr/bin/footprint', args, { encoding: 'utf8', timeout: FOOTPRINT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { text = (e && e.stdout) ? String(e.stdout) : ''; }
  return parseFootprintOutput(text);
}

/**
 * BRO-8175: process table for the given job roots, with footprintBytes on
 * every member of their trees. RSS alone undercounts a runaway whose pages
 * are compressed/swapped (the 2026-11-23 numbers were footprint). null when
 * ps fails (fail open).
 */
function sampleJobRows(rootPids, { psExec = execFileSync, fpExec = execFileSync } = {}) {
  const rows = sampleProcessTable(psExec);
  if (!rows) return null;
  const members = new Set();
  for (const p of rootPids) for (const r of treeOf(p, rows)) members.add(r.pid);
  const fp = sampleFootprints([...members], fpExec);
  return rows.map(r => (fp.has(r.pid) ? { ...r, footprintBytes: fp.get(r.pid) } : r));
}

/** Bytes charged to one process: the larger of RSS and phys_footprint, so the cap never sees less than before. */
function procBytes(r) {
  return Math.max((r.rssKB || 0) * 1024, r.footprintBytes || 0);
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
  return treeOf(rootPid, rows).reduce((s, r) => s + procBytes(r), 0);
}

/**
 * One pass over live jobs. Pure.
 * @param {{jobs:{key:string,pid:number,taskId?:string,jobId?:string}[], rows:object[], prevStrikes:Object<string,number>, capGB:number, requiredStrikes?:number, prevStrikeAt?:Object<string,number>, now?:number, minGapMs?:number}} a
 * @returns {{perJob:object[], kills:object[], nextStrikes:Object<string,number>, nextStrikeAt:Object<string,number>}}
 *   Over-cap jobs strike +1; at requiredStrikes consecutive they are in `kills`.
 *   Under-cap or vanished jobs drop their strikes (one pass over never kills).
 *   With prevStrikeAt (BRO-8175), an over-cap pass less than minGapMs after
 *   the job's last strike keeps the count instead of advancing it.
 *   memBytes/memGB = tree sum of max(RSS, phys_footprint) per process.
 */
function evaluatePass({ jobs, rows, prevStrikes = {}, capGB = DEFAULT_CAP_GB, requiredStrikes = REQUIRED_STRIKES, prevStrikeAt = null, now = Date.now(), minGapMs = MIN_STRIKE_GAP_MS }) {
  const capBytes = capGB * GB;
  const perJob = [];
  const kills = [];
  const nextStrikes = {};
  const nextStrikeAt = {};
  for (const j of jobs) {
    const tree = treeOf(j.pid, rows);
    if (!tree.length) continue; // dead / unknown pid: not ours to judge
    if (j.pid === process.pid || j.pid === process.ppid) continue; // never judge the watchdog/dispatcher itself
    const memBytes = tree.reduce((s, r) => s + procBytes(r), 0);
    const over = memBytes > capBytes;
    const prev = prevStrikes[j.key] || 0;
    const lastAt = prevStrikeAt ? prevStrikeAt[j.key] : undefined;
    const tooSoon = prev > 0 && Number.isFinite(lastAt) && now - lastAt < minGapMs;
    const strikes = over ? (tooSoon ? prev : prev + 1) : 0;
    if (over) { nextStrikes[j.key] = strikes; nextStrikeAt[j.key] = tooSoon ? lastAt : now; }
    const entry = { ...j, memBytes, memGB: memBytes / GB, over, strikes, pids: tree.map(r => r.pid) };
    perJob.push(entry);
    if (strikes >= requiredStrikes) kills.push(entry);
  }
  return { perJob, kills, nextStrikes, nextStrikeAt };
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
  return `memory-cap ${capGB}GB (tree memory ${entry.memGB.toFixed(1)}GB over ${entry.strikes} consecutive passes)`;
}

// ── watchdog backstop ───────────────────────────────────────────────────────

/**
 * Live job leases that recorded a pid: [{key, pid, taskId, jobId}].
 * Liveness is bsc-runner's own leaseLooksLive (pid is a claude process AND
 * started near the lease), so a stale lease whose pid was recycled by an
 * unrelated process is never signalled.
 */
function liveJobsFromLeases(leaseRoot, { looksLive = (lease) => require('./bsc-runner.js').leaseLooksLive(lease) } = {}) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(leaseRoot); } catch { return out; }
  for (const d of dirs) {
    try {
      const lease = JSON.parse(fs.readFileSync(path.join(leaseRoot, d, 'lease.json'), 'utf8'));
      if (lease && Number.isInteger(lease.pid) && lease.pid > 1 && looksLive(lease)) {
        out.push({ key: lease.jobId || d, pid: lease.pid, taskId: d, jobId: lease.jobId || null });
      }
    } catch { /* unreadable lease: skip */ }
  }
  return out;
}

// Strikes older than this are not "consecutive" (e.g. after a watchdog outage).
const STRIKE_MAX_AGE_MS = 10 * 60 * 1000;
/**
 * State file: { ts, strikes: {key:n}, strikeAt: {key: epochMs} }. ts is the
 * last pass (liveness for --health). A strike older than STRIKE_MAX_AGE_MS is
 * dropped. Pre-BRO-8175 files (no strikeAt) use ts for every key.
 */
function readState(statePath, now = Date.now()) {
  try {
    const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const tsMs = Date.parse(st.ts);
    const strikes = {};
    const strikeAt = {};
    for (const [k, n] of Object.entries(st.strikes || {})) {
      const at = st.strikeAt && Number.isFinite(st.strikeAt[k]) ? st.strikeAt[k] : tsMs;
      if (Number.isFinite(at) && now - at <= STRIKE_MAX_AGE_MS) { strikes[k] = n; strikeAt[k] = at; }
    }
    return { strikes, strikeAt };
  } catch { return { strikes: {}, strikeAt: {} }; }
}
function readStrikes(statePath, now = Date.now()) { return readState(statePath, now).strikes; }
function writeStrikes(statePath, strikes, strikeAt = {}, now = Date.now()) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ts: new Date(now).toISOString(), strikes, strikeAt }, null, 2));
    fs.renameSync(tmp, statePath);
  } catch { /* best effort; worst case the next pass re-strikes */ }
}

/** Age of the last pass recorded in the state file, or null when missing/unreadable. */
function stateAgeMs(statePath, now = Date.now()) {
  try {
    const t = Date.parse(JSON.parse(fs.readFileSync(statePath, 'utf8')).ts);
    return Number.isFinite(t) ? now - t : null;
  } catch { return null; }
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } }
/**
 * BRO-8175: one pass at a time across the launchd agent and the dashboard
 * sweep. mkdir lock + pid file (same shape as dispatch-watchdog acquireLock):
 * a holder that died (SIGKILL/jetsam under memory pressure) is reclaimed, a
 * pid-less dir is only broken once it is older than 60s.
 */
function acquirePassLock(lockDir, { alive = pidAlive, now = Date.now() } = {}) {
  const pidFile = path.join(lockDir, 'pid');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(path.dirname(lockDir), { recursive: true });
      fs.mkdirSync(lockDir);
      fs.writeFileSync(pidFile, String(process.pid));
      return () => { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* gone */ } };
    } catch {
      let holder = null;
      try { holder = parseInt(fs.readFileSync(pidFile, 'utf8'), 10); } catch { holder = null; }
      if (holder) { if (holder !== process.pid && alive(holder)) return null; }
      else {
        let ageMs = 0;
        try { ageMs = now - fs.statSync(lockDir).mtimeMs; } catch { continue; }
        if (ageMs < 60 * 1000) return null;
      }
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* raced */ }
    }
  }
  return null;
}

/**
 * One watchdog pass. dryRun / report-only prints and kills nothing and does
 * not touch state. Returns { perJob, killed }.
 */
async function runLeasePass({ jobs, rows, statePath, capGB, dryRun = false, ledger, killFn = killTree, alert = null, log = console.log, now = Date.now() }) {
  if (capDisabled()) return { perJob: [], killed: [], skipped: 'disabled' };
  if (!rows) return { perJob: [], killed: [], skipped: 'ps-unavailable' };
  if (dryRun) {
    const { perJob } = evaluatePass({ jobs, rows, prevStrikes: {}, capGB, now });
    logPerJob(perJob, capGB, log);
    return { perJob, killed: [] };
  }
  const release = acquirePassLock(`${statePath}.lock`, { now });
  if (!release) { log('[memory-cap] another pass holds the lock — skipping'); return { perJob: [], killed: [], skipped: 'locked' }; }
  try {
    const prev = readState(statePath, now);
    const { perJob, kills, nextStrikes, nextStrikeAt } = evaluatePass({ jobs, rows, prevStrikes: prev.strikes, prevStrikeAt: prev.strikeAt, capGB, now });
    logPerJob(perJob, capGB, log);
    const killed = [];
    for (const k of kills) {
      const reason = memoryCapReason(k, capGB);
      await killFn(k.pids);
      // stage stays the shared 'error' spelling (claude-cli.js STAGES contract);
      // the cap rides as fields so retry/breaker classification is unchanged.
      // rssGB keeps its BRO-8167 name for ledger readers; it now carries the
      // tree's max(RSS, footprint) total.
      try {
        ledger.appendEntry({ event: ledger.JOB_EVENTS.FAILED, taskId: k.taskId, jobId: k.jobId, stage: 'implementer-error', reason, memoryCapGB: capGB, rssGB: Number(k.memGB.toFixed(2)), detail: reason, killedBy: 'watchdog-memory-cap' });
      } catch (e) { log(`[memory-cap] ledger write failed: ${e.message}`); }
      if (alert) { try { alert({ taskId: k.taskId, jobId: k.jobId, reason }); } catch { /* alert is best effort */ } }
      delete nextStrikes[k.key];
      delete nextStrikeAt[k.key];
      killed.push(k);
    }
    writeStrikes(statePath, nextStrikes, nextStrikeAt, now);
    return { perJob, killed };
  } finally { release(); }
}

function logPerJob(perJob, capGB, log) {
  for (const j of perJob) log(`[memory-cap] ${j.taskId} job=${j.jobId || '?'} pid=${j.pid} tree=${j.pids.length} proc mem=${j.memGB.toFixed(2)}GB cap=${capGB}GB${j.over ? ` OVER (strike ${j.strikes})` : ''}`);
}

module.exports = {
  DEFAULT_CAP_GB, REQUIRED_STRIKES, SAMPLE_INTERVAL_MS, KILL_GRACE_MS, MIN_STRIKE_GAP_MS, STRIKE_MAX_AGE_MS,
  capDisabled, parseCapGB, parsePsTable, sampleProcessTable, treeOf, treeRssBytes, evaluatePass,
  parseFootprintOutput, sampleFootprints, sampleJobRows, procBytes,
  killTree, memoryCapReason, liveJobsFromLeases, runLeasePass,
  readState, readStrikes, writeStrikes, stateAgeMs, acquirePassLock,
};
