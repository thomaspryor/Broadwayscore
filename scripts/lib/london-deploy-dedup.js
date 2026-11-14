/**
 * Deploy-time London dedup (pre-deploy-check.js).
 *
 * pre-deploy-check.js used to treat ANY two London rows sharing title+category
 * as duplicates whenever one had 0 reviews, and deleted one of them from the
 * deployed shows.json. That silently removed real, distinct productions from
 * prod: a touring stop vs a later residency (The Choir of Man, Wimbledon vs
 * Marble Arch), a transfer declared via priorRuns (Arcadia Old Vic → Duke of
 * York's), a returning Christmas run (Christmas Carol Goes Wrong 2025 → 2026),
 * two different Jane Eyre / Much Ado productions (BRO-275).
 *
 * A row pair is only a duplicate when it is plausibly the SAME production:
 * compatible venue (unknown/TBA, or matching), no conflicting start year, and neither row declares
 * the other as a prior run / transfer.
 */
const { venuesMatch } = require('./deduplication');

// Discovery stubs carry "TBA"/empty venues — that is the duplicate shape this
// dedup was added for (the Krapp's Last Tape / Ursula stubs), so an unknown
// venue is compatible with any venue. Known venues must match, via the shared
// alias-aware venuesMatch, or after dropping a " - Main Theatre" room suffix.
const isUnknownVenue = (v) => !v || /^\s*(tba|tbc|tbd)\s*$/i.test(v);
const stripRoom = (v) => String(v).replace(/\s+[-–]\s+[^-–]+$/, '');
function venuesCompatible(a, b) {
  if (isUnknownVenue(a) || isUnknownVenue(b)) return true;
  return venuesMatch(a, b) || venuesMatch(stripRoom(a), stripRoom(b));
}

// Start year from dates, else the id's trailing -YYYY, so a row with no dates
// is not a wildcard that matches every run at that venue.
function startYear(show) {
  const d = show.openingDate || show.previewsStartDate;
  if (d) return String(d).slice(0, 4);
  const m = String(show.id || '').match(/-(\d{4})$/);
  return m ? m[1] : null;
}

function linksTo(a, b) {
  if (a.transferOf === b.id || a.transferredTo === b.id) return true;
  return Array.isArray(a.priorRuns) && a.priorRuns.some(r => r && r.id === b.id);
}

function isSameLondonProduction(a, b) {
  if (!a || !b || a.id === b.id) return false;
  if (String(a.title).trim().toLowerCase() !== String(b.title).trim().toLowerCase()) return false;
  if (a.category !== b.category) return false;
  if (linksTo(a, b) || linksTo(b, a)) return false;
  if (!venuesCompatible(a.venue, b.venue)) return false;
  const ya = startYear(a);
  const yb = startYear(b);
  if (ya && yb && ya !== yb) return false;
  return true;
}

const STATUS_PRIORITY = { open: 3, previews: 2, upcoming: 1, closed: 0 };

/**
 * Returns the Set of show ids to drop. Only dedups pairs where at least one
 * side has 0 reviews (no data loss); keeps the side with more reviews, then
 * the more current status.
 */
function findLondonDuplicatesToRemove(shows, reviewCountByShow) {
  const kept = [];
  const toRemove = new Set();
  for (const show of shows) {
    if (show.category !== 'west-end' && show.category !== 'off-west-end') continue;
    const idx = kept.findIndex(prev => isSameLondonProduction(prev, show));
    if (idx === -1) { kept.push(show); continue; }
    const prev = kept[idx];
    const prevReviews = reviewCountByShow[prev.id] || 0;
    const currReviews = reviewCountByShow[show.id] || 0;
    if (prevReviews !== 0 && currReviews !== 0) { kept.push(show); continue; }
    const currWins = currReviews > prevReviews ||
      (currReviews === prevReviews && (STATUS_PRIORITY[show.status] || 0) > (STATUS_PRIORITY[prev.status] || 0));
    if (currWins) {
      toRemove.add(prev.id);
      kept[idx] = show;
    } else {
      toRemove.add(show.id);
    }
  }
  return toRemove;
}

module.exports = { isSameLondonProduction, findLondonDuplicatesToRemove };
