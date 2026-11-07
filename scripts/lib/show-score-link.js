'use strict';

/**
 * Validate a Show Score page URL before it is shipped to the iOS app.
 *
 * The app used to invent `show-score.com/show/<title-slug>`, which 404s for
 * every show (BRO-4821). The real per-show page comes from
 * data/show-score-urls.json; this guard keeps a malformed entry from ever
 * reaching the app as a tappable link.
 *
 * Returns the URL when it is an https show-score.com page under one of the
 * known section prefixes, else null.
 */
const SECTION_PREFIXES = [
  '/broadway-shows/',
  '/off-broadway-shows/',
  '/off-off-broadway-shows/',
  '/uk/',
];

function sanitizeShowScoreUrl(url) {
  if (typeof url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== 'www.show-score.com' && parsed.hostname !== 'show-score.com') return null;
  const okPath = SECTION_PREFIXES.some(p => parsed.pathname.startsWith(p) && parsed.pathname.length > p.length);
  return okPath ? url : null;
}

module.exports = { sanitizeShowScoreUrl, SECTION_PREFIXES };
