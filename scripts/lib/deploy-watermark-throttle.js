#!/usr/bin/env node
'use strict';

/**
 * Decides whether vercel-deploy.yml should skip dispatching
 * update-deploy-watermark.yml for this deploy.
 *
 * update-deploy-watermark.yml used to fire on EVERY successful deploy
 * (~121 commits/day to data/audit/deploy-watermark.json +
 * data/audit/stage-latency.jsonl), starving other jobs' pushes to main
 * (BRO-2983). This throttles the dispatch to at most once per
 * intervalMinutes, mirroring should-deploy-gate.js's staleness-tolerant
 * design: skip only on POSITIVE proof the watermark is fresh, fail OPEN
 * (dispatch) on anything ambiguous — missing field, unparseable date, a
 * future/negative age from clock skew — so a parsing bug can never
 * silently suppress the watermark forever. A wrongly-skipped dispatch is
 * silent staleness; a wrongly-run one costs one extra cheap workflow run.
 */

/**
 * @param {object} a
 * @param {string} a.updatedAtRaw  deploy-watermark.json's updatedAt field (ISO-8601), or '' / undefined
 * @param {number} a.nowMs         Date.now()
 * @param {number} a.intervalMinutes  throttle floor in minutes
 * @returns {{skip: boolean, reason: string, ageMinutes: number|null}}
 */
function shouldSkipWatermarkDispatch({ updatedAtRaw, nowMs, intervalMinutes }) {
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
    return { skip: true, reason: `watermark is ${ageMinutes.toFixed(1)}min old (< ${intervalMinutes}min floor)`, ageMinutes };
  }

  return { skip: false, reason: `watermark is ${ageMinutes.toFixed(1)}min old (>= ${intervalMinutes}min floor)`, ageMinutes };
}

module.exports = { shouldSkipWatermarkDispatch };
