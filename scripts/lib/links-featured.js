'use strict';

/** Carry the bio visitor's campaign attribution to the page they choose.
 * @param {string} href
 * @param {string} search
 */
function withBioUtm(href, search) {
  const url = new URL(href, 'https://broadwayscorecard.com');
  for (const [key, value] of new URLSearchParams(search)) {
    if (key.startsWith('utm_')) url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

module.exports = { withBioUtm };
