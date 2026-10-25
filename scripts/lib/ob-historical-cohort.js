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
  const start = entry.previewsStartDate || entry.openingDate;
  if (!entry.openingDate || !entry.closingDate) return { ok: false, reason: 'Playbill opening or closing date missing' };
  const closed = Date.parse(entry.closingDate);
  const today = Date.parse(todayIso);
  if (!(today - closed > minClosedDays * DAY_MS)) return { ok: false, reason: `closed ${minClosedDays} days ago or less` };
  if (!(closed - Date.parse(start) >= minRunDays * DAY_MS)) return { ok: false, reason: `run shorter than ${minRunDays} days` };
  return { ok: true, reason: 'promotable' };
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
    tags: [],
    discoverySource: 'ob-historical:tm',
    discoveredAt,
    openingDateSource: dateSource,
    closingDateSource: dateSource,
    evidenceUrls: evidenceUrls.filter(Boolean),
  };
  return { type: 'add-show', show };
}

module.exports = { decideObHistoricalEntry, toAddShowAction, MIN_RUN_DAYS };
