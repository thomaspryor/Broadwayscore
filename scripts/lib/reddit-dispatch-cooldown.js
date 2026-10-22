/**
 * Cross-run cooldown for the Reddit sentiment scrape (BRO-5916).
 *
 * Every opening-night tick re-dispatches update-reddit-sentiment.yml. When
 * every Reddit route is down, each dispatch burned ~290 ScrapingBee credits
 * and failed. This module decides, from a tiny append-only ledger
 * (data/audit/reddit-run-health.jsonl, one JSON row per run), whether the next
 * dispatch should be skipped, and whether the "no successful Reddit write for
 * 48h" alert is due (once per outage, not per run).
 *
 * Rows: { ts, outcome: 'ok' | 'unavailable' | 'alerted', note? }
 * Pure functions only; the scraper and the dispatchers do the I/O.
 */
const fs = require('fs');
const path = require('path');

const LEDGER_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'reddit-run-health.jsonl');

const DEFAULTS = {
  threshold: 3,          // consecutive 'unavailable' runs before dispatches are skipped
  probeAfterHours: 6,    // while cooling down, let one run through this long after the last attempt
  staleAlertHours: 48,   // no 'ok' for this long => alert (once)
};

function parseLedger(text) {
  return String(text || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && Number.isFinite(Date.parse(r.ts)) && ['ok', 'unavailable', 'alerted'].includes(r.outcome));
}

function readLedger(file = LEDGER_PATH) {
  try { return parseLedger(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

function appendRow(row, file = LEDGER_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

// Attempts only (alert rows are bookkeeping, not scrape attempts).
function attempts(rows) {
  return rows.filter(r => r.outcome === 'ok' || r.outcome === 'unavailable');
}

/**
 * @returns {{skip:boolean, reason:string, consecutiveUnavailable:number}}
 */
function decideCooldown(rows, nowMs = Date.now(), opts = {}) {
  const { threshold, probeAfterHours } = { ...DEFAULTS, ...opts };
  const att = attempts(rows);
  let streak = 0;
  for (let i = att.length - 1; i >= 0 && att[i].outcome === 'unavailable'; i--) streak++;
  if (streak < threshold) {
    return { skip: false, reason: streak ? `${streak} unavailable run(s), below threshold ${threshold}` : 'healthy', consecutiveUnavailable: streak };
  }
  const lastTs = Date.parse(att[att.length - 1].ts);
  const ageH = (nowMs - lastTs) / 3600000;
  if (ageH >= probeAfterHours) {
    return { skip: false, reason: `cooldown probe: last attempt ${ageH.toFixed(1)}h ago`, consecutiveUnavailable: streak };
  }
  return {
    skip: true,
    reason: `Reddit cooldown: last ${streak} runs ended with all sources unavailable; next probe in ${(probeAfterHours - ageH).toFixed(1)}h`,
    consecutiveUnavailable: streak,
  };
}

/**
 * Alert when there has been no successful run for staleAlertHours, once per
 * outage (an 'alerted' row after the last 'ok' suppresses repeats).
 * With no 'ok' row at all, the oldest row anchors the outage start.
 * @returns {{alert:boolean, reason:string, sinceTs:string|null}}
 */
function shouldAlertStale(rows, nowMs = Date.now(), opts = {}) {
  const { staleAlertHours } = { ...DEFAULTS, ...opts };
  if (rows.length === 0) return { alert: false, reason: 'no history', sinceTs: null };
  let lastOkIdx = -1;
  rows.forEach((r, i) => { if (r.outcome === 'ok') lastOkIdx = i; });
  const anchor = lastOkIdx >= 0 ? rows[lastOkIdx] : rows[0];
  const sinceMs = Date.parse(anchor.ts);
  if (!rows.slice(lastOkIdx + 1).some(r => r.outcome === 'unavailable')) {
    return { alert: false, reason: 'no failed run since last success', sinceTs: anchor.ts };
  }
  if ((nowMs - sinceMs) / 3600000 < staleAlertHours) {
    return { alert: false, reason: `less than ${staleAlertHours}h since last success`, sinceTs: anchor.ts };
  }
  if (rows.slice(lastOkIdx + 1).some(r => r.outcome === 'alerted')) {
    return { alert: false, reason: 'already alerted for this outage', sinceTs: anchor.ts };
  }
  return { alert: true, reason: `no successful Reddit scrape since ${anchor.ts}`, sinceTs: anchor.ts };
}

module.exports = { LEDGER_PATH, DEFAULTS, parseLedger, readLedger, appendRow, decideCooldown, shouldAlertStale };
