/**
 * autonomous-ledger.js — append-only run ledger + singleton lock for the
 * autonomous nightly loop (Sprint 2, Notion 39b637c5).
 *
 * Ledger: data/audit/autonomous-ledger.jsonl, one JSON object per line.
 * Nothing is ever rewritten — spend math and the dead-man check are always
 * derived from the file, never from in-memory state, so a crashed run still
 * accounts for every dollar it spent before dying.
 *
 * Entry shape (all optional except event):
 *   { ts, runId, event, cardId, name, model, attempt,
 *     tokensIn, tokensOut, usd, note }
 * Events used by the executor: run-start, run-end, claim, implement,
 * card-pass, card-fail, recovery, email.
 *
 * Singleton: a pidfile (data/audit/autonomous-run.pid) plays the flock role.
 * A second start while the holder is alive and <6h old exits gracefully
 * ("already running"); a holder that is dead or >6h old is STOLEN — a hung
 * implementer must never block tomorrow night.
 *
 * Crash recovery (Sprint-2 carry-forward #2): triage skips any card whose
 * Auto is already set, so queued/attempted cards left behind by a crash
 * would be stranded forever. recoveryActions() is the pure policy the
 * executor applies at the start of every run:
 *   - attempted  → fail("crash-recovery")  (no run is active when we start,
 *                  so an attempted card can only be a crashed attempt)
 *   - queued but not in tonight's plan → clear Auto (re-triaged tomorrow)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const LEDGER_PATH = path.join(REPO, 'data', 'audit', 'autonomous-ledger.jsonl');
const PIDFILE_PATH = path.join(REPO, 'data', 'audit', 'autonomous-run.pid');
const STALE_HOLDER_MS = 6 * 60 * 60 * 1000;

// ── Ledger append / read ────────────────────────────────────────────────────

function appendEntry(entry, ledgerPath = LEDGER_PATH) {
  if (!entry || typeof entry.event !== 'string' || !entry.event) {
    throw new Error('ledger entry requires an event string');
  }
  const line = { ts: new Date().toISOString(), ...entry };
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify(line) + '\n');
  return line;
}

// Corrupt lines (partial write from a crash) are counted, never fatal —
// the ledger must stay readable after any crash.
function readEntries(ledgerPath = LEDGER_PATH) {
  let raw;
  try { raw = fs.readFileSync(ledgerPath, 'utf8'); }
  catch { return { entries: [], corrupt: 0 }; }
  const entries = [];
  let corrupt = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { entries.push(JSON.parse(t)); } catch { corrupt++; }
  }
  return { entries, corrupt };
}

// ── Pure aggregations ───────────────────────────────────────────────────────

function sumUSD(entries) {
  return round2(entries.reduce((s, e) => s + (Number(e.usd) || 0), 0));
}

function entriesForRun(entries, runId) {
  return entries.filter(e => e.runId === runId);
}

function entriesSince(entries, sinceTs) {
  const cutoff = new Date(sinceTs).getTime();
  return entries.filter(e => new Date(e.ts).getTime() >= cutoff);
}

function lastRunId(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].event === 'run-start') return entries[i].runId || null;
  }
  return null;
}

function lastEntryTs(entries) {
  return entries.length ? entries[entries.length - 1].ts : null;
}

function statsByModel(entries) {
  const by = {};
  for (const e of entries) {
    if (!e.model && !e.usd && !e.tokensIn && !e.tokensOut) continue;
    const m = e.model || 'unattributed';
    by[m] = by[m] || { tokensIn: 0, tokensOut: 0, usd: 0 };
    by[m].tokensIn += Number(e.tokensIn) || 0;
    by[m].tokensOut += Number(e.tokensOut) || 0;
    by[m].usd = round2(by[m].usd + (Number(e.usd) || 0));
  }
  return by;
}

// spentTonight is derived from the FILE (via readEntries), never from
// executor memory — a resumed or crashed run still sees prior spend.
function spentTonight(entries, runId) {
  return sumUSD(entriesForRun(entries, runId));
}

// Rolled-up numbers for the morning email's usage block.
// tonight = the most recent run; week = trailing 7 days; paceMonthlyUSD =
// trailing-7-day spend extrapolated to 30 days (null with an empty week).
function usageStats(entries, now = new Date()) {
  const runId = lastRunId(entries);
  const tonight = runId ? entriesForRun(entries, runId) : [];
  const week = entriesSince(entries, new Date(now.getTime() - 7 * 24 * 3600 * 1000));
  const weekUSD = sumUSD(week);
  return {
    runId,
    tonight: {
      usd: sumUSD(tonight),
      tokensIn: tonight.reduce((s, e) => s + (Number(e.tokensIn) || 0), 0),
      tokensOut: tonight.reduce((s, e) => s + (Number(e.tokensOut) || 0), 0),
      byModel: statsByModel(tonight),
    },
    week: {
      usd: weekUSD,
      tokensIn: week.reduce((s, e) => s + (Number(e.tokensIn) || 0), 0),
      tokensOut: week.reduce((s, e) => s + (Number(e.tokensOut) || 0), 0),
    },
    paceMonthlyUSD: week.length ? round2((weekUSD / 7) * 30) : null,
  };
}

// ── Crash recovery policy (pure) ────────────────────────────────────────────

// autoCards: [{ id, auto }] — every non-terminal Auto-stamped card found at
// run start. planIds: Set of card ids in tonight's queue plan.
function recoveryActions(autoCards, planIds) {
  const plan = planIds instanceof Set ? planIds : new Set(planIds || []);
  const actions = [];
  for (const c of autoCards || []) {
    if (!c || !c.id) continue;
    if (c.auto === 'attempted') {
      actions.push({ id: c.id, action: 'fail', reason: 'crash-recovery' });
    } else if (c.auto === 'queued' && !plan.has(c.id)) {
      actions.push({ id: c.id, action: 'clear', reason: 'stale-queue' });
    }
  }
  return actions;
}

// ── Singleton (pidfile flock) ───────────────────────────────────────────────

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

/**
 * Try to become the running instance. Returns:
 *   { acquired: true, stolen?: true }               — we hold the lock
 *   { acquired: false, holder: {pid, startedAt} }   — someone else does
 */
