'use strict';

/**
 * ob-historical-cohort.js — cohort rules for the Off-Broadway historical
 * backfill (BRO-6153, docs/specs/ob-historical-backfill-v2.md).
 *
 * A TheaterMania listing is only the list of what to check. Promotion needs a
 * Playbill production page whose dates match (validate-show-venue.js), and
 * those Playbill dates are what get written. These pure functions decide the
 * rest: both dates known, the run long enough to be reviewed, and closed long
 * enough ago that gather tags its spend `historical-backfill`
 * (scripts/lib/spend-purpose.js BACKFILL_CLOSED_DAYS) and no opening-night or
 * "recent" surface treats it as current.
 */

const { BACKFILL_CLOSED_DAYS } = require('./spend-purpose');
const { sanitizeVenueForWrite } = require('./venue-classification');

const MIN_RUN_DAYS = 14;
const DAY_MS = 86400 * 1000;

/**
 * @param {object} entry  a buildShowEntry() result (promote-ob-historical.js)
 * @param {{todayIso: string, minClosedDays?: number, minRunDays?: number}} opts
 * @returns {{ok: boolean, reason: string}}
 */
function decideObHistoricalEntry(entry, { todayIso, minClosedDays = BACKFILL_CLOSED_DAYS, minRunDays = MIN_RUN_DAYS }) {
  if (!entry || !entry.id) return { ok: false, reason: 'no entry' };
  if (entry.idYearProvisional) return { ok: false, reason: 'id year not from Playbill dates' };
  // buildShowEntry falls back to the first preview when Playbill prints no
  // opening date, so the entry alone cannot tell. The caller marks it.
  if (entry.openingFromPlaybill === false) return { ok: false, reason: 'Playbill page has no opening date' };
  const start = entry.previewsStartDate || entry.openingDate;
  if (!entry.openingDate || !entry.closingDate) return { ok: false, reason: 'Playbill opening or closing date missing' };
  const closed = Date.parse(entry.closingDate);
  const today = Date.parse(todayIso);
  if (!(today - closed > minClosedDays * DAY_MS)) return { ok: false, reason: `closed ${minClosedDays} days ago or less` };
  if (!(closed - Date.parse(start) >= minRunDays * DAY_MS)) return { ok: false, reason: `run shorter than ${minRunDays} days` };
  return { ok: true, reason: 'promotable' };
}

/**
 * A validate-show-venue result whose only mismatches are structural facts the
 * candidate never asserted (isRevival, type). The plan's target carries no
 * claim about either, so Playbill's value is a fact to take, not a conflict.
 * Without this every Playbill-tagged revival reads as a mismatch.
 */
const STRUCTURAL_FIELDS = new Set(['isRevival', 'type', 'showType']);
/**
 * BRO-6470: TheaterMania's opening_date is often the first preview (Kimberly
 * Akimbo, Atlantic 2021: TM 11-05, Playbill previews 11-05, opens 12-08), and
 * the entry's dates are taken from Playbill anyway. So an opening date (or its
 * year) inside Playbill's preview-to-opening span is the same run, and once the
 * opening agrees a closing-date gap is TM's loose closing, not another production.
 */
function isPreviewSpanDate(d, dates) {
  if (!d || !dates || !dates.openingDate) return false;
  const from = dates.firstPreview || dates.openingDate;
  return d >= from && d <= dates.openingDate;
}
function isStructuralOnlyMismatch(r, { claimedOpening = null } = {}) {
  if (!r || r.result !== 'mismatch' || !Array.isArray(r.mismatches) || r.mismatches.length === 0) return false;
  const dates = r.parsed && r.parsed.dates;
  const opening = r.mismatches.find(m => m.field === 'openingDate');
  const openingInSpan = !!opening && isPreviewSpanDate(String(opening.shows || '').slice(0, 10), dates);
  // No openingDate mismatch means the opening AGREED only if one was claimed and compared;
  // with no claimed opening a closing gap is the only date evidence and stays a conflict.
  const openingAgreed = openingInSpan || (!opening && !!claimedOpening);
  return r.mismatches.every(m => {
    if (STRUCTURAL_FIELDS.has(m.field)) return true;
    if (m.field === 'openingDate') return openingInSpan;
    if (m.field === 'opening-year') {
      const ys = [dates && dates.firstPreview, dates && dates.openingDate].filter(Boolean).map(d => Number(d.slice(0, 4)));
      return ys.includes(Number(m.shows));
    }
    if (m.field === 'closingDate') return !!dates && !!dates.openingDate && openingAgreed;
    return false;
  });
}

