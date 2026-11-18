'use strict';
// BRO-7803: runtime versioned score JSON. Pure logic shared by the publisher
// (scripts/publish-live-scores.ts) and the client resolver. No I/O here so
// node --test can require the real functions.
//
// Objects in the public `live-scores` bucket:
//   p.json                    pointer (short cache): { schema, seq, updatedAt, shows: { id: { v, c, rev, n, at } } }
//   kill.json                 kill switch, written only by a human/CLI, never by the publisher: { schema, enabled }
//   s/<showId>.<v>.json       immutable payload: { schema, showId, v, c, rev, view, reviews }
// rev  = reviews.json _meta.lastUpdated (ms) of the data the payload was computed from.
// c    = content hash (excludes rev, so an unchanged show is never republished).
// v    = hash of the exact payload bytes (file name), so a name never holds two byte-strings.

const crypto = require('crypto');

const SCHEMA = 1;
const POINTER_TTL_MS = 48 * 3600 * 1000;
const HOT_DAYS = 3;

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function hash16(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Content hash of a payload body, independent of rev/v/c. */
function contentHash(body) {
  return hash16(stable({ showId: body.showId, view: body.view, reviews: body.reviews }));
}

/** Build the immutable payload for one show. Returns { payload, text, v, c, n }. */
function buildPayload({ showId, view, reviews, rev, tombstone = false }) {
  const c = contentHash({ showId, view, reviews });
  const base = { schema: SCHEMA, showId, c, rev, view, reviews, ...(tombstone ? { tombstone: true } : {}) };
  const v = hash16(stable(base));
  const payload = { ...base, v };
  const text = JSON.stringify(payload);
  return { payload, text, v, c, n: Buffer.byteLength(text) };
}

function payloadPath(showId, v) {
  return `s/${showId}.${v}.json`;
}

/** Hot set: opening within +/- HOT_DAYS or a review published within the last HOT_DAYS (caller filters to open/previews). */
function selectHotShows({ shows, reviewDatesByShow, now = Date.now(), days = HOT_DAYS }) {
  const win = days * 86400000;
  const out = [];
  for (const s of shows) {
    if (!s || !s.id) continue;
    const open = s.openingDate ? Date.parse(s.openingDate + 'T12:00:00Z') : NaN;
    const nearOpening = Number.isFinite(open) && Math.abs(now - open) <= win;
    const dates = (reviewDatesByShow && reviewDatesByShow[s.id]) || [];
    const recentReview = dates.some((d) => {
      const t = Date.parse(d);
      return Number.isFinite(t) && now - t <= win && t - now <= 86400000;
    });
    if (nearOpening || recentReview) out.push(s.id);
  }
  return out;
}

/**
 * Decide whether to publish a show. Returns { publish: boolean, reason }.
 * - unchanged content (c equal to the pointer entry) is skipped
 * - a payload whose reviewCount is lower than the published one is refused
 *   unless allowDecrease (the takedown path)
 * - flagged (staleness guard) shows are never published
 */
function shouldPublish({ prevEntry, prevReviewCount, next, flagged = false, safe = true, allowDecrease = false }) {
  if (!safe) return { publish: false, reason: 'unsafe-run' };
  if (flagged) return { publish: false, reason: 'flagged-stale' };
  if (prevEntry && prevEntry.c === next.c) return { publish: false, reason: 'unchanged' };
  if (!allowDecrease && prevEntry && Number.isFinite(prevReviewCount) && next.view.reviewCount < prevReviewCount) {
    return { publish: false, reason: 'review-count-decrease' };
  }
  return { publish: true, reason: 'changed' };
}

/**
 * Merge updates into the pointer. Never lowers a rev, drops expired entries
 * (older than ttl) and tombstones are kept until they expire. `live` maps
 * showId -> rev of the newest deploy confirmed live; an entry is only dropped
 * when it has expired AND a live deploy already covers it.
 */
function mergePointer({ prev, updates, now = Date.now(), ttlMs = POINTER_TTL_MS, live = {} }) {
  const shows = {};
  const old = (prev && prev.shows) || {};
  for (const [id, e] of Object.entries(old)) {
    const expired = now - (e.at || 0) > ttlMs;
    const covered = Number.isFinite(live[id]) && live[id] >= e.rev;
    if (expired && covered) continue;
    shows[id] = e;
  }
  for (const [id, e] of Object.entries(updates || {})) {
    const cur = shows[id];
    if (cur && cur.rev > e.rev) continue; // never lower rev
    shows[id] = { ...e, at: now };
  }
  return {
    schema: SCHEMA,
    seq: ((prev && prev.seq) || 0) + 1,
    updatedAt: new Date(now).toISOString(),
    shows,
  };
}

module.exports = {
  SCHEMA, POINTER_TTL_MS, HOT_DAYS,
  stable, hash16, contentHash, buildPayload, payloadPath,
  selectHotShows, shouldPublish, mergePointer,
};
