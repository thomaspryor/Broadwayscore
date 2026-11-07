'use strict';

/**
 * Dated listing readers for Off-Broadway venues (BRO-4396).
 *
 * The original OB venue readers (venue-listing-discover.js 'link'/'selector'/
 * 'regex') return bare titles, most of them derived from a URL slug
 * ("Diana Untold" for "Diana: The Untold and Untrue Story"). A bare title can
 * only be promoted when a second source (Playbill OB, TheaterMania) lists the
 * same show, so small runs never got in. These readers also capture the run
 * dates, which lets a venue's own listing count as the evidence
 * (decideVenueListingPromotion in ob-cross-validation.js).
 *
 * Several venues share a ticketing platform, so the readers here are generic:
 *   - OvationTix     (web.ovationtix.com public REST, one org id per venue)
 *   - Tribe Events   (WordPress "The Events Calendar" REST)
 *   - JSON-LD Event / TheaterEvent blocks on a listing page
 *   - dated cards    (title + date-range text inside a repeated card element)
 *
 * Every parser is pure and returns the same shape:
 *   [{ title, firstDate: 'YYYY-MM-DD'|null, lastDate: 'YYYY-MM-DD'|null,
 *      performanceCount: number|null, url: string|null }]
 * one row per production (performances of the same title are merged).
 * Fetch helpers live at the bottom and are exercised by the dry-run only.
 */

const https = require('https');
const { JSDOM } = require('jsdom');
const { parseJsonLd, hasJsonLdType } = require('./jsonld');
const { decodeHtmlEntities } = require('./text-cleaning');
const { isShoutedTitle, isExemptFromTitleCase, toDisplayTitleCase } = require('./title-display-case');
const { foldDiacritics } = require('./title-match');

