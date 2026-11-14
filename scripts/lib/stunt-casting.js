/**
 * Pure logic for the stunt-casting study (/biz/stunt-casting, BRO-5848).
 *
 * The question, first asked on r/Broadway in March 2026: what share of new
 * Broadway productions each season open with a film/TV star in a lead role,
 * and does that casting pay off commercially?
 *
 * Everything here is pure so scripts/lib/stunt-casting.test.mjs can require()
 * the real functions (CLAUDE.md §15). File and LLM I/O live in
 * scripts/build-stunt-casting-dataset.js.
 */
'use strict';

const crypto = require('crypto');
const { getSeasonForDate } = require('./broadway-seasons');
const { playedOnOpeningNight } = require('./cast-principals');
const { isUnrecoupedDesignation, RECOUPED_DESIGNATIONS } = require('./commercial-designations');

const FIRST_SEASON = '2004-2005';
// Headliner classification buckets. "screen" is the headline metric (it is
// what the 2026 Reddit analysis measured); "music" and "other" widen it to
// any non-theater celebrity.
const FAME = Object.freeze(['screen', 'music', 'other', 'stage', 'none']);
const CELEBRITY_FAME = new Set(['screen', 'music', 'other']);
// Opening-night companies are listed alphabetically, so a lead can sit
// anywhere in a big musical's list: send enough names to include them.
const MAX_CAST_FOR_PROMPT = 40;
// Cover and replacement credits are never the headliner.
const NON_LEAD_RE = /understudy|standby|swing|alternate|replacement/i;
// Weeks a production needs in the grosses before its averages are reported;
// a 2-week run says nothing about how a star sells.
const MIN_GROSS_WEEKS = 4;
// Box office is averaged over a production's first reported weeks only.
// Headliners are judged from the opening cast; a long run's later weeks
// belong to replacements, and a typical star engagement is about 16 weeks.
const OPENING_WINDOW_WEEKS = 16;
// Version of the classification prompt and rules. Bump it when
// buildPrompt() or validateClassification() changes, so cached answers made
// under the old rules are redone instead of passing --check.
const CLASSIFIER_VERSION = 1;

const ERAS = [
  { label: '2004–09', from: '2004-2005', to: '2008-2009' },
  { label: '2009–14', from: '2009-2010', to: '2013-2014' },
  { label: '2014–19', from: '2014-2015', to: '2018-2019' },
  { label: '2019–24', from: '2019-2020', to: '2023-2024' },
  { label: '2024–27', from: '2024-2025', to: '2026-2027' },
];

function seasonStartYear(season) {
  return Number(String(season).slice(0, 4));
}

/**
 * A one-night benefit or concert staging (the 2004 Actors Fund Hair and
 * Passion, the Escape readings): opened and closed the same day with no
 * previews. A real flop that closed on opening night (Glory Days, 2008) had
 * previews and stays in.
 */
function isOneNightEvent(s) {
  return !!s.closingDate && s.closingDate === s.openingDate && !s.previewsStartDate;
}

/**
 * Broadway plays and musicals that opened in a study season. Specials,
 * concerts and rows with no opening date or cast are out: there is no lead
 * to classify. Shows that have not opened yet are out too (their casts are
 * still announcements).
 */
function selectStudyShows(shows, { today }) {
  const out = [];
  for (const s of shows) {
    if (s.category !== 'broadway') continue;
    if (s.type !== 'play' && s.type !== 'musical') continue;
    if (!s.openingDate || s.openingDate > today) continue;
    if (isOneNightEvent(s)) continue;
    if (promptCast(s).length === 0) continue;
    const season = getSeasonForDate(s.openingDate);
    if (seasonStartYear(season) < seasonStartYear(FIRST_SEASON)) continue;
    out.push({ ...s, studySeason: season });
  }
  return out.sort((a, b) => a.openingDate.localeCompare(b.openingDate) || a.id.localeCompare(b.id));
}

/**
 * The company to classify. shows.json `cast` is the CURRENT cast (cast-change
 * tracking rewrites it), so a long run lists its replacements, not the stars
 * it opened with (Rocky Horror 2026 had lost Luke Evans and Stephanie Hsu).
 * The IBDB opening-night cast (data/cast/{id}.json), attached by the builder
 * as `openingCast`, is the right input; shows.json `cast` is the fallback.
 */