function acquireSingleton(opts = {}) {
  const {
    pidfilePath = PIDFILE_PATH,
    pid = process.pid,
    now = Date.now(),
    staleMs = STALE_HOLDER_MS,
    isAlive = pidAlive,
  } = opts;
  fs.mkdirSync(path.dirname(pidfilePath), { recursive: true });
  const payload = JSON.stringify({ pid, startedAt: new Date(now).toISOString() });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(pidfilePath, payload, { flag: 'wx' });
      return { acquired: true, stolen: attempt > 0 };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(pidfilePath, 'utf8')); } catch { /* corrupt → steal */ }
    const age = holder ? now - new Date(holder.startedAt).getTime() : Infinity;
    const live = holder && isAlive(holder.pid) && Number.isFinite(age) && age < staleMs;
    if (live) return { acquired: false, holder };
    // Dead or >6h-old holder: steal (unlink, then loop to recreate with wx).
    try { fs.unlinkSync(pidfilePath); } catch { /* raced with another stealer */ }
  }
  // Two failed steal attempts = another live process is racing us; yield.
  let holder = null;
  try { holder = JSON.parse(fs.readFileSync(pidfilePath, 'utf8')); } catch { /* gone again */ }
  return { acquired: false, holder };
}

// Release only if we still own the pidfile (never clobber a stealer's lock).
function releaseSingleton(opts = {}) {
  const { pidfilePath = PIDFILE_PATH, pid = process.pid } = opts;
  try {
    const holder = JSON.parse(fs.readFileSync(pidfilePath, 'utf8'));
    if (holder.pid !== pid) return false;
  } catch { return false; }
  try { fs.unlinkSync(pidfilePath); return true; } catch { return false; }
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = {
  LEDGER_PATH,
  PIDFILE_PATH,
  STALE_HOLDER_MS,
  appendEntry,
  readEntries,
  sumUSD,
  entriesForRun,
  entriesSince,
  lastRunId,
  lastEntryTs,
  statsByModel,
  spentTonight,
  usageStats,
  recoveryActions,
  acquireSingleton,
  releaseSingleton,
  pidAlive,
};
