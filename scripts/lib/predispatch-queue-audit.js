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

// Only these two verdicts represent cards actually blocked from
// auto-dispatch — the ones task #1803 exists to name (previously the digest
// only showed a 4-bucket tally, with no way to tell WHICH cards were stuck
// without running --dry-run by hand).
const BLOCKED_VERDICTS = ['REOPEN-SUSPECT', 'DO-NOT-DISPATCH'];
const DEFAULT_MAX_ITEMS = 8;

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
 * @param {Array<{verdict?: string, name?: string, id?: string}|null|undefined>} a.classifications
 *   classifyCandidate() results — `id` (the task mirror id, e.g. "1803") is
 *   optional and attached by the CLI wrapper since classifyCandidate itself
 *   doesn't know the task id, only the card
 * @param {Array<{at:string, blockedCount:number}>} [a.history] past runs,
 *   oldest-first or any order — findWeekAgoEntry scans all of them
 * @param {number} [a.now] epoch ms, defaults to Date.now() (CLI wrapper
 *   should always pass this explicitly so the module stays pure/testable)
 * @param {number} [a.skippedNoUuid] queued tasks the CLI wrapper couldn't
 *   resolve a Notion id for — excluded from `classifications`/`tally`
 * @param {number} [a.fetchErrors] cards the CLI wrapper failed to
 *   fetch/classify (Notion API error, timeout) — also excluded. Both counts
 *   are surfaced in bannerText/items (ship-check adversarial finding): a run
 *   with real skips must not read identically to a genuinely quiet day, or
 *   the blocked-count banner silently understates the true backlog.
 * @param {number} [a.maxItems] cap on named blocked-card rows in `items`
 *   (task #1803) — same truncate-and-count pattern as
 *   digest-snapshots.js's summarizeFreshnessHighSeverity
 * @returns {{generatedAt:string, bannerText:string,
 *   items:Array<{title:string, detail:string}>, moreCount:number,
 *   tally:object, blockedCount:number, skippedCount:number,
 *   jump:{pctChange:number, previousCount:number, previousAt:string}|null}}
 */
function buildQueueAuditSnapshot({
  classifications, history = [], now = Date.now(), skippedNoUuid = 0, fetchErrors = 0,
  maxItems = DEFAULT_MAX_ITEMS,
} = {}) {
  const tally = tallyVerdicts(classifications);
  const blockedCount = tally['REOPEN-SUSPECT'] + tally['DO-NOT-DISPATCH'];
  const skippedCount = skippedNoUuid + fetchErrors;

  const weekAgo = findWeekAgoEntry(history, now);
  let jump = null;
  if (weekAgo && weekAgo.blockedCount > 0) {
    const pctChange = (blockedCount - weekAgo.blockedCount) / weekAgo.blockedCount;
    if (pctChange >= JUMP_THRESHOLD_PCT) {
      jump = { pctChange, previousCount: weekAgo.blockedCount, previousAt: weekAgo.at };
    }
  }

  const skippedSuffix = skippedCount > 0
    ? ` [${skippedCount} queued task${skippedCount === 1 ? '' : 's'} not counted — ${skippedNoUuid} no Notion id, ${fetchErrors} fetch/classify error]`
    : '';
  // The 4-bucket tally still matters (task #1801's original aggregate
  // signal) — reopen-suspect/do-not-dispatch are already in the lead
  // clause below, so only ok-to-dispatch/check-first need folding in here
  // to keep the full breakdown in bannerText without duplicating counts.
  const tallyFooter = ` · ${tally['OK-TO-DISPATCH']} ok-to-dispatch, ${tally['CHECK-FIRST']} check-first`;
  const bannerText = (jump
    ? `⚠ blocked backlog jumped to ${blockedCount} (${tally['REOPEN-SUSPECT']} reopen-suspect, ${tally['DO-NOT-DISPATCH']} do-not-dispatch) — up ${Math.round(jump.pctChange * 100)}% from ${jump.previousCount} a week ago`
    : `${blockedCount} of ${tally.total} queued card${tally.total === 1 ? '' : 's'} blocked from auto-dispatch (${tally['REOPEN-SUSPECT']} reopen-suspect, ${tally['DO-NOT-DISPATCH']} do-not-dispatch)`
  ) + tallyFooter + skippedSuffix;

  // Named blocked-card items (task #1803): REOPEN-SUSPECT first — it's the
  // anomalous signal (a completed card reopened without explanation) the
  // owner most needs to see; DO-NOT-DISPATCH is usually just terminal-status
  // noise. Array#sort is stable, so relative order within each verdict group
  // is preserved.
  const blockedCards = (classifications || []).filter((c) => c && BLOCKED_VERDICTS.includes(c.verdict));
  blockedCards.sort((a, b) => {
    if (a.verdict === b.verdict) return 0;
    return a.verdict === 'REOPEN-SUSPECT' ? -1 : 1;
  });
  const items = blockedCards.slice(0, maxItems).map((c) => ({
    title: c.name ? String(c.name) : (c.id ? `#${c.id}` : '(untitled card)'),
    detail: `${c.id ? `#${c.id} — ` : ''}${c.verdict}`,
  }));
  const moreCount = Math.max(0, blockedCards.length - items.length);
  if (skippedCount > 0) {
    items.push({ title: 'NOT COUNTED', detail: `${skippedCount} (${skippedNoUuid} no id, ${fetchErrors} fetch error)` });
  }
  // classifyCandidate() only ever returns the 4 VERDICTS above (a closed
  // set) — tally.unresolved should always be 0. Surfacing it when it isn't
  // is a canary: if a future verdict is ever added upstream, this line goes
  // from dead code to the one signal that blockedCount/items silently
  // stopped accounting for the new verdict (ship-check adversarial finding).
  if (tally.unresolved > 0) {
    items.push({ title: 'UNRECOGNIZED VERDICT', detail: `${tally.unresolved} — classifyCandidate returned an unknown verdict string; predispatch-queue-audit.js's VERDICTS list is stale` });
  }

  return {
    generatedAt: new Date(now).toISOString(),
    bannerText,
    items,
    moreCount,
    tally,
    blockedCount,
    skippedCount,
    jump,
  };
}

module.exports = {
  tallyVerdicts, findWeekAgoEntry, buildQueueAuditSnapshot,
  JUMP_THRESHOLD_PCT, WOW_MIN_AGE_MS, WOW_MAX_AGE_MS, VERDICTS,
  BLOCKED_VERDICTS, DEFAULT_MAX_ITEMS,
};
