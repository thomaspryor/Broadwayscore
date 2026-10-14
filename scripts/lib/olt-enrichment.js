'use strict';
// venue-write-guard-ok: parseOltTheaterEvents only carries the OLT venue name into an in-memory parse result; every shows.json write downstream (discover-new-shows.js, enrich-west-end-dates.js) sanitizes through sanitizeVenueForWrite / the closing-date guard before saving.

/**
 * olt-enrichment.js — Official London Theatre (SOLT) readers and the
 * closingDate / ageRecommendation backfill decision for West End rows
 * (2026 data audit, S7-T10).
 *
 * Discovery (scripts/discover-new-shows.js, fetchShowsFromOfficialLondonTheatre)
 * has fetched OLT's listing page for months: every show is a standalone
 * <script type="application/ld+json"> TheaterEvent carrying startDate /
 * endDate / location. Its endDate was only ever used to seed NEW rows —
 * existing rows never had their closingDate backfilled, so The Gruffalo sat
 * status=open while OLT said "Closed 8 Sep", and 51 of 159 West End rows had
 * no closingDate at all. Age guidance is not in the listing JSON-LD; it is on
 * each show page (the "Age & Content" block, mirrored in a FAQPage JSON-LD
 * answer to "What age is X suitable for?"), which is what the per-show
 * reader below parses.
 *
 * Verified against the live pages 2026-09-28:
 *   - listing: 124 TheaterEvent blocks, none with subEvent, every endDate set;
 *   - `location.name` is the venue's OLT URL and `location.title` the human
 *     name on EVERY entry — a reader that takes `.name` writes a URL as the
 *     venue (discovery did exactly that before it moved onto this module);
 *   - show page: FAQ answer "… is recommended for ages 8+ | No under 16's …",
 *     HTML block "Age & Content 8+".
 *
 * Pure functions only (no fs, no network): the script fetches, this module
 * parses and decides, and tests/unit/olt-enrichment.test.mjs exercises the
 * real exports (CLAUDE.md §15).
 */

const { parseJsonLd, hasJsonLdType } = require('./jsonld');
const { isRecentlyLive, toUtcDayNumber } = require('./show-liveness');
const { getShowOpeningYear } = require('./ob-date-fix-eligibility');

const OLT_LISTING_URL = 'https://officiallondontheatre.com/theatre-tickets/';
const OLT_SOURCE = 'olt';

// Which rows the backfill may touch: live/announced West End rows, plus rows
// that closed in the last 90 days (a closingDate that arrived after the fact
// — the Gruffalo case — still lands, and the age guidance is still on the
// page). Older closed rows are left alone: OLT only lists current runs, so
// a title hit on an old row is a later production, not this one.
const OLT_LIVENESS = Object.freeze({
  liveStatuses: Object.freeze(['open', 'previews', 'upcoming', 'announced']),
  allowClosed: true,
  withinDays: 90,
});
const OLT_CATEGORIES = new Set(['west-end', 'off-west-end']);

// A matched OLT entry must belong to the row's own production: its run
// start year may differ from the row's year by at most this much (a run that
// opened in December carries next year's id; a long-runner's OLT startDate is
// its original opening). Anything wider is a same-title revival.
const YEAR_TOLERANCE = 1;

// OLT's endDate is the END OF THE CURRENT BOOKING PERIOD, which is only a
// closing date for a limited run. An open-ended commercial run books in
// tranches — the first dry-run (2026-09-28) would have stamped Hamilton
// "closing 2027-10-02", The Lion King "2027-05-16", The Mousetrap
// "2027-07-17" — and once written, a closingDate is never overwritten, so
// the tranche end would stay and eventually flip the row to closed. A
// limited West End run is 2-6 months; a booking tranche on an open-ended run
// spans a year or more from the run's start. Anything longer than this many
// days from the run's start (OLT startDate, else the row's own start) to the
// OLT endDate is treated as open-ended and left null.
const MAX_LIMITED_RUN_DAYS = 270;

