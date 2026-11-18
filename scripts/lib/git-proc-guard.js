#!/usr/bin/env node
/**
 * BRO-7458: orphaned git network processes and the multi-GB temp packs they leave.
 *
 * WHY: the Codex daily runner ran `git fetch` through spawnSync with a timeout. On timeout node
 * kills only the direct child; the `git index-pack --stdin --fix-thin --keep=fetch-pack` that fetch
 * had spawned was reparented to pid 1 and kept writing .git/objects/pack/tmp_pack_* (3.4 GB seen
 * on 2026-11-18), which filled the disk and crashed the Codex lane.
 *
 * Two halves:
 *   1. Prevention (runGit / runGitOrThrow): network git (fetch|pull|clone) gets
 *      http.lowSpeedLimit=1 / http.lowSpeedTime=60 (via GIT_CONFIG_COUNT env), so an HTTPS transfer that moves nothing
 *      for 60 s aborts by itself. When spawnSync comes back timed out (ETIMEDOUT), overflowed
 *      (ENOBUFS) or signalled, runGit sweeps /proc for git helpers (index-pack, unpack-objects,
 *      fetch-pack, git-remote-http[s]) now reparented to pid 1 that are in this process's group or
 *      started after the spawn, and kills them (SIGTERM, then SIGKILL; start time rechecked first).
 *      The child is NOT detached: Ctrl-C / SIGTERM to the runner's process group must still reach
 *      fetch. http.lowSpeed* covers HTTPS only; a stalled SSH fetch relies on the timeout plus the
 *      sweep, and on the reaper's ppid-1 age rule below.
 *   2. Cleanup (pruneGitTempPacks): find orphaned git network chains from the real process tree
 *      (/proc/<pid>/stat ppid links), kill them, and unlink temp pack files no live process holds.
 *      Fails closed: an unreadable /proc or an unreadable git-looking pid keeps every file.
 *
 * Decision logic is pure over injected records (tests/unit/git-proc-guard.test.mjs, rule 15).
 *
 * CLI (report only, never kills or unlinks):
 *   node scripts/lib/git-proc-guard.js --report [--repo <dir>]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

// git global options that take their value as the NEXT token.
const VALUE_OPTIONS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
const NETWORK_SUBCOMMANDS = new Set(['fetch', 'pull', 'clone']); // push, ls-remote excluded on purpose (no index-pack)
// Network git that is never ours to kill: a helper under one of these is a live push / ls-remote's.
const LIVE_TOP_SUBCOMMANDS = new Set(['push', 'ls-remote', 'send-pack']);
// Children a fetch leaves behind, and the only helpers ever killed.
const HELPER_SUBCOMMANDS = new Set(['index-pack', 'unpack-objects', 'fetch-pack', 'remote-https', 'remote-http']);
// lowSpeedLimit=1 byte/s, not more: a deepen/negotiation fetch can be legitimately quiet for long
// stretches (server counting objects, keepalive sideband packets only), and any byte proves the
// transfer is alive. Only a transfer moving nothing at all for 60 s is aborted.
const LOW_SPEED_ARGS = ['-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=60'];
// Passed through GIT_CONFIG_COUNT/KEY/VALUE (git >= 2.31), not argv: argv stays exactly what the
// caller wrote, so fake-git test doubles that switch on "$1" and argv-reading hooks keep working.
const LOW_SPEED_CONFIG = [['http.lowSpeedLimit', '1'], ['http.lowSpeedTime', '60']];
/** env plus LOW_SPEED_CONFIG appended after any GIT_CONFIG_* entries the caller already set. */
function withLowSpeedEnv(env) {
  const out = { ...(env || process.env) };
  let n = Number.parseInt(out.GIT_CONFIG_COUNT, 10);
  if (!Number.isFinite(n) || n < 0) n = 0;
  for (const [k, v] of LOW_SPEED_CONFIG) { out[`GIT_CONFIG_KEY_${n}`] = k; out[`GIT_CONFIG_VALUE_${n}`] = v; n++; }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

/** Largest timeout runGit allows a network git; larger asks are clamped. */
const MAX_NETWORK_GIT_TIMEOUT_MS = 20 * 60_000;
/** A top-level network git reparented to pid 1 older than this cannot belong to any runGit call. */
const ORPHAN_NETWORK_GIT_AGE_MS = MAX_NETWORK_GIT_TIMEOUT_MS + 10 * 60_000;
/** A temp pack file this old with no live holder is reapable even if we killed nothing. */
const TEMP_PACK_MIN_AGE_MS = 30 * 60_000;
const EXIT_POLL_MS = 5_000;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The git subcommand in `args` (the arguments after `git`), skipping global options. */
function gitSubcommand(args) {
  const a = Array.isArray(args) ? args : [];
  for (let i = 0; i < a.length; i++) {
    const tok = String(a[i]);
    if (VALUE_OPTIONS.has(tok)) { i++; continue; }
    if (tok.startsWith('-')) continue; // --git-dir=x, --no-pager, --bare, ...
    return tok;
  }
  return null;
}

const isNetworkGit = (args) => NETWORK_SUBCOMMANDS.has(gitSubcommand(args));
const isGitCmd = (cmd) => path.basename(String(cmd || '')) === 'git';

function errCode(e) { return e && e.code; }

/** Kernel clock ticks since boot (the unit of /proc/<pid>/stat starttime), or null. */
function uptimeTicks(procRoot = '/proc') {
  try { return Math.floor(Number(fs.readFileSync(path.join(procRoot, 'uptime'), 'utf8').split(/\s+/)[0]) * clockTicks()); } catch { return null; }
}
function ownPgrp() {
  try { return parseStat(fs.readFileSync('/proc/self/stat', 'utf8')).pgrp; } catch { return null; }
}

/**
 * After a network git came back timed out / signalled: helpers reparented to pid 1 that are in our
 * process group or started after `sinceTicks` are what that git left running. Kill them.
 * -> { ok, killed: [pids], survived: [pids] }
 */
function sweepOrphanedHelpers({ sinceTicks = null, pgrp = ownPgrp(), scan = () => readProcRecords(), kill = process.kill, readState, readStartTicks, timeoutMs = EXIT_POLL_MS, pollMs = 100 } = {}) {
  const s = scan();
  // Kill only what we could read in full; an unreadable entry is left alone.
  const targets = (s.records || []).filter((r) => r.readable && r.ppid === 1 && !(Array.isArray(r.nspid) && r.nspid.length > 1)
    && procRole(r) === 'helper' && ((pgrp != null && r.pgrp === pgrp) || (sinceTicks != null && Number.isFinite(r.startTicks) && r.startTicks >= sinceTicks)));
  if (!targets.length) return { ok: s.ok, killed: [], survived: [] };
  const k = killChain(targets.map((r) => r.pid), { kill, readState, readStartTicks, timeoutMs, pollMs, startTicks: new Map(targets.map((r) => [r.pid, r.startTicks])) });
  return { ok: s.ok, killed: k.exited, survived: k.survived };
}

/**
 * spawnSync plus, for a network git: HTTPS low-speed aborts, a 20 min timeout cap and, when it comes
 * back timed out / overflowed / signalled, the sweep above. Same return shape as spawnSync (plus
 * `timedOut`, `swept`). `inject` ({ kill, scan, readState, readStartTicks }) is for tests.
 */
function runGit(cmd, args, opts = {}, inject = {}) {
  const network = isGitCmd(cmd) && isNetworkGit(args);
  if (!network) return spawnSync(cmd, args, opts);
  const timeout = opts.timeout ? Math.min(opts.timeout, MAX_NETWORK_GIT_TIMEOUT_MS) : MAX_NETWORK_GIT_TIMEOUT_MS;
  const since = uptimeTicks();
  const r = spawnSync(cmd, args, { ...opts, timeout, env: withLowSpeedEnv(opts.env) });
  r.timedOut = errCode(r.error) === 'ETIMEDOUT';
  if (r.error || r.signal) {
    try { r.swept = sweepOrphanedHelpers({ sinceTicks: since == null ? null : since - 1, ...inject }); } catch { /* best effort */ }
  }
  return r;
}

/** execFileSync('git', args, opts)-shaped: returns stdout, throws an error carrying status/signal/stdout/stderr. */
function runGitOrThrow(args, opts = {}, inject) {
  const r = runGit('git', args, opts, inject);
  // execFileSync prints the child's stderr when the caller did not choose stdio.
  if (opts.stdio === undefined && r.stderr && r.stderr.length) process.stderr.write(r.stderr);
  if (r.error || r.status !== 0) {
    const e = r.error || new Error(`Command failed: git ${args.join(' ')}\n${r.stderr || ''}`);
    Object.assign(e, { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, pid: r.pid });
    throw e;
  }
  return r.stdout;
}

// ---------------------------------------------------------------- /proc reading

let clkTck = null;
function clockTicks() {
  if (clkTck == null) {
    try { clkTck = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 5000 }).trim()) || 100; } catch { clkTck = 100; }
  }
  return clkTck;
}

