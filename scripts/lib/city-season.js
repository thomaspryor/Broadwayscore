'use strict';

/**
 * Season listings for finder-based city hubs (BRO-7250). Pure functions, no I/O: the CLI is
 * scripts/city-season-sync.js. A hub should list the local professional productions running now or
 * opening soon BEFORE any review exists, so the source is the producing theatre's own season page
 * (read by an LLM, every row checked against the page text) plus BroadwayWorld's regional listing
 * (dates and art, allowlisted theatres only).
 *
 * Rules carried from the hub work (BRO-6854, BRO-7239): a closing date is only written with its source;
 * tours, concerts, readings, galas, youth and amateur companies never become hub shows; ids follow
 * "<slug>-regional-<year>" (add-show-action.js).
 */

const { norm, hasPhrase, addDays } = require('./city-review-finder');
const { SEASON_SOURCES } = require('./city-finder-config');
const { sanitizeVenueForWrite } = require('./venue-classification');

const HORIZON_DAYS = 100; // "the next ~3 months"
const MAX_RUN_DAYS = 200; // a longer "run" is a season banner, not a production

const NON_PRODUCTION_RE = /\b(tour|school|youth|teen|kids?|family series|jr\.?|concert|recital|tribute|tree lighting|reading|gala|benefit|fundraiser|workshop|class(es)?|camp|auditions?|open house|improv|karaoke|trivia|silent movie|in concert|live in|storytime|story time|rental|subscription|season ticket|gift|membership|tbd)\b/i;

/** Houses that mostly present touring work: never a producing theatre for a local hub. */
const PRESENTERS = new Set(['ArtsEmerson', 'Emerson Colonial Theatre']);

/** The producing theatre a listing's venue string names, or null (not on the allowlist). */
function resolveTheatre(city, venue) {
  const n = norm(venue);
  if (!n) return null;
  for (const t of city.theatres) {
    const names = [t.name, ...(t.aliases || []), ...((SEASON_SOURCES[t.name] || {}).venues || [])];
    if (names.some((a) => hasPhrase(n, a))) return PRESENTERS.has(t.name) ? null : t;
  }
  return null;
}

const isIso = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(d));

/** A row is usable when it has real dates, runs now or inside the horizon, and is not a banner or non-production. */
function usableWindow(row, today, horizonDays = HORIZON_DAYS) {
  if (!isIso(row.start) || !isIso(row.end) || row.start > row.end) return false;
  if ((Date.parse(row.end) - Date.parse(row.start)) / 86400000 > MAX_RUN_DAYS) return false;
  return row.end >= today && row.start <= addDays(today, horizonDays);
}

