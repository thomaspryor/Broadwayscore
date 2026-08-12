#!/usr/bin/env node
// scripts/lib/infra-review-digest.js — turn the infra-review gate's two
// ledgers into one digest row.
//
// Card #1095: the #1079 gate (scripts/lib/infra-review-scope.js,
// ~/.claude/hooks/infra-plan-review-gate.sh) writes every warn/block to
// data/audit/infra-review-gate.jsonl — gitignored, per-machine, read by
// nothing. A session that ran a real /plan-review and one that typed
// "NO-PLAN-REVIEW: whatever" both look like silence from the owner's side.
// Card #672 named the honest observable: the ratio of real pre-implementation
// reviews (phase:'plan' verdicts in .claude/review-verdicts.jsonl) to
// bypasses. This module computes that ratio; scripts/health-check.js wires it
// into the daily digest.
//
// Pure function only — no fs, no clock (CLAUDE.md rule 15: tested by
// require()-ing this, not by copying the logic into the test).

'use strict';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function parseTs(ts) {
  const t = Date.parse(ts || '');
  return Number.isFinite(t) ? t : null;
}

function inWindow(ts, now, windowMs) {
  const t = parseTs(ts);
  return t !== null && t <= now && now - t <= windowMs;
}

/**
 * @param {object}   a
 * @param {object[]} a.gateEvents    parsed lines of data/audit/infra-review-gate.jsonl
 *                                   ({ts, action, gated, tier, reason, matched})
 * @param {object[]} a.planVerdicts  parsed lines of .claude/review-verdicts.jsonl
 *                                   (only phase:'plan' entries matter here)
 * @param {number}   a.now           Date.now()
 * @param {number}   a.windowMs      trailing window, default 7 days
 * @returns {{name:string, status:'pass'|'warn', message:string, hint?:string,
 *            gatedEdits:number, critical:number, shared:number, blocked:number,
 *            bypassed:number, failOpened:number, coveredByVerdict:number,
 *            byReviewer:Object<string,number>, restructureEscalations:number}}
 */
function computeInfraReviewDigest({
  gateEvents = [],
  planVerdicts = [],
  now = 0,
  windowMs = WINDOW_MS,
} = {}) {
  const events = (gateEvents || []).filter((e) => e && inWindow(e.ts, now, windowMs));
  const critical = events.filter((e) => e.tier === 'critical');
  const shared = events.filter((e) => e.tier === 'shared');
  const blocked = events.filter((e) => e.action === 'block');
  // Matches infra-review-scope.js's two warn-tier reasons verbatim (bypass /
  // fail-open-after-N-blocks) — see evaluateInfraReviewGate().
  const bypassed = events.filter((e) => e.action === 'warn' && /^NO-PLAN-REVIEW\b/.test(e.reason || ''));
  const failOpened = events.filter((e) => e.action === 'warn' && /^blocked \d+x already\b/.test(e.reason || ''));

  const verdicts = (planVerdicts || []).filter(
    (v) => v && v.phase === 'plan' && v.result === 'pass' && inWindow(v.ts, now, windowMs)
  );
  const byReviewer = {};
  for (const v of verdicts) {
    const key = v.reviewer || 'unknown';
    byReviewer[key] = (byReviewer[key] || 0) + 1;
  }
  const coveredByVerdict = verdicts.length;

  // Task #1218: plan-review.md's "restructure-the-ramp" escalation and
  // second-opinion.md's "Part 0 framing" check both stamp a fired escalation
  // as `note: "restructure-flag: <adopted|dismissed> — <one line>"` (a prefix
  // on the existing note field, not a new schema field — a solo boolean can't
  // distinguish "the plan's scope actually shrank" from "the question got
  // asked and dismissed," which is the exact failure this card exists to fix).
  const restructureEscalations = verdicts.filter((v) => /^restructure-flag:/.test(v.note || '')).length;

  // The incentive-failure signal the /plan-review reviewers predicted before
  // the gate shipped: if sessions are bypassing more than they are actually
  // reviewing, the policy is being routed around, not followed.
  const bypassExceedsReviews = bypassed.length > coveredByVerdict;
  const status = bypassExceedsReviews ? 'warn' : 'pass';

  // "gated" not "total": a critical-tier edit already covered by a fresh plan
  // verdict resolves to action='allow' and is never written to the ledger at
  // all (infra-plan-review-gate.sh only logs warn/block) — this count is the
  // gate's own visibility into itself, not full edit volume.
  const message = events.length === 0 && coveredByVerdict === 0
    ? 'No shared-infra edits or plan-phase reviews recorded in the trailing 7d'
    : `${events.length} shared-infra edit(s) gated (${critical.length} critical, ${shared.length} shared) — `
      + `${blocked.length} blocked, ${bypassed.length} bypassed, ${failOpened.length} failed open on the repeat-block valve; `
      + `${coveredByVerdict} real pre-implementation review(s) recorded`
      + (bypassExceedsReviews ? ' — BYPASSES EXCEED REAL REVIEWS' : '');

  return {
    name: 'Infra-review: gate telemetry',
    status,
    message,
    ...(bypassExceedsReviews
      ? { hint: 'Sessions are routing around the plan-review gate more than using it — see data/audit/infra-review-gate.jsonl and .claude/review-verdicts.jsonl (phase=plan)' }
      : {}),
    gatedEdits: events.length,
    critical: critical.length,
    shared: shared.length,
    blocked: blocked.length,
    bypassed: bypassed.length,
    failOpened: failOpened.length,
    coveredByVerdict,
    byReviewer,
    restructureEscalations,
  };
}

module.exports = { computeInfraReviewDigest, WINDOW_MS };