/** Parse /proc/<pid>/stat text -> { state, ppid, pgrp, startTicks } (comm may hold spaces/parens). */
function parseStat(text) {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const f = text.slice(close + 2).trim().split(/\s+/);
  return { state: f[0], ppid: Number(f[1]), pgrp: Number(f[2]), startTicks: Number(f[19]) };
}

const isGitLookingComm = (comm) => /^git(-|$)/.test(String(comm || '').trim());

/**
 * One /proc entry -> record, or null when the process is gone (ENOENT/ESRCH mid-read).
 * readable:false when a git-looking process could not be fully read (fail closed upstream).
 */
function readProcEntry(procRoot, pid, { uptimeMs = null } = {}) {
  const dir = path.join(procRoot, String(pid));
  const gone = (e) => ['ENOENT', 'ESRCH'].includes(errCode(e));
  let comm;
  let st;
  try {
    comm = fs.readFileSync(path.join(dir, 'comm'), 'utf8').trim();
    st = parseStat(fs.readFileSync(path.join(dir, 'stat'), 'utf8'));
  } catch (e) {
    if (gone(e)) return null;
    return { pid: Number(pid), readable: false, gitLooking: true, why: `stat: ${errCode(e) || e.message}` }; // unknown = assume git
  }
  if (!st) return { pid: Number(pid), readable: false, gitLooking: true, why: 'stat unparsable' };
  const rec = {
    pid: Number(pid), ppid: st.ppid, pgrp: st.pgrp, state: st.state, comm, startTicks: st.startTicks,
    gitLooking: isGitLookingComm(comm), readable: true, cmdline: [], fdTargets: [], cwd: null, nspid: [Number(pid)],
    ageMs: uptimeMs != null && Number.isFinite(st.startTicks) ? Math.max(0, uptimeMs - (st.startTicks * 1000) / clockTicks()) : null,
  };
  try {
    const raw = fs.readFileSync(path.join(dir, 'cmdline'), 'utf8').replace(/\0$/, '');
    rec.cmdline = raw === '' ? [] : raw.split('\0');
    const ns = fs.readFileSync(path.join(dir, 'status'), 'utf8').match(/^NSpid:\s*(.+)$/m);
    if (ns) rec.nspid = ns[1].trim().split(/\s+/).map(Number);
    try { rec.cwd = fs.readlinkSync(path.join(dir, 'cwd')); } catch (e) { if (gone(e)) return null; if (rec.gitLooking) throw e; }
    let fds = [];
    try { fds = fs.readdirSync(path.join(dir, 'fd')); } catch (e) { if (gone(e)) return null; if (rec.gitLooking) throw e; }
    for (const fd of fds) {
      try { rec.fdTargets.push(fs.readlinkSync(path.join(dir, 'fd', fd))); } catch (e) { if (!gone(e) && rec.gitLooking) throw e; }
    }
  } catch (e) {
    if (gone(e)) return null;
    rec.readable = false;
    rec.why = `${errCode(e) || e.message}`;
  }
  return rec;
}

