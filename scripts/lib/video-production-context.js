/**
 * Production context for video-review verification (BRO-4328).
 *
 * The 2026-09-29 audit found ~10% of published video reviews filed under the
 * wrong production: West End runs, UK/US tours, out-of-town tryouts, a
 * community production and earlier revivals all landed on the Broadway id
 * with the same title. The classifier and the pre-share auditor were only
 * ever told the show TITLE, so they could not tell productions apart. These
 * helpers give them the venue, city and run dates, plus a deterministic
 * "posted before this production existed" rule.
 *
 * Pure so tests/unit/video-production-context.test.mjs can require() it.
 */

const MARKET_LABEL = {
  broadway: 'Broadway, New York City',
  'off-broadway': 'Off-Broadway, New York City',
  'west-end': 'West End, London',
  'off-west-end': 'Off-West End, London',
  regional: 'US regional theater',
  tour: 'touring production',
};

// A first-preview reaction can be posted the same night; a small grace also
// absorbs timezone and minor date-entry slop in shows.json.
const PREDATE_GRACE_DAYS = 7;

function parseYmd(s) {
  if (!s) return null;
  const str = String(s).trim();
  let m = str.match(/^(\d{4})(\d{2})(\d{2})$/) || str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (Number.isNaN(t)) return null;
  // Date.UTC rolls 2025-13-45 over into 2026; refuse anything that is not a real day.
  const d = new Date(t);
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : null;
}

/** One line a model can use to tell this production apart from others with the same title. */
function describeProduction(show) {
  const where = MARKET_LABEL[show.category] || MARKET_LABEL[show.market] || show.category || show.market || 'unknown market';
  const parts = [`"${show.title}" (${where})`];
  if (show.venue) parts.push(`at ${show.venue}${show.theaterAddress ? ` (${show.theaterAddress})` : ''}`);
  const dates = [];
  if (show.previewsStartDate) dates.push(`previews from ${show.previewsStartDate}`);
  if (show.openingDate) dates.push(`opened ${show.openingDate}`);
  if (show.closingDate) dates.push(`closed/closing ${show.closingDate}`);
  if (dates.length) parts.push(dates.join(', '));
  const ownStart = parseYmd(show.previewsStartDate) ?? parseYmd(show.openingDate);
  const start = productionStartMs(show);
  if (start !== null && (ownStart === null || start < ownStart)) {
    parts.push(`return engagement: the same production first played from ${new Date(start).toISOString().slice(0, 10)}`);
  }
  if (show.isRevival === true) parts.push('a revival');
  return parts.join('; ');
}

/**
 * Earliest known first performance of this PRODUCTION, as a UTC ms timestamp
 * (or null). One shows.json entry covers one run, so a return engagement's row
 * starts at the return; its earlier run of the identical production is
 * declared by `firstRunStart` (ISO date, BRO-4768; set only by an approved
 * plan). `priorRuns` is deliberately NOT used: it also records tryouts and
 * other-city runs the date rule exists to catch. Videos of
 * that earlier run review this production, so the date rule must start there.
 * Unparseable values are ignored.
 */
function productionStartMs(show) {
  const candidates = [
    parseYmd(show.previewsStartDate) ?? parseYmd(show.openingDate),
    parseYmd(show.firstRunStart),
  ].filter(t => t !== null);
  return candidates.length ? Math.min(...candidates) : null;
}

/** YYYY-MM-DD of productionStartMs, for log and reason lines. */
function productionStartDate(show) {
  const t = productionStartMs(show);
  return t === null ? null : new Date(t).toISOString().slice(0, 10);
}

/**
 * True when the video was posted clearly before this production's first
 * performance (including an earlier run of the same production, see
 * productionStartMs), so it cannot be a first-hand review of it (it reviews
 * an earlier, different production, a tryout, or another city's run).
 * Unknown dates (null, "NA") never count.
 */
function videoPredatesProduction(publishedAt, show, graceDays = PREDATE_GRACE_DAYS) {
  const posted = parseYmd(publishedAt);
  const start = productionStartMs(show);
  if (posted === null || start === null) return false;
  return posted < start - graceDays * 86400000;
}

/**
 * A wrongProduction flag set by verify-productions.js's date rule that the
 * rule no longer supports (an earlier run of the same production was recorded
 * after the flag, BRO-4768). Only method 'date' flags qualify: LLM, audit and
 * manual flags are never revisited by this.
 */
function isStaleDateFlag(t, show) {
  return !!t && t.wrongProduction === true && t.productionCheck?.method === 'date' && !videoPredatesProduction(t.publishedAt, show);
}

module.exports = { describeProduction, videoPredatesProduction, productionStartMs, productionStartDate, isStaleDateFlag, parseYmd, PREDATE_GRACE_DAYS };
