/**
 * dispatch-guard-queue-audit.js — pure tally + trend logic for task #1802,
 * generalizing task #1801's predispatch-queue-audit.js pattern from ONE
 * guard (predispatch-guard's classifyCandidate) to all 8 sibling
 * dispatch-guards.js predicates named in GUARD_NAMES (dispatch-guards.js):
 * deadDispatchGuard, parkedGuard, staleOutcomeGuard, closedCardGuard,
 * workBranchCollisionGuard, exactTitleOverlapGuard, sessionTrackingCloneGuard,
 * linearMirrorGuard.
 *
 * Each guard is only ever visible one refusal at a time, at the moment a
 * single dispatch attempt hits it — there is no aggregate view across every
 * queued task, so a spike in any ONE guard (e.g. a bad Linear mirror sync
 * flagging many cards as linearMirrorGuard refusals) would go unnoticed the
 * same way the predispatch-guard backlog did before #1801.
 *
 * Second-opinion review (task #1802, 2026-08-19) rejected an earlier draft
 * that ran this as a SECOND top-level CLI script with its own launchd plist:
 * two independent `node` processes cannot share fetchCard()'s in-memory
 * result, so a second script would double Notion API load in the same
 * window instead of "reusing" anything. This module is instead consumed by
 * the EXISTING scripts/predispatch-queue-audit.js loop — one fetch pass,
 * two tallies, two snapshot files, one plist.
 *
 * Input shape: `results` is an array of one entry per queued task,
 * {taskId, guards: {<guardName>: {refusal: string|null}|null, ...}}. A
 * per-task per-guard entry of `null` (not `{refusal: ...}`) means the CLI
 * wrapper could not EXECUTE that guard for that task (the guard function
 * itself threw) — tallied separately as `error`, never folded into `ok`.
 * A guard legitimately evaluated with degraded input (e.g. card is null
 * because the Notion fetch failed) is NOT an error here — the guard itself
 * already fails open on that (see dispatch-guards.js's own header), so its
 * `{refusal: null}` result is real "ok" data, matching exactly what a live
 * bsc-next.js dispatch would see under the same outage.
 *
 * Pure functions only — no fs, no network, no clock read internally (now is
 * always passed in) — the CLI wrapper owns all I/O.
 */
'use strict';

const { GUARD_NAMES } = require('./dispatch-guards.js');

// Owner's own suggested-approach threshold from task #1801's card body,
// reused here — a meaningful jump, not the raw count, is what's alert-worthy.
const JUMP_THRESHOLD_PCT = 0.2;

// Same 5-9 day window as predispatch-queue-audit.js's findWeekAgoEntry — a
// daily cron whose runs land a few hours early/late still gets a usable
// week-ago comparator.
const WOW_MIN_AGE_MS = 5 * 24 * 3600e3;
const WOW_MAX_AGE_MS = 9 * 24 * 3600e3;

/**
 * @param {Array<{taskId?: string|number, guards?: object}|null|undefined>} results
 * @returns {{byGuard: object, blockedTasks: number, total: number}}
 *   byGuard[name] = {refused, ok, error, total}
 */
function tallyGuardRefusals(results) {
  const byGuard = {};
  for (const name of GUARD_NAMES) byGuard[name] = { refused: 0, ok: 0, error: 0, total: 0 };
  let blockedTasks = 0;
  const list = results || [];
  for (const r of list) {
    const guards = (r && r.guards) || {};
    let taskBlocked = false;
    for (const name of GUARD_NAMES) {
      const tally = byGuard[name];
      tally.total++;
      const entry = guards[name];
      if (entry === undefined || entry === null) { tally.error++; continue; }
      if (entry.refusal) { tally.refused++; taskBlocked = true; }
      else tally.ok++;
    }
    if (taskBlocked) blockedTasks++;
  }
  return { byGuard, blockedTasks, total: list.length };
}

/**
 * Pick the history entry closest to 7 days before `now`, within the
 * WOW_MIN_AGE_MS..WOW_MAX_AGE_MS window. Returns null when no entry falls in
 * that window (fresh history, or a gap in cron runs). Identical shape to
 * predispatch-queue-audit.js's findWeekAgoEntry, keyed on blockedCount.
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

function guardLabel(name) {
  // camelCase -> "Camel Case" for readable item titles, e.g.
  // "workBranchCollisionGuard" -> "Work Branch Collision".
  const base = name.replace(/Guard$/, '');
  return base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}

/**
 * @param {object} a
 * @param {Array<object>} a.results per-task guard results, see tallyGuardRefusals
 * @param {Array<{at:string, blockedCount:number}>} [a.history]
 * @param {number} [a.now] epoch ms, CLI wrapper should always pass this explicitly
 * @param {number} [a.skippedTasks] queued tasks the CLI wrapper couldn't
 *   evaluate at all (no results entry, e.g. an unexpected exception before
 *   any guard ran) — excluded from `results`/`tally`, surfaced separately so
 *   a run with real skips can't read identically to a genuinely quiet day.
 * @returns {{generatedAt:string, bannerText:string,
 *   items:Array<{title:string, detail:string}>, moreCount:number,
 *   tally:object, blockedCount:number, skippedCount:number,
 *   jump:{pctChange:number, previousCount:number, previousAt:string}|null}}
 */
function buildDispatchGuardQueueAuditSnapshot({
  results, history = [], now = Date.now(), skippedTasks = 0,
} = {}) {
  const tally = tallyGuardRefusals(results);
  const blockedCount = tally.blockedTasks;

  const weekAgo = findWeekAgoEntry(history, now);
  let jump = null;
  if (weekAgo && weekAgo.blockedCount > 0) {
    const pctChange = (blockedCount - weekAgo.blockedCount) / weekAgo.blockedCount;
    if (pctChange >= JUMP_THRESHOLD_PCT) {
      jump = { pctChange, previousCount: weekAgo.blockedCount, previousAt: weekAgo.at };
    }
  }

  const skippedSuffix = skippedTasks > 0
    ? ` [${skippedTasks} queued task${skippedTasks === 1 ? '' : 's'} not evaluated — see stderr for per-task errors]`
    : '';
  const bannerText = (jump
    ? `⚠ dispatch-guard-blocked backlog jumped to ${blockedCount} — up ${Math.round(jump.pctChange * 100)}% from ${jump.previousCount} a week ago`
    : `${blockedCount} of ${tally.total} queued card${tally.total === 1 ? '' : 's'} blocked by at least one dispatch guard`
  ) + skippedSuffix;

  const items = GUARD_NAMES
    .map((name) => ({ name, t: tally.byGuard[name] }))
    .filter(({ t }) => t.refused > 0 || t.error > 0)
    .sort((a, b) => b.t.refused - a.t.refused)
    .map(({ name, t }) => ({
      title: guardLabel(name),
      detail: t.error > 0 ? `${t.refused} refused, ${t.error} not evaluated` : `${t.refused} refused`,
    }));

  if (!items.length) {
    items.push({ title: 'All guards clear', detail: `0 of ${tally.total} queued cards blocked` });
  }

  return {
    generatedAt: new Date(now).toISOString(),
    bannerText,
    items,
    moreCount: 0,
    tally,
    blockedCount,
    skippedCount: skippedTasks,
    jump,
  };
}

module.exports = {
  tallyGuardRefusals, findWeekAgoEntry, buildDispatchGuardQueueAuditSnapshot, guardLabel,
  JUMP_THRESHOLD_PCT, WOW_MIN_AGE_MS, WOW_MAX_AGE_MS, GUARD_NAMES,
};
