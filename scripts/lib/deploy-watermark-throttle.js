#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

// Rebuilds also update the watermark. Only a recorded global deployment proves
// that this workflow has recently emitted its telemetry.
function hasRecentDeploy(logFile, nowMs, intervalMinutes) {
  let fd;
  try {
    fd = fs.openSync(logFile, 'r');
    let pos = fs.fstatSync(fd).size;
    let suffix = '';
    while (pos > 0) {
      const size = Math.min(pos, 65536);
      pos -= size;
      const buf = Buffer.alloc(size);
      const count = fs.readSync(fd, buf, 0, size, pos);
      const lines = (buf.subarray(0, count).toString('utf8') + suffix).split('\n');
      suffix = pos ? lines.shift() : '';
      for (const line of lines) {
        if (!line.includes('"deployed-live"')) continue;
        try {
          const event = JSON.parse(line);
          const age = nowMs - Date.parse(event.at);
          if (event.stage === 'deployed-live' && !event.showId && !event.reviewKey && age >= 0 && age < intervalMinutes * 60000) return true;
        } catch { /* Ignore malformed lines. */ }
      }
    }
  } catch { /* Missing or unreadable telemetry must fail open. */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return false;
}

/**
 * Decides whether update-deploy-watermark.yml should skip its write.
 *
 * update-deploy-watermark.yml used to fire on EVERY successful deploy
 * (~121 commits/day to data/audit/deploy-watermark.json +
 * data/audit/stage-latency.jsonl), starving other jobs' pushes to main
 * (BRO-2983). This throttles writes to at most once per
 * intervalMinutes, mirroring should-deploy-gate.js's staleness-tolerant
 * design: skip only on POSITIVE proof the watermark is fresh, fail OPEN
 * (dispatch) on anything ambiguous — missing field, unparseable date, a
 * future/negative age from clock skew — so a parsing bug can never
 * silently suppress the watermark forever. A fresh deploy event is also
 * required because rebuilds can refresh the watermark independently.
 * A wrongly-skipped write is
 * silent staleness; a wrongly-run one costs one extra cheap workflow run.
 */

/**
 * @param {object} a
 * @param {string} a.updatedAtRaw  deploy-watermark.json's updatedAt field (ISO-8601), or '' / undefined
 * @param {number} a.nowMs         Date.now()
 * @param {number} a.intervalMinutes  throttle floor in minutes
 * @param {string} [a.logFile]       stage-latency log path
 * @returns {{skip: boolean, reason: string, ageMinutes: number|null}}
 */
function shouldSkipWatermarkDispatch({ updatedAtRaw, nowMs, intervalMinutes, logFile = path.join(__dirname, '../../data/audit/stage-latency.jsonl') }) {
  if (!updatedAtRaw) {
    return { skip: false, reason: 'no prior watermark timestamp — dispatching', ageMinutes: null };
  }

  const updatedAtMs = Date.parse(updatedAtRaw);
  if (!Number.isFinite(updatedAtMs)) {
    return { skip: false, reason: `unparseable updatedAt (${JSON.stringify(updatedAtRaw)}) — failing open`, ageMinutes: null };
  }

  const ageMinutes = (nowMs - updatedAtMs) / 60000;
  if (!Number.isFinite(ageMinutes) || ageMinutes < 0) {
    // Future timestamp (clock skew) — ambiguous, fail open rather than skip.
    return { skip: false, reason: `non-positive age (${ageMinutes}min) — failing open`, ageMinutes };
  }

  if (ageMinutes < intervalMinutes) {
    if (!hasRecentDeploy(logFile, nowMs, intervalMinutes)) {
      return { skip: false, reason: 'no recent global deployment telemetry — failing open', ageMinutes };
    }
    return { skip: true, reason: `watermark is ${ageMinutes.toFixed(1)}min old (< ${intervalMinutes}min floor)`, ageMinutes };
  }

  return { skip: false, reason: `watermark is ${ageMinutes.toFixed(1)}min old (>= ${intervalMinutes}min floor)`, ageMinutes };
}

module.exports = { shouldSkipWatermarkDispatch };
