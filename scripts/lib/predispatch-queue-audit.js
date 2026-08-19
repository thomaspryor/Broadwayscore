/**
 * predispatch-queue-audit.js — pure tally + trend logic for task #1801.
 *
 * predispatch-guard.js (task #1800) now refuses to auto-dispatch any card
 * classifyCandidate marks REOPEN-SUSPECT or DO-NOT-DISPATCH. That's correct,
 * but the backlog of blocked cards was only visible one at a time, as each
 * got an individual dispatch attempt and refusal — nobody could see the
 * aggregate, so a reconcile-dead-completions misfire (it legitimately
 * reopens completed cards every 6h, see launchd job
 * com.broadwayscore.reconcile-dead-completions) would go unnoticed until
 * sessions individually tripped over the refusals.
 *
 * This module takes an array of classifyCandidate() results plus a small
 * history of past runs and produces the digest snapshot shape
 * ({generatedAt, bannerText, items, moreCount}) renderNamedDigestBlock
 * already knows how to render (scripts/lib/autonomous-email-render.js) — no
 * new render code needed, matching every other named digest
 * (scripts/lib/digest-snapshots.js).
 *
 * Pure functions only — no fs, no network, no clock read internally (now is
 * always passed in) — the CLI wrapper (scripts/predispatch-queue-audit.js)
 * owns all I/O: reading the local task mirror, calling notion-brain.js get,
 * loading/writing the history + snapshot files.
 */
'use strict';

const VERDICTS = ['OK-TO-DISPATCH', 'CHECK-FIRST', 'REOPEN-SUSPECT', 'DO-NOT-DISPATCH'];

// Owner's own suggested-approach threshold ("alert only on a meaningful
// jump ... not on the raw count — 30-ish is apparently normal steady-state",
// task #1801 card body).
const JUMP_THRESHOLD_PCT = 0.2;

// A week-over-week comparator only makes sense if the history entry is
// actually roughly a week old — comparing against yesterday's run (if the
// producer runs more than once a day) would trigger on ordinary day-to-day
// noise, not a real spike. Widened to 5-9 days so a daily cron (some runs
// land a few hours early/late) always has a usable comparator once a week
// of history exists.
const WOW_MIN_AGE_MS = 5 * 24 * 3600e3;
const WOW_MAX_AGE_MS = 9 * 24 * 3600e3;

/**
 * @param {Array<{verdict?: string}|null|undefined>} classifications results
 *   from repeated classifyCandidate() calls (scripts/lib/predispatch-guard.js)
 * @returns {{'OK-TO-DISPATCH':number,'CHECK-FIRST':number,
 *   'REOPEN-SUSPECT':number,'DO-NOT-DISPATCH':number, unresolved:number,
 *   total:number}}
 */
function tallyVerdicts(classifications) {
  const tally = { 'OK-TO-DISPATCH': 0, 'CHECK-FIRST': 0, 'REOPEN-SUSPECT': 0, 'DO-NOT-DISPATCH': 0, unresolved: 0, total: 0 };
  for (const c of classifications || []) {
    tally.total++;
    const v = c && c.verdict;
    if (VERDICTS.includes(v)) tally[v]++;
    else tally.unresolved++;
  }
  return tally;
}

/**
 * Pick the history entry closest to 7 days before `now`, within the
 * WOW_MIN_AGE_MS..WOW_MAX_AGE_MS window. Returns null when no entry falls in
 * that window (fresh history, or a gap in cron runs).
 * @param {Array<{at:string, blockedCount:number}>} history
 * @param {number} now epoch ms
 */
function findWeekAgoEntry(history, now) {
  if (!Array.isArray(history) || !history.length) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const h of history) {
    if (!h || typeof h.at !== 'string' || typeof h.blockedCount !== 'number') continue;
    const t = new Date(h.at).getTime();
    if (!Number.isFinite(t)) continue;
    const age = now - t;
    if (age < WOW_MIN_AGE_MS || age > WOW_MAX_AGE_MS) continue;
    const diff = Math.abs(age - 7 * 24 * 3600e3);
    if (diff < bestDiff) { bestDiff = diff; best = h; }
  }
  return best;
}

/**
 * @param {object} a
 * @param {Array<{verdict?: string}|null|undefined>} a.classifications
 * @param {Array<{at:string, blockedCount:number}>} [a.history] past runs,
 *   oldest-first or any order — findWeekAgoEntry scans all of them
 * @param {number} [a.now] epoch ms, defaults to Date.now() (CLI wrapper
 *   should always pass this explicitly so the module stays pure/testable)
 * @returns {{generatedAt:string, bannerText:string,
 *   items:Array<{title:string, detail:string}>, moreCount:number,
 *   tally:object, blockedCount:number,
 *   jump:{pctChange:number, previousCount:number, previousAt:string}|null}}
 */
function buildQueueAuditSnapshot({ classifications, history = [], now = Date.now() } = {}) {
  const tally = tallyVerdicts(classifications);
  const blockedCount = tally['REOPEN-SUSPECT'] + tally['DO-NOT-DISPATCH'];

  const weekAgo = findWeekAgoEntry(history, now);
  let jump = null;
  if (weekAgo && weekAgo.blockedCount > 0) {
    const pctChange = (blockedCount - weekAgo.blockedCount) / weekAgo.blockedCount;
    if (pctChange >= JUMP_THRESHOLD_PCT) {
      jump = { pctChange, previousCount: weekAgo.blockedCount, previousAt: weekAgo.at };
    }
  }

  const bannerText = jump
    ? `⚠ blocked backlog jumped to ${blockedCount} (${tally['REOPEN-SUSPECT']} reopen-suspect, ${tally['DO-NOT-DISPATCH']} do-not-dispatch) — up ${Math.round(jump.pctChange * 100)}% from ${jump.previousCount} a week ago`
    : `${blockedCount} of ${tally.total} queued card${tally.total === 1 ? '' : 's'} blocked from auto-dispatch (${tally['REOPEN-SUSPECT']} reopen-suspect, ${tally['DO-NOT-DISPATCH']} do-not-dispatch)`;

  return {
    generatedAt: new Date(now).toISOString(),
    bannerText,
    items: [
      { title: 'OK-TO-DISPATCH', detail: String(tally['OK-TO-DISPATCH']) },
      { title: 'CHECK-FIRST', detail: String(tally['CHECK-FIRST']) },
      { title: 'REOPEN-SUSPECT', detail: String(tally['REOPEN-SUSPECT']) },
      { title: 'DO-NOT-DISPATCH', detail: String(tally['DO-NOT-DISPATCH']) },
    ],
    moreCount: 0,
    tally,
    blockedCount,
    jump,
  };
}

module.exports = {
  tallyVerdicts, findWeekAgoEntry, buildQueueAuditSnapshot,
  JUMP_THRESHOLD_PCT, WOW_MIN_AGE_MS, WOW_MAX_AGE_MS, VERDICTS,
};
