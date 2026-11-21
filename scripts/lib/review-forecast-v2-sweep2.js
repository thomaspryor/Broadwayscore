/**
 * review-forecast-v2-sweep2.js (BRO-7373): second input sweep for the review-score forecast RESEARCH
 * backtest. Pure: no fs, no network, no clock. The live forecast (review-forecast.js) and the landed v2
 * shadow do not import this file.
 *
 * Specs were fixed before any test row was graded (see the card). Groups:
 *   team      creative-team record from OUR Critic Scores (director, book writer, composer/lyricist split;
 *             experience count, last-3 record, best member, share of debut slots). Earlier productions only,
 *             opened at least LAG_DAYS before, any market (as v1 persons do), deviation from that market's mean.
 *   shape     Show Score member-rating SHAPE from the dated pre-opening member reviews (BRO-7347 pull):
 *             median, share of 90+ ratings, share of 60 or below, trend (later reviews minus the first 20).
 *   source    revival dormancy (years since the previous Broadway production of the title in shows.json),
 *             true-story flag (show-origins originalKind), limited-run flag.
 *   schedule  preview performances actually played and shortfall against 8 a week (grosses `performances`),
 *             weeks before opening only.
 *   position  theater seats (theater-metadata), other Broadway openings within 6 days either side, openings in
 *             the 28 days before. Opening dates are announced weeks ahead (same status as the calendar group).
 *   box       preview box office against the THEATER's own norm (earlier shows' preview weeks at the same house),
 *             and the first pre-opening week's level (slopes were already tested in BRO-7347).
 */
'use strict';

const RF = require('./review-forecast.js');
const { LAG_DAYS, toDay, normName, titleKey } = RF;

const TEAM_SHRINK_K = 3;
const RECENT_N = 3;
const SHAPE_K = 10; // as the Show Score mean: shrink toward the typical show
const SHAPE_MEDIAN_CENTER = 85;
const SHAPE_HI_CENTER = 0.4;
const SHAPE_LOW_CENTER = 0.1;
const SHAPE_TREND_MIN_N = 30;
const SEATS_CENTER = Math.log(1000);
const MAX_DORMANT_YEARS = 60;
const BOX_WEEKS = 2; // preview weeks used for the venue-norm comparison, as v1
const SCHEDULE_WEEKS = 4;
const VENUE_NORM_MIN_SHOWS = 2;

const SWEEP2_GROUPS = {
  team: ['dirN', 'bookN', 'musicN', 'dirRecent', 'bookRecent', 'musicRecent', 'bookDev', 'musicDev', 'teamBest', 'teamDebutFrac'],
  shape: ['audMed', 'audHi90', 'audLow', 'audTrend'],
  source: ['revDormancy', 'revKnown', 'trueStory', 'trueStoryUnknown', 'limitedRun'],
  schedule: ['prevPerfs', 'perfShortfall'],
  position: ['logSeats', 'sameWeekOpen', 'crowd28'],
  box: ['venueCap', 'venueAtp', 'firstCap', 'firstAtp', 'hasVenueNorm'],
};
const SWEEP2_FEATURE_NAMES = Object.values(SWEEP2_GROUPS).flat();

const EXCLUDE_ROLE = /direction|supervis|orchestrat|arrang|design|coordinator|associate|assistant|casting|stage manag|production manag|(music|musical) director/i;
/** Role -> 'dir' | 'book' | 'music' | null. Book writers and composers/lyricists are split (v1 merges them as 'writer'). */
function roleGroup2(role) {
  const r = String(role || '');
  if (/^(co-)?directors?$/i.test(r.trim()) || /^director &/i.test(r.trim()) || /^writer & director$/i.test(r.trim())) return 'dir';
  if (EXCLUDE_ROLE.test(r)) return null;
  if (/music|lyric|composer/i.test(r)) return 'music';
  if (/playwright|\bbook\b|writer|adaptation|author|creator/i.test(r)) return 'book';
  return null;
}

