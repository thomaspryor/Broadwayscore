'use strict';
/**
 * BRO-7280: the opt-in pre-embargo window. While it is open every lane fetch is forced to the shared scraper's
 * existing { directOnly: true } (plain HTTP, no paid or browser fallback) and the paid SERP search is refused, so the
 * window costs $0 in scraper credits. At embargo - 30 min (the normal lane start) it closes and the lane fetches as
 * it always has.
 *
 * Off unless the repo variable LANE_PREEMBARGO_DIRECT_ONLY is 'on'. The variable changes only through
 * opening-night-lane-switch.yml. Unset = every function here is inert and the lane behaves exactly as before.
 *
 * A fetch that fails inside the window fails because the paid tiers were withheld, not because the page is bad, so the
 * error is tagged `laneDeferred` and the lane's retry/strike counters skip it (inline-score fail, Google News unwrap
 * strikes, Talkin' Broadway blocked carries). After the window the same page gets the full chain.
 *
 * Scope: scraper credits (the ledger rows lane-spend-window.js counts). LLM scoring is a separate bill and is not
 * changed by the window.
 */
const { toDateMs } = require('../date-utils');
const MIN = 60 * 1000;
const VARIABLE = 'LANE_PREEMBARGO_DIRECT_ONLY';
const LANE_LEAD_MIN = 30;            // the window closes where the normal lane start is: embargo - 30 min
const START_LOCAL = '19:30';         // the window opens at this wall-clock time in the show's market zone ...
const MAX_LEAD_MIN = 90;             // ... but never earlier than embargo - 90 min, so the tail (+185 min; +95 at the BRO-7786 observed-drop cap) still fits the 355-min job cap (BRO-7740: also the default for a market-default embargo)
const DEFER_RETRY_MS = 30 * 1000;
// BRO-7786: with an OBSERVED earliest drop (embargo-drop-profiles.js, >=5 recorded nights) the guard opens at that drop minus this margin ...
const EARLY_DROP_MARGIN_MIN = 15;
// ... but never earlier than embargo - 180 min (recorded Broadway nights dropped up to 120 min early). The lane's window length is fixed, so the tail after the embargo shrinks by the extra lead (still >= embargo + 95 min at the cap).
const MAX_OBSERVED_LEAD_MIN = 180;

/** 'on' (any case, also true/1/yes) -> true. Anything else, unset included, is off. Pure. */
function parseFlag(v) {
  return ['on', 'true', '1', 'yes'].includes(String(v == null ? '' : v).trim().toLowerCase());
}

/** The window is open from the lane's early start until embargo - 30 min. Pure. */
function windowActive({ enabled, embargoMs, nowMs, leadMin = LANE_LEAD_MIN }) {
  if (!enabled || !Number.isFinite(embargoMs) || !Number.isFinite(nowMs)) return false;
  return nowMs < embargoMs - leadMin * MIN;
}

/** UTC ms of HH:MM wall-clock on the local calendar day of `refMs` in `timeZone`. Pure (Intl only). */
function localWallClockMs(refMs, timeZone, hhmm = START_LOCAL) {
  const [h, m] = hhmm.split(':').map(Number);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = (ms) => Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const ref = parts(refMs);
  const asUtc = Date.UTC(+ref.year, +ref.month - 1, +ref.day, h, m);
  // asUtc is the wall clock read as UTC; shift by the zone's offset at that moment (twice settles a DST edge).
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const p = parts(guess);
    guess += asUtc - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }
  return guess;
}

function localHour(ms, timeZone) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms)));
}

/**
 * When the lane starts. Flag off: embargo - 30 min, as always. Flag on: 19:30 local on the embargo's local day, but no
 * earlier than embargo - 90 min and never later than embargo - 30 min. Pure.
 */
function laneStartMs({ embargoMs, timeZone, enabled, earliestDropMs }) {
  const normal = embargoMs - LANE_LEAD_MIN * MIN;
  if (!enabled || !timeZone) return normal;
  let local;
  try {
    local = localWallClockMs(embargoMs, timeZone);
    if (local >= embargoMs && new Date(embargoMs).getTime() && localHour(embargoMs, timeZone) < 12) local = localWallClockMs(embargoMs - 24 * 60 * MIN, timeZone); // a small-hours embargo: 19:30 the evening before
  } catch { return normal; }
  const start = Math.min(normal, Math.max(local, embargoMs - MAX_LEAD_MIN * MIN));
  return observedStartMs({ embargoMs, earliestDropMs, startMs: start });
}

