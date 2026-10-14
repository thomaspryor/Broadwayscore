/**
 * publishDate backfill for a review file with no publishDate (BRO-4252).
 * A dateline printed in the article text outranks digits in the URL: URL digits are
 * often an article id (Albany Times Union 'review-20161207.php' -> 2016-12-07 while the
 * text said Feb 19, 2025). Returns { date, source } or null; callers never fall back to
 * the show's opening date.
 */
const { textDateline } = require('./date-guard');
const { extractDateFromUrl } = require('./rebuild-helpers');

function resolveBackfillPublishDate(data) {
  const textDate = textDateline(data && data.fullText);
  if (textDate) return { date: textDate, source: 'text-dateline' };
  const urlDate = extractDateFromUrl(data && data.url);
  if (urlDate && urlDate.date) return { date: urlDate.date, source: urlDate.source };
  return null;
}

module.exports = { resolveBackfillPublishDate };
