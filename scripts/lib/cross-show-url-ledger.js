'use strict';

/**
 * BRO-6910: append-only ledger of every review URL the cross-show URL slug
 * guard (detectCrossShowUrlMismatch) could not reroute.
 *
 * Before this, gather-reviews printed "Skipping ... URL belongs to X" and
 * dropped the review with no durable trace, so the slow-market gap audit and
 * its grader could not see the loss (Clifford Odets' Waiting for Lefty lost
 * Vulture, NYSR, Theater Pizzazz and Cititour on 2026-11-02 and graded PASS).
 *
 * Each row: { ts, showId, url, outletId, criticName, matchedShowId,
 *   matchedTitle, matchedStatus, source, sourceUrl }
 * One row per (showId, url): gather re-runs every ~30 min and would otherwise
 * re-append the same drop forever. audit-show-review-gap.js reads the rows for
 * a show as cited URLs, so a dropped review that never went live is MISSING
 * and slow-market-grade FAILs instead of passing blind.
 *
 * Committed by the commit-scraper-spend-ledger composite action, which every
 * gather shard and opening-night workflow runs with if: always(). Parallel runs
 * append concurrently, so the push path (PUSH_RECONCILE_MERGED_JSON=1)
 * union-merges rows by (showId, url) via mergeCrossShowUrlLedger.
 */

const fs = require('fs');
const path = require('path');
const { isTestRun } = require('./test-run-guard');

const DEFAULT_LEDGER = path.join(__dirname, '..', '..', 'data', 'audit', 'cross-show-url-holds.jsonl');

function ledgerPath() {
  if (process.env.CROSS_SHOW_URL_LEDGER) return process.env.CROSS_SHOW_URL_LEDGER;
  // Tests reach createReviewFile; never append synthetic rows to the real ledger.
  if (isTestRun()) return path.join(require('os').tmpdir(), `cross-show-url-holds-test-${process.pid}.jsonl`);
  return DEFAULT_LEDGER;
}

// (showId|url) keys already on disk, loaded once per process per ledger path.
const seenByPath = new Map();
function seenKeys(p) {
  if (!seenByPath.has(p)) {
    const set = new Set();
    for (const r of readCrossShowUrlRows({ file: p })) set.add(`${r.showId}|${r.url}`);
    seenByPath.set(p, set);
  }
  return seenByPath.get(p);
}

// Returns true when a NEW row was written, false for a duplicate or failure.
function appendCrossShowUrlRow(row) {
  if (!row || !row.showId || !row.url) return false;
  const p = ledgerPath();
  const seen = seenKeys(p);
  const dedupeKey = `${row.showId}|${row.url}`;
  if (seen.has(dedupeKey)) return false;
  const record = {
    ts: new Date().toISOString(),
    showId: row.showId,
    url: row.url,
    outletId: row.outletId || null,
    criticName: row.criticName || null,
    matchedShowId: row.matchedShowId || null,
    matchedTitle: row.matchedTitle || null,
    matchedStatus: row.matchedStatus || null,
    source: row.source || null,
    sourceUrl: row.sourceUrl || null,
  };
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(record) + '\n');
    seen.add(dedupeKey);
    return true;
  } catch (e) {
    process.stderr.write(`[cross-show-url-ledger] append failed: ${e.message}\n`);
    return false;
  }
}

function readCrossShowUrlRows({ showId, since, file } = {}) {
  const p = file || ledgerPath();
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const sinceMs = since ? Date.parse(since) : NaN;
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || !r.showId || !r.url) continue;
    if (showId && r.showId !== showId) continue;
    if (Number.isFinite(sinceMs) && !(Date.parse(r.ts) >= sinceMs)) continue;
    rows.push(r);
  }
  return rows;
}

// The union merge lives write-free in merge-cross-show-url-ledger.js so the
// core-data merge registry (and the safe-form audits that load it) never pull
// in this module's appendFileSync.
const { mergeCrossShowUrlLedger, keyOf } = require('./merge-cross-show-url-ledger');

module.exports = {
  DEFAULT_LEDGER,
  ledgerPath,
  appendCrossShowUrlRow,
  readCrossShowUrlRows,
  mergeCrossShowUrlLedger,
  keyOf,
};
