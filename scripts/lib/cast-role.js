'use strict';

/**
 * Cast `role` hygiene (BRO-6477).
 *
 * LLM cast backfills sometimes answer "I could not find the role" with a
 * sentence instead of leaving the field empty. backfill-cast-web.js wrote
 * `role: "role not specified"` onto three my-neighbour-totoro-west-end-2025
 * cast rows on 2026-10-28 (data commit d3ebbe9). The excerpt guards tokenize
 * every cast role into "character name" cues, so "role", "not" and
 * "specified" became cues and "it is not an exact replica" sitting 40
 * characters from "Phelim McDermott" made the director look like a departed
 * actor. That failed the former-cast sweep on every main run for the rest of
 * the day.
 *
 * A placeholder is not a role. Writers drop it (cleanRole) and consumers that
 * turn roles into text cues ignore it (isPlaceholderRole), so one bad row
 * cannot silently change what a guard matches.
 */

// Whole-value matches only: "Ensemble" and "Unknown Male" are real casting
// labels some sources use and other code already handles them. These are the
// phrases that mean "the model had no answer".
const PLACEHOLDER_ROLE_RE = new RegExp(
  '^\\s*(?:' + [
    'role\\s+(?:not\\s+(?:specified|available|listed|found|provided|known)|unknown|unspecified|tbd|tba|n/?a)',
    '(?:not|un)\\s*specified',
    'not\\s+(?:available|listed|found|provided|known|applicable)',
    'unknown\\s+role',
    'unlisted',
    'n/?a',
    'none',
    'null',
    'undefined',
    'tbd',
    'tba',
    '-+',
    '\\?+',
  ].join('|') + ')\\s*[.!]?\\s*$',
  'i'
);

/** True for a role string that is a "no answer" sentence rather than a role. */
function isPlaceholderRole(role) {
  if (typeof role !== 'string') return false;
  return PLACEHOLDER_ROLE_RE.test(role);
}

/**
 * The role to store: the trimmed string, or undefined when empty/placeholder.
 * Writers use `role: cleanRole(m.role)` in place of `m.role || undefined`.
 */
function cleanRole(role) {
  if (typeof role !== 'string') return undefined;
  const trimmed = role.trim();
  if (!trimmed || isPlaceholderRole(trimmed)) return undefined;
  return trimmed;
}

/** shows.json rows carrying a placeholder cast role: [{ id, name, role }]. */
function findPlaceholderCastRoles(shows) {
  const out = [];
  for (const show of Array.isArray(shows) ? shows : []) {
    if (!show || !Array.isArray(show.cast)) continue;
    for (const member of show.cast) {
      if (member && isPlaceholderRole(member.role)) {
        out.push({ id: show.id, name: member.name, role: member.role });
      }
    }
  }
  return out;
}

// BRO-6479: scrapers default a missing role to 'Unknown' (scrape-cast-changes)
// or 'Cast' (and 'cast'/'unknown' variants), 107 rows on 25 shows. They are
// stored as-is (scrape-cast-changes uses 'Unknown' as an internal sentinel and
// validate-data does not treat them as bad rows), but they carry no role: the
// word "cast" is among the most common words in a review, so as a role CUE it
// makes any capitalized name near it look like a departed actor.
const NO_INFO_ROLE_RE = /^\s*(?:unknown|cast)\s*$/i;

/** True for a placeholder OR an 'Unknown'/'Cast' default: no usable role information. */
function isNoInfoRole(role) {
  if (typeof role !== 'string') return false;
  return isPlaceholderRole(role) || NO_INFO_ROLE_RE.test(role);
}

module.exports = { isPlaceholderRole, isNoInfoRole, cleanRole, findPlaceholderCastRoles, PLACEHOLDER_ROLE_RE, NO_INFO_ROLE_RE };