const DAY_MS = 24 * 60 * 60 * 1000;
const USER_AGENT = 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0; +https://broadwayscorecard.com)';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Tidy a listing title: entities, tags, curly quotes, whitespace, shouting. */
function cleanListingTitle(raw) {
  let t = decodeHtmlEntities(String(raw == null ? '' : raw))
    .replace(/<[^>]*>/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  // Box-office systems store titles the way the marketing team typed them
  // ("LOVE ME", "KEVIN!!!!!"). validate-data.js flags a shouted title, so a
  // promotion carrying one would fail the run; recase unless the title is a
  // verified ALL-CAPS exemption.
  if (t && isShoutedTitle(t) && !isExemptFromTitleCase(undefined, t)) t = toDisplayTitleCase(t);
  // Box offices tag an annual return with its season ("A Christmas Carol the
  // Musical 2026"); the catalog year lives in the id, not the title.
  // Not when the year is part of the name ("Class of 2026", "Summer in 2027").
  // Season prefix: "2026: The Master Builder" (Arcola's Spektrix names).
  t = t.replace(/^20[2-3]\d:\s+/, '');
  // London box offices bracket it: "Cinderella (2026)" (Lyric Hammersmith).
  if (!/\b(?:of|in|since|circa|class)\s+20[2-3]\d$/i.test(t)) t = t.replace(/\s+(?:20[2-3]\d|\(20[2-3]\d\))$/, '').trim();
  return t;
}

const NY_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/**
 * Any date-ish value → 'YYYY-MM-DD', or null. A timestamp carrying a zone
 * ("2026-10-08T00:30:00Z", "...-04:00") is converted to its New York date
 * (Vivenu stores performances in UTC, so a 8pm show reads as the next day);
 * one without a zone is taken as written. Epoch numbers are ms (or s when
 * small enough to be seconds).
 */
function isoDay(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value < 1e11 ? value * 1000 : value);
    return Number.isNaN(d.getTime()) ? null : NY_DAY.format(d);
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return NY_DAY.format(d);
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

/**
 * Merge dated rows by normalized title: earliest first date, latest last
 * date, summed performance counts. Keeps the first-seen url.
 */
function mergeByTitle(rows) {
  const byKey = new Map();
  for (const r of rows) {
    if (!r || !r.title) continue;
    const key = foldDiacritics(r.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { ...r }); continue; }
    if (r.firstDate && (!prev.firstDate || r.firstDate < prev.firstDate)) prev.firstDate = r.firstDate;
    if (r.lastDate && (!prev.lastDate || r.lastDate > prev.lastDate)) prev.lastDate = r.lastDate;
    // An explicit null (a run of unknown size) keeps the merged count unknown.
    if (prev.performanceCount === null || r.performanceCount === null) prev.performanceCount = null;
    else if (typeof r.performanceCount === 'number') prev.performanceCount = (prev.performanceCount || 0) + r.performanceCount;
    if (!prev.url && r.url) prev.url = r.url;
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// OvationTix
// ---------------------------------------------------------------------------

/**
 * @param {{productions: object[], performances: Object<string, object>}} bundle
 *   productions = GET /trs/api/rest/Production?clientId=N
 *   performances[id] = GET /trs/api/rest/Production(id)/performance
 * @param {{clientId?: number|string}} [opts]
 */
function parseOvationTixBundle(bundle, opts = {}) {
  if (!bundle || !Array.isArray(bundle.productions)) return [];
  const perfById = bundle.performances || {};
  const rows = [];
  for (const p of bundle.productions) {
    if (!p || !p.productionName) continue;
    const detail = perfById[String(p.id)] || {};
    const perfs = Array.isArray(detail.performances) ? detail.performances : [];
    const days = perfs.map(x => isoDay(x && x.startDate)).filter(Boolean).sort();
    const summary = detail.performanceSummary || {};
    const last = isoDay(summary.lastPerformance && summary.lastPerformance.startDate) || days[days.length - 1] || null;
    const first = days[0] || isoDay(summary.nextPerformance && summary.nextPerformance.startDate) || null;
    // A production with no performances on sale is an archive row or a
    // placeholder, not a current booking.
    if (!first && !last) continue;
    const count = typeof summary.count === 'number' ? summary.count : perfs.length;
    const clientId = opts.clientId || p.clientId;
    rows.push({
      title: cleanListingTitle(p.productionName),
      firstDate: first,
      lastDate: last,
      performanceCount: count,
      url: clientId ? `https://ci.ovationtix.com/${clientId}/production/${p.id}` : null,
    });
  }
  return mergeByTitle(rows.filter(r => r.title));
}

// ---------------------------------------------------------------------------
// WordPress "The Events Calendar" (Tribe) REST
// ---------------------------------------------------------------------------

/** @param {{events: object[]}} json - GET /wp-json/tribe/events/v1/events */
function parseTribeEvents(json) {
  const events = json && Array.isArray(json.events) ? json.events : [];
  const rows = events.map(e => ({
    title: cleanListingTitle(e && e.title),
    firstDate: isoDay(e && e.start_date),
    lastDate: isoDay(e && (e.end_date || e.start_date)),
    performanceCount: 1,
    url: (e && e.url) || null,
  }));
  return mergeByTitle(rows.filter(r => r.title && r.firstDate));
}

// ---------------------------------------------------------------------------
// JSON-LD Event / TheaterEvent
// ---------------------------------------------------------------------------

const JSONLD_EVENT_TYPES = ['TheaterEvent', 'Event'];

function jsonLdEventNodes(items) {
  const out = [];
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 4) return;
    if (Array.isArray(node)) { for (const n of node) visit(n, depth + 1); return; }
    if (JSONLD_EVENT_TYPES.some(t => hasJsonLdType(node, t))) out.push(node);
    // ItemList → itemListElement → ListItem.item
    if (Array.isArray(node.itemListElement)) {
      for (const li of node.itemListElement) visit(li && li.item ? li.item : li, depth + 1);
    }
    // A venue node listing its events (schema.org Place/Organization `event`,
    // Marylebone Theatre's PerformingArtsTheater, BRO-4398).
    if (node.event && typeof node.event === 'object') visit(node.event, depth + 1);
  };
  for (const it of items) visit(it, 0);
  return out;
}

