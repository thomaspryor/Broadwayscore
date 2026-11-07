'use strict';

// Per-record lastUpdated stamping for commercial.json (BRO-5005, BRO-4989).
//
// lastUpdated is the push merge's tiebreak (merge-commercial-data.js
// pickNewer): with no base copy the newer record wins whole, and in a field
// conflict the newer record's value wins. Before this, only a few writers
// stamped it (commercial-field-edit.js, apply-commercial-pending.js, ...), so
// most real edits tied with a stale copy and could lose to it (BRO-4657).
//
// The write guard calls this on every save: a record whose content changed
// is stamped. A change confined to MODEL_RUN_FIELDS (a model re-run) is not,
// so a daily derived re-run can never out-vote a same-day cost or
// designation fix.
//
// Limits: two stamped edits to one record on the same day still resolve by
// time in the no-base path; only the base-aware field merge keeps both.
// Records with no previous version under the same key (new, or re-keyed by
// canonicalizeCommercialKeys) are left to their creator.

const { MODEL_RUN_FIELDS } = require('./merge-commercial-data');

const NOT_CONTENT = new Set([...MODEL_RUN_FIELDS, 'lastUpdated', 'firstAdded']);

// Key order is not content: a writer that rebuilds sources[] entries with
// keys in another order must not count as an edit.
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function contentChanged(prev, next) {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    if (NOT_CONTENT.has(k)) continue;
    if (stableJson(prev[k]) !== stableJson(next[k])) return true;
  }
  return false;
}

/**
 * Stamp lastUpdated on records whose content changed vs the on-disk copy.
 *
 * By the caller's lastUpdated against the on-disk one:
 *  - newer: the caller stamped deliberately; kept.
 *  - equal (or either unparseable): the caller edited the version it loaded;
 *    stamped now.
 *  - older: the caller's whole record was loaded before another writer
 *    stamped this one, so writing it replaces that writer's edit (the write
 *    guard merges whole records). Stamping it now would make the stale copy
 *    look newest and out-vote the other edit again at push time, so it keeps
 *    its older stamp and is reported in `staleOverwrites`.
 *
 * @param {object} finalShows - records about to be written (mutated)
 * @param {object|null} previousShows - records on disk before this write
 * @param {string} [now] - ISO timestamp
 * @returns {{ stamped: string[], staleOverwrites: string[] }}
 */
function stampContentChanges(finalShows, previousShows, now = new Date().toISOString()) {
  const stamped = [];
  const staleOverwrites = [];
  if (!finalShows || !previousShows) return { stamped, staleOverwrites };
  for (const [slug, rec] of Object.entries(finalShows)) {
    const prev = previousShows[slug];
    if (!rec || !prev || typeof rec !== 'object' || typeof prev !== 'object') continue;
    if (!contentChanged(prev, rec)) continue;
    const mine = Date.parse(rec.lastUpdated);
    const theirs = Date.parse(prev.lastUpdated);
    if (Number.isFinite(mine) && Number.isFinite(theirs) && mine < theirs) {
      staleOverwrites.push(slug);
      continue;
    }
    if (Number.isFinite(mine) && (!Number.isFinite(theirs) || mine > theirs)) continue;
    rec.lastUpdated = now;
    stamped.push(slug);
  }
  return { stamped, staleOverwrites };
}

module.exports = { stampContentChanges, contentChanged };
