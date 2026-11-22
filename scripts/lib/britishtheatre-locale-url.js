'use strict';
// BRO-8017: britishtheatre.com serves translated copies under /ar|ko|fr|es|de|ja|zh|pt|it/.
// SERP discovery saved those; the translated page fails content verification.
const LOCALE_RE = /^(https?:\/\/(?:www\.)?britishtheatre\.com)\/(?:ar|ko|fr|es|de|ja|zh|pt|it)(\/posts\/)/i;

/** Rewrite a locale-prefixed britishtheatre.com /posts/ URL to its canonical form. Other URLs unchanged. */
function canonicalBritishTheatreUrl(url) {
  if (typeof url !== 'string') return url;
  return url.replace(LOCALE_RE, '$1$2');
}
function hasBritishTheatreLocalePrefix(url) {
  return typeof url === 'string' && LOCALE_RE.test(url);
}
module.exports = { canonicalBritishTheatreUrl, hasBritishTheatreLocalePrefix };