/**
 * Snapshot every process -> { ok, records, why? }. ok:false when /proc cannot be listed or any
 * git-looking process could not be read: the caller then keeps every file and kills nothing.
 * Fail closed by design: a git process of ANOTHER uid whose fds/cwd we may not read (a non-root
 * runner beside a sandbox user's git) makes the whole scan incomplete, so every temp file is kept.
 */
function readProcRecords({ procRoot = '/proc' } = {}) {
  let names;
  try { names = fs.readdirSync(procRoot); } catch (e) { return { ok: false, records: [], why: `cannot list ${procRoot}: ${errCode(e) || e.message}` }; }
  let uptimeMs = null;
  try { uptimeMs = Number(fs.readFileSync(path.join(procRoot, 'uptime'), 'utf8').split(/\s+/)[0]) * 1000; } catch { /* ages unknown: age rule never fires */ }
  const records = [];
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const rec = readProcEntry(procRoot, n, { uptimeMs });
    if (rec) records.push(rec);
  }
  const bad = records.filter((r) => r.gitLooking && !r.readable);
  if (bad.length) return { ok: false, records, why: `unreadable git-looking pid(s): ${bad.map((r) => `${r.pid} (${r.why})`).join(', ')}` };
  return { ok: true, records };
}

// ---------------------------------------------------------------- pure decisions

