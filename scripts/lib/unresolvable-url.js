'use strict';

/**
 * Google's opaque redirect/AMP cache URLs can't be resolved to an article.
 * SERP results sometimes return /goto?url=CAE... (relative) or
 * webcache.googleusercontent.com wrappers instead of the destination. They
 * break dedup (each redirect is unique), owner filtering (no hostname) and
 * fetching (no tier can load a relative path). Shared by brand-mention-serp
 * and review-file-writer (BRO-4458).
 */
function isUnresolvableRedirectUrl(url) {
  if (!url) return true;
  const s = String(url);
  if (s.startsWith('/')) return true;
  if (/^https?:\/\/(?:webcache\.googleusercontent\.com|(?:www\.)?google\.com\/amp)/i.test(s)) return true;
  try {
    const parsed = new URL(s);
    if (!['http:', 'https:'].includes(parsed.protocol)) return true;
  } catch {
    return true;
  }
  return false;
}

module.exports = { isUnresolvableRedirectUrl };
