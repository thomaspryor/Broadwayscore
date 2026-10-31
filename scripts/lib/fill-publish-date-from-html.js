'use strict';
/**
 * Gap-fill a review record's publishDate from the fetched page's own metadata
 * (article:published_time, the main-article JSON-LD), never from the URL
 * (BRO-5859). recover-wayback-reviews.js wrote archived NYT texts with the
 * archived HTML in hand but never read its date: 19 complete NYT reviews
 * shipped undated.
 *
 * `notAfter` (YYYY-MM-DD, optional) bounds the date: an archive snapshot taken
 * on day D cannot hold a page published after D.
 * `source` is the dateSource to stamp (publish-date-provenance.js: 'html-archive'
 * for an archived copy, 'html-page' for the live page).
 * Returns the date set, or null. Mutates `data` only when it sets one.
 */
const { extractPublishDate } = require('./article-extractor');

function fillPublishDateFromHtml(data, html, { url, source, notAfter } = {}) {
  if (!data || data.publishDate || !html || typeof html !== 'string') return null;
  const date = extractPublishDate(html, url || data.url || '');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (notAfter && date > notAfter) return null;
  data.publishDate = date;
  data.dateSource = source || 'html-page';
  return date;
}

/** archive.org timestamp (20251009122353) → 2025-10-09, else null. */
function waybackTimestampDate(ts) {
  const m = String(ts || '').match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

module.exports = { fillPublishDateFromHtml, waybackTimestampDate };
