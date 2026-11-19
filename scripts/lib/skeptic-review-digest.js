#!/usr/bin/env node
// scripts/lib/skeptic-review-digest.js — counts + digest row for the skeptic reviewer (BRO-7839, wired by BRO-7843).
//
// The Stop gate (scripts/lib/skeptic-review-stop.mjs) logs every decision to .cache/skeptic-review-stop.log.
// This pure CJS module counts those rows (the .mjs `--digest` delegates here) and renders the one row
// scripts/health-check.js (checkSkepticReview) puts in the daily digest. No fs, no clock (CLAUDE.md §15).
'use strict';

/** PURE. Counts over decision-log rows. */
function countSkepticRows(rows) {
  const out = { reviews: 0, blocked: 0, passed: 0, wouldBlock: 0, bypass: 0, errors: 0 };
  const sessions = new Set();
  for (const r of rows || []) {
    if (!r) continue;
    if (r.session) sessions.add(r.session);
    if (r.outcome === 'bypass') out.bypass++;
    else if (r.outcome === 'error') out.errors++;
    else if (r.outcome === 'pass') { out.reviews++; out.passed++; }
    else if (r.outcome === 'block') { out.reviews++; out.blocked++; }
    else if (r.outcome === 'over-budget') { out.reviews++; out.wouldBlock++; }
  }
  return { ...out, sessions: sessions.size };
}

/** PURE. Daily-digest row from the counts. Never 'error' (non-paging telemetry, same policy as infra-review). */
function computeSkepticReviewDigest(rows) {
  const d = countSkepticRows(rows);
  const message = `Skeptic review: ${d.reviews} reviews (${d.passed} passed, ${d.blocked} blocked, ${d.wouldBlock} would-block over budget), `
    + `${d.bypass} bypasses, ${d.errors} errors, ${d.sessions} sessions`;
  const status = d.errors > 0 && d.errors >= d.reviews ? 'warn' : 'pass';
  return { name: 'Skeptic review: gate telemetry', status, message, ...d };
}

module.exports = { countSkepticRows, computeSkepticReviewDigest };
