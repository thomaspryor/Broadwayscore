'use strict';
/**
 * BRO-4403: review URLs stored HTML-escaped ("...?categoryid=33&amp;cs=1").
 * Fetchers request the literal "&amp;" query, so re-collection fails. Decode at
 * the write chokepoint (safeWriteReview) and at fetch time (fetchPage).
 *
 * Only the ampersand entity is decoded: &lt;/&gt;/&quot; are not valid raw URL
 * characters, so decoding them could change meaning. Loops for double-escaped
 * ("&amp;amp;"). normalizeUrl() already folds &amp; -> &, so the URL-change
 * invariant sees decoded === same URL and does not clear verdicts.
 */
const { stripLeadingHtmlArtifacts } = require('./text-cleaning');

function decodeUrlEntities(url) {
  if (typeof url !== 'string' || !/&(?:amp|#0*38|#x0*26);/i.test(url)) return url;
  let out = url;
  for (let i = 0; i < 4; i++) {
    const next = out.replace(/&(?:amp|#0*38|#x0*26);/gi, '&');
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Normalize the two BRO-4403 artifacts on a review record (returns the same
 * object when nothing changes). Touches only `url` and a leading raw <img>
 * in `fullText`.
 */
function sanitizeReviewRecord(data) {
  if (!data || typeof data !== 'object') return data;
  let out = data;
  if (typeof data.url === 'string') {
    const u = decodeUrlEntities(data.url);
    if (u !== data.url) out = { ...out, url: u };
  }
  if (typeof data.fullText === 'string' && /^\s*<(?:img|source|br|meta|link|\/?picture)\b/i.test(data.fullText)) {
    const t = stripLeadingHtmlArtifacts(data.fullText);
    if (t !== data.fullText) out = { ...out, fullText: t };
  }
  return out;
}

module.exports = { decodeUrlEntities, sanitizeReviewRecord };
