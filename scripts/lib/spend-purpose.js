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


/**
 * Press-night tag (BRO-5914): 'press-night:<showId>:<YYYY-MM-DD>', where the
 * date is the show's stored opening date. One tag = one show-night, which is
 * the key scrapingdog-caps.js's per-night spend cap counts ledger rows by.
 */
const PRESS_NIGHT_PREFIX = 'press-night';

function pressNightPurpose(showId, night) {
  return `${PRESS_NIGHT_PREFIX}:${showId}:${night}`;
}

/**
 * Parse a purpose tag. null = not a press-night tag (cap does not apply);
 * 'malformed' = starts with the prefix but is unusable (the cap fails closed
 * for that tag); otherwise { showId, night }.
 */
function parsePressNightPurpose(tag) {
  if (typeof tag !== 'string') return null;
  if (tag !== PRESS_NIGHT_PREFIX && !tag.startsWith(`${PRESS_NIGHT_PREFIX}:`)) return null;
  const m = /^press-night:([^:\s]+):(\d{4}-\d{2}-\d{2})$/.exec(tag);
  return m ? { showId: m[1], night: m[2] } : 'malformed';
}

/**
 * Pure: press-night tag for `show` at `nowMs`, or '' when the show is not inside
 * its press-night window. Uses the stored opening date only (no evidence): a
 * show whose date is evidence-only stays untagged, so it is neither capped nor
 * switched to the extra-spend empty-SERP handling.
 */
function pressNightPurposeForShow(show, nowMs = Date.now()) {
  if (!show || !show.id) return '';
  const { computeWindow } = require('./opening-night-windows');
  const now = new Date(nowMs);
  const w = computeWindow(show, { now });
  if (!w || w.anchor !== 'openingDate') return '';
  if (!(w.windowStart <= now && now <= w.windowEnd)) return '';
  return pressNightPurpose(show.id, w.openingDate);
}

/**
 * Scope count-and-warn spend to one show (BRO-5977). Call the returned cleanup
 * in finally, after all of the show's fetches settle. These entry points run
 * one show at a time; concurrent fetches within that show share the same tag.
 */
function beginPressNightSpend(show, nowMs = Date.now()) {
  const previousPurpose = process.env.SCRAPER_SPEND_PURPOSE;
  const previousMode = process.env.SD_PRESS_NIGHT_CAP_MODE;
  const purpose = pressNightPurposeForShow(show, nowMs);
  // Preserve dispatch purposes, but never inherit another show's press-night tag.
  process.env.SCRAPER_SPEND_PURPOSE = purpose
    || (parsePressNightPurpose(previousPurpose) === null ? previousPurpose || '' : '');
  if (purpose) process.env.SD_PRESS_NIGHT_CAP_MODE = 'warn';
  else delete process.env.SD_PRESS_NIGHT_CAP_MODE;
  return () => {
    if (previousPurpose === undefined) delete process.env.SCRAPER_SPEND_PURPOSE;
    else process.env.SCRAPER_SPEND_PURPOSE = previousPurpose;
    if (previousMode === undefined) delete process.env.SD_PRESS_NIGHT_CAP_MODE;
    else process.env.SD_PRESS_NIGHT_CAP_MODE = previousMode;
  };
}

/**
 * Is an empty Scrapingdog SERP a final answer for this gather query? On press
 * night it is not: Google has not indexed the reviews yet, so 0 results means
 * "not yet" and the query must keep falling through to ScrapingBee/Bright Data
 * and must not be cached (BRO-5914; the 860 gather accepted '0 organic
 * results' on 106 of 107 queries ~45 min after the embargo). Only opening-night
 * gathers of a show carrying the press-night tag, so every such query's spend
 * sits under that show-night's cap. Everything else keeps today's behaviour.
 */
function emptySerpAuthoritativeForGather({ openingNight, show, nowMs = Date.now() } = {}) {
  if (!openingNight) return true;
  // Independent kill switch: restores today's accept-empty behaviour without a rollback.
  if (process.env.GATHER_EMPTY_SERP_RETRY_DISABLED === '1') return true;
  return pressNightPurposeForShow(show, nowMs) === '';
}

module.exports = {
  emptySerpAuthoritativeForGather,
  HISTORICAL_BACKFILL, BACKFILL_CLOSED_DAYS, gatherPurposeForShow,
  PRESS_NIGHT_PREFIX, pressNightPurpose, parsePressNightPurpose, pressNightPurposeForShow,
  beginPressNightSpend,
};
