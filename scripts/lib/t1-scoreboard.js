'use strict';

/**
 * t1-scoreboard.js — B3 of the v2 reconciler Sprint B plan
 * (~/Documents/claude-outputs/review-pipeline-from-scratch-design-2026-07-29.md):
 * "coverage % per market, oldest gap, hard cap on lines/day + dedup/ack so a
 * permanent false positive can't recreate alert fatigue inside the one email."
 *
 * Rides the EXISTING daily-digest queue (owner-alert-router.js
 * disposition:'digest' → data/audit/alert-digest-queue.json → health-check.js's
 * "Automation (queued)" section) rather than inventing a new delivery path.
 * ONE conditionKey ('t1-coverage:scoreboard'); routeAlert's own per-condition
 * queueDigestLine() already replaces-not-stacks on re-queue, so the scoreboard
 * naturally refreshes to one current line instead of accumulating duplicates.
 *
 * ACK (dedup so a known-permanent gap can't recreate fatigue): a cell can be
 * acknowledged via data/audit/t1-coverage-ack.json (see loadAcks/isAcked). An
 * acked cell still counts against the market's coverage % (it IS still
 * missing) but never becomes the "oldest gap" callout line, and the hard cap
 * on GAP lines below skips it too — the whole point is "I know about this
 * one, stop mentioning it every day."
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ACK_PATH = path.join(ROOT, 'data', 'audit', 't1-coverage-ack.json');
const MAX_OLDEST_GAPS_DEFAULT = 5;

function cellKey(showId, outletId) {
  return `${showId}::${outletId}`;
}

/** @returns {Array<{key, ackedAt, note}>} */
function loadAcks() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACK_PATH, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
  } catch { /* missing/corrupt — nothing acked */ }
  return [];
}

function isAcked(key, acks) {
  return (acks || []).some((a) => a && a.key === key);
}

/** Append (or refresh the note on) an ack entry. Pure w.r.t. the input array — returns a new array. */
function addAck(acks, key, note, nowIso) {
  const kept = (acks || []).filter((a) => a && a.key !== key);
  kept.push({ key, ackedAt: nowIso, note: note || '' });
  return kept;
}

function saveAcks(acks) {
  fs.mkdirSync(path.dirname(ACK_PATH), { recursive: true });
  fs.writeFileSync(ACK_PATH, JSON.stringify(acks, null, 2) + '\n');
}

/**
 * Build the scoreboard's plain-text body. Pure aside from injected `nowMs`.
 * @param {object} marketStats  { [market]: {covered, denominator, coveragePct} } (t1-coverage-stats.json)
 * @param {object} ledger  { shows: { [showId]: {title, market, cells: {...}} } } (t1-coverage-ledger.json)
 * @param {Array} acks  loadAcks() result
 * @param {number} nowMs
 * @param {object} [opts] { maxOldestGaps }
 * @returns {{ text: string, marketLines: string[], oldestGapLines: string[], omittedByAck: number }}
 */
function buildScoreboardText(marketStats, ledger, acks, nowMs, opts = {}) {
  const maxOldestGaps = opts.maxOldestGaps || MAX_OLDEST_GAPS_DEFAULT;

  const marketLines = Object.keys(marketStats || {}).sort().map((mkt) => {
    const s = marketStats[mkt];
    const pct = s.coveragePct == null ? 'n/a' : `${s.coveragePct}%`;
    return `${mkt}: ${pct} (${s.covered}/${s.denominator})`;
  });

  // Gather open cells, split by whether we are still TRYING.
  //   GAP          — actionable retrieval failure; the SLA burn-down list.
  //   CIRCUIT_OPEN — (B2) a GAP whose outlet breaker tripped, so dispatch is
  //                  paused. It gets its OWN section rather than being dropped:
  //                  a ship-check pass caught that filtering on `!== 'GAP'` made
  //                  every circuit-open cell vanish from both this scoreboard and
  //                  the digest, so "we quietly stopped trying" became invisible —
  //                  exactly the silent-gap failure the v2 plan exists to kill.
  // IN_FLIGHT / SUPPRESSED / NO_REVIEW_EXPECTED are still excluded (not failures,
  // or excluded by registry evidence).
  const shows = (ledger && ledger.shows) || {};
  const gaps = [];
  const circuitOpen = [];
  let omittedByAck = 0;
  for (const showId of Object.keys(shows)) {
    const s = shows[showId];
    for (const outletId of Object.keys(s.cells || {})) {
      const cell = s.cells[outletId];
      const bucket = cell.state === 'GAP' ? gaps : (cell.state === 'CIRCUIT_OPEN' ? circuitOpen : null);
      if (!bucket) continue;
      const key = cellKey(showId, outletId);
      if (isAcked(key, acks)) { omittedByAck++; continue; }
      const firstMs = Date.parse(cell.firstSeenAt);
      const ageHours = Number.isFinite(firstMs) ? Math.round((nowMs - firstMs) / 3600000) : 0;
      bucket.push({ showId, title: s.title, outletId, ageHours });
    }
  }
  const oldestFirst = (a, b) => b.ageHours - a.ageHours;
  gaps.sort(oldestFirst);
  circuitOpen.sort(oldestFirst);

  const capLines = (rows, noun) => {
    const lines = rows.slice(0, maxOldestGaps).map((g) => `${g.title} — ${g.outletId} (${g.ageHours}h)`);
    if (rows.length > maxOldestGaps) lines.push(`… ${rows.length - maxOldestGaps} more ${noun}`);
    return lines;
  };
  const oldestGapLines = capLines(gaps, 'open gap(s)');
  // Same hard cap as the gap list so a broad outlet outage can't flood the one email.
  const circuitOpenLines = capLines(circuitOpen, 'circuit-open cell(s)');

  const text = [
    ...marketLines,
    ...(oldestGapLines.length ? ['', 'Oldest gaps:', ...oldestGapLines] : []),
    ...(circuitOpenLines.length
      ? ['', 'Circuit open (retrieval failing across shows — dispatch paused, auto-probing):', ...circuitOpenLines]
      : []),
  ].join('\n');
  return {
    text, marketLines, oldestGapLines, circuitOpenLines, omittedByAck,
    totalOpenGaps: gaps.length, totalCircuitOpen: circuitOpen.length,
  };
}

module.exports = {
  loadAcks, isAcked, addAck, saveAcks, buildScoreboardText, cellKey,
  ACK_PATH, MAX_OLDEST_GAPS_DEFAULT,
};
