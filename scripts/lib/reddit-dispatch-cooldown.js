/**
 * reddit-dispatch-cooldown.js — cross-run cooldown for the ScrapingBee leg of
 * the Reddit scraper (BRO-5916).
 *
 * Why the provider and not the whole workflow: from 2026-10-19 Reddit direct
 * 403s, Scrapingdog's breaker is open and ScrapingBee premium (10 credits a
 * call) times out. Every opening-night tick re-dispatched
 * update-reddit-sentiment.yml and each run burned ~290 SB credits on a leg that
 * had not succeeded once (spend ledger, 10-21: scrapingbee 292 failures, 0
 * successes; Bright Data and Scrapingdog still answered). Skipping the whole
 * workflow would also stop the cheap legs, so the breaker lives on the SB call
 * and reads its evidence from the committed spend ledger: no extra state file,
 * no commit race, and bulk-reddit-sentiment.yml (which calls the scraper
 * directly) is covered too.
 *
 * All decisions are pure functions over ledger rows so the tests require() the
 * real code.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HOUR_MS = 3600 * 1000;
const SB_LOOKBACK_HOURS = 48;
/** Most recent SB Reddit calls inspected. All failed => the leg is considered down. */
const SB_COOLDOWN_WINDOW = 6;
/** Once down, let one probe call through after this long since the last failure. */
const SB_PROBE_AFTER_HOURS = 6;
/** In-run: stop calling SB after this many straight failures. */
const SB_RUN_FAILURE_LIMIT = 3;
/** Reddit counts as down when no show's reddit source was written for this long. */
const REDDIT_STALE_HOURS = 48;

const LEDGER_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'scraper-spend-ledger.jsonl');

function isSbRedditRow(r) {
  return r && r.provider === 'scrapingbee' && r.host === 'reddit.com' && r.status !== 'budget_capped';
}

/**
 * Cross-run verdict for the ScrapingBee Reddit leg.
 * @param {object[]} rows - ledger rows (any order; need not be pre-filtered)
 * @returns {{allowed:boolean, probe:boolean, reason:string}}
 */
function sbRedditVerdict(rows, { nowMs = Date.now() } = {}) {
  const since = nowMs - SB_LOOKBACK_HOURS * HOUR_MS;
  const recent = (rows || [])
    .filter((r) => isSbRedditRow(r) && Date.parse(r.ts) >= since)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    .slice(-SB_COOLDOWN_WINDOW);
  if (recent.length < SB_COOLDOWN_WINDOW) {
    return { allowed: true, probe: false, reason: `only ${recent.length} SB Reddit calls in ${SB_LOOKBACK_HOURS}h` };
  }
  if (recent.some((r) => r.success === true)) {
    return { allowed: true, probe: false, reason: 'a recent SB Reddit call succeeded' };
  }
  const lastFail = Date.parse(recent[recent.length - 1].ts);
  const ageH = (nowMs - lastFail) / HOUR_MS;
  if (ageH >= SB_PROBE_AFTER_HOURS) {
    return { allowed: true, probe: true, reason: `last ${SB_COOLDOWN_WINDOW} SB Reddit calls failed, ${ageH.toFixed(1)}h ago: probing` };
  }
  return {
    allowed: false, probe: false,
    reason: `last ${SB_COOLDOWN_WINDOW} SB Reddit calls all failed (newest ${ageH.toFixed(1)}h ago); cooling down until ${SB_PROBE_AFTER_HOURS}h`,
  };
}

/** In-run breaker: true once `consecutiveFailures` reaches the limit. */
function sbRunBreakerOpen(consecutiveFailures) {
  return consecutiveFailures >= SB_RUN_FAILURE_LIMIT;
}

/**
 * Should the "Reddit has no fresh data" alert be open?
 * @param {number|null} lastWriteMs - newest sources.reddit.lastUpdated across audience-buzz
 * @param {number} attemptsInWindow - Reddit ledger rows inside the window (proves we are trying)
 */
function redditStaleVerdict({ lastWriteMs, attemptsInWindow, nowMs = Date.now() }) {
  const ageH = lastWriteMs == null ? Infinity : (nowMs - lastWriteMs) / HOUR_MS;
  if (ageH < REDDIT_STALE_HOURS) return { stale: false, ageHours: ageH };
  // Nothing was even attempted: the scraper is idle (monthly cadence), not broken.
  if (!(attemptsInWindow > 0)) return { stale: false, ageHours: ageH, idle: true };
  return { stale: true, ageHours: ageH };
}

/**
 * Read ledger rows from the tail of the jsonl (~14MB, ~47k lines). Reads backwards
 * in chunks until the oldest row parsed is older than sinceMs (or the file start),
 * so a "last 48h" window really is 48h (a fixed 2MB tail only reached ~7h).
 */
function readLedgerTail(file = LEDGER_PATH, { sinceMs = Date.now() - REDDIT_STALE_HOURS * 3600e3, chunk = 2 * 1024 * 1024 } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    let bytes = Math.min(size, chunk);
    for (;;) {
      const start = size - bytes;
      const buf = Buffer.alloc(bytes);
      fs.readSync(fd, buf, 0, bytes, start);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift(); // partial first line
      const rows = [];
      for (const l of lines) {
        if (!l.trim()) continue;
        try { rows.push(JSON.parse(l)); } catch (_) { /* skip torn line */ }
      }
      const oldest = rows.length ? Date.parse(rows[0].ts) : NaN;
      if (start === 0 || (Number.isFinite(oldest) && oldest < sinceMs)) return rows;
      bytes = Math.min(size, bytes * 2);
    }
  } catch (_) {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

module.exports = {
  SB_COOLDOWN_WINDOW, SB_PROBE_AFTER_HOURS, SB_RUN_FAILURE_LIMIT, REDDIT_STALE_HOURS,
  sbRedditVerdict, sbRunBreakerOpen, redditStaleVerdict, readLedgerTail,
};
