'use strict';
/**
 * Spend-purpose tag for scraper ledger rows (BRO-4146).
 *
 * The owner keeps a daily historical backfill (closed shows re-searched for
 * missing reviews). Its SERP spend is first-time work no cache can save, so
 * the gather-reviews daily-credit probe (tests/unit/bro3887-cache-fix-
 * acceptance.test.mjs) excludes rows tagged HISTORICAL_BACKFILL and keeps its
 * 5K ceiling meaningful for everything else (a broken SERP cache peaked at
 * ~10K/day). gather-reviews.js sets SCRAPER_SPEND_PURPOSE per show;
 * provider-telemetry.js stamps it on rows whose caller passed no purpose.
 */
const HISTORICAL_BACKFILL = 'historical-backfill';
const BACKFILL_CLOSED_DAYS = 90;

/** Pure: purpose tag for a gather of `show` at `nowMs` ('' when not backfill). */
function gatherPurposeForShow(show, nowMs = Date.now()) {
  const closed = show && show.closingDate ? new Date(show.closingDate).getTime() : NaN;
  if (Number.isNaN(closed)) return '';
  return nowMs - closed > BACKFILL_CLOSED_DAYS * 86400 * 1000 ? HISTORICAL_BACKFILL : '';
}

module.exports = { HISTORICAL_BACKFILL, BACKFILL_CLOSED_DAYS, gatherPurposeForShow };