function promptCast(show) {
  const opening = Array.isArray(show.openingCast) ? show.openingCast : [];
  const source = opening.length ? opening : (show.cast || []);
  return source
    .filter(c => c && c.name)
    .filter(c => !NON_LEAD_RE.test(c.role || ''))
    // Same rule as cast-principals.js: opening the role excuses only the
    // "Alternate" flag, never understudy/standby/replacement.
    .filter(c => !NON_LEAD_RE.test((c.flags || []).filter(f => !(f === 'Alternate' && playedOnOpeningNight(c))).join(' ')))
    .slice(0, MAX_CAST_FOR_PROMPT)
    .map(c => ({ name: c.name, role: c.role || '' }));
}

/** Cache key: re-classify a show only when the facts we sent change. */
function classificationInputHash(show) {
  const facts = [show.title, show.openingDate, show.type, promptCast(show)];
  // Version 1 hashes stay as they were, so the existing cache is still valid.
  const payload = JSON.stringify(CLASSIFIER_VERSION === 1 ? facts : [CLASSIFIER_VERSION, ...facts, !!show.isRevival, show.venue || '']);
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * Validate one model answer against the cast we sent. Headliners must be
 * names from that cast (the model may not invent a star), fame must be a
 * known bucket. Returns { ok, value, error }.
 */
function validateClassification(answer, show) {
  if (!answer || answer.id !== show.id) return { ok: false, error: 'id mismatch' };
  // An empty list is a real answer: an ensemble show with no lead (Dancin').
  if (!Array.isArray(answer.headliners)) return { ok: false, error: 'no headliners array' };
  const castNames = new Set(promptCast(show).map(c => c.name));
  const headliners = [];
  for (const h of answer.headliners.slice(0, 4)) {
    if (!h || !castNames.has(h.name)) return { ok: false, error: `headliner not in cast: ${h && h.name}` };
    if (!FAME.includes(h.fame)) return { ok: false, error: `bad fame "${h.fame}" for ${h.name}` };
    headliners.push({ name: h.name, fame: h.fame, knownFor: String(h.knownFor || '').slice(0, 80) });
  }
  return { ok: true, value: { headliners } };
}

function hasScreenStar(headliners) {
  return headliners.some(h => h.fame === 'screen');
}
function hasCelebrity(headliners) {
  return headliners.some(h => CELEBRITY_FAME.has(h.fame));
}

function pct(n, d) {
  return d ? Math.round((n / d) * 1000) / 10 : null;
}

function rate(rows, pred) {
  return { n: rows.length, hits: rows.filter(pred).length, pct: pct(rows.filter(pred).length, rows.length) };
}

function splitByType(rows, pred) {
  return {
    plays: rate(rows.filter(r => r.type === 'play'), pred),
    musicals: rate(rows.filter(r => r.type === 'musical'), pred),
    all: rate(rows, pred),
  };
}

function bySeason(rows) {
  const seasons = [...new Set(rows.map(r => r.season))].sort();
  return seasons.map(season => {
    const sub = rows.filter(r => r.season === season);
    return { season, screen: splitByType(sub, r => r.screenStar), celebrity: splitByType(sub, r => r.celebrity) };
  });
}

function byEra(rows) {
  return ERAS.map(era => {
    const sub = rows.filter(r => r.season >= era.from && r.season <= era.to);
    return { label: era.label, from: era.from, to: era.to, screen: splitByType(sub, r => r.screenStar), celebrity: splitByType(sub, r => r.celebrity) };
  }).filter(e => e.screen.all.n > 0);
}

/**
 * Per-week Broadway context: the median gross of every show reporting that
 * week. A production's "gross index" is its gross divided by that median, so
 * a 2006 run and a 2025 run compare without an inflation series.
 */
function weeklyMedians(weeks) {
  const med = {};
  for (const [week, rows] of Object.entries(weeks)) {
    const grosses = Object.values(rows).map(r => r && r.gross).filter(g => typeof g === 'number' && g > 0).sort((a, b) => a - b);
    if (grosses.length < 5) continue;
    const m = grosses.length >> 1;
    med[week] = grosses.length % 2 ? grosses[m] : (grosses[m - 1] + grosses[m]) / 2;
  }
  return med;
}

/**
 * Average a production's weekly grosses rows over its first
 * OPENING_WINDOW_WEEKS reported weeks; `weeks` counts the whole run. `keys` is
 * every key the grosses history may file it under (id and slug both occur).
 * Returns null below MIN_GROSS_WEEKS.
 */
function grossSummary(weeks, medians, keys) {
  let n = 0, capSum = 0, capN = 0, idxSum = 0, idxN = 0, atpSum = 0, atpN = 0;
  for (const week of Object.keys(weeks).sort()) {
    const rows = weeks[week];
    let row = null;
    for (const k of keys) if (rows[k]) { row = rows[k]; break; }
    if (!row || !(row.gross > 0)) continue;
    n++;
    if (n > OPENING_WINDOW_WEEKS) continue;
    if (typeof row.capacity === 'number' && row.capacity > 0) { capSum += row.capacity; capN++; }
    if (typeof row.atp === 'number' && row.atp > 0) { atpSum += row.atp; atpN++; }
    if (medians[week]) { idxSum += row.gross / medians[week]; idxN++; }
  }
  if (n < MIN_GROSS_WEEKS) return null;
  const r1 = x => Math.round(x * 10) / 10;
  return {
    weeks: n,
    avgCapacity: capN ? r1(capSum / capN) : null,
    avgAtp: atpN ? Math.round(atpSum / atpN) : null,
    grossIndex: idxN ? Math.round((idxSum / idxN) * 100) / 100 : null,
  };
}

function median(xs) {
  const v = xs.filter(x => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : Math.round(((v[m - 1] + v[m]) / 2) * 100) / 100;
}

// Commercial designations that settle the recoupment question. Nonprofit
// houses, tour stops and TBD rows are not a recoup/no-recoup outcome.
const RECOUPED = new Set(RECOUPED_DESIGNATIONS);

function commercialOutcome(designation) {
  if (RECOUPED.has(designation)) return 'recouped';
  if (isUnrecoupedDesignation(designation)) return 'not-recouped';
  return null;
}

/** Star-led vs not, per type, on box office and recoupment. */
function commercialComparison(rows, { since = '2014-2015' } = {}) {
  // Nonprofit-house productions have no investors to pay back and price
  // tickets on subscription, so they would blur both halves of "does it pay".
  const sub = rows.filter(r => r.season >= since && r.designation !== 'Nonprofit');
  const group = pred => {
    const g = sub.filter(pred);
    const withGross = g.filter(r => r.grosses);
    const decided = g.filter(r => r.outcome);
    return {
      n: g.length,
      grossN: withGross.length,
      medianGrossIndex: median(withGross.map(r => r.grosses.grossIndex)),
      medianCapacity: median(withGross.map(r => r.grosses.avgCapacity)),
      medianAtp: median(withGross.map(r => r.grosses.avgAtp)),
      medianWeeks: median(withGross.map(r => r.grosses.weeks)),
      decidedN: decided.length,
      recoupPct: pct(decided.filter(r => r.outcome === 'recouped').length, decided.length),
    };
  };
  const out = { since, openingWindowWeeks: OPENING_WINDOW_WEEKS };
  for (const type of ['play', 'musical']) {
    out[type] = {
      star: group(r => r.type === type && r.screenStar),
      noStar: group(r => r.type === type && !r.screenStar),
    };
  }
  return out;
}

module.exports = {
  FIRST_SEASON, FAME, ERAS, MIN_GROSS_WEEKS, MAX_CAST_FOR_PROMPT, OPENING_WINDOW_WEEKS, CLASSIFIER_VERSION,
  selectStudyShows, isOneNightEvent, promptCast, classificationInputHash, validateClassification,
  hasScreenStar, hasCelebrity, bySeason, byEra, weeklyMedians, grossSummary,
  commercialOutcome, commercialComparison, median, pct,
};