/** BroadwayWorld regional-listing rows -> season rows, allowlisted professional theatres only. */
function fromBwwRows(rows, city, today, horizonDays = HORIZON_DAYS) {
  const out = [];
  for (const r of rows || []) {
    const t = resolveTheatre(city, r.theatre);
    if (!t || !t.pro || NON_PRODUCTION_RE.test(r.title)) continue;
    const row = { title: r.title, theatre: t.name, city: t.city || r.city, start: r.start, end: r.end, source: 'broadwayworld-regional-listing', pageUrl: r.bwwUrl, image: r.image || null };
    if (usableWindow(row, today, horizonDays)) out.push(row);
  }
  return out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const FULL = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** The page names this month with a day number beside it ("Nov 12", "12 November"), not just a word that starts alike. */
const monthIn = (text, iso) => {
  const i = Number(iso.slice(5, 7)) - 1;
  const m = `(?:${MONTHS[i]}\\.?|${FULL[i]})`;
  return new RegExp(`\\b${m}\\s*\\d{1,2}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s*${m}\\b`, 'i').test(text);
};

/**
 * LLM rows read from a theatre's season page -> season rows. Nothing the page does not say survives:
 * the title must appear in the page text, the start or end month must be named there, and a production link
 * must be one of the page's own links.
 */
function fromPageRows(rows, { theatre, pageText, pageLinks = [], pageUrl, today, horizonDays = HORIZON_DAYS }) {
  const hay = norm(pageText);
  const links = new Set(pageLinks);
  const out = [];
  for (const r of rows || []) {
    if (!r || !r.title || NON_PRODUCTION_RE.test(r.title)) continue;
    if (!` ${hay} `.includes(` ${norm(r.title)} `)) continue;
    const row = { title: String(r.title).trim(), theatre: theatre.name, city: theatre.city, start: r.start, end: r.end, source: 'theatre-season-page', type: r.type, pageUrl: links.has(r.url) ? r.url : pageUrl, image: null };
    if (!usableWindow(row, today, horizonDays)) continue;
    if (!monthIn(pageText, row.start) && !monthIn(pageText, row.end)) continue;
    out.push(row);
  }
  return out;
}

/**
 * Shows queued in pending-fix plans, so the daily job does not propose them twice. A plan that failed
 * validation, was rejected or was superseded must NOT count: its shows never reached shows.json and would
 * otherwise be locked out forever (BRO-7250 review). `skipFile(name)` drops the caller's own plan files.
 */
const LIVE_PLAN_STATUS = new Set(['pending', 'applied', 'partial']);
function pendingShows(plans) {
  const out = [];
  for (const pj of plans || []) {
    if (!pj || !LIVE_PLAN_STATUS.has(pj.status)) continue;
    for (const a of (pj.plan && pj.plan.actions) || []) if (a && a.show) out.push(a.show);
  }
  return out;
}

/**
 * BRO-7291 (class 6, wrong dates from season pages): the run printed on a production's OWN page
 * ("Extended! Oct 27 – Dec 13", "First Look (previews): Oct 27 - Nov 1 mat"). A season page or listing is a
 * summary that an LLM reads; GRIM came out of one as Nov 27 while its own page said Oct 27. Returns
 *   { first, end, opening, snippet }  first/last performance; opening = an "opening (night)|opens <date>" line, else
 *   the day after the last preview (same day for a matinee), else the first performance. null when no run is printed.
 * `year` is the season year (the row's start year); a range that wraps the new year moves its end to year + 1.
 */
const MON_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MON_N = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DASH = '\\s*(?:-|–|—|to|through|thru)\\s*';
const RANGE_RE = new RegExp(`\\b${MON_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d\\d))?${DASH}(?:${MON_RE}\\.?\\s+)?(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:,?\\s+(20\\d\\d))?`, 'gi');
const PREVIEW_RE = new RegExp(`preview(?:s|ing)?\\b[^.:]{0,20}:?\\s*${MON_RE}\\.?\\s+\\d{1,2}${DASH}(?:${MON_RE}\\.?\\s+)?(\\d{1,2})(?!\\d)(?:,?\\s+20\\d\\d)?(\\s+mat(?:inee)?\\b)?`, 'i');
const OPENS_RE = new RegExp(`\\b(?:opening(?:\\s+night)?|opens|official opening)\\s*:?\\s*(?:(?:sun|mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?)(?:day)?\\.?,?\\s+)?${MON_RE}\\.?\\s+(\\d{1,2})(?!\\d)`, 'i');
const pad2 = (n) => String(n).padStart(2, '0');
const monN = (m) => MON_N[String(m).toLowerCase().slice(0, 3)];
const okDate = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
function runRangeFromShowPage(text, { year } = {}) {
  const t = String(text || '').replace(/\s+/g, ' ');
  RANGE_RE.lastIndex = 0;
  let m;
  while ((m = RANGE_RE.exec(t))) {
    const m1 = monN(m[1]); const d1 = Number(m[2]);
    const m2 = m[4] ? monN(m[4]) : m1; const d2 = Number(m[5]);
    // "Jan 5 – Feb 9, 2027": the end's year names the start's too (one earlier when the run wraps the new year)
    const y1 = Number(m[3] || (m[6] ? Number(m[6]) - (m2 < m1 ? 1 : 0) : year));
    if (!y1 || !m1 || !m2 || !okDate(y1, m1, d1)) continue;
    let y2 = Number(m[6] || y1);
    if (!m[6] && (m2 < m1 || (m2 === m1 && d2 < d1))) y2 = y1 + 1;
    if (!okDate(y2, m2, d2)) continue;
    const first = `${y1}-${pad2(m1)}-${pad2(d1)}`;
    const end = `${y2}-${pad2(m2)}-${pad2(d2)}`;
    const days = (Date.parse(end) - Date.parse(first)) / 86400000;
    if (days < 1 || days > MAX_RUN_DAYS) continue; // a single performance window or a season banner
    let opening = first;
    const pv = PREVIEW_RE.exec(t);
    const op = OPENS_RE.exec(t);
    const pick = (mon, day) => { const mm = monN(mon); const dd = Number(day); if (!mm) return null; for (const yy of [y1, y1 + 1]) { const iso = `${yy}-${pad2(mm)}-${pad2(dd)}`; if (okDate(yy, mm, dd) && iso >= first && iso <= end) return iso; } return null; };
    // An explicit opening line wins; else the day after the last preview (the same day when previews end on a
    // matinee: GRIM "previews Oct 27 - Nov 1 mat", regular performances from Nov 1 eve); else the first performance.
    const opened = op && pick(op[1], op[2]);
    const lastPreview = pv && pick(pv[2] || pv[1], pv[3]);
    if (opened) opening = opened;
    else if (lastPreview) opening = pv[4] ? lastPreview : addDays(lastPreview, 1);
    return { first, end, opening, snippet: t.slice(Math.max(0, m.index - 30), m.index + m[0].length + 10).trim() };
  }
  return null;
}

/** Days between two ISO dates (absolute). */
const gapDays = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
/** A listing and a season page that disagree on the run by more than this need the production's own page. */
const DATE_CONFLICT_DAYS = 3;

const keyOf = (r) => `${norm(r.title)}|${norm(r.theatre)}`;

/** One row per production: theatre-page dates win over the listing; the listing's art is kept. */
function mergeSeason(lists) {
  const byKey = new Map();
  for (const row of lists.flat()) {
    const k = keyOf(row);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, { ...row, sources: [row.source] }); continue; }
    const winner = row.source === 'theatre-season-page' && prev.source !== 'theatre-season-page' ? row : prev;
    const loser = winner === row ? prev : row;
    // BRO-7291 class 6: two sources that disagree on the run are a question for the production's own page, not a coin toss.
    const conflict = prev.dateConflict || gapDays(row.start, prev.start) > DATE_CONFLICT_DAYS || gapDays(row.end, prev.end) > DATE_CONFLICT_DAYS
      ? { [row.source]: `${row.start}..${row.end}`, [prev.source]: `${prev.start}..${prev.end}`, ...(prev.dateConflict || {}) } : null;
    byKey.set(k, { ...winner, image: winner.image || loser.image, bwwUrl: [winner, loser].map((x) => x.pageUrl).find((u) => /broadwayworld/.test(u || '')) || null, sources: [...new Set([...(prev.sources || [prev.source]), row.source])], ...(conflict ? { dateConflict: conflict } : {}) });
  }
  return [...byKey.values()].sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}

