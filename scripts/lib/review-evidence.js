'use strict';

/**
 * review-evidence — canonical store + freshness predicate for "the world has
 * published reviews of catalogued show X" facts (v2 reconciler plan, Sprint A).
 *
 * Written by audit-reverse-discovery.js whenever a roundup-shaped item's title
 * MATCHES a catalogued show (the inverse of its missing-show candidates).
 * Read by:
 *   - opening-night-selection.js  (evidence-anchored selection arm: a show
 *     with fresh evidence is selectable even with openingDate null / stale
 *     previewsStartDate / stuck status — the Broad Strokes class, 2026-07-29:
 *     11 published reviews, 0 gathered, because selection required a date)
 *   - audit-opening-night-coverage.js (ledger target scope: same blind spot)
 *
 * ONE predicate on purpose (CLAUDE.md §"includability predicates must be
 * canonical"): both consumers must agree on what "fresh evidence" means or
 * the coverage audit inherits a different blind spot than the selector.
 *
 * File shape (data/audit/review-evidence.json, tracked in the PUBLIC repo —
 * show ids + aggregator URLs only, no review content):
 *   { generatedAt, shows: { <showId>: { latest: ISO-date,
 *       items: [{ source, url, date }] (≤5, newest first) } } }
 */

const fs = require('fs');
const path = require('path');

const EVIDENCE_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'review-evidence.json');
const MAX_ITEMS_PER_SHOW = 5;
const PRUNE_DAYS = 60;

function loadReviewEvidence(filePath = EVIDENCE_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed.shows === 'object' && parsed.shows ? parsed.shows : {};
  } catch {
    return {}; // absent/corrupt file = no evidence, never a crash
  }
}

/**
 * The canonical freshness predicate. Evidence anchors a show when its latest
 * roundup item is within the same lookback window the date-driven selection
 * uses — a stale roundup (closed run, old production) must not re-select.
 */
function hasFreshEvidence(evidenceShows, showId, { now = new Date(), lookbackDays = 21 } = {}) {
  const e = evidenceShows && evidenceShows[showId];
  if (!e || !e.latest) return false;
  const ts = Date.parse(e.latest); // date-only string parses as UTC midnight
  if (!Number.isFinite(ts)) return false;
  // Cutoff in UTC to match: a local-midnight cutoff diverges from CI by up
  // to a day at the window boundary (QA ship-check finding).
  const n = now instanceof Date ? now : new Date(now);
  const cutoff = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - lookbackDays);
  return ts >= cutoff && ts <= n.getTime() + 24 * 3600 * 1000;
}

/**
 * Merge newly observed items into the store. Pure on inputs; caller persists.
 * Items: [{ showId, source, url, date }]. Dedup key: source+url. Prunes shows
 * whose newest item is older than PRUNE_DAYS.
 */
function mergeEvidence(existingShows, items, { now = new Date() } = {}) {
  const shows = JSON.parse(JSON.stringify(existingShows || {}));
  for (const it of items) {
    if (!it || !it.showId || !it.date) continue;
    const cur = shows[it.showId] || { latest: null, items: [] };
    if (!cur.items.some((x) => x.source === it.source && x.url === it.url)) {
      cur.items.push({ source: it.source, url: it.url, date: it.date });
    }
    cur.items.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    cur.items = cur.items.slice(0, MAX_ITEMS_PER_SHOW);
    cur.latest = cur.items[0].date;
    shows[it.showId] = cur;
  }
  const pruneBefore = now.getTime() - PRUNE_DAYS * 86400000;
  for (const [id, e] of Object.entries(shows)) {
    if (!e.latest || Date.parse(e.latest) < pruneBefore) delete shows[id];
  }
  return shows;
}

function saveReviewEvidence(shows, { now = new Date(), filePath = EVIDENCE_PATH } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(shows).sort(([a], [b]) => a.localeCompare(b)));
  // Skip the write when the shows content is unchanged — generatedAt would
  // otherwise dirty the file on every 6h run and force a no-op commit (QA
  // ship-check finding).
  try {
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (JSON.stringify(existing.shows) === JSON.stringify(sorted)) return false;
  } catch { /* absent/corrupt → write fresh */ }
  fs.writeFileSync(filePath, JSON.stringify({ generatedAt: now.toISOString(), shows: sorted }, null, 2) + '\n');
  return true;
}

module.exports = {
  EVIDENCE_PATH,
  loadReviewEvidence,
  hasFreshEvidence,
  mergeEvidence,
  saveReviewEvidence,
};
