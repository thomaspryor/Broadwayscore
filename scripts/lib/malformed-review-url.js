/**
 * BRO-5162: a review-text `url` must be an absolute http(s) URL with a dotted
 * host. Relative paths ('/people/Jesse-Green/'), review text stored as a url
 * ('[https://So](<https://So>)%20what...') and rediscovery protocol-upgrade
 * damage ('https://%20http:/www.newsday.com/...') all failed this check.
 */

const DOTTED_HOST = /^[^.\s/]+(\.[^.\s/]+)+$/;

function isWellFormedReviewUrl(url) {
  if (typeof url !== 'string' || !url || /\s/.test(url)) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  return /^https?:$/.test(u.protocol) && DOTTED_HOST.test(u.hostname);
}

/**
 * Pull an embedded absolute URL out of a damaged value ('https://%20http:/www.x.com/a',
 * 'https://%C2%A0http://x.com/a'). Returns a well-formed URL or null.
 */
function recoverEmbeddedUrl(url) {
  if (typeof url !== 'string') return null;
  if (isWellFormedReviewUrl(url.trim())) return url.trim();
  const tail = url.match(/\s(https?:\/\/[^\s<>)\]]+)\s*$/i);
  if (tail && isWellFormedReviewUrl(tail[1])) return tail[1];
  const m = url.match(/https?:\/\/(?:%20|%C2%A0|\s)*(https?:\/+[^\s<>)\]]+)/i);
  if (!m) return null;
  const fixed = m[1].replace(/^(https?:)\/+/i, '$1//');
  return isWellFormedReviewUrl(fixed) ? fixed : null;
}

/** '' / null / undefined mean "no url" and are fine. */
function classifyUrlField(url) {
  if (url == null || url === '') return { ok: true };
  if (isWellFormedReviewUrl(url)) return { ok: true };
  return { ok: false, recovered: recoverEmbeddedUrl(url) };
}

module.exports = { isWellFormedReviewUrl, recoverEmbeddedUrl, classifyUrlField };