/**
 * Playbill's own play/musical and revival labels for an entry, from the
 * validate result's parsed tag-line. Falls back to the entry's title guess.
 */
function playbillFacts(r, entry) {
  const tag = (r && r.parsed && r.parsed.tagLine) || {};
  const type = tag.showType === 'play' || tag.showType === 'musical' ? tag.showType : entry.type;
  // A bare "Revival" tag-line (no Play/Musical) already parses as 'unknown' (playbill-tagline.js).
  const isRevival = tag.revivalStatus === 'revival' ? true : tag.revivalStatus === 'original' ? false : null;
  const openingFromPlaybill = !!(r && r.parsed && r.parsed.dates && r.parsed.dates.openingDate);
  return { type, isRevival, openingFromPlaybill };
}

/**
 * The add-show action for a promotable entry, or null when the venue fails
 * sanitizeVenueForWrite. discoverySource marks the row as backfilled so a
 * cohort can be audited or reverted as a set.
 */
function toAddShowAction(entry, { discoveredAt, dateSource, evidenceUrls = [], discoverySource = 'ob-historical:tm' }) {
  const venue = sanitizeVenueForWrite(entry.venue);
  if (!venue) return null;
  const show = {
    id: entry.id,
    // Playbill prints some titles in quotes ("Anna Christie"); the id/slug
    // already drop them, the display title should too.
    title: String(entry.title || '').replace(/^["“](.*)["”]$/, '$1'),
    slug: entry.slug,
    venue,
    previewsStartDate: entry.previewsStartDate || null,
    openingDate: entry.openingDate,
    closingDate: entry.closingDate,
    status: 'closed',
    category: 'off-broadway',
    market: 'broadway',
    type: entry.type,
    // Not 'historical': on the site that tag is a theme ("historical
    // drama", src/lib/data-core.ts thematicTags). The OB historical audits
    // select these rows by discoverySource instead (isObHistoricalRow).
    tags: entry.isRevival === true ? ['revival'] : entry.isRevival === false ? ['new'] : [],
    ...(typeof entry.isRevival === 'boolean' ? { isRevival: entry.isRevival } : {}),
    discoverySource,
    discoveredAt,
    openingDateSource: dateSource,
    closingDateSource: dateSource,
    evidenceUrls: evidenceUrls.filter(Boolean),
  };
  return { type: 'add-show', show };
}

/**
 * BRO-6254: link fields for an add-show split from another production of the
 * same title (selectPromotable's transferOf). An earlier new run is linked
 * from the later one (crossLinkFrom puts priorRuns on the existing row); a
 * later new run names the earlier one (priorRunOf). {} when either run has
 * no opening date, since add-show-action refuses a link without one.
 */
function transferLinkFields(entry, other) {
  if (!entry || !other || !entry.openingDate || !other.openingDate) return {};
  return entry.openingDate < other.openingDate ? { crossLinkFrom: other.id } : { priorRunOf: other.id };
}

/**
 * Is this shows.json row part of the Off-Broadway historical backfill? Older
 * backfilled rows carry the 'historical' tag; rows this cohort script writes
 * carry discoverySource 'ob-historical:<source>' (BRO-6153). Shared by the
 * audit cohorts in audit-review-crossmodel.js and fact-check-sample.js.
 */
function isObHistoricalRow(s) {
  if (!s || s.market !== 'broadway' || s.category !== 'off-broadway') return false;
  return (Array.isArray(s.tags) && s.tags.includes('historical'))
    || String(s.discoverySource || '').startsWith('ob-historical:');
}

/**
 * BRO-6496: a census candidate's Playbill run must start in the cohort window.
 * TheaterMania rows are window-filtered before Playbill; census titles carry
 * only a review date, so a same-title page for another year (a 2008 revival
 * of a play reviewed in 2019) must not get through. First preview counts as
 * the start, as in isTmRowInWindow.
 */
function isEntryInWindow(entry, { fromIso, toIso }) {
  const start = entry && (entry.previewsStartDate || entry.openingDate);
  return !!start && start >= fromIso && start <= toIso;
}

module.exports = { isEntryInWindow, transferLinkFields, isObHistoricalRow, decideObHistoricalEntry, toAddShowAction, isStructuralOnlyMismatch, playbillFacts, MIN_RUN_DAYS };
