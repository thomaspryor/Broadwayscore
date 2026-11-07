'use strict';

/**
 * Spectra (spectra.theater): the successor home of the Lortel Archives /
 * Internet Off-Broadway Database (iobdb.com now redirects to
 * https://www.spectra.theater/library/offbroadway). BRO-6493.
 *
 * Why: ~90 off-Broadway rows store openingDate === previewsStartDate (IBDB and
 * several historical imports record the first performance as the opening),
 * and many have no Playbill production page, so the OB date enricher's only
 * per-show source (scripts/enrich-off-broadway-dates.js Phase 3) misses them.
 * Spectra carries IOBDB's own First Performance / Opening Date / Closing Date
 * for each production.
 *
 * Every Spectra explore page (production, work, venue) server-renders the
 * same production records in its React Server Component payload:
 *   {"id":"<uuid>","productionStartDate":"2023-04-17",
 *    "productionOpeningDate":"2023-04-27","productionEndDate":"2023-05-13",
 *    "productionYear":2023,"tierLevel":20,"tierDescription":"Off-Broadway",
 *    "licenseType":null,"productionName":"The Knight of the Burning Pestle",
 *    "brandName":"...", ...}
 * A VENUE page lists every production at that venue, so one fetch covers all
 * rows at the venue. productionOpeningDate is null when IOBDB never recorded
 * a press night: then there is no opening date to take (never guess).
 *
 * Pure functions only. The network path (SERP for the venue page, then
 * fetchPage) lives in the enricher; these are what it and the unit test
 * (scripts/lib/spectra-iobdb.test.mjs) both call (CLAUDE.md §15).
 */

const { titleWordsMatch } = require('./show-matching');

const SPECTRA_ORIGIN = 'https://www.spectra.theater';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const VENUE_URL_RE = new RegExp(`^https?://(?:www\\.)?spectra\\.theater/explore/venue/(${UUID})(?:[/?#]|$)`, 'i');
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A Spectra tier this script must never take a date from (a Broadway transfer of the same title). */
const EXCLUDED_TIERS = new Set(['broadway']);

/** Closing dates further apart than this are different engagements. */
const CLOSING_MATCH_MAX_DAYS = 7;

// Decode a JSON string body (the bit between the quotes) without trusting it.
function decodeJsonString(raw) {
  try { return JSON.parse(`"${raw}"`); } catch { return raw; }
}

function isoOrNull(v) {
  return typeof v === 'string' && ISO_RE.test(v) ? v : null;
}

/**
 * Every production record in a Spectra explore page, deduplicated by id.
 * Tolerates both the escaped (inside self.__next_f.push("...")) and the
 * unescaped form of the payload. Returns [] for anything that is not a
 * Spectra page (soft 404, challenge page, empty body).
 */
function parseSpectraProductions(html) {
  if (!html || typeof html !== 'string') return [];
  const text = html.replace(/\\"/g, '"');
  const re = new RegExp(
    `\\{"id":"(${UUID})","productionStartDate":("(?:[^"\\\\]|\\\\.)*"|null),` +
    `"productionOpeningDate":("(?:[^"\\\\]|\\\\.)*"|null),"productionEndDate":("(?:[^"\\\\]|\\\\.)*"|null),` +
    `"productionYear":(\\d{4}|null),"tierLevel":[^,]*,"tierDescription":("(?:[^"\\\\]|\\\\.)*"|null),` +
    `"licenseType":(?:"(?:[^"\\\\]|\\\\.)*"|null),"productionName":"((?:[^"\\\\]|\\\\.)*)"` +
    `(?:,"brandName":("(?:[^"\\\\]|\\\\.)*"|null))?`,
    'g',
  );
  const unq = (s) => (s && s !== 'null' ? decodeJsonString(s.slice(1, -1)) : null);
  const byId = new Map();
  let m;
  while ((m = re.exec(text)) !== null) {
    const id = m[1].toLowerCase();
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      startDate: isoOrNull(unq(m[2])),
      openingDate: isoOrNull(unq(m[3])),
      endDate: isoOrNull(unq(m[4])),
      year: m[5] && m[5] !== 'null' ? parseInt(m[5], 10) : null,
      tier: unq(m[6]),
      name: decodeJsonString(m[7]),
      brandName: unq(m[8] || null),
      url: `${SPECTRA_ORIGIN}/explore/production/${id}`,
    });
  }
  return [...byId.values()];
}

