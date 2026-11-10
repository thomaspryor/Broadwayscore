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
const MIN = 60 * 1000;
const VARIABLE = 'LANE_PREEMBARGO_DIRECT_ONLY';
const LANE_LEAD_MIN = 30;            // the window closes where the normal lane start is: embargo - 30 min
const START_LOCAL = '19:30';         // the window opens at this wall-clock time in the show's market zone ...
const MAX_LEAD_MIN = 90;             // ... but never earlier than embargo - 90 min, so the +240 min tail still fits the 355-min job cap
const DEFER_RETRY_MS = 30 * 1000;

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
function laneStartMs({ embargoMs, timeZone, enabled }) {
  const normal = embargoMs - LANE_LEAD_MIN * MIN;
  if (!enabled || !timeZone) return normal;
  let local;
  try {
    local = localWallClockMs(embargoMs, timeZone);
    if (local >= embargoMs && new Date(embargoMs).getTime() && localHour(embargoMs, timeZone) < 12) local = localWallClockMs(embargoMs - 24 * 60 * MIN, timeZone); // a small-hours embargo: 19:30 the evening before
  } catch { return normal; }
  return Math.min(normal, Math.max(local, embargoMs - MAX_LEAD_MIN * MIN));
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

module.exports = { VARIABLE, LANE_LEAD_MIN, START_LOCAL, MAX_LEAD_MIN, DEFER_RETRY_MS, parseFlag, windowActive, localWallClockMs, laneStartMs, deferred, isDeferred, guardPorts };
