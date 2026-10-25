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
const STRUCTURAL_FIELDS = new Set(['isRevival', 'type']);
function isStructuralOnlyMismatch(r) {
  return !!r && r.result === 'mismatch' && Array.isArray(r.mismatches) && r.mismatches.length > 0
    && r.mismatches.every(m => STRUCTURAL_FIELDS.has(m.field));
}

/**
 * Playbill's own play/musical and revival labels for an entry, from the
 * validate result's parsed tag-line. Falls back to the entry's title guess.
 */
function playbillFacts(r, entry) {
  const tag = (r && r.parsed && r.parsed.tagLine) || {};
  const type = tag.showType === 'play' || tag.showType === 'musical' ? tag.showType : entry.type;
  const isRevival = tag.revivalStatus === 'revival' ? true : tag.revivalStatus === 'original' ? false : null;
  const openingFromPlaybill = !!(r && r.parsed && r.parsed.dates && r.parsed.dates.openingDate);
  return { type, isRevival, openingFromPlaybill };
}

/**
 * The add-show action for a promotable entry. discoverySource marks the row as
 * backfilled so a cohort can be audited or reverted as a set.
 */
function toAddShowAction(entry, { discoveredAt, dateSource, evidenceUrls = [] }) {
  const show = {
    id: entry.id,
    title: entry.title,
    slug: entry.slug,
    venue: entry.venue,
    previewsStartDate: entry.previewsStartDate || null,
    openingDate: entry.openingDate,
    closingDate: entry.closingDate,
    status: 'closed',
    category: 'off-broadway',
    market: 'broadway',
    type: entry.type,
    // 'historical' is what the OB historical audits select on
    // (audit-review-crossmodel.js isHist, fact-check samples).
    tags: ['historical', entry.isRevival ? 'revival' : 'new'],
    ...(typeof entry.isRevival === 'boolean' ? { isRevival: entry.isRevival } : {}),
    discoverySource: 'ob-historical:tm',
    discoveredAt,
    openingDateSource: dateSource,
    closingDateSource: dateSource,
    evidenceUrls: evidenceUrls.filter(Boolean),
  };
  return { type: 'add-show', show };
}

module.exports = { decideObHistoricalEntry, toAddShowAction, isStructuralOnlyMismatch, playbillFacts, MIN_RUN_DAYS };
