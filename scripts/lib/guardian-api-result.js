'use strict';

/**
 * Turn a Guardian Content API `fields` object into a fetch result in the same
 * shape every scraper tier returns ({ text, html, method, attempts }).
 *
 * collect-review-texts.js used to return { fullText, contentTier, ... } here,
 * so the caller's `result.text.length` threw and every Guardian review failed
 * after the API had already returned its text (BRO-5851).
 *
 * Returns null when the API gave no usable body (caller falls back to scrapers).
 */
function guardianFieldsToResult(fields) {
  if (!fields || !(fields.bodyText || fields.body)) return null;
  let text = fields.bodyText || '';
  if (!text && fields.body) {
    text = fields.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  if (text.length <= 200) return null;
  const stars = fields.starRating ? parseInt(fields.starRating, 10) : undefined;
  return {
    text,
    html: fields.body || '',
    method: 'guardian-api',
    attempts: [{ tier: 0, method: 'guardian-api', success: true }],
    starRating: Number.isFinite(stars) ? stars : undefined,
  };
}

module.exports = { guardianFieldsToResult };