/** creativeTeam -> {dir:Set, book:Set, music:Set} of normalized names. "Book, Music & Lyrics" counts for both. */
function teamOf(creativeTeam) {
  const g = { dir: new Set(), book: new Set(), music: new Set() };
  for (const c of creativeTeam || []) {
    const n = normName(c.name);
    if (!n) continue;
    const role = String(c.role || '');
    if (/^(co-)?directors?$/i.test(role.trim()) || /^director &/i.test(role.trim()) || /^(writer|book|playwright)\s*(&|,|\/|and)\s*(co-)?director$/i.test(role.trim())) g.dir.add(n);
    if (EXCLUDE_ROLE.test(role) && !/^director &/i.test(role.trim())) continue;
    if (/music|lyric|composer/i.test(role)) g.music.add(n);
    if (/playwright|\bbook\b|writer|adaptation|author|creator/i.test(role)) g.book.add(n);
  }
  return g;
}

/** shows: shows.json rows -> Map(showId -> team). */
function buildTeamIndex(shows) {
  const m = new Map();
  for (const s of shows) if (s.creativeTeam && s.creativeTeam.length) m.set(s.id, teamOf(s.creativeTeam));
  return m;
}

/**
 * Pool index of Broadway openings for crowding, dormancy: [{id, title, openingDate, category, type}] from ALL shows.
 */
function buildOpeningsIndex(shows) {
  // Intentionally NOT isBroadwayCategory: the forecast pool is the strict 'broadway' category, as in review-forecast.js.
  return shows.filter((s) => s.category === 'broadway' && toDay(s.openingDate) != null && (s.type === 'play' || s.type === 'musical')
    && !s.noReviewsExpected && !s.cancelledBeforeOpening)
    .map((s) => ({ id: s.id, key: titleKey(s.title), day: toDay(s.openingDate), openingDate: s.openingDate }));
}

const med = (arr) => { const v = [...arr].sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };

/**
 * ctx = { pool, poolById, teams: Map, openings: [], weeks, theaterSeats: {venue: capacity}, origins, memberShape: {id: stats}, showMeta: {id: {isRevival, limitedRun}} }
 * Returns { x, provenance, has }.
 */
