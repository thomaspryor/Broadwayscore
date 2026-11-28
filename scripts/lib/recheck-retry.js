'use strict';
/**
 * recheck-retry.js — Done cards whose last recheck had NO verdict get re-run
 * on later nights instead of never (BRO-7559).
 *
 * A Done card is a recheck target only inside its completion window, so one
 * "unverifiable" row (test not landed yet, run out of budget, alert ledger not
 * caught up) was the card's final word. On 2026-11-15, 52 Done cards sat on
 * such a row; 9 of their tests had landed since and passed, and 5 alert
 * checks that once exited 3 passed too.
 *
 * Classification reads the structured `cause` field the recheck now writes;
 * rows written before it existed are matched by LEGACY_CAUSE_RES, the one place
 * old prose is parsed.
 */

const DAY_MS = 24 * 3600 * 1000;

// Causes worth another try, and where. 'timeout' needs a run with real budget
// (the --backlog sweep), never the 5-minute nightly one (second-opinion finding).
const NIGHTLY_RETRY_CAUSES = new Set(['missing-path', 'exit3', 'deferred']);
const BACKLOG_RETRY_CAUSES = new Set(['missing-path', 'exit3', 'timeout', 'deferred']);

const LEGACY_CAUSE_RES = [
  ['missing-path', /names a path absent from this checkout|^check is stale: .* is not on main/],
  // A key no CI ledger ever receives (Mac-only alerts) will never resolve here.
  ['exit3-no-ledger', /exited 3 .*is in no alert ledger/],
  ['exit3', /check exited 3\b/],
  ['timeout', /killed by SIG[A-Z]+ after \d+ms/],
  ['whole-suite', /^check is the whole unit suite/],
];

function causeOfRecheckRow(row) {
  if (!row) return null;
  if (row.cause) return row.cause;
  if (row.status !== 'unverifiable') return null;
  const d = String(row.detail || '');
  for (const [cause, re] of LEGACY_CAUSE_RES) if (re.test(d)) return cause;
  return null;
}

/**
 * @param {object[]} entries - recheck ledger rows
 * @param {{now?:number, maxAgeDays?:number, maxAttempts?:number, limit?:number, backlog?:boolean, exclude?:Set<string>}} [o]
 * @returns {string[]} card ids, longest-waiting first
 */
function retryCandidateIds(entries, o = {}) {
  const now = o.now ?? Date.now();
  const maxAgeDays = o.maxAgeDays ?? 45;
  const maxAttempts = o.maxAttempts ?? 4;
  const limit = o.limit ?? 6;
  const causes = o.backlog ? BACKLOG_RETRY_CAUSES : NIGHTLY_RETRY_CAUSES;
  const exclude = o.exclude || new Set();

  const byCard = new Map();
  // A run that hit its budget names the cards it never reached (cardIds on
  // the 'recheck-deferred' row): each counts as a no-verdict attempt.
  const rows = [];
  for (const e of entries || []) {
    if (e && e.event === 'recheck-deferred' && Array.isArray(e.cardIds)) {
      for (const id of e.cardIds) rows.push({ event: 'recheck', cardId: id, ts: e.ts, status: 'unverifiable', cause: 'deferred' });
    } else rows.push(e);
  }
  for (const e of rows) {
    if (!e || e.event !== 'recheck' || !e.cardId) continue;
    const t = Date.parse(e.ts || '');
    if (!Number.isFinite(t)) continue;
    const s = byCard.get(e.cardId) || { first: t, last: null, lastTs: -Infinity, attempts: 0 };
    s.first = Math.min(s.first, t);
    if (e.status === 'unverifiable') s.attempts++;
    if (t >= s.lastTs) { s.last = e; s.lastTs = t; }
    byCard.set(e.cardId, s);
  }
  const out = [];
  for (const [id, s] of byCard) {
    if (exclude.has(id)) continue;
    if (!s.last || s.last.status !== 'unverifiable') continue;
    if (!causes.has(causeOfRecheckRow(s.last))) continue;
    if (s.attempts >= maxAttempts) continue;
    if (now - s.first > maxAgeDays * DAY_MS) continue;
    // Not twice in one day: the evidence it waits on moves daily at most.
    if (now - s.lastTs < 20 * 3600 * 1000) continue;
    out.push({ id, lastTs: s.lastTs });
  }
  out.sort((a, b) => a.lastTs - b.lastTs);
  return out.slice(0, limit).map((x) => x.id);
}

// A retry fetches cards by id, so one may have been reopened since its last
// recheck. Only a card still Done is a done claim; re-checking a reopened one
// would report a failure against work someone is doing.
function stillDoneCards(cards) {
  return (cards || []).filter((c) => c && c.status === 'Done');
}

module.exports = { causeOfRecheckRow, retryCandidateIds, stillDoneCards, NIGHTLY_RETRY_CAUSES, BACKLOG_RETRY_CAUSES, LEGACY_CAUSE_RES };
