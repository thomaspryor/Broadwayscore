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
const { extractDateFromUrl } = require('./rebuild-helpers');

/**
 * @param {object} a
 * @param {string|null} [a.publishDateArg] - --publish-date, trusted as given
 * @param {string|null} [a.html]
 * @param {string} a.url
 * @param {string|null} [a.text] - extracted article body
 * @param {string|null} [a.stagePublishDate] - walled-page-meta date for The Stage
 * @returns {{publishDate: string|null, dateSource: 'text-regex'|null, from: 'arg'|'page'|'stage'|'text'|null, reason?: string}}
 */
function resolveIngestPublishDate({ publishDateArg = null, html = null, url, text = null, stagePublishDate = null } = {}) {
  if (publishDateArg) return { publishDate: publishDateArg, dateSource: null, from: 'arg' };
  const page = html ? extractPublishDate(html, url) : null;
  if (page) return { publishDate: page, dateSource: null, from: 'page' };
  if (stagePublishDate) return { publishDate: stagePublishDate, dateSource: null, from: 'stage' };
  // Same floor as the collector: under 100 chars there is no byline to read.
  if (typeof text !== 'string' || text.length <= 100) return { publishDate: null, dateSource: null, from: null, reason: 'no-body-date' };
  const fallback = bodyPublishDateFallback({ textDate: extractDateFromText(text), urlDate: url ? extractDateFromUrl(url) : null });
  // body-url-conflict: neither date wins; the rebuild's backfill settles it (BRO-5351).
  if (!fallback.publishDate) return { publishDate: null, dateSource: null, from: null, reason: fallback.reason };
  return { publishDate: fallback.publishDate, dateSource: fallback.dateSource, from: 'text' };
}

module.exports = { resolveIngestPublishDate };
