'use strict';

/**
 * Pure decision logic for BRO-166 (OB discovery S7: ticket links + affiliate
 * coverage for new shows / off-off-broadway).
 *
 * enrich-todaytix-data.js and enrich-fallback-ticket-links.js already try to
 * find an affiliate-able ticketLinks entry for every open/previews show —
 * this module identifies the shows that come out of that pipeline with
 * NEITHER a ticketLinks entry NOR an officialUrl, i.e. shows that dead-end
 * with no buy button at all (owner decision 2026-08-04: an unmonetized
 * "Official Site" link beats no link — never hold a show back for lack of
 * an affiliate deal).
 *
 * "Off-off-broadway" has no distinct category in shows.json yet (BRO-2485
 * tracks that enumeration work) — new OOB shows are promoted with
 * category: 'off-broadway' (scripts/promote-ob-venue-candidates.js), so this
 * targets that category plus off-west-end (its West End-side sibling).
 */

const { foldDiacritics } = require('./title-match');

// Statuses a "new show" can be in before it's fully on sale. `closed` and
// anything else are excluded — a closed show correctly has no buy button.
const ACTIVE_STATUSES = new Set(['open', 'previews', 'upcoming', 'announced']);

// off-off-broadway shows are promoted under category 'off-broadway' (no
// distinct category exists yet — see BRO-2485); off-west-end is the West
// End-side equivalent tier.
const TARGET_CATEGORIES = new Set(['off-broadway', 'off-west-end']);

/**
 * Shows that currently dead-end with no buy button: active, off-broadway
 * (or off-west-end) tier, no ticketLinks, no officialUrl.
 */
function findDeadEndShows(shows) {
  return (shows || []).filter((s) => {
    if (!s || !TARGET_CATEGORIES.has(s.category)) return false;
    if (!ACTIVE_STATUSES.has(s.status)) return false;
    if (s.officialUrl) return false;
    if (Array.isArray(s.ticketLinks) && s.ticketLinks.length > 0) return false;
    return true;
  });
}

const VENUE_STOPWORDS = new Set(['the', 'theater', 'theatre']);

function significantTokens(s) {
  // Fold diacritics BEFORE stripping non-ASCII, or an accented venue name
  // shreds into fragments that can never match — see task #648.
  return foldDiacritics(s).toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !VENUE_STOPWORDS.has(w));
}

/**
 * Match a show's venue name against a list of venue configs (shape:
 * {name, url}, e.g. scripts/lib/venue-listing-discover.js's
 * OB_VENUE_CONFIGS) and return that venue's own site as a last-resort
 * "Official Site" link. Word-token prefix match (not raw substring) both
 * so abbreviations resolve ("Irish Rep" config ⇔ "Irish Repertory Theatre"
 * venue) and so a short config name like "BAM" can't accidentally match an
 * unrelated venue purely by character overlap (e.g. "Alabama Theatre").
 */
function venueFallbackUrl(show, venueConfigs) {
  const venueTokens = significantTokens(show && show.venue);
  if (venueTokens.length === 0) return null;
  const match = (venueConfigs || []).find((v) => {
    const configTokens = significantTokens(v.name);
    if (configTokens.length === 0) return false;
    return configTokens.every((ct) =>
      venueTokens.some((vt) => vt.startsWith(ct) || ct.startsWith(vt))
    );
  });
  if (!match) return null;
  // officialUrl is set once and never re-verified (same as every other
  // enricher), so persisting OB_VENUE_CONFIGS' listing-page URL verbatim
  // risks freezing a season-specific path forever — e.g. MCC Theater's
  // config URL embeds the season ("our-2025-26-season") and is documented
  // there as needing a manual bump every year. Normalize to the venue's
  // domain root, which is still a genuine, stable "Official Site" link.
  try {
    return new URL(match.url).origin + '/';
  } catch {
    return match.url;
  }
}

module.exports = {
  ACTIVE_STATUSES,
  TARGET_CATEGORIES,
  findDeadEndShows,
  venueFallbackUrl,
};
