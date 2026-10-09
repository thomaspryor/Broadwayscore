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

function outletEntryFor(outletId) {
  try { return (require('../../data/outlet-registry.json').outlets || {})[outletId]; } catch { return undefined; }
}

/**
 * @param {string} url
 * @param {Object} [opts]
 * @param {Function} [opts.fetchPageFn] - (url, {source}) => {content|html|body} | string
 * @param {string} [opts.criticName] - byline guessed from the SERP title
 * @param {string} [opts.outletId] - canonical outlet id; unregistered outlets are not prefetched
 *   (the writer's unknown-outlet guard only refuses text-less files, so body text would defeat it)
 * @param {string} [opts.showId] - for multi-show post section isolation
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{fullText: string|null, publishDate: string|null, criticName: string|null}>}
 */
async function prefetchDiscoveredArticle(url, opts = {}) {
  const empty = { fullText: null, publishDate: null, criticName: opts.criticName || null };
  if (opts.outletId !== undefined) {
    let registry = {};
    try { registry = require('../../data/outlet-registry.json').outlets || {}; } catch { registry = {}; }
    if (!opts.outletId || opts.outletId === 'unknown' || !registry[opts.outletId]) return empty;
  }
  const fetchPageFn = opts.fetchPageFn || require('./scraper').fetchPage;
  const { extractArticleTextFromUrl, extractPublishDate } = require('./article-extractor');
  const { extractByline } = require('./byline-extraction');
  const { stripTrailingJunk } = require('./text-cleaning');
  const { isolateMultiShowSectionForShowId } = require('./multi-show-section-extract');
  const { resolveCritic } = require('./resolve-critic');
  let html;
  try {
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('prefetch timeout')), opts.timeoutMs || 45000); });
    const r = await Promise.race([fetchPageFn(url, { source: 'opening-night-discovery' }), timeout]).finally(() => clearTimeout(timer));
    html = (r && (r.content || r.html || r.body)) || (typeof r === 'string' ? r : null);
  } catch {
    return empty;
  }
  if (!html || typeof html !== 'string' || html.length < 500) return empty;

  let text = '';
  try {
    text = stripTrailingJunk(extractArticleTextFromUrl(html, url, opts.criticName || null) || '') || '';
    if (text && opts.showId) {
      const iso = isolateMultiShowSectionForShowId(url, text, opts.showId);
      text = iso.action === 'refuse' ? '' : (iso.text || '');
    }
  } catch { text = ''; }
  let publishDate = null;
  try { publishDate = extractPublishDate(html, url) || null; } catch { publishDate = null; }
  let byline = null;
  try { byline = extractByline(html) || null; } catch { byline = null; }

  const hasBody = text.length >= MIN_BODY_CHARS;
  const serpName = opts.criticName && opts.criticName !== 'Unknown' ? opts.criticName : null;
  const resolved = resolveCritic({ criticArg: serpName, byline, outletEntry: outletEntryFor(opts.outletId) });
  const criticName = resolved === 'Unknown' ? null : resolved;
  return {
    fullText: hasBody ? text : null,
    publishDate,
    criticName,
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