function buildSweep2Features(target, ctx, opts = {}) {
  const floor = opts.floor ?? 10;
  const D = toDay(target.openingDate);
  if (D == null) throw new Error(`bad openingDate for ${target.id}`);
  const cutoff = D - LAG_DAYS;
  const prov = [];
  const note = (kind, ref, date) => prov.push({ kind, ref, date });
  const x = {};
  SWEEP2_FEATURE_NAMES.forEach((k) => { x[k] = 0; });
  const has = { team: false, shape: false, source: false, schedule: false, position: false, box: false, venueNorm: false };

  // ---- team ----
  const team = ctx.teams && ctx.teams.get(target.id);
  if (team && (team.dir.size || team.book.size || team.music.size)) {
    // Earlier productions of the SAME title are BRO-7369's input (transfers), not a team record: drop them here.
    const ownKey = titleKey(target.title);
    const past = ctx.pool.filter((s) => s.id !== target.id && titleKey(s.title) !== ownKey && toDay(s.openingDate) != null && toDay(s.openingDate) <= cutoff && s.rc >= floor);
    const catMeanCache = {};
    const catMean = (cat) => {
      if (catMeanCache[cat] === undefined) {
        const v = past.filter((s) => s.category === cat).map((s) => s.score);
        catMeanCache[cat] = v.length ? RF.mean(v) : null;
      }
      return catMeanCache[cat];
    };
    const records = (name) => {
      const devs = []; // chronological
      for (const s of past) {
        const t = ctx.teams.get(s.id);
        if (!t || !(t.dir.has(name) || t.book.has(name) || t.music.has(name))) continue;
        const cm = catMean(s.category);
        if (cm == null) continue;
        devs.push({ day: toDay(s.openingDate), dev: s.score - cm });
        note('team-credit', s.id, s.openingDate);
      }
      return devs.sort((a, b) => a.day - b.day).map((q) => q.dev);
    };
    const shrunk = (d) => (d.length ? d.reduce((a, b) => a + b, 0) / (d.length + TEAM_SHRINK_K) : null);
    const role = (set) => {
      const per = [...set].map((nm) => { const d = records(nm); return { n: d.length, all: shrunk(d), recent: shrunk(d.slice(-RECENT_N)) }; });
      if (!per.length) return null;
      const m = (f) => { const v = per.map(f).filter((q) => q != null); return v.length ? RF.mean(v) : 0; };
      return { n: RF.mean(per.map((p) => Math.log1p(p.n))), all: m((p) => p.all), recent: m((p) => p.recent), per };
    };
    const d = role(team.dir); const b = role(team.book); const m = role(team.music);
    if (d) { x.dirN = d.n; x.dirRecent = d.recent; }
    if (b) { x.bookN = b.n; x.bookRecent = b.recent; x.bookDev = b.all; }
    if (m) { x.musicN = m.n; x.musicRecent = m.recent; x.musicDev = m.all; }
    const people = [d, b, m].filter(Boolean).flatMap((r) => r.per);
    if (people.length) {
      const alls = people.map((p) => p.all).filter((q) => q != null);
      x.teamBest = alls.length ? Math.max(...alls) : 0;
      x.teamDebutFrac = people.filter((p) => p.n === 0).length / people.length;
      has.team = true;
    }
  }

  // ---- shape (dated pre-opening Show Score member reviews) ----
  const sh = ctx.memberShape && ctx.memberShape[target.id];
  if (sh && sh.n >= 1 && sh.newest) {
    const n = sh.n;
    if (sh.median != null) x.audMed = (n * sh.median + SHAPE_K * SHAPE_MEDIAN_CENTER) / (n + SHAPE_K) - SHAPE_MEDIAN_CENTER;
    if (sh.shareGe90 != null) x.audHi90 = (n * sh.shareGe90 + SHAPE_K * SHAPE_HI_CENTER) / (n + SHAPE_K) - SHAPE_HI_CENTER;
    if (sh.shareLe60 != null) x.audLow = (n * sh.shareLe60 + SHAPE_K * SHAPE_LOW_CENTER) / (n + SHAPE_K) - SHAPE_LOW_CENTER;
    if (n >= SHAPE_TREND_MIN_N && sh.meanRest != null && sh.meanFirst20 != null) x.audTrend = sh.meanRest - sh.meanFirst20;
    note('member-shape', target.id, sh.newest);
    has.shape = true;
  }

  // ---- source ----
  const meta = (ctx.showMeta && ctx.showMeta[target.id]) || {};
  if (target.isRevival) {
    const tk = titleKey(target.title);
    let last = null;
    for (const o of ctx.openings) {
      if (o.id === target.id || o.key !== tk || o.day > D - 365) continue; // a production at least a year earlier is a prior run
      if (last == null || o.day > last.day) last = o;
    }
    if (last) { x.revDormancy = Math.log1p(Math.min(MAX_DORMANT_YEARS, (D - last.day) / 365.25)); x.revKnown = 1; note('prior-opening', last.id, last.openingDate); }
  }
  const og = ctx.origins && ctx.origins[target.id];
  if (og && og.originalKind) x.trueStory = og.originalKind === 'true-story' ? 1 : 0; else x.trueStoryUnknown = 1;
  x.limitedRun = meta.limitedRun ? 1 : 0;
  if (og) note('static-origin', target.id, null);
  has.source = !!target.isRevival ? x.revKnown === 1 : true;

  // ---- schedule, position, box office: Broadway proper only (grosses and the opening calendar) ----
  // Intentionally NOT isBroadwayCategory: strict category, same as the v1/v2 evaluation rows.
  if (target.category === 'broadway') {
    const wkAll = ctx.weeks ? Object.keys(ctx.weeks).filter((w) => toDay(w) < D && ctx.weeks[w][target.id]).sort() : [];
    const wk4 = wkAll.slice(-SCHEDULE_WEEKS);
    if (wk4.length) {
      let perfs = 0; let short = 0; let k = 0;
      for (const w of wk4) {
        const r = ctx.weeks[w][target.id];
        if (!(r.performances > 0)) continue;
        perfs += r.performances; short += Math.max(0, 8 - r.performances); k += 1;
        note('gross-week', `${target.id}@${w}`, w);
      }
      if (k) { x.prevPerfs = Math.log1p(perfs); x.perfShortfall = short / k; has.schedule = true; }
    }

    if (ctx.theaterSeats && target.venue && ctx.theaterSeats[target.venue] > 0) {
      x.logSeats = Math.log(ctx.theaterSeats[target.venue]) - SEATS_CENTER; has.position = true; note('static-venue', target.venue, null);
    }
    let same = 0; let crowd = 0;
    for (const o of ctx.openings) {
      if (o.id === target.id) continue;
      if (Math.abs(o.day - D) <= 6) { same += 1; note('announced-opening', o.id, null); }
      if (o.day <= cutoff && o.day > cutoff - 28) { crowd += 1; note('earlier-opening', o.id, o.openingDate); }
    }
    x.sameWeekOpen = same; x.crowd28 = crowd; has.position = true;

    // box office against the theater's own norm
    const previewOf = (id, open) => { // an earlier show's last BOX_WEEKS preview weeks (strictly before its own opening)
      const ws = Object.keys(ctx.weeks).filter((w) => toDay(w) < open && ctx.weeks[w][id]).sort().slice(-BOX_WEEKS);
      const caps = []; const atps = [];
      for (const w of ws) { const r = ctx.weeks[w][id]; if (r.capacity > 0 && r.atp > 0) { caps.push(r.capacity); atps.push(Math.log(r.atp)); } }
      return caps.length ? { cap: RF.mean(caps), atp: RF.mean(atps) } : null;
    };
    const mine = ctx.weeks ? previewOf(target.id, D) : null;
    if (mine && target.venue) {
      const norms = [];
      for (const s of ctx.pool) {
        if (s.id === target.id || s.venue !== target.venue || s.category !== 'broadway') continue;
        const od = toDay(s.openingDate);
        if (od == null || od > cutoff) continue;
        const p = previewOf(s.id, od);
        if (p) { norms.push(p); note('venue-norm', s.id, s.openingDate); }
      }
      if (norms.length >= VENUE_NORM_MIN_SHOWS) {
        x.venueCap = mine.cap - RF.mean(norms.map((q) => q.cap));
        x.venueAtp = mine.atp - RF.mean(norms.map((q) => q.atp));
        x.hasVenueNorm = 1; has.venueNorm = true; has.box = true;
        note('gross-week', `${target.id}@box`, wkAll[wkAll.length - 1]);
      }
    }
    // level four weeks before opening (SCHEDULE_WEEKS back, or the earliest available), relative to that week's market median), as v1 builds its two-week level
    if (wkAll.length >= 2) {
      const w = wkAll[Math.max(0, wkAll.length - SCHEDULE_WEEKS)];
      const all = Object.values(ctx.weeks[w]).filter((r) => r && r.capacity > 0 && r.atp > 0);
      const r = ctx.weeks[w][target.id];
      if (all.length >= 5 && r.capacity > 0 && r.atp > 0) {
        x.firstCap = r.capacity - med(all.map((q) => q.capacity));
        x.firstAtp = Math.log(r.atp / med(all.map((q) => q.atp)));
        has.box = true; note('gross-week', `${target.id}@${w}`, w);
      }
    }
  }
  return { x, provenance: prov, has };
}

