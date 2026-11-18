'use strict';
/**
 * BRO-7779 item 7: when reviews really drop, per market and per outlet, from recorded nights.
 *
 * The press-night clock times every night off the market hour (press-night-record.js EMBARGO_HOUR_LOCAL). That hour is
 * a guess (BRO-7740). The test bench (scripts/test-bench-publish-times.js) has the observed embargo of each recorded
 * night (scripts/lib/observed-embargo.js: the first cluster of outlets publishing together) and every review's exact
 * publish time. This module turns those into:
 *
 *   markets[m]  how far the real drop sat from the market hour on each recorded night (minutes, negative = early):
 *               earliest, median, latest, and how many nights dropped early.
 *   outlets[o]  outlets that publish before the cluster (Talkin' Broadway a day early, Culture Sauce two hours early):
 *               nights seen, nights early, the biggest lead.
 *
 * dropWindow(show, profiles) gives the window a watch should cover, with `basis` 'observed' (N recorded nights) or
 * 'guess' (too few nights: the market hour alone). Every caller shows the basis next to the time, so a guess always
 * reads as one.
 *
 * Pure over plain data (CLAUDE.md rule 15). Not part of the lane code hash: nothing here moves the lane's own timing.
 */

const MIN = 60 * 1000;
const MIN_NIGHTS_FOR_OBSERVED = 5;
const EARLY_POST_MIN = 10; // an outlet more than this ahead of the cluster posted early

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

function marketHourMs(category, openingDate) {
  const { marketEmbargoAt } = require('./press-night-record');
  const at = marketEmbargoAt({ category, openingDate });
  return at ? Date.parse(at) : null;
}

/** The market a recorded night belongs to: Off-Broadway shares Broadway's hour and zone, Off-West End the West End's. */
function marketOf(category) {
  if (category === 'broadway' || category === 'off-broadway') return 'broadway';
  if (category === 'west-end' || category === 'off-west-end') return 'west-end';
  return category || null;
}

/**
 * @param {{nights: Object<string, object>}} bench   data/audit/test-bench/nights.json
 * @param {Object<string, {rows: object[]}>} publishTimes  showId -> data/audit/test-bench/publish-times/<id>.json
 */
function buildProfiles(bench, publishTimes = {}, { generatedAt = null } = {}) {
  const markets = {};
  const outlets = {};
  for (const n of Object.values((bench && bench.nights) || {})) {
    if (!n || !n.observed || n.observed.source !== 'observed-cluster' || n.observed.midnightOnly) continue;
    const hourMs = marketHourMs(n.category, n.openingDate);
    const dropMs = Date.parse(n.observed.at);
    if (hourMs == null || !Number.isFinite(dropMs)) continue;
    const market = marketOf(n.category);
    const m = markets[market] || (markets[market] = { nights: [] });
    m.nights.push({ showId: n.showId, openingDate: n.openingDate, offsetMin: Math.round((dropMs - hourMs) / MIN) });
    for (const r of ((publishTimes[n.showId] || {}).rows || [])) {
      if (!r || !r.outlet || r.precision !== 'exact') continue;
      const t = Date.parse(r.publishedTime);
      if (!Number.isFinite(t)) continue;
      const leadMin = Math.round((dropMs - t) / MIN);
      const o = outlets[r.outlet] || (outlets[r.outlet] = { nights: 0, earlyNights: 0, maxLeadMin: 0 });
      o.nights += 1;
      if (leadMin > EARLY_POST_MIN) { o.earlyNights += 1; o.maxLeadMin = Math.max(o.maxLeadMin, leadMin); }
    }
  }
  for (const m of Object.values(markets)) {
    const offs = m.nights.map((x) => x.offsetMin);
    m.nights.sort((a, b) => a.openingDate.localeCompare(b.openingDate));
    Object.assign(m, { n: offs.length, earliestMin: Math.min(...offs), medianMin: median(offs), latestMin: Math.max(...offs), earlyNights: offs.filter((x) => x < 0).length });
  }
  const earlyOutlets = Object.fromEntries(Object.entries(outlets).filter(([, o]) => o.earlyNights > 0).sort(([a], [b]) => a.localeCompare(b)));
  return { generatedAt, minNightsForObserved: MIN_NIGHTS_FOR_OBSERVED, markets, earlyOutlets };
}

/**
 * The window a press-night watch should cover for `show` on its opening night.
 * @returns {{basis: 'observed'|'guess'|'none', n: number, marketHourAt: string|null, fromAt: string|null, toAt: string|null, earliestMin: number|null, text: string}}
 */
function dropWindow(show, profiles) {
  const hourMs = show ? marketHourMs(show.category, show.openingDate) : null;
  if (hourMs == null) return { basis: 'none', n: 0, marketHourAt: null, fromAt: null, toAt: null, earliestMin: null, text: 'no market hour, so no drop window' };
  const m = profiles && profiles.markets && profiles.markets[marketOf(show.category)];
  const iso = (ms) => new Date(ms).toISOString();
  if (!m || m.n < MIN_NIGHTS_FOR_OBSERVED) {
    return { basis: 'guess', n: m ? m.n : 0, marketHourAt: iso(hourMs), fromAt: iso(hourMs), toAt: iso(hourMs), earliestMin: null,
      text: `guess: the market hour ${iso(hourMs)}, with ${m ? m.n : 0} recorded night(s) for this market (need ${MIN_NIGHTS_FOR_OBSERVED})` };
  }
  const sign = (x) => (x > 0 ? `+${x}` : `${x}`);
  return { basis: 'observed', n: m.n, marketHourAt: iso(hourMs), fromAt: iso(hourMs + m.earliestMin * MIN), toAt: iso(hourMs + m.latestMin * MIN), earliestMin: m.earliestMin,
    text: `observed over ${m.n} recorded nights: reviews dropped from ${sign(m.earliestMin)} to ${sign(m.latestMin)} min around the market hour (median ${sign(m.medianMin)}, early on ${m.earlyNights}), so ${iso(hourMs + m.earliestMin * MIN)} to ${iso(hourMs + m.latestMin * MIN)} tonight` };
}

module.exports = { buildProfiles, dropWindow, marketOf, MIN_NIGHTS_FOR_OBSERVED, EARLY_POST_MIN };
