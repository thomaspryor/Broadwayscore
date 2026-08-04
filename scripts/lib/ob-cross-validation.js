'use strict';

/**
 * Cross-validation gate for venue-discovered OB candidates.
 *
 * Why: User Impact reviewer P0 — a venue-page redesign that leaks
 * "Spring Gala 2026" as a fake show would otherwise land in shows.json,
 * trigger the opening-night orchestrator, and fire a real broadcast to
 * subscribers. Cross-validating against Playbill OB + Lortel before
 * promoting prevents this class of incident.
 *
 * Rule: a candidate promotes to shows.json ONLY if its title (normalized)
 * appears in either Playbill OB's schedule article OR Lortel's
 * currently-playing list within `windowHours` of the candidate's
 * discoveredAt timestamp. Otherwise it stays in staging.
 *
 * Admin escape hatch: scripts/promote-ob-venue-candidates.js --admin-force
 * bypasses this gate for a named title (e.g. a legitimate Atlantic show
 * that Playbill hasn't picked up yet).
 */

const { normalizeTitle, titleTokens, jaccard } = require('./title-match');
const { isKnownOffBroadwayVenue, OFF_BROADWAY_VENUES } = require('./venue-classification');

const JACCARD_FUZZY_MATCH_THRESHOLD = 0.6;

/**
 * @param {Object} candidate - { title, venue, discoveredAt }
 * @param {Object} sources - { playbillEntries, lortelEntries }
 *   - playbillEntries: [{ title, firstPreview, opening }] from playbill-ob-schedule
 *   - lortelEntries: [{ title, firstPreview, openingNight }] (optional)
 * @param {Object} options
 * @param {number} options.windowHours - reserved for future cadence checks
 *   (right now the gate is "title appears at all", not "within last Nh")
 * @returns {{ confirmed: boolean, source: string|null, reason: string }}
 */
function isCandidateConfirmed(candidate, sources, options = {}) {
  if (!candidate || !candidate.title) {
    return { confirmed: false, source: null, reason: 'candidate missing title' };
  }

  const want = normalizeTitle(candidate.title);
  if (!want) {
    return { confirmed: false, source: null, reason: 'title normalizes to empty string' };
  }

  const playbill = sources?.playbillEntries || [];
  const lortel = sources?.lortelEntries || [];
  const wantTokens = titleTokens(candidate.title);

  // Pass 1: exact normalized match (cheap, catches most cases)
  for (const e of playbill) {
    if (e && e.title && normalizeTitle(e.title) === want) {
      return { confirmed: true, source: 'playbill', reason: `matched playbill entry "${e.title}" (exact)` };
    }
  }
  for (const e of lortel) {
    if (e && e.title && normalizeTitle(e.title) === want) {
      return { confirmed: true, source: 'lortel', reason: `matched lortel entry "${e.title}" (exact)` };
    }
  }

  // Pass 2: token-set jaccard >= 0.6. Catches venue-page-extracted variants
  // like "Girls Chance Music" matching Playbill's "||: GIRLS :||: CHANCE :||: MUSIC :||"
  // (the `|` chars aren't separators in normalizeTitle so the strings differ
  // after normalization, but the token sets agree).
  if (wantTokens.size > 0) {
    for (const e of playbill) {
      if (!e || !e.title) continue;
      const sim = jaccard(wantTokens, titleTokens(e.title));
      if (sim >= JACCARD_FUZZY_MATCH_THRESHOLD) {
        return { confirmed: true, source: 'playbill', reason: `matched playbill entry "${e.title}" (jaccard=${sim.toFixed(2)})` };
      }
    }
    for (const e of lortel) {
      if (!e || !e.title) continue;
      const sim = jaccard(wantTokens, titleTokens(e.title));
      if (sim >= JACCARD_FUZZY_MATCH_THRESHOLD) {
        return { confirmed: true, source: 'lortel', reason: `matched lortel entry "${e.title}" (jaccard=${sim.toFixed(2)})` };
      }
    }
  }

  return { confirmed: false, source: null, reason: `no Playbill/Lortel match for "${candidate.title}"` };
}

// ---------------------------------------------------------------------------
// decideCriticListingPromotion — sibling gate for candidates sourced from a
// single-maintainer critic-listing blog (e.g. newyorktheater.me / 'nyt-theater',
// Sprint 1, task #997). isCandidateConfirmed above requires a Playbill OR
// Lortel match; Lortel is dead (404, no replacement — see
// scripts/enrich-off-broadway-dates.js) and Playbill's OB schedule article
// carries none of this source's shows (task #987). Widening isCandidateConfirmed
// to cover that gap would widen its blast radius for EVERY candidate source,
// present and future — the wrong fix (see header comment above + card 3b2637c5).
//
// This gate is deliberately SELF-SUFFICIENT instead: it confirms off what the
// candidate's own discovery already proved (title, a venue resolvable against
// the canonical Off-Broadway venue list, a plausible publish date, and a
// persisted source URL to audit against later) rather than requiring a SECOND
// source to corroborate it. Plan v1's fatal flaw (the #647/#772 dead-arm
// class) was a rule whose corroborators — TDF, BWW, a venue page — nobody was
// actually building, so it would have confirmed nothing. `corroborations[]`
// on the candidate (see aggregator-candidate-extract.js) stays optional
// provenance for future use; this rule never REQUIRES it to be non-empty.
// ---------------------------------------------------------------------------

