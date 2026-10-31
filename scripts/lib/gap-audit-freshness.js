/**
 * gap-audit-freshness.js
 *
 * Checkpoint freshness + ordering policy for audit-show-review-gap.js.
 *
 * Why this exists (2026-07-14, The Whoopi Monologues incident): the hourly
 * gap-audit cron grinds a 3-year back-catalogue (~126 due targets) under an
 * 18-min budget, ordered least-recently-audited first. A show that opened
 * TODAY sat behind three days of backlog — its missing NYT review (cited by
 * the BWW roundup) was never auto-ingested. Opening-week shows are exactly
 * where reviews land hour-by-hour and where the score is publicly quoted,
 * so they must (a) re-audit on every hourly run and (b) sort ahead of the
 * back-catalogue grind.
 */

const { inOpeningWindow } = require('./gap-reference-sources');
const { showRecencyKey } = require('./collection-priority');
const { SLOW_MARKETS, SLOW_MARKET_ALERT_DAYS } = require('./slow-market-gap');

// Shows opened within the last 7 days sort ahead of the back-catalogue grind.
const OPENING_PRIORITY_WINDOW_DAYS = 7;
// Tiered freshness bounds the hourly cost so a busy opening week can't invert
// the starvation and eat the whole budget: only shows opened in the last 2
// days (typically 0-4 shows, where reviews land hour-by-hour) re-audit every
// run; days 3-7 re-check every 3h (late reviews, corrections).
const OPENING_HOT_DAYS = 2;
// Just under the hourly cron interval so consecutive runs never skip.
const OPENING_WINDOW_FRESHNESS_MS = 55 * 60 * 1000;
const OPENING_WARM_FRESHNESS_MS = 3 * 60 * 60 * 1000;
// Talkin' Broadway (and occasionally others) publish up to 24h before the
// official opening (CLAUDE.md rule 14) — cover the eve-of-opening day too.
const PRE_OPENING_GRACE_MS = 24 * 60 * 60 * 1000;
// Longest re-audit skip any show can earn (closed + audited clean). Exported so
// show-review-gap.json's retention can be derived from it rather than guessed:
// a retention shorter than this evicts closed-clean shows long before they are
// due to be re-audited, and they read as no-census-yet in the meantime
// (ship-check finding, task #902).
const MAX_FRESHNESS_SKIP_MS = 365 * 24 * 60 * 60 * 1000;

// The opening-window alert still reads this show's row and it counts uncollected reviews.
// alertUncollected is the alert's own count (census-only hits ignored for a closed show);
// an entry written before that field existed falls back to uncollected.
function alertReadsRow(show, entry, now = Date.now()) {
  if (!entry || !inOpeningWindow(show, now)) return false;
  return (entry.alertUncollected ?? entry.uncollected) > 0;
}

// BRO-6687: off-Broadway / West End / off-West End reviews trickle in over days
// 8-21, but a show there that audited clean on day 7 fell to tier 2 behind ~770
// back-catalogue shows and waited 2-13 days for re-audit (43 of 67 in-window
// slow-market shows on 2026-10-31), so late reviews were not found in-window.
// These shows get their own tier between alerting rows and the back catalogue,
// re-checked every 48h: about 25 audits/day for ~50 shows, against ~70/day of
// observed audit throughput. Rows that still count uncollected reviews stay
// tier 1, and rows the slow-market rollup still alerts on (slowMarketResidual,
// which also counts reverify exclusions) keep the 12h default.
const SLOW_MARKET_CLEAN_TIER = 1.5;
const SLOW_MARKET_CLEAN_FRESHNESS_MS = 48 * 60 * 60 * 1000;
function isSlowMarketCleanInWindow(show, entry, now = Date.now()) {
  return show?.status !== 'closed' && SLOW_MARKETS.has(show?.category)
    && inOpeningWindow(show, now, SLOW_MARKET_ALERT_DAYS)
    && !!entry && !(entry.uncollected > 0) && !(entry.slowMarketResidual > 0);
}

