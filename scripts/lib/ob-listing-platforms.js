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
  return t;
}

/** Any date-ish value → 'YYYY-MM-DD' (local date part as written), or null. */
function isoDay(value) {
  if (value == null) return null;
  const s = String(value).trim();
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
    const key = r.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { ...r }); continue; }
    if (r.firstDate && (!prev.firstDate || r.firstDate < prev.firstDate)) prev.firstDate = r.firstDate;
    if (r.lastDate && (!prev.lastDate || r.lastDate > prev.lastDate)) prev.lastDate = r.lastDate;
    if (typeof r.performanceCount === 'number') prev.performanceCount = (prev.performanceCount || 0) + r.performanceCount;
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
        performanceCount: subs.length || 1,
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
function parseDateRangeText(text, { todayIso = new Date().toISOString().slice(0, 10) } = {}) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return { firstDate: null, lastDate: null };
  const tokens = [];
  // Month-name dates: "Oct 3", "October 3, 2026", "Oct. 3rd 2026"
  const monthRe = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?:\s*[-–—]\s*(\d{1,2})(?:st|nd|rd|th)?(?!\d|\s*[a-z/])(?:,?\s+(\d{4}))?)?/gi;
  let m;
  while ((m = monthRe.exec(s)) !== null) {
    const mon = MONTHS[m[1].toLowerCase().replace(/\.$/, '')];
    if (!mon) continue;
    tokens.push({ idx: m.index, mon, day: Number(m[2]), year: m[3] ? Number(m[3]) : (m[5] ? Number(m[5]) : null) });
    // "Nov 20–23" → a second token in the same month
    if (m[4]) tokens.push({ idx: m.index + 1, mon, day: Number(m[4]), year: m[5] ? Number(m[5]) : (m[3] ? Number(m[3]) : null) });
  }
  // Numeric dates: 10/3/26, 10/03/2026
  const numRe = /\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/g;
  while ((m = numRe.exec(s)) !== null) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    tokens.push({ idx: m.index, mon: Number(m[1]), day: Number(m[2]), year: y });
  }
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
    const titleEl = card.querySelector(venue.titleSelector);
    const title = cleanListingTitle(titleEl ? titleEl.textContent : '');
    if (!title) continue;
    const dateEl = venue.dateSelector ? card.querySelector(venue.dateSelector) : null;
    const { firstDate, lastDate } = parseDateRangeText(dateEl ? dateEl.textContent : '', { todayIso });
    const a = venue.linkSelector ? card.querySelector(venue.linkSelector) : (card.matches && card.matches('a[href]') ? card : card.querySelector('a[href]'));
    rows.push({ title, firstDate, lastDate, performanceCount: null, url: a ? a.getAttribute('href') : null });
  }
  return mergeByTitle(rows);
}

// ---------------------------------------------------------------------------
// Fetch helpers (network; exercised by the dry-run, not unit-tested)
// ---------------------------------------------------------------------------

function getJson(url, { headers = {}, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers }, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(getJson(new URL(res.headers.location, url).toString(), { headers, timeoutMs }));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
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

async function fetchOvationTixBundle(clientId) {
  const headers = { clientId: String(clientId), newCIRequest: 'true' };
  const productions = await getJson(`${OVT_API}/Production?clientId=${encodeURIComponent(clientId)}`, { headers });
  if (!Array.isArray(productions)) throw new Error(`OvationTix ${clientId}: productions is not an array`);
  const performances = {};
  for (const p of productions.slice(0, OVT_MAX_PRODUCTIONS)) {
    try {
      const d = await getJson(`${OVT_API}/Production(${p.id})/performance`, { headers });
      performances[String(p.id)] = { performanceSummary: d.performanceSummary, performances: (d.performances || []).map(x => ({ startDate: x.startDate })) };
    } catch (e) {
      performances[String(p.id)] = { error: e.message };
    }
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

/** Parse a listing HTML string into a Document (shared by the HTML readers). */
function htmlToDocument(html) {
  return new JSDOM(html).window.document;
}

module.exports = {
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
};