/**
 * BRO-7786: pull the guard's start back to the earliest drop seen on recorded nights (minus a margin), never earlier than
 * embargo - 180 min and never later than `startMs`. No usable earliestDropMs (a guess basis, no profile) = startMs. Pure.
 */
function observedStartMs({ embargoMs, earliestDropMs, startMs }) {
  if (!Number.isFinite(earliestDropMs) || !Number.isFinite(embargoMs)) return startMs;
  const want = earliestDropMs - EARLY_DROP_MARGIN_MIN * MIN;
  return Math.min(startMs, Math.max(want, embargoMs - MAX_OBSERVED_LEAD_MIN * MIN));
}

/**
 * BRO-7740: is the pre-embargo guard on for this night? On when the owner's LANE_PREEMBARGO_DIRECT_ONLY is on, OR when the
 * embargo is only the market-default guess. The guard is direct-only (no paid scraper tier, no SERP), so turning it on for
 * a guessed embargo costs nothing; it exists so the lane is already running when an early release lands. The variable and
 * its default are untouched (an owner money call). Pure.
 * @returns {{enabled:boolean, reason:'flag'|'assumed-embargo'|'off'}}
 */
function guardMode({ flagOn, assumed }) {
  if (flagOn) return { enabled: true, reason: 'flag' };
  if (assumed) return { enabled: true, reason: 'assumed-embargo' };
  return { enabled: false, reason: 'off' };
}

/**
 * BRO-7740 detector. The first admitted review that is provably tonight's (a full publish timestamp at or after the
 * guard's earliest start, and not already on disk) proves the embargo has lifted: the guard closes at once and the lane
 * fetches with the full chain. An aggregator-cited preview link with no date, an older date or an on-disk URL never
 * counts (a stale or date-only admit must not open the paid tiers early). Pure.
 * @param {{admitted:Array<{url?:string,publishDate?:string,key?:string}>, night:string, onDiskUrls?:Set<string>|string[]}} i
 * @returns {{lifted:boolean, evidence?:object}}
 */
function dropEvidence({ admitted = [], night, onDiskUrls = [], floorMs }) {
  const disk = onDiskUrls instanceof Set ? onDiskUrls : new Set(onDiskUrls);
  for (const a of admitted || []) {
    // A full timestamp at or after floorMs (the guard's earliest start). A bare date, or a zoned date turned into UTC the
    // evening before, proves nothing about tonight (outlet-index finds are admitted from the day before).
    if (!a || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(a.publishDate || ''))) continue;
    const ms = toDateMs(a.publishDate);
    if (!Number.isFinite(ms) || (Number.isFinite(floorMs) ? ms < floorMs : String(a.publishDate).slice(0, 10) < night)) continue;
    if (a.url && disk.has(a.url)) continue;
    return { lifted: true, evidence: { key: a.key || null, url: a.url || null, publishDate: a.publishDate } };
  }
  return { lifted: false };
}

/** Tag an error as caused by the window withholding the paid tiers (not by the page). */
function deferred(err, why) {
  const e = err instanceof Error ? err : new Error(String(err));
  e.laneDeferred = true;
  if (why) e.laneDeferredWhy = why;
  return e;
}
const isDeferred = (e) => !!(e && e.laneDeferred);

/**
 * Wrap the lane's ports. `isActive()` is read on every call, so the same wrapper covers the window and the hand-over
 * to normal fetching with no timer. fetchPage is forced to directOnly; search (the paid SERP) is refused with a
 * deferred error. Returns the ports unchanged when `enabled` is false. Pure apart from the calls it forwards.
 */
function guardPorts({ enabled, fetchPage, search, isActive }) {
  if (!enabled) return { fetchPage, search };
  return {
    fetchPage: async (url, opts = {}) => {
      if (!isActive()) return fetchPage(url, opts);
      try { const r = await fetchPage(url, { ...opts, directOnly: true }); return r && typeof r === 'object' ? { ...r, laneDirectOnly: true } : r; } catch (e) { throw deferred(e, 'direct-only fetch in the pre-embargo window'); }
    },
    search: async (query, ...rest) => {
      if (isActive()) throw deferred(new Error('SERP refused: pre-embargo window'), 'paid SERP in the pre-embargo window');
      return search(query, ...rest);
    },
  };
}

module.exports = { guardMode, dropEvidence, VARIABLE, LANE_LEAD_MIN, START_LOCAL, MAX_LEAD_MIN, EARLY_DROP_MARGIN_MIN, MAX_OBSERVED_LEAD_MIN, observedStartMs, DEFER_RETRY_MS, parseFlag, windowActive, localWallClockMs, laneStartMs, deferred, isDeferred, guardPorts };
