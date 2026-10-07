'use strict';
/**
 * Night lease for the opening-night lane (BRO-4210; design:
 * docs/opening-night-autonomy-review-2026-09-28.md section 6).
 *
 * While the lane holds a show's lease, every other writer (the orchestrator's poller,
 * Express, gather-reviews, enrich-reviews, rebuild-reviews, push-review-texts) is meant to
 * skip that show. This module is the lease itself: pure state transitions plus a thin
 * same-machine file wrapper. It does not wire any workflow to honour the lease; that is a
 * separate card per workflow.
 *
 * State: { leases: { "<show>|<night>": { holder, acquiredAt, heartbeatAt, expiresAt } } }
 *
 * Rules, each one a failure mode from the design review:
 *  - First holder wins; a second starter gets `held-by-other` and must exit. The same holder
 *    acquiring again renews (a restart of the lane keeps the night).
 *  - A lease is only ever taken over once it has EXPIRED. A live holder is never evicted.
 *  - heartbeat() on an expired or foreign lease fails: a lane that lost its lease must stop
 *    writing, not carry on and race the new holder.
 *  - Only the holder can release.
 *  - Holder ids must be unique per starter (for example `gha-<run id>` and `mac-<pid>-<epoch>`).
 *    The same string re-acquiring is a renewal by design, so two starters sharing a fixed name
 *    would BOTH win. A restarted lane with a fresh id is refused until the old lease expires or
 *    the old process releases; clean shutdowns should call release().
 *  - The file wrapper fails CLOSED. scripts/lib/file-lock.js fails open (a lock it cannot
 *    take is assumed stale and broken), which is right for a checkpoint but wrong for a
 *    lease: granting a lease without mutual exclusion is the exact double-writer bug this
 *    exists to prevent. If the lock is not actually held, or the state file exists but cannot be
 *    read or parsed, nothing is granted and nothing is written (rewriting from an assumed-empty
 *    state would wipe every other show's live lease). Only a missing file reads as empty.
 *
 * Cross-machine: the lane is armed from two places (a GitHub Actions job and the Mac
 * launchd backup). A lease file on one disk cannot arbitrate between them. Across machines
 * the file has to live in a repo and be claimed by a push that fails when the remote moved
 * (compare-and-swap); that persistence layer is a separate card and uses these same pure
 * transitions.
 */
const fs = require('fs');
const path = require('path');
const { withFileLock } = require('../file-lock');

const DEFAULT_TTL_MS = 30 * 60 * 1000; // renewed by heartbeat; a dead lane frees its show in 30 minutes

const keyFor = (show, night) => `${show}|${night}`;

function check({ show, night, holder }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(show || ''))) throw new Error(`lease: bad show id "${show}"`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(night || ''))) throw new Error(`lease: bad night "${night}"`);
  if (!holder || typeof holder !== 'string') throw new Error('lease: holder is required');
}

function checkTtl(ttlMs) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error(`lease: ttlMs must be a positive number, got ${ttlMs}`);
}

const isLive = (lease, t) => Date.parse(lease.expiresAt) > t; // an unparsable expiry is expired, everywhere
const nowMs = (now) => (now === undefined ? Date.now() : new Date(now).getTime());
const isoAt = (ms) => new Date(ms).toISOString();
const emptyState = () => ({ leases: {} });
const clone = (state) => ({ leases: { ...((state && state.leases) || {}) } });

/** Take (or renew) the lease. Pure: returns {ok, state, reason, holder?}. */
function acquire(state, { show, night, holder, now, ttlMs = DEFAULT_TTL_MS }) {
  check({ show, night, holder });
  checkTtl(ttlMs);
  const t = nowMs(now);
  const next = clone(state);
  const key = keyFor(show, night);
  const cur = next.leases[key];
  const fresh = { holder, acquiredAt: isoAt(t), heartbeatAt: isoAt(t), expiresAt: isoAt(t + ttlMs) };
  if (!cur) { next.leases[key] = fresh; return { ok: true, state: next, reason: 'acquired' }; }
  const live = isLive(cur, t);
  if (cur.holder === holder) {
    next.leases[key] = { ...cur, heartbeatAt: isoAt(t), expiresAt: isoAt(t + ttlMs) };
    return { ok: true, state: next, reason: 'renewed' };
  }
  if (!live) { next.leases[key] = fresh; return { ok: true, state: next, reason: 'taken-over-expired', previousHolder: cur.holder }; }
  return { ok: false, state: next, reason: 'held-by-other', holder: cur.holder, expiresAt: cur.expiresAt };
}

