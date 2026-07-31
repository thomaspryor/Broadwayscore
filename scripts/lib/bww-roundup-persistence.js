/**
 * BWW Review Roundup URL persistence (Scraping v2 Sprint 1 T6).
 *
 * Why: 1 of 2,821 shows has a persisted `bwwRoundupUrl` — discoverBwwRoundupUrl
 * re-derives the same URL from scratch on every poll/watch cycle even after a
 * successful discovery, because nothing ever writes the result back to
 * shows.json. This module closes that gap with two pieces:
 *
 *   1. Write-once positive cache: `bwwRoundupUrl` on the show record itself,
 *      through the guarded shows.json write path (shows-write-guard.js).
 *      Write-once (never overwrites an existing value) — revalidation is a
 *      SEPARATE explicit call (clearStaleBwwRoundupUrl), not an overwrite on
 *      every successful discovery, so a caller processing a stale cached URL
 *      doesn't silently clobber a value another writer already fixed.
 *   2. Negative cache: data/audit/bww-roundup-miss-ledger.jsonl (append-only,
 *      dispatch-ledger.js pattern) + isInRoundupMissCooldown(), a pure
 *      decision function. NOT a per-cycle shows.json field — shows-write-
 *      guard.js merges concurrent writers at whole-show granularity, and the
 *      ~58 miss-writes/day this ledger replaces would out-vote a concurrent
 *      category/status correction landing on the same show in the same
 *      merge window.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { loadShows: defaultLoadShows, saveShows: defaultSaveShows } = require('./shows-write-guard');

const MISS_LEDGER_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'bww-roundup-miss-ledger.jsonl');

// How long a recorded miss suppresses further discovery attempts, once the
// cooldown actually applies (see isInRoundupMissCooldown). Env-tunable for
// tests/tuning; 24h matches the SERP cache's own negative-result TTL scale.
const MISS_COOLDOWN_MS = Number(process.env.BWW_ROUNDUP_MISS_COOLDOWN_HOURS || 24) * 60 * 60 * 1000;

// Shows within this many days of opening (before OR after) are exempt from
// cooldown entirely — the roundup may simply not be published yet, and this
// is exactly the window where BWSC's time-to-publish SLA is on the line.
// Cooldown only starts protecting against the back-catalogue grind once a
// show is well past its opening.
const OPENING_WINDOW_DAYS = 7;

/**
 * Persist `url` onto show `showId`'s shows.json record if it doesn't
 * already have a bwwRoundupUrl. Write-once: a caller holding a stale
 * discovery result never overwrites a value another writer already set.
 * Returns true if a write happened.
 */
function persistBwwRoundupUrlIfMissing(showId, url, { loadShows = defaultLoadShows, saveShows = defaultSaveShows } = {}) {
  if (!showId || !url) return false;
  const data = loadShows();
  const show = data.shows.find(s => s.id === showId);
  if (!show || show.bwwRoundupUrl) return false;
  show.bwwRoundupUrl = url;
  saveShows(data);
  return true;
}

/**
 * Clear a persisted bwwRoundupUrl that revalidation found stale (e.g. the
 * cached URL now 404s). Rediscovery picks it back up on the next poll —
 * discoverBwwRoundupUrl / the poller always fall back to fresh discovery
 * when shows.json has no bwwRoundupUrl. No-op if nothing is set (idempotent,
 * safe to call defensively without a pre-check).
 */
function clearStaleBwwRoundupUrl(showId, { loadShows = defaultLoadShows, saveShows = defaultSaveShows } = {}) {
  if (!showId) return false;
  const data = loadShows();
  const show = data.shows.find(s => s.id === showId);
  if (!show || !show.bwwRoundupUrl) return false;
  delete show.bwwRoundupUrl;
  saveShows(data);
  return true;
}

/** Append a miss record. Mirrors dispatch-ledger.js's appendEntry shape. */
function recordRoundupMiss(showId, ledgerPath = MISS_LEDGER_PATH) {
  if (!showId) throw new Error('recordRoundupMiss requires a showId');
  const line = { ts: new Date().toISOString(), showId };
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify(line) + '\n');
  return line;
}