function inOpeningPriorityWindow(show, now = Date.now()) {
  if (show?.status === 'closed') return false;
  if (inOpeningWindow(show, now, OPENING_PRIORITY_WINDOW_DAYS)) return true;
  const opening = Date.parse(show?.openingDate);
  return Number.isFinite(opening) && opening > now && (opening - now) <= PRE_OPENING_GRACE_MS;
}

// How long to skip a show after auditing it. Closed shows that came back clean
// rarely change, so they get a long skip (don't re-burn credits); open shows
// and shows with gaps are re-checked sooner so newly-published reviews are
// caught; opening-week shows re-check every run.
function freshnessMsFor(show, lastEntry, { freshnessHours = 12, now = Date.now() } = {}) {
  const closed = show && show.status === 'closed';
  // A closed show that audited clean won't get new reviews — re-check only yearly
  // (effectively one-time) so the back-catalogue grind doesn't burn credits forever.
  if (closed && lastEntry && lastEntry.gaps === 0) return MAX_FRESHNESS_SKIP_MS; // 365d
  // BRO-5513: a closed show still inside the opening-window alert whose row counts
  // uncollected reviews is read by that alert daily; waiting 14d left a stale row
  // firing (Measure for Measure, closed after 2 nights, row frozen at 2026-10-04).
  if (closed && alertReadsRow(show, lastEntry, now)) return freshnessHours * 60 * 60 * 1000;
  if (closed) return 14 * 24 * 60 * 60 * 1000; // 14d — retry closed shows that still had gaps
  if (inOpeningPriorityWindow(show, now)) {
    return inOpeningWindow(show, now, OPENING_HOT_DAYS)
      ? OPENING_WINDOW_FRESHNESS_MS
      : OPENING_WARM_FRESHNESS_MS;
  }
  if (isSlowMarketCleanInWindow(show, lastEntry, now)) return Math.max(SLOW_MARKET_CLEAN_FRESHNESS_MS, freshnessHours * 60 * 60 * 1000);
  return freshnessHours * 60 * 60 * 1000; // open/previews — re-check often for new reviews
}

// Checkpoint timestamp for sorting. Malformed/missing `at` → 0 (treated as
// never-audited, i.e. maximum urgency) so a corrupt entry can't push a show
// to the back of the queue via NaN comparisons.
function checkpointTs(entry) {
  if (!entry || !entry.at) return 0;
  const t = new Date(entry.at).getTime();
  return Number.isFinite(t) ? t : 0;
}

// Ordering for time-budgeted runs: opening-window shows first (reviews are
// landing NOW), then least-recently-audited so the back-catalogue still grinds.
//
// Ties (above all the never-audited pile, which all share ts 0) break toward
// live shows and then the newest opening. Without this the tie fell back to
// shows.json file order: on 2026-10-04 Arias with a Twist (opened 9/23) and
// Purpose (9/16) sat at queue positions 95 and 116 behind ~46 never-audited
// open shows and 58 closed ones, were never audited, and shipped in the
// 2026-09-28 newsletter with no review-completeness data at all (BRO-4592).
//
// Tier 1 (BRO-5133): a live show past its first week, still inside the
// opening-window alert (inOpeningWindow, 21 days), whose last row still counts
// uncollected reviews, sorts ahead of the back catalogue. The alert re-reads
// that row every day, so without this a show at day 8-21 waited a week or more
// behind back-catalogue retries while the digest repeated its stale gap 15
// times (Lost in Del Valle, Midnight, Elf Lyons, 2026-10; 34 shows 6-13 days
// stale on 2026-10-12). Spend-neutral: the run is time-boxed, this only
// reorders it, and these shows keep the 12h freshness. A live in-window show
// with no row at all is tier 1 too: it has never been checked (BRO-4592 class).
function auditTier(show, entry, now = Date.now()) {
  if (inOpeningPriorityWindow(show, now)) return 0;
  if (show?.status !== 'closed' && inOpeningWindow(show, now) && (!entry || entry.uncollected > 0)) return 1;
  if (show?.status === 'closed' && alertReadsRow(show, entry, now)) return 1; // BRO-5513
  if (isSlowMarketCleanInWindow(show, entry, now)) return SLOW_MARKET_CLEAN_TIER; // BRO-6687
  return 2;
}