/** Extend the lease. Fails when the lease is gone, expired or someone else's: the lane must stop writing. */
function heartbeat(state, { show, night, holder, now, ttlMs = DEFAULT_TTL_MS }) {
  check({ show, night, holder });
  checkTtl(ttlMs);
  const t = nowMs(now);
  const next = clone(state);
  const key = keyFor(show, night);
  const cur = next.leases[key];
  if (!cur) return { ok: false, state: next, reason: 'no-lease' };
  if (cur.holder !== holder) return { ok: false, state: next, reason: 'held-by-other', holder: cur.holder };
  if (!isLive(cur, t)) return { ok: false, state: next, reason: 'expired' };
  next.leases[key] = { ...cur, heartbeatAt: isoAt(t), expiresAt: isoAt(t + ttlMs) };
  return { ok: true, state: next, reason: 'renewed' };
}

/** Release. Only the holder can; anyone else is refused and the lease is untouched. */
function release(state, { show, night, holder }) {
  check({ show, night, holder });
  const next = clone(state);
  const key = keyFor(show, night);
  const cur = next.leases[key];
  if (!cur) return { ok: true, state: next, reason: 'no-lease' };
  if (cur.holder !== holder) return { ok: false, state: next, reason: 'held-by-other', holder: cur.holder };
  delete next.leases[key];
  return { ok: true, state: next, reason: 'released' };
}

/**
 * The check other writers make before touching a show: is any non-expired lease held on it,
 * for any night? `ignoreHolder` lets the lane's own writes through. Pure.
 */
function activeLeaseFor(state, show, { now, ignoreHolder } = {}) {
  const t = nowMs(now);
  for (const [key, lease] of Object.entries((state && state.leases) || {})) {
    const [leaseShow, night] = key.split('|');
    if (leaseShow !== show) continue;
    if (!isLive(lease, t)) continue;
    if (ignoreHolder && lease.holder === ignoreHolder) continue;
    return { show, night, holder: lease.holder, expiresAt: lease.expiresAt };
  }
  return null;
}

/** Drop expired leases (housekeeping so the file does not grow forever). Pure. */
function sweepExpired(state, { now } = {}) {
  const t = nowMs(now);
  const next = emptyState();
  for (const [key, lease] of Object.entries((state && state.leases) || {})) {
    if (isLive(lease, t)) next.leases[key] = lease;
  }
  return next;
}

// ---- same-machine file wrapper -------------------------------------------------------------

/** Missing file = no leases. Any other read or parse failure throws: the caller must refuse, not assume empty. */
function readState(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return emptyState();
    throw e;
  }
  const parsed = JSON.parse(text); // a corrupt file throws
  if (!parsed || typeof parsed !== 'object' || !parsed.leases || typeof parsed.leases !== 'object') throw new Error('lease state file has no leases object');
  return parsed;
}

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try { fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); fs.renameSync(tmp, file); } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

/** Run one pure transition against the file, under an exclusive lock, failing closed. */
function transition(file, fn, args) {
  let out = null;
  const { lockTimeoutMs, ...pure } = args;
  withFileLock(`${file}.lock`, (held) => {
    if (!held) { out = { ok: false, reason: 'lock-unavailable', state: null }; return; }
    let current;
    try { current = readState(file); } catch (e) {
      out = { ok: false, reason: 'state-unreadable', detail: String((e && e.message) || e).slice(0, 200), state: null };
      return;
    }
    out = fn(current, pure);
    if (out.ok) writeAtomic(file, sweepExpired(out.state, { now: pure.now }));
  }, lockTimeoutMs ? { timeoutMs: lockTimeoutMs } : undefined);
  return out || { ok: false, reason: 'lock-unavailable', state: null };
}

const acquireLease = (file, args) => transition(file, acquire, args);
const heartbeatLease = (file, args) => transition(file, heartbeat, args);
const releaseLease = (file, args) => transition(file, release, args);
// A state file that cannot be read is treated as LEASED (unknown): a writer that cannot tell must wait, not write.
const isShowLeased = (file, show, opts) => {
  try { return activeLeaseFor(readState(file), show, opts); } catch (e) {
    return { show, night: null, holder: 'unknown', expiresAt: null, unreadable: true };
  }
};

module.exports = {
  DEFAULT_TTL_MS, emptyState, acquire, heartbeat, release, activeLeaseFor, sweepExpired,
  acquireLease, heartbeatLease, releaseLease, isShowLeased, readState,
};
