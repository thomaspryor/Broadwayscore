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

module.exports = { resolveBackfillPublishDate };