// How stale the article can be relative to when it was discovered/staged
// before we refuse to trust it (a critic-listing post scraped from an old
// archive page, not the live monthly roundup).
const CRITIC_LISTING_MAX_STALENESS_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {Object} candidate - the aggregator-candidate-extract.js shape:
 *   { title, venue, sourceUrl, articlePublishedAt, discoveredAt, ... }
 * @param {Object} options
 * @param {(venue: string) => boolean} [options.isKnownVenue] - injectable
 *   canonical-venue check, defaults to the real Off-Broadway venue list.
 *   Tests use this to simulate a normal "venue not on the list" rejection.
 * @param {() => boolean} [options.venueDirectoryAvailable] - injectable
 *   liveness check for the canonical venue directory this gate depends on.
 *   Defaults to "the real, committed list loaded". Tests set this to `false`
 *   to exercise the "required source is unavailable" refusal path — distinct
 *   from an ordinary "venue not found" rejection: the directory itself
 *   couldn't be consulted, so this gate REFUSES to confirm rather than
 *   guessing either way (fetched-zero-results vs fetch-failed).
 * @returns {{ confirmed: boolean, source: string|null, reason: string }}
 */
function decideCriticListingPromotion(candidate, options = {}) {
  const {
    isKnownVenue = isKnownOffBroadwayVenue,
    venueDirectoryAvailable = () => OFF_BROADWAY_VENUES.size > 0,
  } = options;

  if (!candidate || !candidate.title || !normalizeTitle(candidate.title)) {
    return { confirmed: false, source: null, reason: 'candidate missing title' };
  }
  if (!candidate.sourceUrl) {
    return { confirmed: false, source: null, reason: 'no persisted source URL — nothing to audit against later' };
  }
  if (!candidate.venue) {
    return { confirmed: false, source: null, reason: 'null venue' };
  }

  // "Required source unavailable" — the canonical venue directory itself
  // couldn't be consulted (fetch-failed class). REFUSE to confirm rather
  // than treat an outage as either a pass or a normal not-found reject.
  if (!venueDirectoryAvailable()) {
    return {
      confirmed: false, source: null,
      reason: 'canonical Off-Broadway venue directory unavailable — refusing to confirm (not a venue rejection)',
    };
  }
  // Directory was consulted fine; venue just isn't on it (fetched-zero-results).
  if (!isKnownVenue(candidate.venue)) {
    return { confirmed: false, source: null, reason: `venue "${candidate.venue}" not in canonical Off-Broadway venue list` };
  }

  // Compatible dates: articlePublishedAt and discoveredAt must both exist,
  // parse, and roughly agree — discoveredAt should land at/after the
  // article's own publish date (staging always records discovery AFTER the
  // page existed) and not so long after it that this is stale archive
  // content masquerading as a current listing.
  const published = candidate.articlePublishedAt ? new Date(candidate.articlePublishedAt) : null;
  const discovered = candidate.discoveredAt ? new Date(candidate.discoveredAt) : null;
  if (!published || Number.isNaN(published.getTime()) || !discovered || Number.isNaN(discovered.getTime())) {
    return { confirmed: false, source: null, reason: 'missing or unparseable articlePublishedAt/discoveredAt' };
  }
  if (discovered.getTime() < published.getTime() - DAY_MS) {
    return {
      confirmed: false, source: null,
      reason: `date mismatch: discoveredAt (${candidate.discoveredAt}) precedes articlePublishedAt (${candidate.articlePublishedAt})`,
    };
  }
  const stalenessDays = (discovered.getTime() - published.getTime()) / DAY_MS;
  if (stalenessDays > CRITIC_LISTING_MAX_STALENESS_DAYS) {
    return {
      confirmed: false, source: null,
      reason: `date mismatch: articlePublishedAt is ${Math.round(stalenessDays)}d stale relative to discoveredAt`,
    };
  }

  return {
    confirmed: true, source: 'critic-listing',
    reason: `title + canonical venue "${candidate.venue}" + compatible dates + persisted source URL`,
  };
}

module.exports = {
  isCandidateConfirmed,
  decideCriticListingPromotion,
};