// ---------------------------------------------------------------------------
// HTML / JSON-LD readers
// ---------------------------------------------------------------------------

const LD_JSON_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Raw text of every <script type="application/ld+json"> block, in order. */
function extractJsonLdBlocks(html) {
  const out = [];
  if (typeof html !== 'string') return out;
  LD_JSON_RE.lastIndex = 0;
  let m;
  while ((m = LD_JSON_RE.exec(html))) out.push(m[1]);
  return out;
}

/**
 * OLT titles arrive HTML-entity encoded inside the JSON ("Angel&#8217;s Bone",
 * "Franz &#038; Marie"). Same substitutions discovery applied inline, plus
 * generic numeric entities.
 */
function decodeOltText(value) {
  return String(value || '')
    .replace(/&#8217;|&#8216;|[‘’]/g, "'")
    .replace(/&#8220;|&#8221;|[“”]/g, '"')
    .replace(/&#8211;|[–]/g, '–')
    .replace(/&#8212;|[—]/g, '—')
    .replace(/&#038;|&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();
}

/** 'null' / '' / missing → null; otherwise the string as OLT sent it. */
function rawDateOrNull(value) {
  if (value === null || value === undefined || value === 'null' || value === '') return null;
  return String(value);
}

/** 'YYYY-MM-DD' from an ISO date/datetime string (written date), else null. */
function isoDay(value) {
  const raw = rawDateOrNull(value);
  if (!raw) return null;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * The human venue name from an OLT `location`. `location.name` is the
 * venue's OLT URL on the live page and `location.title` the name; take the
 * first candidate that is not a URL.
 */
function oltVenueName(location) {
  if (!location) return null;
  if (typeof location === 'string') return decodeOltText(location) || null;
  if (typeof location !== 'object') return null;
  for (const candidate of [location.title, location.name]) {
    if (typeof candidate !== 'string') continue;
    const text = decodeOltText(candidate);
    if (text && !/^https?:\/\//i.test(text)) return text;
  }
  return null;
}

/**
 * Every TheaterEvent on the OLT listing page (season containers with
 * subEvent skipped, untitled entries skipped). No dedupe and no
 * theatre/venue filtering — discovery applies its own on top.
 *
 * @param {string} html
 * @returns {Array<{title:string, venue:string|null, url:string|null,
 *   startDate:string|null, endDate:string|null, description:string}>}
 *   startDate/endDate are the raw strings OLT emitted ('null' normalised to
 *   null); use isoDay() for the calendar day.
 */
function parseOltTheaterEvents(html) {
  const events = [];
  for (const block of extractJsonLdBlocks(html)) {
    for (const node of parseJsonLd(block)) {
      if (!hasJsonLdType(node, 'TheaterEvent')) continue;
      if (node.subEvent) continue;
      const title = decodeOltText(node.name);
      if (!title) continue;
      events.push({
        title,
        venue: oltVenueName(node.location),
        url: typeof node.url === 'string' && node.url ? node.url : null,
        startDate: rawDateOrNull(node.startDate),
        endDate: rawDateOrNull(node.endDate),
        description: typeof node.description === 'string' ? node.description : '',
      });
    }
  }
  return events;
}

/**
 * Normalise an age-guidance phrase to the corpus format ("Ages 12+" —
 * 214 of 218 stored values; "All ages" for the rest). null when the text
 * carries no age.
 */
function normalizeAgeGuidance(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.replace(/\s+/g, ' ').trim();
  if (/\b(all ages|suitable for all|any age)\b/i.test(t)) return 'All ages';
  const m = t.match(/\b(?:ages?\s*)?(\d{1,2})\s*\+/i) || t.match(/\bages?\s+(\d{1,2})\b/i) || t.match(/\b(\d{1,2})\s*(?:years?|yrs?)?\s*(?:and|&)\s*(?:over|up|above)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > 21) return null;
  return `Ages ${n}+`;
}

/**
 * Age guidance from an OLT show page: the FAQPage JSON-LD answer to "What
 * age is … suitable for?" first, then the "Age & Content" HTML block.
 *
 * @param {string} html
 * @returns {string|null} 'Ages N+' | 'All ages' | null
 */
function parseOltAgeGuidance(html) {
  if (typeof html !== 'string' || !html) return null;
  for (const block of extractJsonLdBlocks(html)) {
    for (const node of parseJsonLd(block)) {
      if (!hasJsonLdType(node, 'FAQPage')) continue;
      const questions = Array.isArray(node.mainEntity) ? node.mainEntity : [];
      for (const q of questions) {
        if (!q || !/\bwhat age\b/i.test(String(q.name || ''))) continue;
        const answer = q.acceptedAnswer && (q.acceptedAnswer.text || q.acceptedAnswer);
        const age = normalizeAgeGuidance(typeof answer === 'string' ? decodeOltText(answer) : '');
        if (age) return age;
      }
    }
  }
  const idx = html.search(/Age\s*(?:&amp;|&)\s*Content/i);
  if (idx === -1) return null;
  const text = decodeOltText(html.slice(idx, idx + 600).replace(/<[^>]+>/g, ' '));
  return normalizeAgeGuidance(text.replace(/^Age\s*&\s*Content\s*/i, ''));
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

// Venue words that say nothing about WHICH venue: dropped before comparing.
const GENERIC_VENUE_TOKENS = new Set([
  'theatre', 'theater', 'royal', 'the', 'london', 'studios', 'studio', 'playhouse',
  'hall', 'centre', 'center', 'arts', 'west', 'end', 'new', 'old', 'and', 'at', 'of',
]);

function venueTokens(venue) {
  return new Set(
    decodeOltText(venue)
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 4 && !GENERIC_VENUE_TOKENS.has(t))
  );
}

/**
 * Loose venue agreement — a secondary guard behind the title match, not a
 * venue-equality decision (deduplication.js's venuesMatch is that, and is
 * deliberately exact, which would false-skip "Haymarket, Theatre Royal" vs
 * "Theatre Royal Haymarket"). Two venues agree when either side is missing
 * or carries no distinctive word, or they share one. Disagreement means the
 * matched row is playing somewhere else: another production of the title.
 */
function venuesAgree(rowVenue, oltVenue) {
  if (!rowVenue || !oltVenue) return true;
  const a = venueTokens(rowVenue);
  const b = venueTokens(oltVenue);
  if (a.size === 0 || b.size === 0) return true;
  for (const t of a) if (b.has(t)) return true;
  return false;
}

/** May the backfill touch this row at all (category + liveness)? */
function isOltEnrichable(show, { today } = {}) {
  if (!show || !OLT_CATEGORIES.has(show.category)) return false;
  return isRecentlyLive(show, today === undefined ? OLT_LIVENESS : { ...OLT_LIVENESS, today });
}

function yearOf(isoLike) {
  const day = isoDay(isoLike);
  return day ? Number(day.slice(0, 4)) : null;
}

function daysBetweenDays(fromDay, toDay) {
  const from = toUtcDayNumber(fromDay);
  const to = toUtcDayNumber(toDay);
  return from === null || to === null ? null : to - from;
}

/**
 * The backfill plan for one (row, OLT entry) pair. Pure.
 *
 *   closingDate      null on the row + endDate on the entry → fill (source 'olt')
 *                    humanCorrectedClosingDate: true         → skip, always
 *                    already set                             → skip (never overwrite)
 *                    endDate before the row's own start      → skip (bad data)
 *                    run start → endDate > MAX_LIMITED_RUN_DAYS
 *                                                            → skip (open-ended
 *                                                              run; endDate is a
 *                                                              booking tranche)
 *   ageRecommendation null/'' on the row + guidance parsed   → fill
 *                    already set                             → skip
 *   both             OLT run-start year > ±YEAR_TOLERANCE from the row's own
 *                    year, or the venues share no distinctive word
 *                    (venuesAgree) → skip everything (same-title other
 *                    production)
 *
 * @param {object} show   shows.json row
 * @param {object} entry  parseOltTheaterEvents() entry, optionally with
 *                        `ageRecommendation` (from parseOltAgeGuidance)
 * @returns {{changes: Array<{field:string, old:*, new:*, source:string}>,
 *            skips: Array<{field:string, reason:string}>}}
 */
function planOltEnrichment(show, entry) {
  const changes = [];
  const skips = [];
  if (!show || !entry) return { changes, skips: [{ field: '*', reason: 'missing-show-or-entry' }] };

  // Only the run's START dates a production; an endDate is a booking
  // tranche years after a long-runner's opening, so it must not stand in.
  const showYear = getShowOpeningYear(show);
  const entryYear = yearOf(entry.startDate);
  if (showYear !== null && entryYear !== null && Math.abs(entryYear - showYear) > YEAR_TOLERANCE) {
    return { changes, skips: [{ field: '*', reason: `production-year-mismatch (row ${showYear}, OLT run starts ${entryYear})` }] };
  }
  if (!venuesAgree(show.venue, entry.venue)) {
    return { changes, skips: [{ field: '*', reason: `venue-mismatch (row "${show.venue}", OLT "${entry.venue}")` }] };
  }

  // closingDate
  const endDay = isoDay(entry.endDate);
  const startDay = isoDay(show.openingDate) || isoDay(show.previewsStartDate);
  if (!endDay) {
    skips.push({ field: 'closingDate', reason: 'no-olt-end-date' });
  } else if (show.humanCorrectedClosingDate === true) {
    skips.push({ field: 'closingDate', reason: 'human-corrected' });
  } else if (show.closingDate) {
    skips.push({ field: 'closingDate', reason: 'already-set' });
  } else if (startDay && endDay < startDay) {
    skips.push({ field: 'closingDate', reason: `end-before-start (OLT ${endDay} < row ${startDay})` });
  } else {
    const runStart = isoDay(entry.startDate) || startDay;
    const runDays = runStart ? daysBetweenDays(runStart, endDay) : null;
    if (runDays !== null && runDays > MAX_LIMITED_RUN_DAYS) {
      skips.push({ field: 'closingDate', reason: `open-ended-run (${runStart} → ${endDay} is ${runDays}d; OLT endDate is a booking tranche, not a closing)` });
    } else {
      changes.push({ field: 'closingDate', old: null, new: endDay, source: OLT_SOURCE });
    }
  }

  // ageRecommendation
  const age = normalizeAgeGuidance(entry.ageRecommendation) || (entry.ageRecommendation === 'All ages' ? 'All ages' : null);
  if (!age) {
    skips.push({ field: 'ageRecommendation', reason: 'no-olt-age' });
  } else if (show.ageRecommendation !== null && show.ageRecommendation !== undefined && show.ageRecommendation !== '') {
    skips.push({ field: 'ageRecommendation', reason: 'already-set' });
  } else {
    changes.push({ field: 'ageRecommendation', old: show.ageRecommendation ?? null, new: age, source: OLT_SOURCE });
  }

  return { changes, skips };
}

module.exports = {
  OLT_LISTING_URL,
  OLT_SOURCE,
  OLT_LIVENESS,
  YEAR_TOLERANCE,
  MAX_LIMITED_RUN_DAYS,
  extractJsonLdBlocks,
  decodeOltText,
  isoDay,
  oltVenueName,
  parseOltTheaterEvents,
  normalizeAgeGuidance,
  parseOltAgeGuidance,
  venuesAgree,
  isOltEnrichable,
  planOltEnrichment,
};
