/**
 * Opening-night discovery prefetch (BRO-4933).
 *
 * discover-opening-night-reviews.js used to write the SERP hit as an empty
 * stub (fullText null, "not_attempted") and rely on a later collect pass. In
 * the opening window that left e.g. the Evening Standard Rent review
 * unscored for hours. Fetch the body in the same run, with the same
 * fetchPage + extractArticleTextFromUrl path as ingest-review-from-url.js,
 * and take the byline from the page (JSON-LD author etc.) so the file is not
 * named --unknown.
 *
 * Failure is non-fatal: the caller falls back to the old empty stub.
 */

'use strict';

const MIN_BODY_CHARS = 200;

/**
 * @param {string} url
 * @param {Object} [opts]
 * @param {Function} [opts.fetchPageFn] - (url, {source}) => {content|html|body} | string
 * @param {string} [opts.criticName] - byline guessed from the SERP title
 * @returns {Promise<{fullText: string|null, publishDate: string|null, criticName: string|null}>}
 */
async function prefetchDiscoveredArticle(url, opts = {}) {
  const empty = { fullText: null, publishDate: null, criticName: opts.criticName || null };
  const fetchPageFn = opts.fetchPageFn || require('./scraper').fetchPage;
  const { extractArticleTextFromUrl, extractPublishDate } = require('./article-extractor');
  const { extractByline } = require('./byline-extraction');
  let html;
  try {
    const r = await fetchPageFn(url, { source: 'opening-night-discovery' });
    html = (r && (r.content || r.html || r.body)) || (typeof r === 'string' ? r : null);
  } catch {
    return empty;
  }
  if (!html || typeof html !== 'string' || html.length < 500) return empty;

  let text = '';
  try { text = extractArticleTextFromUrl(html, url, opts.criticName || null) || ''; } catch { text = ''; }
  let publishDate = null;
  try { publishDate = extractPublishDate(html, url) || null; } catch { publishDate = null; }
  let byline = null;
  try { byline = extractByline(html) || null; } catch { byline = null; }

  const hasBody = text.length >= MIN_BODY_CHARS;
  const serpName = opts.criticName && opts.criticName !== 'Unknown' ? opts.criticName : null;
  return {
    fullText: hasBody ? text : null,
    publishDate,
    criticName: serpName || byline || null,
  };
}

/** Merge a prefetch result into the createOrMergeReviewFile input. */
function applyPrefetch(input, pre) {
  const out = { ...input, fields: { ...input.fields } };
  if (pre && pre.criticName) out.criticName = pre.criticName;
  if (pre && pre.fullText) out.fields.fullText = pre.fullText;
  if (pre && pre.publishDate) out.fields.publishDate = pre.publishDate;
  return out;
}

module.exports = { prefetchDiscoveredArticle, applyPrefetch, MIN_BODY_CHARS };
