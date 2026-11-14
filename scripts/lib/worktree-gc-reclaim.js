'use strict';
/**
 * Pure decision functions for worktree GC + dispatch disk-pressure (BRO-2319).
 *
 * Extracted per CLAUDE.md rule 15 so scripts/gc-merged-worktrees.sh (bash)
 * and scripts/lib/bsc-runner.js (dispatch) share ONE tested source of truth
 * instead of each re-implementing the same "is this safe" logic inline.
 * No I/O here — callers gather the booleans/numbers from git/lsof/lease
 * files/df and pass them in, which is what makes this requireable in a
 * plain node:test file with zero fixtures.
 */

/**
 * Decide whether a worktree is safe for `git worktree remove`.
 *
 * A live lease always wins: a job actively using this worktree must never
 * be pulled out from under it, even if its branch happens to already be an
 * ancestor of origin/main (e.g. a resumed session continuing to commit after
 * its first batch of work already landed).
 *
 * @param {object} d
 * @param {boolean} d.isAncestorOfMain  - every commit on the branch is already
 *   reachable from origin/main (fast-forward/plain-merge case; the squash
 *   case is handled upstream by `git cherry`, folded into hasUnmergedCommits).
 * @param {boolean} d.hasUnmergedCommits - branch has commits origin/main does
 *   not have (per `git cherry`), i.e. genuinely stranded work.
 * @param {boolean} d.hasLiveLease - a data/audit/job-leases/* lease with a
 *   live pid has this worktree's path as its cwd.
 * @param {string} [d.cwdPin='none'] - classifyCwdPin() class (BRO-2694);
 *   unrecognised values are treated as 'unknown' (keep).
 * @param {boolean} [d.worktreeIdle=false] - no source file touched for
 *   STALE_DAYS; required before a 'stale-process' pin is reclaimed.
 * @returns {{removable: boolean, blocker: 'lease'|'unmerged'|'cwd-pin'|null, reason: string}}
 */
function decideWorktreeReclaim({ isAncestorOfMain, hasUnmergedCommits, hasLiveLease, cwdPin = 'none', worktreeIdle = false }) {
  if (hasLiveLease) {
    return { removable: false, blocker: 'lease', reason: 'live-lease — a running job has this worktree as its cwd' };
  }
  let base;
  if (isAncestorOfMain) {
    base = 'branch already an ancestor of origin/main';
  } else if (hasUnmergedCommits) {
    return { removable: false, blocker: 'unmerged', reason: 'unmerged commits — possibly stranded work' };
  } else {
    base = 'no unmerged commits';
  }
  // BRO-2694: the merge state says removable; now the cwd pin. Only the
  // 'stale-process' class (see classifyCwdPin) on a worktree nobody has
  // touched for STALE_DAYS is reclaimed; every other non-'none' class —
  // including anything unrecognised — keeps the worktree.
  const pin = CWD_PIN_CLASSES.includes(cwdPin) ? cwdPin : 'unknown';
  if (pin === 'none') return { removable: true, blocker: null, reason: base };
  if (pin === 'stale-process' && worktreeIdle) {
    return { removable: true, blocker: null, reason: `${base}; cwd pinned only by an orphaned, idle non-session process tree` };
  }
  const why = pin === 'stale-process' ? 'stale-process pin but worktree touched recently' : pin;
  return { removable: false, blocker: 'cwd-pin', reason: `merged but a live process has this worktree as its cwd (${why})` };
}

/**
 * BRO-2694 — cwd-pin classes. Before this, ANY process with a cwd inside a
 * merged worktree kept it forever (task #1709's guard), so merged worktrees
 * pinned by an orphan a finished worker left behind (e.g. a `next start`)
 * were never reclaimed and the GC reported freed=0KB. Deny by default: only
 * 'stale-process' is reclaimable.
 *   none           no process has its cwd in the worktree
 *   stale-process  every pinner belongs to an ORPHANED tree (its root was
 *                  reparented to pid 1) whose root's own cwd is inside the
 *                  worktree, with no claude process and no tty anywhere on the
 *                  chain, and every process on it older than minAgeHours
 *   live-session   a claude process or a terminal (tty) is on some pinner's
 *                  chain, or the orphaned tree is younger than minAgeHours
 *   foreign-process the tree's root lives elsewhere (GUI editor, language
 *                  server, a subreaper) — not ours to judge
 *   unknown        snapshot inconsistent (pid missing, cycle, unparseable age)
 * Accepted residual risk (plan review): a session rooted OUTSIDE the worktree
 * that `cd`s in and leaves a background server orphaned for >= minAgeHours,
 * in a worktree untouched for STALE_DAYS, whose work is already merged; and a
 * GUI editor launched from inside the worktree (`code .`, reparented to init,
 * no tty) left untouched that long. Neither loses work: the branch is merged
 * and git still refuses a dirty tree; the process is left pointing at a
 * deleted directory.
 */