/**
 * Role of a process record: 'network' (fetch|pull|clone), 'live-top' (push|ls-remote|send-pack:
 * never killed, nor anything under it), 'helper' (a killable fetch helper), 'git' (other git), or null.
 */
function procRole(rec) {
  const argv = rec.cmdline || [];
  if (!argv.length) return rec.gitLooking ? 'git' : null;
  const base = path.basename(argv[0]);
  let sub = null;
  if (base === 'git') sub = gitSubcommand(argv.slice(1));
  else if (base.startsWith('git-')) sub = base.slice(4);
  else return rec.gitLooking ? 'git' : null;
  if (NETWORK_SUBCOMMANDS.has(sub)) return 'network';
  if (LIVE_TOP_SUBCOMMANDS.has(sub)) return 'live-top';
  if (HELPER_SUBCOMMANDS.has(sub)) return 'helper';
  return 'git';
}

const under = (p, dir) => typeof p === 'string' && (p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`));
const touchesRepo = (rec, commonDir) => under(rec.cwd, commonDir) || (rec.fdTargets || []).some((t) => under(t, commonDir));

/**
 * -> { chains: [{ top, pids, reason }], subreaperChains, nestedSkipped }
 * A helper (index-pack, fetch-pack, git-remote-https...) is orphaned when no ancestor is a live
 * top-level fetch|pull|clone and its git ancestry tops out at ppid 1. A top-level network git
 * with ppid 1 older than orphanAgeMs is orphaned too (its whole chain goes). Every chain must
 * touch our git common dir (open fd or cwd), and nothing in a nested pid namespace is touched.
 */
function findOrphanGitChains(records, { gitCommonDir, orphanAgeMs = ORPHAN_NETWORK_GIT_AGE_MS } = {}) {
  const byPid = new Map(records.map((r) => [r.pid, r]));
  const kids = new Map();
  for (const r of records) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r); }
  const nested = (r) => Array.isArray(r.nspid) && r.nspid.length > 1;
  const isGit = (r) => r && procRole(r) != null;
  const out = { chains: [], subreaperChains: 0, nestedSkipped: 0 };
  const seenTops = new Set();

  const chainFrom = (top) => {
    const pids = [];
    const walk = (r) => { pids.push(r.pid); for (const k of kids.get(r.pid) || []) if (isGit(k)) walk(k); };
    walk(top);
    return pids;
  };
  const addChain = (top, reason) => {
    if (seenTops.has(top.pid)) return;
    seenTops.add(top.pid);
    const pids = chainFrom(top);
    const members = pids.map((p) => byPid.get(p));
    if (members.some((m) => nested(m) || !m.readable)) { out.nestedSkipped++; return; }
    if (!members.some((m) => touchesRepo(m, gitCommonDir))) return; // another repo's
    out.chains.push({ top: top.pid, pids, reason });
  };

  for (const r of records) {
    if (!r.readable) continue;
    if (nested(r)) { if (isGit(r)) out.nestedSkipped++; continue; }
    const role = procRole(r);
    if (role === 'helper') {
      let top = r;
      let owned = false;
      for (let cur = r, guard = 0; guard < 64; guard++) {
        const parent = byPid.get(cur.ppid);
        if (!parent) break;
        const pr = procRole(parent);
        // A live fetch owns it; a push / ls-remote is a live top we never kill under.
        if (pr === 'network' || pr === 'live-top') { owned = true; break; }
        if (!pr) break; // non-git parent
        top = parent; cur = parent;
      }
      if (owned) continue; // a live fetch owns it; the age rule below judges that fetch
      // Only a killable helper may top a killed chain (never some other git command).
      if (top.ppid === 1 && procRole(top) === 'helper') addChain(top, 'helper reparented to pid 1');
      else if (top.ppid === 1) continue;
      else if (!byPid.get(top.ppid) || !isGit(byPid.get(top.ppid))) {
        // Tops out at a non-git, non-init parent: a subreaper, or a person running it by hand.
        if (touchesRepo(r, gitCommonDir)) out.subreaperChains++;
      }
    } else if (role === 'network' && r.ppid === 1 && r.ageMs != null && r.ageMs > orphanAgeMs) {
      addChain(r, `network git reparented to pid 1, ${Math.round(r.ageMs / 60_000)} min old`);
    }
  }
  return out;
}

/** Alive? kill(pid,0): ESRCH = dead, EPERM = alive; a zombie (state Z) counts as dead. */
function pidAlive(pid, { kill = process.kill, readState = defaultReadState } = {}) {
  try { kill(pid, 0); } catch (e) { if (errCode(e) === 'ESRCH') return false; /* EPERM (or anything else): exists */ }
  return readState(pid) !== 'Z';
}
function defaultReadStartTicks(pid) {
  try { return parseStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))?.startTicks ?? null; } catch { return null; }
}
function defaultReadState(pid) {
  try { return parseStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))?.state || null; } catch { return null; }
}

/** Poll until every pid is dead (or a zombie) or timeoutMs passes -> Set of pids still alive. */
function waitForExit(pids, { timeoutMs = EXIT_POLL_MS, pollMs = 100, ...probe } = {}) {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter((p) => pidAlive(p, probe));
  while (alive.length && Date.now() < deadline) {
    sleepSync(pollMs);
    alive = alive.filter((p) => pidAlive(p, probe));
  }
  return new Set(alive);
}

/** SIGTERM a chain, wait, SIGKILL survivors, wait -> { exited: [pids], survived: [pids] }. */
function killChain(pids, { kill = process.kill, readState = defaultReadState, timeoutMs = EXIT_POLL_MS, pollMs = 100, startTicks = new Map(), readStartTicks = defaultReadStartTicks } = {}) {
  const reused = new Set();
  // Re-read starttime right before each signal: a pid whose start changed is a new process that
  // reused the number (ours already exited), so it is skipped and never signalled.
  const same = (p) => { const want = startTicks.get(p); if (want == null) return true; const now = readStartTicks(p); if (now === want) return true; reused.add(p); return false; };
  // ESRCH: already gone; EPERM: not ours to kill (waitForExit then reports it as a survivor).
  const send = (sig, list) => { for (const p of list) { if (reused.has(p) || !same(p)) continue; try { kill(p, sig); } catch { /* see above */ } } };
  send('SIGTERM', pids);
  let alive = waitForExit(pids.filter((p) => !reused.has(p)), { kill, readState, timeoutMs, pollMs });
  if (alive.size) {
    send('SIGKILL', [...alive]);
    alive = waitForExit([...alive], { kill, readState, timeoutMs, pollMs });
  }
  return { exited: pids.filter((p) => !alive.has(p)), survived: [...alive] };
}

const TEMP_PACK_NAME = /^(tmp_pack_|tmp_idx_|\.tmp-\d+-pack-|pack-[0-9a-f]+\.keep$)/;
const isTempPackName = (n) => TEMP_PACK_NAME.test(n);

/** pid a temp file names (keep file's `fetch-pack <pid> on <host>`, repack's `.tmp-<pid>-pack-`), with host. */
function namedOwner(name, readText) {
  const m = name.match(/^\.tmp-(\d+)-pack-/);
  if (m) return { pid: Number(m[1]), host: os.hostname() };
  if (/\.keep$/.test(name)) {
    const k = String(readText() || '').match(/^fetch-pack (\d+) on (\S+)/);
    return k ? { pid: Number(k[1]), host: k[2] } : { unknown: true };
  }
  return null;
}

/** Sum of bytes in temp-pack files under <commonDir>/objects/pack (for logDiskUsage). */
function tempPackBytes(gitCommonDir) {
  const dir = path.join(gitCommonDir, 'objects', 'pack');
  let total = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const n of names) if (isTempPackName(n)) { try { total += fs.lstatSync(path.join(dir, n)).size; } catch { /* gone */ } }
  return total;
}

/**
 * Kill orphaned git network chains under gitCommonDir, then unlink temp pack files nothing holds.
 * A file goes only when (a) it is >= minAgeMs old or (b) its holders were all orphans we killed
 * and saw exit, AND a fresh /proc re-scan shows no live holder. dryRun reports what would happen.
 * -> { ok, why?, chains, killed, survived, reaped: [{name, bytes}], kept: [{name, why}], bytes, subreaperChains, nestedSkipped }
 */
function pruneGitTempPacks({
  gitCommonDir, dryRun = false, kill = process.kill, readState = defaultReadState, readStartTicks = defaultReadStartTicks,
  scan = () => readProcRecords(), now = () => Date.now(), minAgeMs = TEMP_PACK_MIN_AGE_MS,
  orphanAgeMs = ORPHAN_NETWORK_GIT_AGE_MS, exitTimeoutMs = EXIT_POLL_MS, pollMs = 100, unlink = fs.unlinkSync,
} = {}) {
  const res = { ok: true, dryRun, chains: [], killed: [], survived: [], reaped: [], kept: [], bytes: 0, subreaperChains: 0, nestedSkipped: 0 };
  const commonDir = path.resolve(gitCommonDir);
  const packDir = path.join(commonDir, 'objects', 'pack');
  let names = [];
  try { names = fs.readdirSync(packDir).filter(isTempPackName); } catch { names = []; }

  const first = scan();
  if (!first.ok) return { ...res, ok: false, why: first.why, kept: names.map((name) => ({ name, why: 'process scan incomplete' })) };
  const found = findOrphanGitChains(first.records, { gitCommonDir: commonDir, orphanAgeMs });
  Object.assign(res, { chains: found.chains, subreaperChains: found.subreaperChains, nestedSkipped: found.nestedSkipped });
  const orphanPids = new Set(found.chains.flatMap((c) => c.pids));
  const byPidStart = new Map(first.records.map((r) => [r.pid, r.startTicks]));
  const probe = { kill, readState };

  let exited = new Set();
  if (dryRun) exited = new Set(orphanPids); // as if every kill succeeded
  else {
    for (const c of found.chains) {
      const k = killChain(c.pids, { ...probe, timeoutMs: exitTimeoutMs, pollMs, readStartTicks, startTicks: new Map(c.pids.map((p) => [p, byPidStart.get(p)])) });
      res.killed.push(...k.exited);
      res.survived.push(...k.survived);
      for (const p of k.exited) exited.add(p);
    }
  }
  if (!names.length) return res;

  const holders = (records, file) => records.filter((r) => (r.fdTargets || []).some((t) => t === file || t === `${file} (deleted)`)).map((r) => r.pid);
  const before = new Map(names.map((n) => [n, holders(first.records, path.join(packDir, n))]));
  // Fresh re-scan after the kills. In a dry run, the first scan minus the would-be-killed orphans.
  let second;
  if (dryRun) second = { ok: true, records: first.records.filter((r) => !orphanPids.has(r.pid)) };
  else second = scan();
  if (!second.ok) { res.kept.push(...names.map((name) => ({ name, why: `re-scan incomplete: ${second.why}` }))); return res; }

  const t = now();
  for (const name of names) {
    const file = path.join(packDir, name);
    let st;
    try { st = fs.lstatSync(file); } catch { continue; }
    if (!st.isFile()) { res.kept.push({ name, why: 'not a regular file' }); continue; }
    const owner = namedOwner(name, () => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } });
    if (owner && owner.unknown) { res.kept.push({ name, why: '.keep not written by fetch-pack' }); continue; }
    if (owner && owner.host !== os.hostname()) { res.kept.push({ name, why: `owner on another host (${owner.host})` }); continue; }
    if (owner && !exited.has(owner.pid) && pidAlive(owner.pid, probe)) { res.kept.push({ name, why: `owner pid ${owner.pid} alive` }); continue; }
    const held = before.get(name) || [];
    const ageOk = t - st.mtimeMs >= minAgeMs;
    const orphanHeld = held.length > 0 && held.every((p) => exited.has(p));
    const ownerKilled = !!owner && exited.has(owner.pid);
    if (!ageOk && !orphanHeld && !ownerKilled) { res.kept.push({ name, why: `young (${Math.round((t - st.mtimeMs) / 60_000)} min) and not an orphan's` }); continue; }
    const live = holders(second.records, file).filter((p) => !exited.has(p) || pidAlive(p, probe));
    if (live.length) { res.kept.push({ name, why: `held by live pid ${live.join(',')}` }); continue; }
    if (dryRun) { res.reaped.push({ name, bytes: st.size, would: true }); continue; }
    try { unlink(file); res.reaped.push({ name, bytes: st.size }); res.bytes += st.size; } catch (e) { res.kept.push({ name, why: `unlink: ${errCode(e) || e.message}` }); }
  }
  if (dryRun) res.wouldFreeBytes = res.reaped.reduce((s, r) => s + r.bytes, 0);
  return res;
}

