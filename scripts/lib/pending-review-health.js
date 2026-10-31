'use strict';

/**
 * pending-review-health.js — pure decisions about _pending review stubs (BRO-2735).
 *
 * data/review-texts/_pending/{showId}/ is a hard sink: rebuild never reads it,
 * so a review stranded there is invisible on the site. Three failure modes let a
 * T1/T2 opening-night review sit there with nobody told:
 *
 *   1. replay-pending-bylines.js kept a zero-text, byline-less stub with a quiet
 *      "keep in pending" log line and a clean exit. isUnrecoverablePendingStub()
 *      names that state so the replay can alert on it.
 *   2. Nothing re-fetched the body of a stub that had a URL but no text.
 *      buildRefetchedPendingRecord() rebuilds the stub from a fresh fetch.
 *   3. Nothing watched the AGE of _pending entries independently of the
 *      opening-night monitor. findStalePendingEntries() flags entries older than
 *      N hours for shows 0..7 days AFTER opening (pre-opening stubs are expected:
 *      the review pages do not exist yet, so this window is signed, not Math.abs).
 *
 * gather-reviews.js rewrote each pending record from scratch on every run, so a
 * record never kept a creation time (and replay bookkeeping was wiped).
 * mergePendingRecord() keeps the first-seen clock and that bookkeeping.
 *
 * Everything except findStalePendingEntries() is pure; that one takes `fs`-like
 * deps so tests can seed a temp tree.
 */

const fs = require('fs');
const path = require('path');

const HOUR_MS = 3600e3;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_STALE_HOURS = 24;
const POST_OPENING_WINDOW_DAYS = 7;

// Validator check id for a stale _pending entry. Deliberately NOT in
// review-texts-gate.js CATASTROPHIC_CHECKS / HEALABLE_CHECKS: it is listed in
// REPORT_ONLY_CHECKS there, which the --gate path excludes from its counts, so
// a stale stub never reddens main on push. The default (non-gate) validator
// reports it and exits 1.
const STALE_PENDING_CHECK = 'stale_pending';

// Fields written by replay-pending-bylines.js / sweeps that must survive a
// re-discovery rewrite of the same pending file. Losing promoteSkippedReason
// made replay re-fetch every judged-junk URL on every run.
const PRESERVED_PENDING_FIELDS = [
  'firstSeenAt',
  'promoteSkippedReason',
  'promoteSkippedAt',
  'rssIdentityRejected',
  'pendingUnrecoverableAt',
  'pendingRefetchedAt',
];

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasByline(data) {
  return !!data && hasText(data.criticName) && data.criticName.trim().toLowerCase() !== 'unknown';
}

/** A stub whose body is empty (excerpts do not count: they are not the review). */
function isZeroTextPendingStub(data) {
  return !!data && !hasText(data.fullText);
}

/**
 * After replay has done everything it can: no body AND no byline means the
 * review can neither promote nor be rescued by the next run without a human or
 * better tooling. `byline` is what replay extracted this run (may be null).
 */
function isUnrecoverablePendingStub(data, byline) {
  if (!data) return false;
  const gotByline = hasText(byline) && byline.trim().toLowerCase() !== 'unknown';
  return isZeroTextPendingStub(data) && !hasByline(data) && !gotByline;
}