/** The venue's own name on a Spectra venue page (its follow-button entityName), or null. */
function parseSpectraVenueName(html) {
  if (!html) return null;
  const text = html.replace(/\\"/g, '"');
  const m = text.match(/"entityType":"venue","entityId":"[^"]*","entityName":"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  return decodeJsonString(m[1]).replace(/Â/g, '').trim() || null;
}

/** Canonical venue-page URL from any Spectra venue URL, or null. */
function toSpectraVenueUrl(url) {
  const m = String(url || '').match(VENUE_URL_RE);
  return m ? `${SPECTRA_ORIGIN}/explore/venue/${m[1].toLowerCase()}` : null;
}

/**
 * First SERP result that is a Spectra venue page whose result title names
 * the show's venue (venueMatches(ourVenue, resultTitle)). Pure: the caller
 * runs the SERP and supplies the venue-name predicate.
 */
function pickSpectraVenueUrl(serpResults, ourVenue, venueMatches) {
  if (!Array.isArray(serpResults) || !ourVenue || typeof venueMatches !== 'function') return null;
  for (const r of serpResults) {
    const url = toSpectraVenueUrl(r && r.url);
    if (!url) continue;
    if (!venueMatches(ourVenue, String((r && r.title) || '').replace(/Â/g, ''))) continue;
    return url;
  }
  return null;
}

function daysApart(a, b) {
  return Math.round(Math.abs(new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86400000);
}

/**
 * The single Spectra production record that IS this row's production, or a
 * reason it cannot be decided. All of:
 *   - title: titleMatches(show.title, productionName or brandName)
 *   - tier: never Broadway (a transfer of the same title)
 *   - year: productionYear === the row's own year (`showYear`, required)
 *   - identity: Spectra's first performance equals the row's stored
 *     previewsStartDate, OR both closing dates exist and agree within
 *     CLOSING_MATCH_MAX_DAYS; when both closings exist they must agree
 *     regardless (a same-start different-run record is a different
 *     engagement)
 *   - exactly one record passes (two = ambiguous, refuse)
 *
 * Returns { ok: true, record } or { ok: false, reason }.
 */
function matchSpectraProduction(records, show, { showYear, titleMatches = titleWordsMatch } = {}) {
  if (!show || !show.title) return { ok: false, reason: 'no-show' };
  if (!Number.isInteger(showYear)) return { ok: false, reason: 'no-show-year' };
  const list = Array.isArray(records) ? records : [];
  const titled = list.filter((r) => [r.name, r.brandName].some((n) => n && titleMatches(show.title, n)));
  if (titled.length === 0) return { ok: false, reason: 'no-title-match' };
  const sameYear = titled.filter((r) => r.year === showYear && !EXCLUDED_TIERS.has(String(r.tier || '').toLowerCase()));
  if (sameYear.length === 0) return { ok: false, reason: 'no-same-year-production' };
  const identified = sameYear.filter((r) => {
    const startAgrees = !!(r.startDate && show.previewsStartDate && r.startDate === show.previewsStartDate);
    const bothClosings = !!(r.endDate && show.closingDate);
    const closingAgrees = bothClosings && daysApart(r.endDate, show.closingDate) <= CLOSING_MATCH_MAX_DAYS;
    if (bothClosings && !closingAgrees) return false;
    return startAgrees || closingAgrees;
  });
  if (identified.length === 0) return { ok: false, reason: 'production-identity-unconfirmed' };
  if (identified.length > 1) return { ok: false, reason: 'ambiguous-spectra-production' };
  const record = identified[0];
  if (!record.openingDate) return { ok: false, reason: 'no-opening-date-on-page', record };
  return { ok: true, record };
}

module.exports = {
  SPECTRA_ORIGIN,
  CLOSING_MATCH_MAX_DAYS,
  parseSpectraProductions,
  parseSpectraVenueName,
  toSpectraVenueUrl,
  pickSpectraVenueUrl,
  matchSpectraProduction,
};
