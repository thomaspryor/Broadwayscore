'use strict';
/**
 * Does a Show Score page's venue meta name the same venue as the show's venue?
 * (BRO-6825) audit-show-score-urls.js flagged same-venue pages as "wrong
 * production" because the page appends an operator or blurb ("Vivian Beaumont
 * Theater – Lincoln Center Theater", "Wyndham's Theatre, starring ..."), spaces
 * the name differently ("Black Box"/"Blackbox") or uses a handle ("@sohoplace").
 * A genuinely different venue (Palace vs Winter Garden) still fails.
 */
const { venuesMatch } = require('./deduplication');
const { foldDiacritics } = require('./title-match');

const compact = (s) => foldDiacritics(String(s || '')).toLowerCase().replace(/&#0?39;|[’‘]/g, "'").replace(/[^a-z0-9]/g, '');

function pageVenueMatches(pageVenue, showVenue) {
  if (!pageVenue || !showVenue) return false;
  if (venuesMatch(pageVenue, showVenue)) return true;
  const want = compact(showVenue);
  if (!want) return false;
  if (compact(pageVenue) === want) return true;
  // Leading segment before an operator/blurb separator.
  const lead = String(pageVenue).split(/\s[–—-]\s|,|\||:/)[0];
  return compact(lead) === want || venuesMatch(lead.trim(), showVenue);
}

module.exports = { pageVenueMatches };
