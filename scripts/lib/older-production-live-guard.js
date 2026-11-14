'use strict';
/**
 * older-production-live-guard — detects review files of an OLDER or OTHER
 * production that are live on a current show (BRO-4432).
 *
 * The date backstops (validate-data CHECK 0 / date-plausibility.js and the
 * review-guards URL-date rule) all key on a trustworthy publishDate. The
 * BRO-4428 coverage audit found two shapes they cannot see:
 *
 *   1. stale-wrong-verdict-tier: the file's own persisted contentTierReason is
 *      "Wrong production" / "Wrong show" (the classifier stamped it while the
 *      flag was set), but the flag has since gone with no human clear. The
 *      rebuild recomputes the tier from the (now missing) flag, so the review
 *      ships. Case: oliver-west-end-2024/thestage--dave-fargnoli.json, a review
 *      of The Other Place (Lyttelton), scored live on Oliver!.
 *
 *   2. url-date-contradiction: the URL carries its own publish date (a
 *      /YYYY/mon/DD/ path, or a Times version-1 article UUID, whose timestamp
 *      is the article's creation time) that falls outside every window of the
 *      show, while publishDate is missing or was stamped with the current
 *      run's date. Case: as-you-like-it-globe-west-end-2026, where the
 *      Guardian's 2022 Sohoplace review (/stage/2022/dec/15/) carried
 *      publishDate 2026-08-23, and a 2023 Times review had no date at all.
 *
 * The URL is used only as a contradiction signal against publishDate here,
 * never as a source of metadata written back to a file (CLAUDE.md §3). A URL
 * date inside a declared priorRuns window or tour leg is legitimate coverage
 * of the same production and is not reported (the window math is
 * review-guards' getWrongProductionReasonFromUrl, reused, not copied).
 *
 * Pure: no I/O. Consumed by audit-review-contamination.js class G.
 */

const { getWrongProductionReasonFromUrl } = require('./review-guards');
const { isEffectivelyWrongProductionOrShow } = require('./content-quality');

const STALE_VERDICT_TIER_REASON_RE = /^\s*wrong (production|show)\s*$/i;

// A publishDate within this many days of the URL's own date agrees with it.
const DATE_AGREEMENT_DAYS = 60;

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

// Gregorian offset between the UUID epoch (1582-10-15) and the Unix epoch, ms.
const UUID_EPOCH_OFFSET_MS = 12219292800000;

function isoDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (isNaN(dt.getTime()) || dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Publish date a URL carries about itself, or null.
 *   - /YYYY/MM/DD/ or /YYYY/mon/DD/ path (Guardian, WordPress blogs, NYSR).
 *     A month-only path (/YYYY/MM/) gives no day, so it is not used: the
 *     contradiction test below needs a real date.
 *   - thetimes.com / thetimes.co.uk /article/<uuid> where the UUID is
 *     version 1 (time-based). Version-4 UUIDs carry no date.
 * @param {string|null|undefined} url
 * @returns {{date:string, source:'path'|'times-uuid-v1'}|null}
 */
function urlOwnDate(url) {
  if (!url || typeof url !== 'string') return null;
  const p = url.match(/\/(20\d{2})\/(\d{2}|[a-z]{3,4})\/(\d{1,2})\//i);
  if (p) {
    const raw = p[2].toLowerCase();
    const month = /^\d{2}$/.test(raw) ? parseInt(raw, 10) : MONTHS[raw];
    const date = month ? isoDate(parseInt(p[1], 10), month, parseInt(p[3], 10)) : null;
    if (date) return { date, source: 'path' };
  }
  const t = url.match(/thetimes\.co(?:m|\.uk)\/.*?\barticle\/(?:[a-z0-9-]*-)?([0-9a-f]{8})-([0-9a-f]{4})-1([0-9a-f]{3})-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (t) {
    const ticks = (BigInt(`0x${t[3]}`) << 48n) | (BigInt(`0x${t[2]}`) << 32n) | BigInt(`0x${t[1]}`);
    const ms = Number(ticks / 10000n) - UUID_EPOCH_OFFSET_MS;
    const dt = new Date(ms);
    if (!isNaN(dt.getTime()) && dt.getUTCFullYear() >= 2000) {
      return { date: dt.toISOString().slice(0, 10), source: 'times-uuid-v1' };
    }
  }
  return null;
}

/**
 * Shape 1. A persisted "Wrong production"/"Wrong show" tier reason with no
 * effective flag and no human clear.
 * @param {object} review parsed review-text file
 * @returns {string|null}
 */
function staleWrongVerdictTierReason(review) {
  if (!review) return null;
  const reason = review.contentTierReason || review.tierReason;
  if (!STALE_VERDICT_TIER_REASON_RE.test(String(reason || ''))) return null;
  const { effectivelyWrongProduction, effectivelyWrongShow } = isEffectivelyWrongProductionOrShow(review);
  if (effectivelyWrongProduction || effectivelyWrongShow) return null;
  // A human said this IS the right production/show: the stale reason is noise.
  if (review.wrongProductionManualClear || review.wrongShowManualClear
    || review.humanReviewedWrongProduction === false) return null;
  return `persisted contentTierReason "${reason}" but no wrongProduction/wrongShow flag and no human clear`;
}

/**
 * Shape 2. The URL's own date sits outside every window of the show and
 * publishDate is missing or disagrees with it by more than DATE_AGREEMENT_DAYS.
 * When publishDate agrees with an out-of-window URL date, validate-data's
 * blocking CHECK 0 already sees the file, so it is left to that check.
 * @param {object} review parsed review-text file
 * @param {object} show shows.json entry
 * @returns {string|null}
 */
function urlDateContradictionReason(review, show) {
  if (!review || !show) return null;
  const own = urlOwnDate(review.url);
  if (!own) return null;
  const pub = review.publishDate ? new Date(require('./date-utils').toDateMs(review.publishDate)) : null;
  const pubValid = pub && !isNaN(pub.getTime());
  if (pubValid) {
    const gapDays = Math.abs(pub - new Date(own.date)) / 86400000;
    if (gapDays <= DATE_AGREEMENT_DAYS) return null;
  }
  const [y, m, d] = own.date.split('-');
  const windowReason = getWrongProductionReasonFromUrl(`https://x/${y}/${m}/${d}/`, show);
  if (!windowReason) return null;
  const pubText = pubValid ? `publishDate ${review.publishDate}` : 'no publishDate';
  return `URL's own date ${own.date} (${own.source}) is outside this show's runs and priorRuns, and the file has ${pubText}`;
}

/**
 * Both checks for one live (not already excluded) file.
 * @returns {{kind:'stale-wrong-verdict-tier'|'url-date-contradiction', reason:string}|null}
 */
function olderProductionLiveReason(review, show) {
  if (!review) return null;
  const { effectivelyWrongProduction, effectivelyWrongShow } = isEffectivelyWrongProductionOrShow(review);
  if (effectivelyWrongProduction || effectivelyWrongShow) return null;
  const stale = staleWrongVerdictTierReason(review);
  if (stale) return { kind: 'stale-wrong-verdict-tier', reason: stale };
  const contradiction = urlDateContradictionReason(review, show);
  if (contradiction) return { kind: 'url-date-contradiction', reason: contradiction };
  return null;
}

module.exports = {
  urlOwnDate,
  staleWrongVerdictTierReason,
  urlDateContradictionReason,
  olderProductionLiveReason,
  DATE_AGREEMENT_DAYS,
};
