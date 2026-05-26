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

module.exports = {
  isCandidateConfirmed,
};