/** @param {Document} doc */
function extractDatedJsonLdEvents(doc) {
  const rows = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    const nodes = jsonLdEventNodes(parseJsonLd(script.textContent));
    for (const ev of nodes) {
      const subs = Array.isArray(ev.subEvent) ? ev.subEvent : (ev.subEvent ? [ev.subEvent] : []);
      const starts = [ev.startDate, ...subs.map(s => s && s.startDate)].map(isoDay).filter(Boolean).sort();
      const ends = [ev.endDate, ...subs.map(s => s && (s.endDate || s.startDate))].map(isoDay).filter(Boolean).sort();
      const first = starts[0] || null;
      const last = ends[ends.length - 1] || starts[starts.length - 1] || null;
      rows.push({
        title: cleanListingTitle(ev.name),
        firstDate: first,
        lastDate: last,
        // One node for a whole run ("startDate 2026-09-19, endDate
        // 2026-11-14", no subEvent) says nothing about how many shows it has:
        // unknown, not 1 (Menier's JSON-LD, BRO-4398).
        performanceCount: subs.length || (first && last && first !== last ? null : 1),
        url: typeof ev.url === 'string' ? ev.url : null,
      });
    }
  }
  return mergeByTitle(rows.filter(r => r.title));
}

// ---------------------------------------------------------------------------
// Dated cards: free-text date ranges
// ---------------------------------------------------------------------------

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function pad2(n) { return String(n).padStart(2, '0'); }