/** One log line for pruneDisk. */
function summarizePrune(r) {
  const gb = (b) => `${(b / 1e9).toFixed(2)} GB`;
  if (!r.ok) return `git temp packs: kept all (${r.why}); ${r.kept.length} file(s)`;
  const freed = r.dryRun ? `would free ${gb(r.wouldFreeBytes || 0)}` : `freed ${gb(r.bytes)}`;
  return `git temp packs: ${r.chains.length} orphan chain(s)${r.chains.length ? ` [${r.chains.map((c) => c.pids.join('>')).join('; ')}]` : ''}`
    + `, killed ${r.killed.length}${r.survived.length ? `, survived ${r.survived.join(',')}` : ''}`
    + `, reaped ${r.reaped.length} file(s) ${freed}, kept ${r.kept.length}`
    + `, subreaper chains ${r.subreaperChains}${r.nestedSkipped ? `, nested-ns skipped ${r.nestedSkipped}` : ''}`;
}

/** Absolute git common dir of the repo at cwd, or null. */
function gitCommonDirOf(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return path.resolve(cwd, out);
  } catch { return null; }
}

module.exports = {
  gitSubcommand, isNetworkGit, runGit, runGitOrThrow, sweepOrphanedHelpers,
  parseStat, readProcEntry, readProcRecords, procRole, findOrphanGitChains,
  pidAlive, waitForExit, killChain, isTempPackName, tempPackBytes, pruneGitTempPacks, summarizePrune, gitCommonDirOf,
  LOW_SPEED_ARGS, LOW_SPEED_CONFIG, withLowSpeedEnv, MAX_NETWORK_GIT_TIMEOUT_MS, ORPHAN_NETWORK_GIT_AGE_MS, TEMP_PACK_MIN_AGE_MS,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h') || !argv.includes('--report')) {
    console.log('Usage: node scripts/lib/git-proc-guard.js --report [--repo <dir>]\n  Reports orphaned git network chains and reapable temp packs. Never kills or unlinks.');
    process.exit(argv.includes('--report') ? 0 : (argv.length ? 2 : 0));
  }
  const ri = argv.indexOf('--repo');
  const repo = ri >= 0 ? argv[ri + 1] : process.cwd();
  const common = gitCommonDirOf(repo);
  if (!common) { console.error(`not a git repo: ${repo}`); process.exit(2); }
  const r = pruneGitTempPacks({ gitCommonDir: common, dryRun: true });
  console.log(`git common dir: ${common}`);
  console.log(summarizePrune(r));
  for (const c of r.chains) console.log(`  orphan chain top=${c.top} pids=${c.pids.join(',')} (${c.reason})`);
  for (const f of r.reaped) console.log(`  would reap ${f.name} (${(f.bytes / 1e9).toFixed(2)} GB)`);
  for (const f of r.kept) console.log(`  keep ${f.name}: ${f.why}`);
}
