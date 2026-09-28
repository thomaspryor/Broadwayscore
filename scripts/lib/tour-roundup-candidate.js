'use strict';

/**
 * National-tour roundups as "add this tour?" suggestions (BRO-4211 Phase E).
 *
 * BroadwayWorld's landing page lists roundups like
 * Review-Roundup-DEATH-BECOMES-HER-Launches-National-Tour-20260915. The slug
 * matcher reads the Broadway title and matches the Broadway show, and the
 * category guard in processShow then drops the roundup with only a log line.
 * When that Broadway show has no tour entry yet, the owner should hear about
 * it: adding a category:'tour' entry is a manual, validated step.
 *
 * Pure: callers pass the matched show and the shows list.
 */

// "...-Launches-North-AMERICAN-Tour-...", "...-Embarks-on-National-Tour-...",
// "...-on-Tour-...", "...-US-Tour-...". Anchored to slug words so a title word
// like "Tourist" or "Detour" doesn't count.
const TOUR_SLUG_RE = /(?:^|-)(?:north-american|national|us|first-national|touring)-tour(?:-|$)|(?:^|-)on-tour(?:-|$)|(?:^|-)tour-(?:launch|kicks-off|opens|begins)(?:-|$)/i;
// A UK or West End tour is not the North American tour.
const UK_SLUG_RE = /(?:^|-)(?:uk|uk-and-ireland|uk-ireland|west-end)(?:-|$)/i;

function isNationalTourRoundupSlug(slug) {
  const s = String(slug || '').split(/[?#]/)[0];
  return TOUR_SLUG_RE.test(s) && !UK_SLUG_RE.test(s);
}

/**
 * The Broadway show a tour roundup suggests adding a tour for, or null when
 * the slug isn't a tour roundup, the match isn't a Broadway show, or a tour
 * entry for that production (or another of its title) already exists.
 */
function tourCandidateFor(slug, matchedShow, shows) {
  if (!isNationalTourRoundupSlug(slug) || !matchedShow) return null;
  if ((matchedShow.category || 'broadway') !== 'broadway') return null;
  const title = String(matchedShow.title || '').trim().toLowerCase();
  const byId = new Map((shows || []).map(s => [s.id, s]));
  const hasTour = (shows || []).some(s => {
    if (s.category !== 'tour' || !s.tourOf) return false;
    if (s.tourOf === matchedShow.id) return true;
    const parent = byId.get(s.tourOf);
    return !!parent && String(parent.title || '').trim().toLowerCase() === title;
  });
  if (hasTour) return null;
  return { broadwayShowId: matchedShow.id, title: matchedShow.title };
}

module.exports = { isNationalTourRoundupSlug, tourCandidateFor };
