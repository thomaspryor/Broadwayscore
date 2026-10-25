'use strict';

/**
 * priority-queue-health.js — the OUTCOME number for the P0/P1 queue
 * (BRO-4487): how many Urgent/High issues are open, and how old they are.
 *
 * WHY THIS EXISTS. Between 2026-08-26 and 2026-10-01 the open P0/P1 pile
 * grew from ~700 to 907 while ~25 sessions each "fixed the drain". Every
 * one of those fixes measured the machinery's own activity (claims,
 * dispatches, ledger freshness, Done/day across all priorities); nothing
 * measured whether P0s were being handled within a day and P1s within a
 * week. This module is that measurement and nothing else.
 *
 * Counting rules, each one a lesson from the 2026-10-01 audit:
 *   - Priority comes from linear-watchdog-source.js's priorityOf(), not the
 *     raw field: an unset field with a "P0:"/"P1:" title is treated as
 *     P0/P1 by the dispatcher, so it must be counted the same way here.
 *   - Archived issues are excluded (the caller queries without
 *     includeArchived): 159 archived-but-Backlog canary issues once inflated
 *     the count by 17%.
 *   - The total open count across ALL priorities is reported next to the
 *     P0/P1 numbers. Demoting a card improves the P0/P1 numbers without
 *     doing any work; it does not change the total, so a "fix" that only
 *     relabels shows up as a flat total.
 *
 * Pure: no fs, no clock, no network. The CLI (check-priority-queue-health.js)
 * fetches and passes `now`.
 */

const { priorityOf } = require('./linear-watchdog-source.js');
const { isTerminalStateType } = require('./linear-state-types.js');

const HOUR_MS = 60 * 60 * 1000;
// Owner rule 2026-10-01: "P1s should get addressed quickly, and P0s immediately."
const P0_MAX_AGE_HOURS = 24;
const P1_MAX_AGE_HOURS = 7 * 24;

function ageHours(issue, now) {
  const created = Date.parse(issue && issue.createdAt);
  return Number.isFinite(created) ? (now - created) / HOUR_MS : 0;
}

/**
 * @param {Array<{identifier:string,title:string,priority:number,createdAt:string,state:{type:string}}>} issues
 *   non-archived issues (any state; terminal ones are ignored here)
 * @param {number} now epoch ms
 */
function assessPriorityQueue(issues, now) {
  const open = (issues || []).filter((i) => i && !isTerminalStateType(i.state && i.state.type));
  const p0 = [];
  const p1 = [];
  for (const issue of open) {
    const p = priorityOf(issue);
    if (p === 'P0') p0.push(issue);
    else if (p === 'P1') p1.push(issue);
  }
  const byAgeDesc = (a, b) => ageHours(b, now) - ageHours(a, now);
  p0.sort(byAgeDesc);
  p1.sort(byAgeDesc);
  const p0Overdue = p0.filter((i) => ageHours(i, now) > P0_MAX_AGE_HOURS);
  const p1Overdue = p1.filter((i) => ageHours(i, now) > P1_MAX_AGE_HOURS);
  return {
    totalOpen: open.length,
    p0Open: p0.length,
    p1Open: p1.length,
    oldestP0Hours: p0.length ? Math.round(ageHours(p0[0], now)) : null,
    p0Overdue: p0Overdue.length,
    p1Overdue: p1Overdue.length,
    healthy: p0Overdue.length === 0 && p1Overdue.length === 0,
    oldestP0: p0Overdue.slice(0, 10).map((i) => ({ identifier: i.identifier, title: i.title, ageHours: Math.round(ageHours(i, now)) })),
  };
}

/** One plain-English line for the digest / job summary. */
function formatSummary(r) {
  const p0Part = r.p0Open
    ? `${r.p0Open} P0 open (${r.p0Overdue} older than ${P0_MAX_AGE_HOURS}h, oldest ${Math.round(r.oldestP0Hours / 24)}d)`
    : '0 P0 open';
  return `${p0Part}; ${r.p1Open} P1 open (${r.p1Overdue} older than 7d); ${r.totalOpen} open issues of any priority.`;
}

// BRO-4510: started-zombie sweep leftovers. A card the sweep could not decide
// (no safe VERIFY, unrunnable VERIFY, first FAIL strike, or a refusal) needs a
// person; its LATEST ledger row says why. A later card-pass clears it, and
// `openIdentifiers` (the cards still open on the board) drops resolved ones.
function summarizeZombieLeftovers(ledgerRows, openIdentifiers) {
  const latest = new Map();
  for (const r of ledgerRows || []) {
    if (!r || !r.cardId || !r.ts) continue;
    const prev = latest.get(r.cardId);
    if (!prev || r.ts >= prev.ts) latest.set(r.cardId, r);
  }
  const open = openIdentifiers ? new Set(openIdentifiers) : null;
  const stuck = [...latest.values()].filter((r) => r.event !== 'card-pass' && (!open || open.has(r.cardId)));
  const byReason = {};
  for (const r of stuck) byReason[r.reason || r.event] = (byReason[r.reason || r.event] || 0) + 1;
  return { count: stuck.length, byReason, cards: stuck.map((r) => r.cardId).sort() };
}

function formatZombieLeftovers(s) {
  if (!s.count) return 'Started-zombie sweep: no cards left undecided.';
  const reasons = Object.entries(s.byReason).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
  return `Started-zombie sweep: ${s.count} cards left for a person (${reasons}): ${s.cards.slice(0, 8).join(', ')}${s.cards.length > 8 ? ', ...' : ''}`;
}

module.exports = { assessPriorityQueue, formatSummary, summarizeZombieLeftovers, formatZombieLeftovers, P0_MAX_AGE_HOURS, P1_MAX_AGE_HOURS };