/** Parse a shows.json openingDate ('YYYY-MM-DD' or ISO) to epoch ms, or null. */
function openingMs(show) {
  if (!show || !show.openingDate) return null;
  const raw = String(show.openingDate);
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 0 <= now - opening <= windowDays. Signed on purpose: before opening, review
 * pages do not exist and _pending stubs are expected, so they must not flag.
 */
function isInPostOpeningWindow(show, nowMs = Date.now(), windowDays = POST_OPENING_WINDOW_DAYS) {
  const op = openingMs(show);
  if (op == null) return false;
  const delta = nowMs - op;
  return delta >= 0 && delta <= windowDays * DAY_MS;
}

/**
 * When did this pending entry first appear? Prefers the record's own clock
 * (firstSeenAt, written by gather-reviews since BRO-2735); falls back to the
 * file mtime, which is a lower bound on age for legacy records with no clock.
 * Returns { ms, source } or null.
 */
function pendingFirstSeenMs(data, mtimeMs) {
  const stamp = data && data.firstSeenAt ? Date.parse(data.firstSeenAt) : NaN;
  if (Number.isFinite(stamp)) return { ms: stamp, source: 'firstSeenAt' };
  if (Number.isFinite(mtimeMs)) return { ms: mtimeMs, source: 'mtime' };
  return null;
}

/**
 * Pure: is this _pending entry stale? Returns null when not, else
 * { ageHours, clock } describing why.
 */
function stalePendingReason({ data, show, mtimeMs, nowMs = Date.now(), staleHours = DEFAULT_STALE_HOURS,
  windowDays = POST_OPENING_WINDOW_DAYS }) {
  if (!data || data.rssIdentityRejected) return null; // tagged permanent junk
  if (!isInPostOpeningWindow(show, nowMs, windowDays)) return null;
  const seen = pendingFirstSeenMs(data, mtimeMs);
  if (!seen) return null;
  const ageHours = (nowMs - seen.ms) / HOUR_MS;
  if (ageHours < staleHours) return null;
  return { ageHours: Math.round(ageHours * 10) / 10, clock: seen.source };
}

/** STALE_PENDING_HOURS env override, else the default. */
function resolveStaleHours(env = process.env) {
  const n = Number(env && env.STALE_PENDING_HOURS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_HOURS;
}

/**
 * Walk <reviewTextsRoot>/_pending/<showId>/*.json and return stale entries.
 * Only shows in the post-opening window are read, so the scan is cheap.
 * @returns {Array<{showId,file,relPath,outletId,url,ageHours,clock,zeroText}>}
 */
function findStalePendingEntries({ reviewTextsRoot, shows, nowMs = Date.now(), staleHours = DEFAULT_STALE_HOURS,
  windowDays = POST_OPENING_WINDOW_DAYS, fsImpl = fs }) {
  const pendingRoot = path.join(reviewTextsRoot, '_pending');
  if (!fsImpl.existsSync(pendingRoot)) return [];
  const out = [];
  for (const show of shows || []) {
    if (!show || !show.id || !isInPostOpeningWindow(show, nowMs, windowDays)) continue;
    const dir = path.join(pendingRoot, show.id);
    let files;
    try { files = fsImpl.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { continue; }
    for (const file of files.sort()) {
      const full = path.join(dir, file);
      let data;
      try { data = JSON.parse(fsImpl.readFileSync(full, 'utf8')); } catch { continue; }
      let mtimeMs;
      try { mtimeMs = fsImpl.statSync(full).mtimeMs; } catch { /* no mtime */ }
      const r = stalePendingReason({ data, show, mtimeMs, nowMs, staleHours, windowDays });
      if (!r) continue;
      out.push({
        showId: show.id, file, relPath: path.join('review-texts', '_pending', show.id, file),
        outletId: data.outletId || null, url: data.url || null,
        ageHours: r.ageHours, clock: r.clock, zeroText: isZeroTextPendingStub(data),
      });
    }
  }
  return out;
}

/**
 * gather-reviews pending writer: merge an incoming no-byline record over the
 * existing pending file without losing its first-seen clock or replay
 * bookkeeping. A body already recovered (refetch) is not wiped by a textless
 * re-discovery. Pure.
 */
function mergePendingRecord(existing, incoming, nowIso = new Date().toISOString()) {
  const merged = { ...incoming, pendingReason: 'no-byline' };
  if (existing && typeof existing === 'object') {
    for (const k of PRESERVED_PENDING_FIELDS) {
      if (existing[k] !== undefined && existing[k] !== null) merged[k] = existing[k];
    }
    if (hasText(existing.fullText) && !hasText(incoming && incoming.fullText)) {
      for (const k of ['fullText', 'contentTier', 'contentTierReason', 'isFullReview', 'wordCount', 'textStatus',
        'fetchMethod', 'textFetchedAt']) {
        if (existing[k] !== undefined) merged[k] = existing[k];
      }
    }
  }
  if (!merged.firstSeenAt) merged.firstSeenAt = nowIso;
  return merged;
}

/** Rebuild (not repair in place) a pending stub from a fresh fetch; returns a NEW object. */
// Body fields of a zero-text stub: dropped so the fresh fetch (patch) owns them.
const STUB_BODY_FIELDS = ['fullText', 'textWordCount', 'contentTier', 'isFullReview', 'fetchMethod', 'textFetchedAt'];

function buildRefetchedPendingRecord(stub, patch, nowIso = new Date().toISOString()) {
  // Carry EVERY stub field (exclusion flags such as wrongProduction, score
  // provenance, aggregator sources) so a rebuilt record is never less guarded
  // than the stub it replaces; only body fields come from the fresh fetch.
  const rebuilt = {};
  for (const k of Object.keys(stub || {})) {
    if (STUB_BODY_FIELDS.includes(k) || stub[k] === undefined) continue;
    rebuilt[k] = stub[k];
  }
  Object.assign(rebuilt, patch || {});
  rebuilt.pendingRefetchedAt = nowIso;
  if (!rebuilt.firstSeenAt) rebuilt.firstSeenAt = nowIso;
  return rebuilt;
}

module.exports = {
  DEFAULT_STALE_HOURS,
  POST_OPENING_WINDOW_DAYS,
  STALE_PENDING_CHECK,
  PRESERVED_PENDING_FIELDS,
  isZeroTextPendingStub,
  isUnrecoverablePendingStub,
  isInPostOpeningWindow,
  pendingFirstSeenMs,
  stalePendingReason,
  resolveStaleHours,
  findStalePendingEntries,
  mergePendingRecord,
  buildRefetchedPendingRecord,
};
