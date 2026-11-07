'use strict';

/**
 * Split a Wayback Machine snapshot URL into the page to fetch and the
 * original article URL a review file should carry (BRO-6448). The review
 * writer rejects a web.archive.org url for any outlet (domain-mismatch), so a
 * dead-URL review recovered from a snapshot must be stored under the original.
 * Returns { fetchUrl, url }; for any non-snapshot url both are the input.
 */
const WAYBACK_RE = /^https?:\/\/web\.archive\.org\/web\/\d{4,14}(?:[a-z]{2}_)?\/(https?:\/\/.+)$/i;

function unwrapWaybackUrl(input) {
  const m = WAYBACK_RE.exec(String(input || ''));
  if (!m) return { fetchUrl: input, url: input };
  return { fetchUrl: input, url: m[1] };
}

module.exports = { unwrapWaybackUrl };