/** Throws if any sweep-2 input is dated on or after opening night (earlier-production inputs keep the LAG_DAYS lag). */
function assertNoLeakageSweep2(target, provenance) {
  const D = toDay(target.openingDate);
  const bad = [];
  for (const p of provenance) {
    if (p.kind === 'static-origin' || p.kind === 'static-venue' || p.kind === 'announced-opening') continue; // undated by definition: static descriptor or the announced schedule
    const d = toDay(p.date);
    if (d == null) { bad.push({ ...p, why: 'undated input' }); continue; }
    if (p.kind === 'gross-week') { if (!(d < D)) bad.push({ ...p, why: 'gross-week not before opening' }); continue; }
    if (p.kind === 'member-shape') { if (!(d <= D - LAG_DAYS)) bad.push({ ...p, why: 'member-shape within the lag or after opening' }); continue; }
    if (p.ref === target.id) { bad.push({ ...p, why: 'uses the show itself' }); continue; }
    if (!(d <= D - LAG_DAYS)) bad.push({ ...p, why: `${p.kind} opened ${(D - d).toFixed(0)}d before target (< ${LAG_DAYS}d lag)` });
  }
  if (bad.length) {
    const e = new Error(`LEAKAGE(sweep2) for ${target.id} (${target.openingDate}): ${bad.length} input(s) not dated before opening, first: ${JSON.stringify(bad[0])}`);
    e.bad = bad;
    throw e;
  }
  return true;
}

module.exports = { SWEEP2_GROUPS, SWEEP2_FEATURE_NAMES, teamOf, buildTeamIndex, buildOpeningsIndex, buildSweep2Features, assertNoLeakageSweep2 };
