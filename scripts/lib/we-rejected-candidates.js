'use strict';
// venue-write-guard-ok: the rejection store records the candidate venue for the audit ledger (data/audit/we-rejected-candidates.json); it never writes a venue into shows.json.
/**
 * Prior-rejection store for the West End aggregator promoter (BRO-4204
 * S4-T9; consumed by scripts/promote-we-aggregator-candidates.js).
 *
 * Why: the promoter re-derives its candidate list live from the WET/LBO
 * listings every run, so a candidate it cannot promote (non-canonical venue,
 * stale roundup, shouted title, id collision, or one that simply THROWS) is
 * re-evaluated — and, for LBO, re-fetched for its article date — every
 * single day. Two failure modes followed from that (audit, 2026-09-28):
 *   1. The same ~9 known-bad LBO candidates consumed the --limit=15 date-
 *      fetch budget each run, so the remaining ~63 were deferred with
 *      `skip-limit` forever (identical per-run counts in
 *      data/audit/we-promotion-log.jsonl for 4 consecutive days).
 *   2. A candidate that threw mid-loop aborted main() — nothing written,
 *      every other candidate in the batch lost with it.
 * Remembering each rejected (title|venue) hash lets the next run skip it
 * BEFORE any live fetch, and lets a throwing candidate be recorded and
 * stepped over rather than sinking the batch.
 *
 * File: data/audit/we-rejected-candidates.json — CI-written state, same
 * handling as the promoter's other state files (we-last-promotion-ids.json,
 * we-promotion-log.jsonl): written only by a non-dry-run promoter run and
 * committed by promote-we-aggregator.yml's "Commit WE promotion audit log"
 * step. Never hand-edit; delete an entry to force re-evaluation.
 *
 * Entries expire REJECTED_TTL_DAYS after they were first recorded so a fix
 * upstream (a venue added to WEST_END_VENUES, a deleted duplicate row) gets
 * the candidate re-evaluated without anyone touching the file.
 *
 * Hash: candidateHash from owe-venue-staging.js (sha256 of lowercased
 * "title|venue", 16 hex chars) — the same key the Off-West-End staging
 * file uses, so a WE candidate hashes identically across both London paths.
 */

const fs = require('fs');
const path = require('path');
const { candidateHash } = require('./owe-venue-staging');

const REJECTED_FILE = path.join(__dirname, '..', '..', 'data', 'audit', 'we-rejected-candidates.json');
const REJECTED_TTL_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REASON_CHARS = 300;

function emptyStore() {
  return { version: 1, generatedAt: null, ttlDays: REJECTED_TTL_DAYS, rejected: {} };
}

/**
 * Load the store. A missing file is the normal first-run state; a corrupt
 * one is logged and treated as empty — this file must never be able to
 * block a promotion run (that would recreate the very failure it exists
 * to prevent).
 */
function loadRejectedCandidates(file = REJECTED_FILE, { warn = console.warn } = {}) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e && e.code !== 'ENOENT') warn(`we-rejected-candidates: could not read ${file} (${e.message}) — starting from an empty store`);
    return emptyStore();
  }
  if (!raw || typeof raw !== 'object' || !raw.rejected || typeof raw.rejected !== 'object' || Array.isArray(raw.rejected)) {
    warn(`we-rejected-candidates: ${file} has an unexpected shape — starting from an empty store`);
    return emptyStore();
  }
  return { ...emptyStore(), generatedAt: raw.generatedAt || null, rejected: raw.rejected };
}

function isExpired(entry, now, ttlDays = REJECTED_TTL_DAYS) {
  const first = Date.parse(entry && entry.firstSeen);
  if (!Number.isFinite(first)) return true;
  return now.getTime() - first > ttlDays * DAY_MS;
}

/**
 * The still-live prior rejection for `candidate` ({title, venue}), or null
 * when none is recorded or the recorded one has expired (→ re-evaluate).
 * @returns {null | {hash: string, title, venue, kind, reason, firstSeen, lastSeen, count, expiresAt: string}}
 */
function priorRejection(store, candidate, now = new Date()) {
  if (!store || !store.rejected) return null;
  const hash = candidateHash(candidate || {});
  const entry = store.rejected[hash];
  if (!entry || isExpired(entry, now)) return null;
  const expiresAt = new Date(Date.parse(entry.firstSeen) + REJECTED_TTL_DAYS * DAY_MS).toISOString();
  return { hash, ...entry, expiresAt };
}

/**
 * Record (or refresh) a rejection. firstSeen is preserved across runs so
 * the TTL counts from the ORIGINAL rejection, not the latest re-sighting;
 * an expired entry starts a fresh window.
 * @returns {string} the candidate hash
 */
function recordRejection(store, candidate, { kind, reason }, now = new Date()) {
  const hash = candidateHash(candidate || {});
  const iso = now.toISOString();
  const prev = store.rejected[hash];
  const carryOver = prev && !isExpired(prev, now);
  store.rejected[hash] = {
    title: candidate.title ?? null,
    venue: candidate.venue ?? null,
    source: candidate.source ?? null,
    sourceUrl: candidate.sourceUrl ?? null,
    kind: String(kind || 'rejected'),
    reason: String(reason || '').slice(0, MAX_REASON_CHARS),
    firstSeen: carryOver ? prev.firstSeen : iso,
    lastSeen: iso,
    count: carryOver ? (Number(prev.count) || 0) + 1 : 1,
  };
  return hash;
}

/** Drop expired entries so the file stays bounded. Returns how many went. */
function pruneExpired(store, now = new Date()) {
  let dropped = 0;
  for (const [hash, entry] of Object.entries(store.rejected)) {
    if (isExpired(entry, now)) { delete store.rejected[hash]; dropped++; }
  }
  return dropped;
}

/**
 * Atomic write (tmp + rename, same pattern as the promoter's
 * writeLastPromotionFile) with sorted keys for stable diffs in the audit
 * commit. Prunes expired entries first.
 */
function writeRejectedCandidates(store, file = REJECTED_FILE, now = new Date()) {
  pruneExpired(store, now);
  const rejected = {};
  for (const hash of Object.keys(store.rejected).sort()) rejected[hash] = store.rejected[hash];
  const out = { version: 1, generatedAt: now.toISOString(), ttlDays: REJECTED_TTL_DAYS, rejected };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return Object.keys(rejected).length;
}

module.exports = {
  REJECTED_FILE,
  REJECTED_TTL_DAYS,
  candidateHash,
  loadRejectedCandidates,
  priorRejection,
  recordRejection,
  pruneExpired,
  writeRejectedCandidates,
};