function validIso(y, m, d) {
  const iso = `${y}-${pad2(m)}-${pad2(d)}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * Parse listing date text into { firstDate, lastDate }.
 *   "Oct 3 – Nov 16, 2026", "October 3, 2026 - January 4, 2027",
 *   "Sep 30 - Oct 5", "Nov 20–23", "Through Nov 16", "10/3/26 - 11/16/26",
 *   "Tuesday, October 7, 2026"
 * A missing year is taken from the next dated token, or else chosen so the
 * date lands within [today - 180d, today + 365d]. Returns nulls when no date
 * is found. `through/until/thru` before a single date makes it lastDate only.
 */
function parseDateRangeText(text, { todayIso = new Date().toISOString().slice(0, 10), dayFirst = false } = {}) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return { firstDate: null, lastDate: null };
  const tokens = dayFirst ? dayFirstTokens(s) : monthFirstTokens(s);
  return resolveDateTokens(tokens, s, todayIso);
}

const MONTH_NAME_RE_SRC = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAY_RE_SRC = '(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?,?\\s+)?';

/**
 * UK order (BRO-4398, London venue cards): "Tue 8 Sep – Sat 31 Oct 2026",
 * "29 Sept - 24 Oct 2026", "13 - 24 October 2026", "Fri 16 - Fri 23 Oct
 * 2026", "5th March 2027", "30/09/2026". A bare day before a separator takes
 * the month and year of the next dated token ("13 - 24 October").
 */
function dayFirstTokens(s) {
  const tokens = [];
  const dayMonthRe = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_NAME_RE_SRC}\\b\\.?(?:,?\\s+(\\d{4}))?`, 'gi');
  let m;
  while ((m = dayMonthRe.exec(s)) !== null) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon) tokens.push({ idx: m.index, mon, day: Number(m[1]), year: m[3] ? Number(m[3]) : null });
  }
  const bareDayRe = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*[-–—]\\s*${WEEKDAY_RE_SRC}(?=\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_NAME_RE_SRC}\\b)`, 'gi');
  while ((m = bareDayRe.exec(s)) !== null) {
    const next = tokens.filter(t => t.idx > m.index).sort((a, b) => a.idx - b.idx)[0];
    if (!next) continue;
    const day = Number(m[1]);
    // "30 - 2 Nov" crosses a month end: the bare day belongs to October.
    const mon = day > next.day ? (next.mon === 1 ? 12 : next.mon - 1) : next.mon;
    const year = next.year == null ? null : (mon > next.mon ? next.year - 1 : next.year);
    tokens.push({ idx: m.index, mon, day, year });
  }
  const numRe = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b(?!\/)/g;
  while ((m = numRe.exec(s)) !== null) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
    tokens.push({ idx: m.index, mon: Number(m[2]), day: Number(m[1]), year: y });
  }
  return tokens;
}

function monthFirstTokens(s) {
  const tokens = [];
  // Month-name dates: "Oct 3", "October 3, 2026", "Oct. 3rd 2026"
  const monthRe = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?!\d|:|\s*(?:am|pm)\b)(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?:\s*[-–—]\s*(\d{1,2})(?:st|nd|rd|th)?(?!\d|:|\s*[a-z/])(?:,?\s+(\d{4}))?)?/gi;
  let m;
  while ((m = monthRe.exec(s)) !== null) {
    const mon = MONTHS[m[1].toLowerCase().replace(/\.$/, '')];
    if (!mon) continue;
    tokens.push({ idx: m.index, mon, day: Number(m[2]), year: m[3] ? Number(m[3]) : (m[5] ? Number(m[5]) : null) });
    // "Nov 20–23" → a second token in the same month
    if (m[4]) tokens.push({ idx: m.index + 1, mon, day: Number(m[4]), year: m[5] ? Number(m[5]) : (m[3] ? Number(m[3]) : null) });
  }
  // Numeric dates: 10/3/26, 10/03/2026
  const numRe = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b(?!\/)/g;
  while ((m = numRe.exec(s)) !== null) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
    tokens.push({ idx: m.index, mon: Number(m[1]), day: Number(m[2]), year: y });
  }
  return tokens;
}

function resolveDateTokens(tokens, s, todayIso) {
  if (tokens.length === 0) return { firstDate: null, lastDate: null };
  tokens.sort((a, b) => a.idx - b.idx);

  // Fill missing years from the next token that has one ("Oct 3 – Nov 16, 2026").
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].year == null && i + 1 < tokens.length && tokens[i + 1].year != null) {
      const next = tokens[i + 1];
      tokens[i].year = tokens[i].mon > next.mon ? next.year - 1 : next.year;
    }
  }
  const today = new Date(`${todayIso}T00:00:00Z`);
  const nearestYear = (mon, day) => {
    const y0 = today.getUTCFullYear();
    for (const y of [y0, y0 + 1, y0 - 1]) {
      const iso = validIso(y, mon, day);
      if (!iso) continue;
      const diff = (new Date(`${iso}T00:00:00Z`) - today) / DAY_MS;
      if (diff >= -180 && diff <= 365) return y;
    }
    return y0;
  };
  const isos = [];
  let prevIso = null;
  for (const t of tokens) {
    let year = t.year;
    if (year == null) {
      year = nearestYear(t.mon, t.day);
      // A year-less second date earlier in the calendar than the first rolls over.
      if (prevIso) {
        const cand = validIso(year, t.mon, t.day);
        if (cand && cand < prevIso) year = Number(prevIso.slice(0, 4)) + (t.mon < Number(prevIso.slice(5, 7)) ? 1 : 0);
      }
    }
    const iso = validIso(year, t.mon, t.day);
    if (iso) { isos.push(iso); prevIso = iso; }
  }
  if (isos.length === 0) return { firstDate: null, lastDate: null };
  const sorted = [...isos].sort();
  if (isos.length === 1 && /\b(through|thru|until|till|closes|closing|ends)\b/i.test(s)) {
    return { firstDate: null, lastDate: sorted[0] };
  }
  // "Starts Sep 9", "Previews begin Nov 5": the first date only, run end unknown.
  if (isos.length === 1 && /\b(starts?|begins?|beginning|from|opens|previews)\b/i.test(s)) {
    return { firstDate: sorted[0], lastDate: null };
  }
  return { firstDate: sorted[0], lastDate: sorted[sorted.length - 1] };
}

/**
 * Cards with a title element and a date element.
 * @param {Document} doc
 * @param {{itemSelector: string, titleSelector: string, dateSelector: string, linkSelector?: string}} venue
 */
function extractDatedCards(doc, venue, { todayIso } = {}) {
  if (!venue.itemSelector || !venue.titleSelector) {
    throw new Error(`extractDatedCards: venue ${venue.name} needs itemSelector + titleSelector`);
  }
  const root = venue.scopeSelector ? doc.querySelector(venue.scopeSelector) : doc;
  if (!root) return [];
  const rows = [];
  for (const card of root.querySelectorAll(venue.itemSelector)) {
    // A listing that spans several houses (Roundabout, Lincoln Center
    // Theater) keeps only cards naming this one.
    if (venue.itemMustMatch && !venue.itemMustMatch.test(card.outerHTML)) continue;
    if (venue.itemMustNotMatch && venue.itemMustNotMatch.test(card.textContent || '')) continue;
    const titleEl = card.querySelector(venue.titleSelector);
    const title = cleanListingTitle(titleEl ? titleEl.textContent : '');
    if (!title) continue;
    const dateEl = venue.dateSelector ? card.querySelector(venue.dateSelector) : null;
    const { firstDate, lastDate } = parseDateRangeText(dateEl ? dateEl.textContent : '', { todayIso, dayFirst: !!venue.dayFirst });
    const a = venue.linkSelector ? card.querySelector(venue.linkSelector) : (card.matches && card.matches('a[href]') ? card : card.querySelector('a[href]'));
    rows.push({ title, firstDate, lastDate, performanceCount: null, url: a ? a.getAttribute('href') : null });
  }
  return mergeByTitle(rows);
}


// ---------------------------------------------------------------------------
// Spektrix (public /api/v3/events)
// ---------------------------------------------------------------------------

/**
 * @param {object[]|{events: object[], instances?: object[]}} payload -
 *   GET https://<host>/<client>/api/v3/events, or that plus
 *   GET .../api/v3/instances (fetchSpektrixEvents with {instances: true}).
 *   With instances, each event's performance count is its number of
 *   non-cancelled instances, so the promotion gate can tell a run from a
 *   monthly club night (BRO-4398: London accounts sell those beside plays).
 * @param {{genres?: string[], genreField?: string, exclude?: Object<string, RegExp>}} [opts]
 *   genres: keep only events whose genre attribute is one of these (PAC NYC
 *   lists DJ sets, talks and access services on the same account).
 *   exclude: drop an event when any named field matches its RegExp
 *   (`{attribute_SupplementaryEvent: /^true$/i}` for add-ons).
 */
const RUN_BLOCK_GAP_DAYS = 30;

// The account's own genre labels for an event ("Musicals", "Musical - star
// casting", "Children's Show", "Drama"), joined: every Spektrix attribute whose
// name says genre/type/category/artform. Lets the promoter type a row from
// the box office instead of guessing from the title.
const SPEKTRIX_GENRE_ATTR_RE = /^attribute_(?:genre\d*|type|category|eventtype|webeventtype|taaartform|primaryartform|additionalgenreortype)$/i;
function spektrixGenreText(e) {
  const vals = Object.keys(e || {})
    .filter(k => SPEKTRIX_GENRE_ATTR_RE.test(k))
    .map(k => e[k])
    .filter(v => typeof v === 'string' && v.trim());
  return vals.length ? [...new Set(vals.map(v => v.trim()))].join('; ') : null;
}

/** Sorted ISO days → [{first, last, count}] blocks split at gaps over RUN_BLOCK_GAP_DAYS. */
function runBlocks(daysList) {
  const days = daysList.filter(Boolean).sort();
  const blocks = [];
  for (const d of days) {
    const cur = blocks[blocks.length - 1];
    if (cur && (Date.parse(`${d}T00:00:00Z`) - Date.parse(`${cur.last}T00:00:00Z`)) / DAY_MS <= RUN_BLOCK_GAP_DAYS) {
      cur.last = d;
      cur.count++;
    } else {
      blocks.push({ first: d, last: d, count: 1 });
    }
  }
  return blocks;
}

function parseSpektrixEvents(payload, opts = {}) {
  const events = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.events) ? payload.events : null);
  if (!events) return [];
  const instances = payload && !Array.isArray(payload) && Array.isArray(payload.instances) ? payload.instances : null;
  // Per event: its non-cancelled instance days, split into blocks wherever
  // two performances are more than RUN_BLOCK_GAP_DAYS apart. One Spektrix
  // event can hold separate bookings months apart (King's Head "God Is A
  // Woman The Musical": April, June and January blocks, BRO-4398 review);
  // the row describes the block that is current or next, not their union.
  let blocksById = null;
  if (instances) {
    const days = new Map();
    for (const i of instances) {
      const id = i && i.event && i.event.id;
      if (!id || i.cancelled === true) continue;
      if (!days.has(id)) days.set(id, []);
      days.get(id).push(isoDay(i.start) || null);
    }
    blocksById = new Map();
    for (const [id, list] of days) blocksById.set(id, runBlocks(list));
  }
  const todayIso = opts.todayIso || new Date().toISOString().slice(0, 10);
  const genreField = opts.genreField || 'attribute_Genre1';
  const genres = opts.genres ? new Set(opts.genres.map(g => g.toLowerCase())) : null;
  const exclude = opts.exclude ? Object.entries(opts.exclude) : [];
  const rows = [];
  for (const e of events) {
    if (!e || !e.name) continue;
    if (String(e.attribute_NoEventPage || '').toLowerCase() === 'true') continue;
    if (genres && !genres.has(String(e[genreField] || '').toLowerCase())) continue;
    if (exclude.some(([field, re]) => re.test(String(e[field] == null ? '' : e[field])))) continue;
    let firstDate = isoDay(e.firstInstanceDateTime);
    let lastDate = isoDay(e.lastInstanceDateTime);
    // instanceDates is display text ("September 16-October 18"), not a
    // list, so without the instances feed the count is unknown and the
    // gate falls back to "at least two distinct dates".
    let performanceCount = null;
    if (blocksById) {
      const blocks = blocksById.get(e.id) || [];
      const block = blocks.find(bl => bl.last >= todayIso) || blocks[blocks.length - 1];
      performanceCount = block ? block.count : 0;
      if (block && blocks.length > 1) { firstDate = block.first; lastDate = block.last; }
    }
    rows.push({ title: cleanListingTitle(e.name), firstDate, lastDate, performanceCount, url: e.webUrl || null, genre: spektrixGenreText(e) });
  }
  // An event whose instances were all cancelled (or none published) is not
  // on sale as a run.
  return mergeByTitle(rows.filter(r => r.title && (r.firstDate || r.lastDate) && r.performanceCount !== 0));
}

// ---------------------------------------------------------------------------
// Ticketsolve (BRO-4433): https://<client>.ticketsolve.com/shows.xml lists
// every on-sale show with one <event> per performance.
// ---------------------------------------------------------------------------

const cdataText = (s) => String(s == null ? '' : s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();

/**
 * Ticketsolve shows.xml → dated rows. Performance days are taken as written
 * (the venue's local date, never converted to New York), counted per run
 * block like parseSpektrixEvents; a show whose <event_category> matches
 * opts.excludeCategory (showcases, classes) is skipped.
 * @param {string} xml
 * @param {{todayIso?: string, excludeCategory?: RegExp}} [opts]
 */
function parseTicketsolveShows(xml, opts = {}) {
  if (typeof xml !== 'string' || !xml.includes('<show')) return [];
  const todayIso = opts.todayIso || new Date().toISOString().slice(0, 10);
  const rows = [];
  for (const m of xml.matchAll(/<show\b[^>]*>([\s\S]*?)<\/show>/g)) {
    const body = m[1];
    const eventsAt = body.indexOf('<events');
    // Show-level fields only: not the <events>, nor the <images> block whose
    // <url>s would shadow the show's own.
    const head = (eventsAt >= 0 ? body.slice(0, eventsAt) : body).replace(/<images\b[\s\S]*?<\/images>/g, '');
    const name = cdataText((head.match(/<name\b[^>]*>([\s\S]*?)<\/name>/) || [])[1]);
    const category = cdataText((head.match(/<event_category\b[^>]*>([\s\S]*?)<\/event_category>/) || [])[1]);
    if (!name || (opts.excludeCategory && opts.excludeCategory.test(category))) continue;
    const days = [];
    for (const e of body.matchAll(/<event\b[^>]*>([\s\S]*?)<\/event>/g)) {
      const status = cdataText((e[1].match(/<status\b[^>]*>([\s\S]*?)<\/status>/) || [])[1]).toLowerCase();
      if (status === 'cancelled' || status === 'canceled') continue;
      const when = cdataText((e[1].match(/<date_time_iso\b[^>]*>([\s\S]*?)<\/date_time_iso>/) || [])[1]);
      if (/^\d{4}-\d{2}-\d{2}/.test(when)) days.push(when.slice(0, 10));
    }
    const blocks = runBlocks(days);
    const block = blocks.find(bl => bl.last >= todayIso) || blocks[blocks.length - 1];
    if (!block) continue;
    const url = cdataText((head.match(/<url\b[^>]*>([\s\S]*?)<\/url>/) || [])[1]) || null;
    rows.push({ title: cleanListingTitle(name), firstDate: block.first, lastDate: block.last, performanceCount: block.count, url });
  }
  return mergeByTitle(rows.filter(r => r.title));
}

// ---------------------------------------------------------------------------
// Generic JSON path reader (WordPress REST, PatronTicket, Next.js page data)
// ---------------------------------------------------------------------------

/**
 * Values at a dotted path; `[]` flattens an array ("a.b[].c").
 * @returns {unknown[]}
 */
function valuesAtPath(obj, path) {
  if (!path) return [obj];
  let cur = [obj];
  for (const raw of String(path).split('.')) {
    const flatten = raw.endsWith('[]');
    const key = flatten ? raw.slice(0, -2) : raw;
    const next = [];
    for (const v of cur) {
      if (v == null || typeof v !== 'object') continue;
      const got = key === '' ? v : v[key];
      if (got === undefined || got === null) continue;
      if (flatten) { if (Array.isArray(got)) next.push(...got); }
      else next.push(got);
    }
    cur = next;
  }
  return cur;
}

/**
 * Read dated productions out of any JSON payload by config.
 * @param {unknown} payload
 * @param {{itemsPath: string, titleField: string, firstField?: string,
 *   lastField?: string, datesField?: string, urlField?: string,
 *   filterField?: string, filterAnyOf?: Array<string|number>}} spec
 *   datesField (a path under each item to every performance date) gives
 *   first/last/count when the item has no run fields.
 */
function extractJsonItems(payload, spec) {
  const items = valuesAtPath(payload, spec.itemsPath);
  const allow = spec.filterAnyOf ? new Set(spec.filterAnyOf.map(String)) : null;
  const rows = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (allow) {
      const vals = valuesAtPath(it, spec.filterField).flatMap(v => (Array.isArray(v) ? v : [v])).map(String);
      if (!vals.some(v => allow.has(v))) continue;
    }
    const title = cleanListingTitle(valuesAtPath(it, spec.titleField)[0]);
    if (!title) continue;
    let first = spec.firstField ? isoDay(valuesAtPath(it, spec.firstField)[0]) : null;
    let last = spec.lastField ? isoDay(valuesAtPath(it, spec.lastField)[0]) : null;
    let count = null;
    if (spec.datesField) {
      const days = valuesAtPath(it, spec.datesField).map(isoDay).filter(Boolean).sort();
      if (days.length) {
        first = first || days[0];
        last = last || days[days.length - 1];
        count = days.length;
      }
    }
    const url = spec.urlField ? valuesAtPath(it, spec.urlField)[0] : null;
    rows.push({ title, firstDate: first, lastDate: last, performanceCount: count, url: typeof url === 'string' ? url : null });
  }
  return mergeByTitle(rows);
}

/** The JSON a Next.js page embeds in <script id="__NEXT_DATA__">, or null. */
function extractNextData(html) {
  return extractAllNextData(html)[0] || null;
}

/** Every __NEXT_DATA__ payload in a string (several NYTG pages joined). */
function extractAllNextData(html) {
  const out = [];
  const re = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    try { out.push(JSON.parse(m[1])); } catch { /* skip a malformed block */ }
  }
  return out;
}

// New York Theatre Guide venue pages (/venues/<slug>) list each venue's
// current productions with start and closing dates in their page data. Used
// for rental houses whose own sites carry no listing, or sit behind a bot
// challenge (The Public, Park Avenue Armory, Theatre Row). An editorial
// listing like TheaterMania's, not the venue's own box office.
const NYTG_VENUE_SPEC = {
  itemsPath: 'props.pageProps.venueCurrentProducts[]',
  titleField: 'displayName',
  firstField: 'startingDate',
  lastField: 'closingDate',
};
const NYTG_BASE = 'https://www.newyorktheatreguide.com/venues/';

/** @param {string|string[]} htmls - one page per NYTG slug */
function parseNytgVenuePages(htmls) {
  const rows = [];
  for (const html of [].concat(htmls || [])) {
    for (const data of extractAllNextData(html)) rows.push(...extractJsonItems(data, NYTG_VENUE_SPEC));
  }
  return mergeByTitle(rows);
}

// ---------------------------------------------------------------------------
// Fetch helpers (network; exercised by the dry-run, not unit-tested)
// ---------------------------------------------------------------------------

function getJson(url, { headers = {}, timeoutMs = 30000, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: raw ? '*/*' : 'application/json', ...headers }, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(getJson(new URL(res.headers.location, url).toString(), { headers, timeoutMs, raw }));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (raw) { resolve(body); return; }
        try { resolve(JSON.parse(body)); } catch { reject(new Error(`non-JSON response from ${url}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`timeout for ${url}`)); });
    req.on('error', reject);
  });
}

