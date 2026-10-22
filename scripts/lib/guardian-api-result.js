'use strict';

const { isArticleOutsideProductionWindow } = require('./date-guard');

/**
 * Turn a Guardian Content API `content` object into a fetch result in the same
 * shape every scraper tier returns ({ text, html, method, attempts }), plus the
 * API's own metadata as `apiMeta`: { score, publishDate }.
 *
 * collect-review-texts.js used to return { fullText, contentTier, ... } here,
 * so the caller's `result.text.length` threw and every Guardian review failed
 * after the API had already returned its text (BRO-5851).
 *
 * `html` stays empty: the API body is a fragment with no <head>, canonical or
 * star widget, so the page-level extractors (score, date, title, walled-page
 * salvage) would read nothing or the wrong thing from it. The rating comes from
 * the API field instead, as in fetch-guardian-reviews.js, and the publish
 * date from webPublicationDate.
 *
 * Returns { result: null, reason } when the shortcut should not be used:
 * no usable body, or an article dated outside the production's window (a
 * revival's stale slug serving a prior production, the Glengarry 2017 case).
 */
/** The Europe/London calendar day of an ISO timestamp (a 00:30 BST post is that day, not the UTC day before). */
function londonDay(iso) {
  const d = new Date(iso || '');
  if (!iso || isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function guardianContentToResult(content, { show = null } = {}) {
  const fields = content && content.fields;
  if (!fields || !(fields.bodyText || fields.body)) return { result: null, reason: 'no usable body' };
  if (show && isArticleOutsideProductionWindow(show, content.webPublicationDate)) {
    return { result: null, reason: `article dated ${content.webPublicationDate} is outside this production's window` };
  }
  let text = fields.bodyText || '';
  if (!text && fields.body) {
    text = fields.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  if (text.length <= 200) return { result: null, reason: 'no usable body' };
  const stars = /^[1-5]$/.test(String(fields.starRating || '').trim()) ? Number(fields.starRating) : null;
  return {
    result: {
      text,
      html: '',
      method: 'guardian-api',
      attempts: [{ tier: 0, method: 'guardian-api', success: true }],
      apiMeta: {
        score: stars
          ? { originalScore: `${stars}/5 stars`, normalizedScore: Math.round((stars / 5) * 100), source: 'guardian-api' }
          : null,
        publishDate: londonDay(content.webPublicationDate),
      },
    },
    reason: null,
  };
}

module.exports = { guardianContentToResult, londonDay };
