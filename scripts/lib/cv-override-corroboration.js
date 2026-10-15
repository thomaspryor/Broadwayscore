'use strict';

/**
 * Temporal-override corroboration for CV.wrongProduction (BRO-4427).
 *
 * content-verifier.js stamps "[OVERRIDE: review within Nd of opening, likely
 * correct production]" onto contentVerification.reasoning and downgrades the
 * confidence to low when the LLM says wrongProduction for a review published
 * near opening. It leaves contentVerification.wrongProduction=true and sets
 * no clear flag, so cv-wrongproduction-unhandled.check.js errored on every
 * such shipped review (1003 reviews in 464 shows, 2026-09-30) and blocked the
 * School Girls opening-night checklist on a review that plainly covered the
 * Broadway production (BRO-4361).
 *
 * The override alone is NOT proof: juan-a-ramirez (an Every Brilliant Thing
 * review filed as Schmigadoon) carried the same stamp. This module decides
 * whether the review text independently corroborates the override: it must
 * name the show's title AND the show's venue (or a known alias of it). A
 * cross-show contamination never names both; a real near-opening review of
 * this production almost always does. A corroborated override is reported as
 * a warning instead of a blocking error. Nothing here writes data or changes
 * inclusion or scoring: rebuild already ships these reviews.
 */

const { buildMentionRegex } = require('./opening-night-checks/slug-mismatch.check.js');
const { normalizeForMatch, containsToken, venueTokens } = require('./venue-tokens');
const { getVenueAliases } = require('./venue-aliases');

// Must match the prefix content-verifier.js writes (verifyContent, temporal
// override branch). The test pins both sides of this contract.
const OVERRIDE_STAMP_RE = /^\s*\[OVERRIDE: review (?:within \d+d of opening|near opening), likely correct production\]/;

function hasTemporalOverrideStamp(cv) {
  return !!(cv && typeof cv.reasoning === 'string' && OVERRIDE_STAMP_RE.test(cv.reasoning));
}

/** All lowercase tokens that name the show's venue, alias names included. */
function showVenueTokens(show) {
  if (!show || !show.venue) return [];
  const names = [show.venue];
  try {
    const entry = getVenueAliases(show.venue, show.market);
    if (entry && Array.isArray(entry.aliases)) names.push(...entry.aliases);
  } catch {
    // Alias table unavailable: the venue's own name still counts.
  }
  const tokens = new Set();
  for (const n of names) for (const t of venueTokens(n)) tokens.add(t);
  return [...tokens];
}

/**
 * @param {object} review - review-texts file contents
 * @param {object} show - shows.json entry ({ id, title, venue, market, ... })
 * @returns {{ corroborated: boolean, reason: string, venueToken?: string }}
 */
function classifyOverrideCorroboration(review, show) {
  const cv = review && review.contentVerification;
  if (!cv || cv.wrongProduction !== true) return { corroborated: false, reason: 'cv-not-wrong-production' };
  if (!hasTemporalOverrideStamp(cv)) return { corroborated: false, reason: 'no-override-stamp' };
  if (cv.confidence !== 'low') return { corroborated: false, reason: 'confidence-not-low' };
  // wrongArticle + wrongProduction is the wrongShow shape: a different article
  // entirely, never something a date window can vouch for.
  if (cv.wrongArticle === true) return { corroborated: false, reason: 'wrong-article' };

  const text = typeof review.fullText === 'string' ? review.fullText : '';
  if (text.length < 200) return { corroborated: false, reason: 'no-fulltext' };

  const mentionRe = show ? buildMentionRegex(show) : null;
  if (!mentionRe) return { corroborated: false, reason: 'no-title-pattern' };
  if (!mentionRe.test(text)) return { corroborated: false, reason: 'title-not-in-text' };

  const tokens = showVenueTokens(show);
  if (tokens.length === 0) return { corroborated: false, reason: 'no-venue-token' };
  const norm = normalizeForMatch(text).replace(/'/g, '');
  const venueToken = tokens.find(t => containsToken(norm, t));
  if (!venueToken) return { corroborated: false, reason: 'venue-not-in-text' };

  return { corroborated: true, reason: 'override-title-and-venue-in-text', venueToken };
}

module.exports = {
  OVERRIDE_STAMP_RE,
  hasTemporalOverrideStamp,
  showVenueTokens,
  classifyOverrideCorroboration,
};
