'use strict';
/**
 * News-post guard for URL ingest (BRO-7817).
 *
 * A short announcement (closing date, opening date, anniversary, casting) at a review outlet is not a
 * review. ingest-urls.js wrote one as a review file (Front Row Center, "To Kill A Mockingbird Sets
 * Closing and Opening Dates", 986 chars) because nothing asked what the page was. Both signals must
 * agree before a page is refused: an announcement-shaped URL slug AND a short body that never says
 * "review". A long page, or one that says review, is never refused here.
 */

const NEWS_SLUG = /(?:^|[-/])(?:sets?-(?:closing|opening|a-closing)|closing-(?:date|and|on|august|september|october|november|december|january|february|march|april|may|june|july)|set-to-(?:open|close|begin)|celebrates?-\d+-(?:years?|anniversary)|announces?|extends?|extended|tickets?-(?:on-sale|now-on-sale)|cast-announced|casting-announced|to-close|to-open|to-extend)(?:-|\/|$)/i;
const MAX_NEWS_CHARS = 3000;
const REVIEW_WORD = /\breview(?:s|ed|er|ing)?\b/i;

function slugOf(url) {
  try { return new URL(url).pathname.replace(/\/+$/, '').split('/').slice(-1)[0] || ''; } catch { return String(url || ''); }
}

/**
 * @param {{url: string, text: string|null|undefined}} p
 * @returns {{news: boolean, reason?: string}}
 */
function classifyNewsPost({ url, text }) {
  const body = typeof text === 'string' ? text : '';
  if (!body) return { news: false };
  if (!NEWS_SLUG.test(slugOf(url))) return { news: false };
  if (body.length > MAX_NEWS_CHARS) return { news: false };
  if (REVIEW_WORD.test(body)) return { news: false };
  return { news: true, reason: `announcement-shaped url slug and a ${body.length}-char body with no "review"` };
}

module.exports = { classifyNewsPost, NEWS_SLUG, MAX_NEWS_CHARS };