const CWD_PIN_CLASSES = ['none', 'stale-process', 'live-session', 'foreign-process', 'unknown'];

// `claude` as a word or path segment (.../bin/claude, .../claude/versions/x,
// `claude --session-id`), or the npm package path. A false positive only
// ever KEEPS a worktree, so this errs wide.
const CLAUDE_SESSION_CMD_RE = /(^|[/\s])claude([\s/]|$)|claude-code/;
const DEFAULT_PIN_MIN_AGE_HOURS = 24;
const MAX_CHAIN_DEPTH = 64;

/** Env value -> hours; empty/NaN/negative -> the 24h default (never "off"). */
function parseMinAgeHours(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_PIN_MIN_AGE_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PIN_MIN_AGE_HOURS;
}

/** Portable `ps -o etime` ([[dd-]hh:]mm:ss) -> seconds, or null if unparseable. */
function parseEtime(s) {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(String(s || ''));
  if (!m) return null;
  const [, d, h, mi, se] = m;
  return (Number(d || 0) * 86400) + (Number(h || 0) * 3600) + (Number(mi) * 60) + Number(se);
}

/** `ps -ww -A -o pid=,ppid=,etime=,tty=,command=` text -> Map pid -> row. */
function parsePsTable(text) {
  const table = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    table.set(Number(m[1]), { ppid: Number(m[2]), etimeSec: parseEtime(m[3]), tty: m[4], command: m[5] || '' });
  }
  return table;
}

/** `lsof -a -d cwd -F pn` text -> Map pid -> cwd. */
function parseLsofCwds(text) {
  const cwds = new Map();
  let pid = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid != null) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

function hasTty(tty) {
  return !!tty && tty !== '?' && tty !== '??' && tty !== '-';
}

function isUnder(p, dir, sep = '/') {
  return p === dir || p.startsWith(dir + sep);
}

/**
 * Pure classifier. No I/O: the caller passes one lsof cwd snapshot and one ps
 * snapshot (gc-worktree-liveness.js cwdPinStatus does that I/O).
 *
 * @param {object} d
 * @param {string} d.worktreePath - resolved absolute worktree path
 * @param {Map<number,string>} d.cwds - pid -> cwd for every process lsof saw
 * @param {Map<number,{ppid:number,etimeSec:number|null,tty:string,command:string}>} d.procs
 * @param {number} [d.minAgeHours=24]
 * @returns {{pin: string, pids: number[], reason: string}}
 */
