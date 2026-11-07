/**
 * publishDate backfill for a review file with no publishDate (BRO-4252).
 *
 * URL digits are usually the publication date, but a compact YYYYMMDD can be an
 * article id (Albany Times Union 'review-20161207.php' while the text said Feb 19,
 * 2025). A real URL date can never be LATER than the publication date, so for the
 * compact (article-id-prone) pattern only, a strict single dateline in the text that
 * is later than the URL date and not after the fetch time replaces it. Text dates
 * earlier than the URL date (a past event or production) never override, and the
 * text is never used when the URL gives nothing. Never falls back to the opening date.
 *
 * @returns {{ date: string, source: string } | null}
 */
const { extractDateFromUrl } = require('./rebuild-helpers');
const { extractSingleDate } = require('./text-single-date');

function resolveBackfillPublishDate(data) {
  const urlDate = extractDateFromUrl(data && data.url);
  if (!urlDate || !urlDate.date) return null;
  if (urlDate.source === 'url-compact' && typeof data.fullText === 'string') {
    const textDate = extractSingleDate(data.fullText);
    if (textDate && textDate > urlDate.date) {
      const fetched = Date.parse(data.textFetchedAt || data.firstSeenAt || '');
      if (Number.isNaN(fetched) || Date.parse(textDate) <= fetched + 86400000) {
        return { date: textDate, source: 'text-over-url-compact' };
      }
    }
  }
  return { date: urlDate.date, source: urlDate.source };
}

/**
 * The rebuild pre-opening pass's effective review date (BRO-4855): the guarded
 * publishDate (an LLM-guessed date is never the sole basis, BRO-4473), else a
 * FULL YYYY-MM-DD resolved from the url (never a bare year or YYYY-MM).
 * Shared by rebuild-all-reviews.js and scoring-delta.js's replay so the two
 * cannot disagree about whether a review "has a usable date".
 *
 * @param {object} data - review record
 * @param {object|null} show - shows.json record
 * @returns {Date|null}
 */
function resolveGuardReviewDate(data, show) {
  const { parseDate } = require('./date-utils');
  const { guardPublishDate } = require('./date-guard');
  if (!data) return null;
  const pd = parseDate(guardPublishDate(data, show).publishDate);
  if (pd && !isNaN(pd.getTime())) return pd;
  if (!data.url) return null;
  const urlDate = resolveBackfillPublishDate(data);
  if (urlDate && urlDate.date && /^\d{4}-\d{2}-\d{2}$/.test(urlDate.date)) {
    const parsed = parseDate(urlDate.date);
    if (parsed && !isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

module.exports = { resolveBackfillPublishDate, resolveGuardReviewDate };