/**
 * Settle a merged season row's dates against its production page (BRO-7291 class 6). `range` is
 * runRangeFromShowPage's result for row.pageUrl (null when there is no production page or it printed no run).
 * The page's run wins over the season page and the listing. Without it, a row whose sources disagree is held.
 * @returns {{ row: object, held: string|null }}
 */
function settleRunDates(row, range, pageUrl) {
  // A range that does not even overlap what the sources said is another production's (a sidebar, "also playing").
  if (range && !(range.first <= row.end && range.end >= row.start)) range = null;
  if (range) {
    return { row: { ...row, start: range.opening, end: range.end, source: 'theatre-show-page', dateNote: `production page "${range.snippet}" (${pageUrl})` }, held: null };
  }
  if (row.dateConflict) return { row, held: `sources disagree on the run (${Object.entries(row.dateConflict).map(([k, v]) => `${k} ${v}`).join(' vs ')}) and the production page printed none` };
  return { row, held: null };
}

/** Existing hub show for a season row (same title; venue names the theatre when the title is not unique). */
function findExisting(row, shows) {
  const yr = (d) => String(d || '').slice(0, 4);
  const same = shows.filter((s) => norm(s.title) === norm(row.title) && [yr(s.openingDate), yr(s.closingDate)].some((y) => y && (y === yr(row.start) || y === yr(row.end))));
  if (!same.length) return null;
  const th = norm(row.theatre).replace(/^the /, '');
  return same.find((s) => norm(s.venue || '').includes(th)) || null;
}

const slugify = (t) => String(t).toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** id "<title>-regional-<year>"; a clash adds the theatre's first word; a second clash drops the row. */
function showId(row, taken) {
  const year = row.start.slice(0, 4);
  const base = slugify(row.title);
  const first = slugify(row.theatre).replace(/^the-/, '').split('-')[0];
  return [`${base}-regional-${year}`, `${base}-${first}-regional-${year}`].find((id) => !taken.has(id)) || null;
}

/**
 * The add-show entry for a season row. Dates are the theatre's own (closingDate + closingDateSource);
 * `images` is filled by the caller once the art is on disk.
 */
function buildShow(row, { id, hubSlug, hub, city, today }) {
  return {
    id, title: row.title, slug: id,
    venue: sanitizeVenueForWrite(`${row.theatre}, ${row.city || city.defaultCity}, ${city.state}`),
    status: row.start > today ? 'upcoming' : 'open',
    type: row.type === 'musical' || row.type === 'play' ? row.type : (/\b(musical|cabaret|cinderella)\b/i.test(row.title) ? 'musical' : 'play'),
    category: 'regional', market: 'regional',
    openingDate: row.start, openingDateSource: row.dateNote || row.source,
    closingDate: row.end, closingDateSource: row.dateNote || row.source,
    discoverySource: hub.discoverySource,
    localOnly: true, city: hubSlug,
    discoveredAt: today,
    evidenceUrls: [row.pageUrl, row.bwwUrl].filter(Boolean).filter((u, i, a) => a.indexOf(u) === i).slice(0, 3),
  };
}

module.exports = { runRangeFromShowPage, settleRunDates, DATE_CONFLICT_DAYS, HORIZON_DAYS, NON_PRODUCTION_RE, resolveTheatre, usableWindow, fromBwwRows, fromPageRows, mergeSeason, findExisting, pendingShows, showId, buildShow, slugify };
