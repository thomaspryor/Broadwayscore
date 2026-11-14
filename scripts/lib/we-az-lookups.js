/**
 * Theatre Record A-Z titles -> TR lookup rows for resolve-we-unlisted-tr.js
 * (BRO-6298). WhatsOnStage lists almost nothing before 2018-19 (5 unlisted
 * West End reviews for 2015-16), so the A-Z of London productions that
 * build-we-az-season.js parses is the season's title source.
 *
 * A row is a lookup when the A-Z gives a West End venue, or no venue at all
 * (the 2015 layout prints none; the TR production page supplies it and
 * decideWeHistoricalPromotion() then applies isWestEndVenue to that venue).
 * `date` is the A-Z opening date, else the as-at date of the first issue that
 * listed the title: the production was running then, which is what the
 * resolver's issue-window match and "starts after the review" guard need.
 * Titles that are OCR debris (no letters, "THEATRE RECORD 131") are dropped.
 */
// venue-write-guard-ok: reads Theatre Record A-Z text and builds audit lookups; nothing here writes shows.json
'use strict';

const { isWestEndVenue } = require('./venue-classification');
const { normalizeTitle } = require('./title-match');

const WOS_LONDON_MARKET = 83;
const JUNK_TITLE = /^(theatre record\b|\W*$)|[~$%|{}]/i;

/** A-Z venue abbreviations -> names the classifier knows ("T R Haymarket"). */
function azVenueName(v) {
  const s = String(v || '').replace(/^T R /, 'Theatre Royal ').replace(/\s+/g, ' ').trim();
  return s || null;
}

function venueIsWestEnd(v) {
  return isWestEndVenue(v) || isWestEndVenue(`${v} Theatre`);
}

/**
 * @param {{titles: Array<{title: string, venue: string|null, opened: string|null, firstAsAt: string|null}>}} az
 * @param {Array<{title: string}>} existing lookups already chosen (WOS reviews)
 */
function azLookups(az, existing = []) {
  const seen = new Set((existing || []).map(l => normalizeTitle(l.title)));
  const lookups = [];
  const dropped = [];
  for (const t of (az && az.titles) || []) {
    const title = String(t.title || '').trim();
    const drop = reason => dropped.push({ title, venue: t.venue || null, reason });
    if (JUNK_TITLE.test(title) || !(/[A-Za-z]{3}/.test(title) || (t.venue && /^\d{3,4}$/.test(title)))) { drop('not a title'); continue; }
    const venue = azVenueName(t.venue);
    if (venue && !venueIsWestEnd(venue)) { drop('A-Z venue is not a West End venue'); continue; }
    const date = t.opened || t.firstAsAt;
    if (!date) { drop('no A-Z date'); continue; }
    const key = normalizeTitle(title);
    if (!key || seen.has(key)) { drop('duplicate title'); continue; }
    seen.add(key);
    lookups.push({ title, venue: venue ? (venueIsWestEnd(venue) && !isWestEndVenue(venue) ? `${venue} Theatre` : venue) : null, date, url: null, market: [WOS_LONDON_MARKET], source: 'tr-az' });
  }
  return { lookups, dropped };
}

module.exports = { azLookups, azVenueName };
