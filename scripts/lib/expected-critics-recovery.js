'use strict';

/**
 * expected-critics-recovery.js (BRO-7312): fix an expected-critics gap before
 * ever telling the owner about it.
 *
 * Owner, 2026-11-10: "I should only get flagged if an automated system really
 * truly can't fix this." expected-critics.js (BRO-7166) finds the cells: a
 * usual critic with no live review of an opening 72h+ old. This module decides
 * what the automation does with each one:
 *
 *   recovering  a targeted search (scripts/recover-expected-critics.js runs
 *               scripts/collect-outlet-reviews.js for exactly that show and
 *               outlet) is scheduled or waiting on the rebuild. Not shown to
 *               the owner while the schedule is being kept.
 *   acked       ATTEMPTS_FOR_ACK searches spread over 14+ days all came back
 *               empty, so the outlet did not review it. Recorded here with
 *               the evidence (never in t1-coverage-ack.json, which has one
 *               writer); callers merge it via mergedAcks().
 *   dead-end    the searches found something they could not use (a page that
 *               is not a review, outside the run's dates, a file that never
 *               went live), the outlet cannot be searched, or the search kept
 *               failing. Only these reach the owner, in plain words.
 *
 * State: data/audit/expected-critics-recovery.json, single writer
 * (recover-expected-critics.js saves it). Pure apart from loadRecoveryState.
 */

const fs = require('fs');
const path = require('path');
const { cellKey } = require('./expected-critics');

const STATE_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'expected-critics-recovery.json');
const DAY_MS = 86400000;
const HOUR_MS = 3600000;
// Attempt n (0-based) is due this many days after opening day.
const SCHEDULE_DAYS = [3, 7, 14];
const ATTEMPTS_FOR_ACK = SCHEDULE_DAYS.length;
const MIN_RETRY_GAP_MS = 20 * HOUR_MS;
const ACK_MIN_DAYS_AFTER_OPENING = 14; // the last empty search must be this late
const WRITTEN_SETTLE_MS = 3 * DAY_MS; // a written file gets this long to go live
const EXISTING_FILE_DEAD_MS = 14 * DAY_MS; // a file on disk that never goes live
const MAX_TOTAL_ATTEMPTS = 8; // searches that keep breaking (SERP down, errors)
const OVERDUE_GRACE_MS = 2 * DAY_MS; // owner sees a recovering cell only once the schedule slips this far
const FRESH_GRACE_MS = 2 * DAY_MS; // a cell nobody has tried yet stays quiet this long after it became missing
const ACK_SOURCE = 'expected-critics-recovery';

const EVIDENCE = new Set(['no_evidence', 'rejected']);

function emptyState() {
  return { schemaVersion: 1, cells: {} };
}

function loadRecoveryState(p = STATE_PATH) {
  try {
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (s && typeof s === 'object' && s.cells && typeof s.cells === 'object') return s;
  } catch { /* missing or corrupt: start empty */ }
  return emptyState();
}

/** End of opening day (UTC), as expected-critics.js reads it. */
function openedMs(openingDate) {
  const ms = openingDate ? Date.parse(String(openingDate).slice(0, 10)) : NaN;
  return Number.isFinite(ms) ? ms + DAY_MS : null;
}

const atMs = (a) => Date.parse(a && a.at);

/**
 * Where one cell stands.
 * @param {{openingDate: string, attempts?: object[], autoAck?: object}} cell
 * @returns {{phase: 'recovering'|'acked'|'dead-end', reason: string, nextDueMs: number|null}}
 */