function compareAuditPriority(a, b, checkpoint, now = Date.now()) {
  const wa = auditTier(a, checkpoint[a.id], now);
  const wb = auditTier(b, checkpoint[b.id], now);
  if (wa !== wb) return wa - wb;
  const byAge = checkpointTs(checkpoint[a.id]) - checkpointTs(checkpoint[b.id]); // oldest / never-audited first
  if (byAge !== 0) return byAge;
  const ca = a.status === 'closed' ? 1 : 0;
  const cb = b.status === 'closed' ? 1 : 0;
  if (ca !== cb) return ca - cb;
  // Newest opening first. YYYY-MM-DD strings (or NO_DATE_SENTINEL) compare lexically.
  return showRecencyKey(b).localeCompare(showRecencyKey(a));
}

// BRO-5655: reserved slots for the stalest gap rows. compareAuditPriority puts
// opening-week shows first, and a busy opening week (39 tier-0 shows due on
// 2026-10-19) uses the whole time budget, so a show 8-21 days after opening
// waited days for re-audit. Its show-review-gap.json row kept the old
// computedAt and the opening-window alert kept firing on gaps that were
// already fixed (Antigone Exits, row stuck at 2026-10-14, BRO-5489).
// Every STALE_RESERVE_EVERY-th slot (indices 1, 5, 9, ...) goes to the due
// show whose gap row is oldest, so about 25% of each run refreshes the stalest
// rows regardless of how many opening shows are queued. Slot 1, not slot 3,
// so a run that only gets through a couple of shows still refreshes one.
const STALE_RESERVE_EVERY = 4;
// BRO-4061: a second reserved lane for the back catalogue (auditTier 2).
// The stale lane above only reaches shows that HAVE a gap row, so a show
// that was never audited (191 in the 3y window on 2026-10-22, the checkpoint
// stuck at 925 entries for 14 days) could never get a slot while opening-week
// shows filled every other one. Slots 5, 17, 29, ... (one per run of 6-17
// shows; runs audit 8-20) go to the head of the tier-2 queue in priority
// order: never-audited first, then oldest checkpoint. Those slots are
// stale-lane slots (5 % 4 === 1), so the back catalogue's share is split
// between its two lanes and opening-week shows lose nothing while the stale
// queue has rows (with no gap file, or the stale queue used up, the slot comes
// from tier 0 instead: at most 1 in 12). Replaying 14
// days over the 2026-10-22 queue at 8, 12 and 20 shows per run, hot-show
// waits were identical to today's, never-audited went 191 -> ~105 instead of
// growing to ~210. Placing the lane on a tier-0 slot (3) instead pushed the
// worst hot-show wait from 9.5h to 12.9h at 20 shows per run.
// If the tier-2 queue is empty the slot falls back to the stale lane.
const CATALOGUE_RESERVE_EVERY = 12;
const CATALOGUE_RESERVE_AT = 5;

// showId -> computedAt ms, from a parsed show-review-gap.json. Rows that
// cannot be stale in a way a re-audit fixes are left out: no/unparseable
// computedAt, and quarantined rows (BRO-3002), whose computedAt stays frozen
// while the show is quarantined and would otherwise take a slot every run.
function gapRowTimestamps(gapAudit) {
  const out = new Map();
  const rows = gapAudit && Array.isArray(gapAudit.results) ? gapAudit.results : [];
  for (const r of rows) {
    if (!r || !r.showId || r.quarantine) continue;
    const t = Date.parse(r.computedAt);
    if (Number.isFinite(t)) out.set(r.showId, t);
  }
  return out;
}

