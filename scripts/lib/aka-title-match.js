/**
 * Alias-title matching for audience scrapers (Mezzanine, Theatr).
 *
 * Our shows.json title is sometimes the press title ("Billy Crystal 860") while
 * the audience app lists the bare show title ("860"). Title-only matching missed
 * it on both apps (BRO-5943). An alias (shows.json akaTitles) counts as a match
 * only when the venue also agrees, because bare aliases like "860" are exactly
 * the short, collision-prone strings that must not attach to another production.
 */
const { normalizeTitle, foldDiacritics } = require('./title-match');

function normVenue(v) {
  return foldDiacritics(String(v || ''))
    .toLowerCase()
    .replace(/\b(theatre|theater|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when two venue names refer to the same house ("Imperial Theatre" ~ "Imperial"). */
function venueAgrees(a, b) {
  const x = normVenue(a);
  const y = normVenue(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // Same rule as Mezzanine's venuesMatch: a bare prefix must be 8+ chars so
  // "New" cannot match "New Amsterdam" ("Imperial" ~ "Imperial Ballroom" still does).
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  return shorter.length >= 8 && longer.startsWith(shorter + ' ');
}

/** Normalized alias titles of a show that differ from its main title. */
function aliasNorms(show) {
  const main = normalizeTitle(show.title);
  const out = new Set();
  for (const t of Array.isArray(show.akaTitles) ? show.akaTitles : []) {
    if (typeof t !== 'string') continue;
    const n = normalizeTitle(t);
    if (n && n !== main) out.add(n);
  }
  return out;
}

/** Does an external listing (name + venue) match one of our show's aliases at the same venue? */
function matchesAlias(show, listingName, listingVenue) {
  return aliasNorms(show).has(normalizeTitle(listingName)) && venueAgrees(show.venue, listingVenue);
}

module.exports = { venueAgrees, aliasNorms, matchesAlias, normVenue };