function cellPhase(cell, nowMs) {
  if (cell.autoAck) return { phase: 'acked', reason: 'no-review-found', nextDueMs: null };
  const opened = openedMs(cell.openingDate);
  const attempts = (cell.attempts || []).filter((a) => Number.isFinite(atMs(a)));
  const last = attempts[attempts.length - 1] || null;

  if (attempts.some((a) => a.outcome === 'not_searchable')) {
    return { phase: 'dead-end', reason: 'not-searchable', nextDueMs: null };
  }
  const firstExisting = attempts.find((a) => a.outcome === 'existing_file');
  if (firstExisting && nowMs - atMs(firstExisting) >= EXISTING_FILE_DEAD_MS) {
    return { phase: 'dead-end', reason: 'file-not-live', nextDueMs: null };
  }
  if (last && last.outcome === 'written' && nowMs - atMs(last) < WRITTEN_SETTLE_MS) {
    return { phase: 'recovering', reason: 'waiting-for-rebuild', nextDueMs: atMs(last) + WRITTEN_SETTLE_MS };
  }

  // A write that never went live counts as a find the system could not use.
  const evidence = attempts.filter((a) => EVIDENCE.has(a.outcome) || a.outcome === 'written');
  if (evidence.length >= ATTEMPTS_FOR_ACK) {
    const allEmpty = evidence.every((a) => a.outcome === 'no_evidence');
    if (!allEmpty) return { phase: 'dead-end', reason: lastFindReason(evidence), nextDueMs: null };
    const lastEmpty = evidence[evidence.length - 1];
    if (opened != null && atMs(lastEmpty) >= opened + ACK_MIN_DAYS_AFTER_OPENING * DAY_MS) {
      return { phase: 'acked', reason: 'no-review-found', nextDueMs: null };
    }
    // Empty but all early: one more search after day 14 before calling it.
  }
  if (attempts.length >= MAX_TOTAL_ATTEMPTS) {
    return { phase: 'dead-end', reason: 'search-keeps-failing', nextDueMs: null };
  }

  const n = Math.min(evidence.length, SCHEDULE_DAYS.length - 1);
  const scheduled = opened != null ? opened + SCHEDULE_DAYS[n] * DAY_MS : nowMs;
  const nextDueMs = Math.max(scheduled, last ? atMs(last) + MIN_RETRY_GAP_MS : 0);
  return { phase: 'recovering', reason: attempts.length ? 'retry-scheduled' : 'first-search', nextDueMs };
}

function lastFindReason(evidence) {
  const finds = evidence.filter((a) => a.outcome !== 'no_evidence');
  const f = finds[finds.length - 1];
  if (!f) return 'found-unusable';
  if (f.outcome === 'written') return 'written-not-live';
  return f.reason || 'found-unusable';
}

/**
 * Bring the state in line with today's gap list: register new missing cells,
 * drop cells that are no longer missing (live now, out of window), keep acked
 * cells (their ack is what keeps them not-missing).
 * @param {object[]} gaps findExpectedCriticGaps rows
 */
function syncState(state, gaps, nowMs) {
  const next = { ...state, cells: {} };
  const missing = new Map();
  for (const g of gaps || []) if (g.status === 'missing') missing.set(cellKey(g.showId, g.outletId), g);
  for (const [key, cell] of Object.entries(state.cells || {})) {
    if (cell.autoAck || missing.has(key)) next.cells[key] = cell;
  }
  for (const [key, g] of missing) {
    if (!next.cells[key]) {
      next.cells[key] = {
        showId: g.showId, outletId: g.outletId, openingDate: g.openingDate,
        firstSeenMissingAt: new Date(nowMs).toISOString(), attempts: [],
      };
    }
  }
  return next;
}

/**
 * Cells due for a search, oldest opening first, grouped per show (one
 * collector run per show), capped at maxSearches cells.
 * @returns {Array<{showId: string, outletIds: string[]}>}
 */
function planRecovery(state, nowMs, { maxSearches = 12 } = {}) {
  const due = [];
  for (const [key, cell] of Object.entries(state.cells || {})) {
    const p = cellPhase(cell, nowMs);
    if (p.phase === 'recovering' && p.nextDueMs != null && p.nextDueMs <= nowMs) due.push({ key, cell });
  }
  due.sort((a, b) => String(a.cell.openingDate).localeCompare(String(b.cell.openingDate)) || a.key.localeCompare(b.key));
  const byShow = new Map();
  for (const { cell } of due.slice(0, Math.max(0, maxSearches))) {
    if (!byShow.has(cell.showId)) byShow.set(cell.showId, []);
    byShow.get(cell.showId).push(cell.outletId);
  }
  return [...byShow].map(([showId, outletIds]) => ({ showId, outletIds: outletIds.sort() }));
}

/**
 * Collector arguments for one planned show: exactly that show and those
 * outlets, any tier (standing outlets are not all tier 1-2), dates checked.
 */
function collectorArgs(plan, { resultJson, dryRun = false } = {}) {
  const args = [
    '--shows', plan.showId,
    '--outlets', plan.outletIds.join(','),
    '--max-tier', '3',
    '--max-searches', String(plan.outletIds.length),
    '--require-publish-window',
    '--result-json', resultJson,
  ];
  if (dryRun) args.push('--dry-run');
  return args;
}

/**
 * Record one collector run's rows against the cells it was asked about. A
 * planned cell with no row (the run died, the budget ran out) is a
 * non-evidence attempt: it does not count toward an ack.
 * @returns {object} new state
 */