// Reorders an already priority-sorted target list. Pure: same shows in, same
// shows out, no duplicates. Shows without a gap row are not stale-slot
// candidates (no row means no stale alert, and compareAuditPriority already
// puts never-audited shows first in their tier).
// BRO-5489: `preferIds` (shows whose row the opening-window alert re-reads
// every day: auditTier 1) take the reserved slots before older rows. Oldest-
// first alone gave every slot to back-catalogue rows from September (Hate
// Radio, 46 days), so on 2026-10-21 What The Animals Say (row 11 days old),
// Kramer/Fauci, Fences and Boop kept re-alerting on rows no run refreshed.
// Preferred rows get the 12h freshness once refreshed, so they cannot hold
// the slots for long; oldest-first still orders within each group.
// BRO-4061: `catalogueIds` (tier-2 shows) opt in to the catalogue lane; it
// keeps `ordered`'s order and returns its picks as catalogueReservedIds.
// Without it the result is exactly the stale-lane-only behaviour.
function reserveStalestSlots(ordered, rowTsById, {
  every = STALE_RESERVE_EVERY,
  preferIds = null,
  catalogueIds = null,
  catalogueEvery = CATALOGUE_RESERVE_EVERY,
  catalogueAt = CATALOGUE_RESERVE_AT,
} = {}) {
  const list = Array.isArray(ordered) ? ordered : [];
  const staleOn = every >= 2 && rowTsById && rowTsById.size > 0;
  const catalogueOn = catalogueIds && catalogueIds.size > 0 && catalogueEvery >= 2;
  if (!staleOn && !catalogueOn) return { targets: list.slice(), reservedIds: [], catalogueReservedIds: [] };
  const pos = new Map(list.map((s, i) => [s.id, i]));
  const pref = (s) => (preferIds && preferIds.has(s.id) ? 0 : 1);
  const stale = !staleOn ? [] : list
    .filter((s) => rowTsById.has(s.id))
    .sort((a, b) => (pref(a) - pref(b)) || (rowTsById.get(a.id) - rowTsById.get(b.id)) || (pos.get(a.id) - pos.get(b.id)));
  const catalogue = catalogueOn ? list.filter((s) => catalogueIds.has(s.id)) : [];
  const taken = new Set();
  const targets = [];
  const reservedIds = [];
  const catalogueReservedIds = [];
  let p = 0;
  let q = 0;
  let c = 0;
  while (targets.length < list.length) {
    if (catalogueOn && targets.length % catalogueEvery === catalogueAt) {
      while (c < catalogue.length && taken.has(catalogue[c].id)) c++;
      if (c < catalogue.length) {
        taken.add(catalogue[c].id);
        targets.push(catalogue[c]);
        catalogueReservedIds.push(catalogue[c].id);
        continue;
      }
    }
    if (staleOn && targets.length % every === 1) {
      while (q < stale.length && taken.has(stale[q].id)) q++;
      if (q < stale.length) {
        taken.add(stale[q].id);
        targets.push(stale[q]);
        reservedIds.push(stale[q].id);
        continue;
      }
    }
    while (p < list.length && taken.has(list[p].id)) p++;
    if (p >= list.length) break; // duplicate ids in input
    taken.add(list[p].id);
    targets.push(list[p]);
  }
  return { targets, reservedIds, catalogueReservedIds };
}

// Oldest gap row among `showIds` (ids missing from rowTsById are skipped).
// Written into show-review-gap.json so row staleness is visible in the file.
function oldestGapRow(rowTsById, showIds, now = Date.now()) {
  let best = null;
  for (const id of showIds || []) {
    const t = rowTsById && rowTsById.get(id);
    if (!Number.isFinite(t)) continue;
    if (!best || t < best.t) best = { id, t };
  }
  if (!best) return null;
  return {
    showId: best.id,
    computedAt: new Date(best.t).toISOString(),
    ageHours: Math.round(((now - best.t) / 3600000) * 10) / 10,
  };
}

module.exports = {
  STALE_RESERVE_EVERY,
  CATALOGUE_RESERVE_EVERY,
  CATALOGUE_RESERVE_AT,
  gapRowTimestamps,
  reserveStalestSlots,
  oldestGapRow,
  freshnessMsFor,
  inOpeningPriorityWindow,
  compareAuditPriority,
  auditTier,
  isSlowMarketCleanInWindow,
  SLOW_MARKET_CLEAN_TIER,
  SLOW_MARKET_CLEAN_FRESHNESS_MS,
  checkpointTs,
  OPENING_PRIORITY_WINDOW_DAYS,
  OPENING_HOT_DAYS,
  OPENING_WINDOW_FRESHNESS_MS,
  OPENING_WARM_FRESHNESS_MS,
  MAX_FRESHNESS_SKIP_MS,
};