const OVT_API = 'https://web.ovationtix.com/trs/api/rest';
// A busy org lists ~30 productions; anything far past that is a parser or
// API change, not a season.
const OVT_MAX_PRODUCTIONS = 80;
const OVT_PACE_MS = 250;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchOvationTixBundle(clientId) {
  const headers = { clientId: String(clientId), newCIRequest: 'true' };
  const productions = await getJson(`${OVT_API}/Production?clientId=${encodeURIComponent(clientId)}`, { headers });
  if (!Array.isArray(productions)) throw new Error(`OvationTix ${clientId}: productions is not an array`);
  const performances = {};
  const list = productions.slice(0, OVT_MAX_PRODUCTIONS);
  let failed = 0;
  for (const p of list) {
    // Paced and retried once: back-to-back calls drew a 403 on a second run
    // minutes later (ship-check 2026-09-29).
    let d = null;
    for (let attempt = 1; attempt <= 2 && !d; attempt++) {
      await sleep(attempt === 1 ? OVT_PACE_MS : OVT_PACE_MS * 8);
      try { d = await getJson(`${OVT_API}/Production(${p.id})/performance`, { headers }); } catch (e) { if (attempt === 2) performances[String(p.id)] = { error: e.message }; }
    }
    if (d) performances[String(p.id)] = { performanceSummary: d.performanceSummary, performances: (d.performances || []).map(x => ({ startDate: x.startDate })) };
    else failed++;
  }
  // A throttled run would otherwise drop productions silently (no dates →
  // skipped). Fail the venue instead so discovery logs it as failed.
  if (list.length && failed / list.length > 0.25) {
    throw new Error(`OvationTix ${clientId}: ${failed}/${list.length} performance fetches failed`);
  }
  return { productions: productions.map(({ description, ...rest }) => rest), performances };
}