function applyResults(state, { plan, rows, nowMs, dryRun = false }) {
  if (dryRun) return state;
  const next = { ...state, cells: { ...state.cells } };
  const at = new Date(nowMs).toISOString();
  for (const outletId of plan.outletIds) {
    const key = cellKey(plan.showId, outletId);
    const cell = next.cells[key];
    if (!cell) continue;
    const row = (rows || []).find((r) => r && r.showId === plan.showId && r.outletId === outletId);
    const attempt = row
      ? { at, outcome: row.outcome, ...(row.reason ? { reason: row.reason } : {}), ...(row.url ? { url: row.url } : {}) }
      : { at, outcome: 'non_evidence', reason: 'no-result-row' };
    const updated = { ...cell, attempts: [...(cell.attempts || []), attempt] };
    if (cellPhase(updated, nowMs).phase === 'acked') updated.autoAck = { ackedAt: at, note: ackNote(updated) };
    next.cells[key] = updated;
  }
  return next;
}

function ackNote(cell) {
  const dates = (cell.attempts || []).filter((a) => a.outcome === 'no_evidence').map((a) => String(a.at).slice(0, 10));
  return `auto (BRO-7312): ${dates.length} targeted searches of ${cell.outletId} for ${cell.showId} found no review (${dates.join(', ')})`;
}

/** Manual acks plus this module's auto-acks, in t1-coverage-ack.json's shape. */
function mergedAcks(manualAcks, state) {
  const out = [...(manualAcks || [])];
  const have = new Set(out.map((a) => a && a.key));
  for (const [key, cell] of Object.entries((state && state.cells) || {})) {
    if (cell.autoAck && !have.has(key)) out.push({ key, ackedAt: cell.autoAck.ackedAt, note: cell.autoAck.note, source: ACK_SOURCE });
  }
  return out;
}

/**
 * Should the owner hear about this missing cell? Only dead ends, plus any
 * cell the automation is visibly not handling (never tried well after it
 * became missing, or its next search is overdue by days: the job is broken).
 * @param {object} gap a findExpectedCriticGaps row with status 'missing'
 */
function ownerVisibility(gap, state, nowMs) {
  const cell = state && state.cells && state.cells[cellKey(gap.showId, gap.outletId)];
  if (!cell) {
    const missingSince = openedMs(gap.openingDate) + 72 * HOUR_MS;
    return nowMs - missingSince < FRESH_GRACE_MS
      ? { visible: false, phase: 'recovering', reason: 'first-search' }
      : { visible: true, phase: 'not-tracked', reason: 'recovery-not-running' };
  }
  const p = cellPhase(cell, nowMs);
  if (p.phase === 'dead-end') return { visible: true, ...p };
  if (p.phase === 'acked') return { visible: false, ...p };
  // A backlog cell's schedule date can be weeks old the day recovery first
  // sees it; the overdue clock starts no earlier than that day.
  const seen = Date.parse(cell.firstSeenMissingAt);
  const dueFrom = Math.max(p.nextDueMs == null ? -Infinity : p.nextDueMs, Number.isFinite(seen) ? seen : -Infinity);
  if (p.nextDueMs != null && nowMs > dueFrom + OVERDUE_GRACE_MS) return { visible: true, ...p, reason: 'recovery-overdue' };
  return { visible: false, ...p };
}

/** Split missing gap rows into what the owner sees and what the automation still holds. */
function splitForOwner(gaps, state, nowMs) {
  const visible = [];
  const recovering = [];
  for (const g of gaps || []) {
    if (g.status !== 'missing') continue;
    const v = ownerVisibility(g, state, nowMs);
    (v.visible ? visible : recovering).push({ ...g, recovery: v });
  }
  return { visible, recovering };
}

const REASON_TEXT = {
  'not-searchable': 'it has no website we can search',
  'file-not-live': 'we have a copy on file, but it never made it onto the site',
  'written-not-live': 'we saved it, but it never made it onto the site',
  'non-review-url': 'the only match was a page that is not a review',
  'wrong-domain': 'the only match was on a different website',
  'http-error': 'the only match was a broken link',
  'outside-publish-window': 'the only match was from a different production',
  'no-publish-date': 'the only match had no date, so we could not tell which production it covers',
  'search-keeps-failing': 'the search itself kept failing',
  'recovery-overdue': 'the automatic search has stopped running',
  'recovery-not-running': 'the automatic search has not looked for it yet',
};

/** One plain-English line for the owner. */
function ownerLine(g) {
  const why = REASON_TEXT[g.recovery && g.recovery.reason] || 'the automatic searches could not settle it';
  return `${g.outletName} on ${g.title}: no review on the site, and ${why}.`;
}

module.exports = {
  STATE_PATH, SCHEDULE_DAYS, ATTEMPTS_FOR_ACK, ACK_SOURCE,
  emptyState, loadRecoveryState,
  cellPhase, syncState, planRecovery, collectorArgs, applyResults,
  mergedAcks, ownerVisibility, splitForOwner, ownerLine,
};