/** Corrupt lines are skipped, never fatal — mirrors dispatch-ledger.js. */
function readRoundupMisses(ledgerPath = MISS_LEDGER_PATH) {
  let raw;
  try { raw = fs.readFileSync(ledgerPath, 'utf8'); }
  catch { return []; }
  const entries = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { entries.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return entries;
}

/** Most recent miss entry for a show, or null. */
function lastMissForShow(showId, entries) {
  let last = null;
  for (const e of entries) {
    if (e.showId !== showId) continue;
    if (!last || new Date(e.ts).getTime() > new Date(last.ts).getTime()) last = e;
  }
  return last;
}

/**
 * Pure decision: should discovery be SKIPPED for `show` right now because a
 * recent miss is still in cooldown? `lastMiss` is the show's most recent
 * miss-ledger entry (or null/undefined — never in cooldown).
 *
 * Opening-window exemption: a show within OPENING_WINDOW_DAYS of its
 * openingDate (either side — not-yet-opened counts too) is NEVER put in
 * cooldown, regardless of market. The roundup can land any day in that
 * window; suppressing a retry there is exactly the outcome T4/T5's
 * fail-open design avoids elsewhere in this sprint. Once a show is farther
 * than that from opening, a miss suppresses further attempts for
 * MISS_COOLDOWN_MS — this is the guard against the back-catalogue grind
 * (hundreds of long-closed shows burning a Browserbase session each for a
 * guaranteed-miss).
 *
 * @param {object} show - shows.json record; reads openingDate
 * @param {object|null} lastMiss - {ts, showId} or null
 * @param {number} [now] - injectable clock for tests
 */
function isInRoundupMissCooldown(show, lastMiss, now = Date.now()) {
  if (!lastMiss) return false;
  const openingMs = show && show.openingDate ? new Date(show.openingDate).getTime() : NaN;
  if (!Number.isFinite(openingMs)) return false; // no opening date on record — never suppress
  const daysFromOpening = Math.abs(now - openingMs) / 86400000;
  if (daysFromOpening < OPENING_WINDOW_DAYS) return false; // opening-window exemption
  const missAgeMs = now - new Date(lastMiss.ts).getTime();
  return missAgeMs < MISS_COOLDOWN_MS;
}

// How far back to look when counting misses for the digest (task #692). Wider
// than the opening-window exemption itself so a burst of misses right at the
// edge of the window is still visible the next time the digest runs.
const MISS_SUMMARY_WINDOW_HOURS = 48;

/**
 * Pure decision: which shows have 2+ BWW-roundup discovery misses in the
 * trailing MISS_SUMMARY_WINDOW_HOURS AND are currently inside their
 * OPENING_WINDOW_DAYS opening window — the ledger only matters as a health
 * signal there, since misses on long-closed shows are the expected, silently
 * cooled-down case (see isInRoundupMissCooldown above).
 *
 * `entries` is the raw ledger (readRoundupMisses() output: {ts, showId}[]).
 * `shows` is the shows.json shows array (only `id`/`openingDate` are read).
 * Returns entries sorted by missCount desc, then most-recent-miss desc.
 */
function summarizeBwwRoundupMisses(entries, shows, now = Date.now()) {
  const showsById = new Map((shows || []).filter(s => s && s.id).map(s => [s.id, s]));
  const cutoff = now - MISS_SUMMARY_WINDOW_HOURS * 60 * 60 * 1000;
  const byShow = new Map();
  for (const e of entries || []) {
    if (!e || !e.showId || !e.ts) continue;
    const ts = new Date(e.ts).getTime();
    if (!Number.isFinite(ts) || ts < cutoff || ts > now) continue; // ts > now: clock-skewed/corrupt entry, never counts
    if (!byShow.has(e.showId)) byShow.set(e.showId, []);
    byShow.get(e.showId).push(ts);
  }
  const results = [];
  for (const [showId, timestamps] of byShow) {
    if (timestamps.length < 2) continue;
    const show = showsById.get(showId);
    const openingMs = show && show.openingDate ? new Date(show.openingDate).getTime() : NaN;
    if (!Number.isFinite(openingMs)) continue; // no opening date on record — can't confirm the window
    const daysFromOpening = Math.abs(now - openingMs) / 86400000;
    if (daysFromOpening >= OPENING_WINDOW_DAYS) continue; // outside opening window — expected cooldown territory
    timestamps.sort((a, b) => a - b);
    results.push({
      showId,
      missCount: timestamps.length,
      firstMissTs: new Date(timestamps[0]).toISOString(),
      lastMissTs: new Date(timestamps[timestamps.length - 1]).toISOString(),
    });
  }
  results.sort((a, b) => b.missCount - a.missCount || new Date(b.lastMissTs) - new Date(a.lastMissTs));
  return results;
}

module.exports = {
  MISS_LEDGER_PATH,
  MISS_COOLDOWN_MS,
  OPENING_WINDOW_DAYS,
  MISS_SUMMARY_WINDOW_HOURS,
  persistBwwRoundupUrlIfMissing,
  clearStaleBwwRoundupUrl,
  recordRoundupMiss,
  readRoundupMisses,
  lastMissForShow,
  isInRoundupMissCooldown,
  summarizeBwwRoundupMisses,
};