async function fetchTribeEvents(siteUrl, { perPage = 50, maxPages = 4 } = {}) {
  const base = siteUrl.replace(/\/+$/, '');
  const events = [];
  for (let page = 1; page <= maxPages; page++) {
    let json;
    try {
      json = await getJson(`${base}/wp-json/tribe/events/v1/events?per_page=${perPage}&page=${page}`);
    } catch (e) {
      if (page > 1) break; // past the last page Tribe answers 400/404
      throw e;
    }
    events.push(...((json && json.events) || []));
    if (!json || !json.next_rest_url) break;
  }
  return { events };
}

async function fetchSpektrixEvents(url, { instances = false, todayIso = new Date().toISOString().slice(0, 10), timeoutMs } = {}) {
  const json = await getJson(url, timeoutMs ? { timeoutMs } : {});
  if (!Array.isArray(json)) throw new Error(`Spektrix ${url}: events is not an array`);
  if (!instances) return json;
  // The full instances feed runs to 3 MB / 40 s on a busy account
  // (Riverside Studios, 2026-09-30); 180 days back still covers the whole
  // of any run that is current, which is all the count is used for.
  const since = new Date(Date.parse(`${todayIso}T00:00:00Z`) - 180 * DAY_MS).toISOString().slice(0, 10);
  const instUrl = url.replace(/\/events\/?(\?.*)?$/, `/instances?startFrom=${since}`);
  // A slow or broken instances feed must not blank the venue: keep the
  // events with their counts unknown (the gate then needs a multi-day span).
  try {
    const inst = await getJson(instUrl, { timeoutMs: 90000 });
    if (!Array.isArray(inst)) throw new Error('instances is not an array');
    return { events: json, instances: inst };
  } catch (e) {
    console.warn(`::warning::Spektrix ${instUrl}: ${e.message} — reading events without performance counts`);
    return json;
  }
}

/** Parse a listing HTML string into a Document (shared by the HTML readers). */
function htmlToDocument(html) {
  return new JSDOM(html).window.document;
}

module.exports = {
  parseSpektrixEvents,
  parseTicketsolveShows,
  runBlocks,
  valuesAtPath,
  extractJsonItems,
  extractNextData,
  extractAllNextData,
  parseNytgVenuePages,
  NYTG_BASE,
  cleanListingTitle,
  isoDay,
  mergeByTitle,
  parseOvationTixBundle,
  parseTribeEvents,
  extractDatedJsonLdEvents,
  parseDateRangeText,
  extractDatedCards,
  htmlToDocument,
  getJson,
  fetchOvationTixBundle,
  fetchTribeEvents,
  fetchSpektrixEvents,
};
