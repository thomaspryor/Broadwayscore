'use strict';
// The publish date ingest-review-from-url.js stores for a page (BRO-6588).
// Same order the collector uses (collect-review-texts.js, page date then the
// byline fallback): the caller's --publish-date, the page metadata
// (article:published_time / JSON-LD / <time>), The Stage's walled-page meta,
// then the one byline date in the first 500 chars of the article text. The
// ingest path used to stop after the metadata, so a page served without its
// <head> (TheWrap's A Few Good Men review) landed undated.

const { extractPublishDate } = require('./article-extractor');
const { extractDateFromText } = require('./body-date-mismatch');
const { bodyPublishDateFallback } = require('./publish-date-provenance');
const { extractDateFromUrl } = require('./url-date');

/**
 * @param {object} a
 * @param {string|null} [a.publishDateArg] - --publish-date, trusted as given
 * @param {string|null} [a.html]
 * @param {string} a.url
 * @param {string|null} [a.text] - extracted article body
 * @param {string|null} [a.stagePublishDate] - walled-page-meta date for The Stage
 * @returns {{publishDate: string|null, dateSource: 'text-regex'|null, from: 'arg'|'page'|'stage'|'text'|null, reason?: string}}
 */
// BRO-6716: a show-listing page (Cititour) carries the review but no article date,
// only the production's run block: "Open/Close Dates</b><br>Opening 4/12/2026".
// Read that labelled date only. A prior run's page prints its own, different date.
function listingOpeningDate(html) {
  if (typeof html !== 'string') return null;
  const m = html.match(/Open\/Close Dates(?:<[^>]+>|\s)*Opening\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i);
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function resolveIngestPublishDate({ publishDateArg = null, html = null, url, text = null, stagePublishDate = null, showOpeningDate = null } = {}) {
  if (publishDateArg) return { publishDate: publishDateArg, dateSource: null, from: 'arg' };
  const page = html ? extractPublishDate(html, url) : null;
  if (page) return { publishDate: page, dateSource: null, from: 'page' };
  if (stagePublishDate) return { publishDate: stagePublishDate, dateSource: null, from: 'stage' };
  // Same floor as the collector: under 100 chars there is no byline to read.
  const fallback = (typeof text !== 'string' || text.length <= 100)
    ? { publishDate: null, reason: 'no-body-date' }
    : bodyPublishDateFallback({ textDate: extractDateFromText(text), urlDate: url ? extractDateFromUrl(url) : null });
  if (fallback.publishDate) return { publishDate: fallback.publishDate, dateSource: fallback.dateSource, from: 'text' };
  // Last resort, never over a page or byline date: the listing's run block names
  // THIS production's opening night, so the review is dated to it.
  const listed = listingOpeningDate(html);
  if (listed && showOpeningDate && listed === String(showOpeningDate).slice(0, 10)) {
    return { publishDate: listed, dateSource: 'listing-opening-date', from: 'listing' };
  }
  // body-url-conflict: neither date wins; the rebuild's backfill settles it (BRO-5351).
  return { publishDate: null, dateSource: null, from: null, reason: fallback.reason };
}

module.exports = { resolveIngestPublishDate, listingOpeningDate };