function classifyCwdPin({ worktreePath, cwds, procs, minAgeHours = DEFAULT_PIN_MIN_AGE_HOURS, sep = '/' }) {
  const pinners = [];
  for (const [pid, cwd] of cwds) if (isUnder(cwd, worktreePath, sep)) pinners.push(pid);
  if (pinners.length === 0) return { pin: 'none', pids: [], reason: 'no process has its cwd here' };
  const minAgeSec = parseMinAgeHours(minAgeHours) * 3600;
  const rank = { 'stale-process': 0, 'foreign-process': 1, 'live-session': 2, unknown: 3 };
  let worst = 'stale-process';
  let why = 'orphaned idle tree rooted in this worktree';
  const bump = (cls, reason) => { if (rank[cls] > rank[worst]) { worst = cls; why = reason; } };
  for (const pid of pinners) {
    const seen = new Set();
    let cur = pid;
    let root = null;
    let verdict = null;
    let young = false;
    for (let depth = 0; depth <= MAX_CHAIN_DEPTH; depth++) {
      const row = procs.get(cur);
      if (!row || seen.has(cur)) { verdict = ['unknown', `pid ${cur} missing from ps or cycle`]; break; }
      seen.add(cur);
      if (CLAUDE_SESSION_CMD_RE.test(row.command)) { verdict = ['live-session', `claude process ${cur} on pid ${pid}'s chain`]; break; }
      if (hasTty(row.tty)) { verdict = ['live-session', `pid ${cur} on pid ${pid}'s chain has a terminal (${row.tty})`]; break; }
      if (row.etimeSec == null) { verdict = ['unknown', `pid ${cur} age unparseable`]; break; }
      if (row.etimeSec < minAgeSec) young = true;
      if (row.ppid === 1) { root = cur; break; }
      if (row.ppid === 0 || cur === 1) { verdict = ['unknown', `pid ${pid}'s chain ends without an init-parented root`]; break; }
      cur = row.ppid;
    }
    if (!verdict && root == null) verdict = ['unknown', `pid ${pid}'s chain deeper than ${MAX_CHAIN_DEPTH}`];
    if (!verdict) {
      const rootCwd = cwds.get(root);
      if (rootCwd == null) verdict = ['unknown', `root pid ${root} cwd not in lsof snapshot`];
      else if (!isUnder(rootCwd, worktreePath, sep)) verdict = ['foreign-process', `pid ${pid}'s tree is rooted outside this worktree (root ${root})`];
      else if (young) verdict = ['live-session', `pid ${pid}'s orphaned tree is younger than ${minAgeSec / 3600}h`];
    }
    if (verdict) bump(verdict[0], verdict[1]);
  }
  return { pin: worst, pids: pinners, reason: why };
}

/** True iff this pin class alone (ignoring idleness) can never allow removal. */
function cwdPinBlocks(pin) {
  return pin !== 'none' && pin !== 'stale-process';
}

/**
 * Decide whether new dispatch should be refused because disk is critically
 * low — the loud counterpart to the silent failure BRO-2319 documents
 * (lease/worktree/log writes that fail quietly under ENOSPC).
 *
 * @param {object} d
 * @param {number} d.freeGB - current free space on the worktree filesystem.
 * @param {number} d.floorGB - minimum free space required to dispatch.
 * @returns {boolean} true iff dispatch should be refused.
 */
function shouldRefuseDispatch({ freeGB, floorGB }) {
  return freeGB < floorGB;
}

/**
 * A lease with pid === null/undefined is NOT the same as a dead pid — it
 * means the job is still being provisioned (acquireLease writes pid:null;
 * the real pid only lands once the subprocess actually spawns, via
 * onSpawn). A freshly-provisioned worktree in that window is exactly the
 * highest-risk moment for GC to race (clean, forked straight off
 * origin/main, so it reads as already-merged) — fail SAFE and count it as
 * live. Only a lease with a KNOWN, non-null pid is checked against
 * isAliveFn for staleness; a dead-pid lease (crashed holder) is correctly
 * NOT counted as live. Shared by computeLiveLeaseCwds (GC) and
 * bsc-runner.acquireLease (steal-on-dead-pid reclaim) so the two decisions
 * can't drift apart (BRO-2414).
 *
 * @param {{pid?: number|null}|null|undefined} lease
 * @param {(pid: number|null|undefined) => boolean} isAliveFn
 * @returns {boolean}
 */
function isLeaseLive(lease, isAliveFn) {
  if (!lease) return false;
  return lease.pid == null || isAliveFn(lease.pid);
}

/**
 * Given parsed job-lease records (data/audit/job-leases/*\/lease.json) and a
 * pid-liveness predicate, return the Set of `cwd` values that GC must treat
 * as live and never remove. See isLeaseLive for the pid:null-is-live rationale.
 *
 * @param {Array<{cwd?: string, pid?: number|null}>} leases
 * @param {(pid: number|null|undefined) => boolean} isAliveFn
 * @returns {Set<string>}
 */
function computeLiveLeaseCwds(leases, isAliveFn) {
  const cwds = new Set();
  for (const lease of leases || []) {
    if (!lease || !lease.cwd) continue;
    if (isLeaseLive(lease, isAliveFn)) cwds.add(lease.cwd);
  }
  return cwds;
}

module.exports = {
  decideWorktreeReclaim, shouldRefuseDispatch, computeLiveLeaseCwds, isLeaseLive,
  classifyCwdPin, cwdPinBlocks, parsePsTable, parseLsofCwds, parseEtime, parseMinAgeHours,
  CWD_PIN_CLASSES, CLAUDE_SESSION_CMD_RE, DEFAULT_PIN_MIN_AGE_HOURS,
};
