'use strict';

/**
 * isPlaceholderByline(criticName, outlet)
 *
 * A byline is a placeholder — not a human critic identity — when scraper
 * extraction fell back to the outlet's own name, or to a generic desk/staff
 * label, instead of finding the actual writer. Card #1907 (2026-08-26): a
 * same-URL cluster where a placeholder survives as canonical alongside a real
 * byline double-counts the article (loves-labours-lost-globe-west-end-2026,
 * "The Times" vs "Clive Davis" — both files carried outlet "The Times (UK)").
 *
 * WHY criticName+outlet DATA FIELDS, not the filename slug: the pre-existing
 * isUnknownByline() in fix-circular-duplicate-pairs.js compares
 * bylineSlug(filename) to outletSlug(filename) — the filename PREFIX
 * (outletId, e.g. "times-uk"), not the outlet's display name ("The Times
 * (UK)"). A file named `times-uk--the-times.json` has slug "the-times" and
 * outletSlug "times-uk" — never equal, even though criticName "The Times"
 * IS the outlet display name. That mismatch is exactly why the loves-labours-
 * lost duplicate survived undetected. Reading the actual `criticName`/`outlet`
 * fields sidesteps outletId-vs-display-name drift entirely.
 */

// Bylines that carry no human identity regardless of outlet. Lowercase,
// space-normalized (matches normalizeForCompare's output).
const GENERIC_BYLINE_TERMS = new Set([
  'unknown', 'staff', 'staff writer', 'staff reporter', 'editor', 'editors',
  'editorial staff', 'editorial team', 'the editors', 'news desk', 'newsdesk',
  'bww news desk', 'admin', 'contributor', 'contributors', 'guest',
  'guest contributor', 'anonymous', 'team', 'review team', 'reviewer',
  'critic', 'theatre desk', 'theater desk', 'correspondent',
]);

/** Lowercase, strip parenthetical qualifiers ("(UK)"), collapse punctuation/whitespace. */
function normalizeForCompare(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * True when criticName is a placeholder rather than a real byline: empty,
 * purely numeric, a known generic desk/staff term, or the outlet's own name
 * (after normalization) with nothing else attached.
 *
 * SELF-BRANDED CRITICS (Codex adversarial review, card #1907): some solo
 * review sites are named after their one real critic — outlet-registry.json
 * has "carole-di-tosti" (displayName "Carole Di Tosti", defaultCritic
 * "Carole Di Tosti"), plus "carey-purcell", "oscar-e-moore". For those, the
 * criticName-equals-outlet-name coincidence is the OPPOSITE of a placeholder:
 * it's registry-confirmed proof of the real byline. `opts.defaultCritic` is
 * the outlet-registry's own authoritative claim for who writes there — when
 * criticName matches it, this is NEVER a placeholder, full stop, whatever the
 * outlet-name comparison below would otherwise say. The caller resolves
 * `defaultCritic` from outlet-registry.json (this function stays pure — no
 * I/O — the caller injects the registry-derived context).
 *
 * Pure — no I/O, safe for unit tests and use inside a canonical chooser.
 *
 * @param {string|null|undefined} criticName
 * @param {string|null|undefined} outlet display name (e.g. "The Times (UK)")
 * @param {{defaultCritic?: string|null}} [opts] outlet-registry.json's
 *   outlets[outletId].defaultCritic for this record's outlet, if resolvable
 * @returns {boolean}
 */
function isPlaceholderByline(criticName, outlet, opts = {}) {
  const norm = normalizeForCompare(criticName);
  if (!norm) return true;
  const normDefaultCritic = normalizeForCompare(opts.defaultCritic);
  if (normDefaultCritic && norm === normDefaultCritic) return false;
  if (/^\d+$/.test(norm.replace(/\s+/g, ''))) return true;
  if (GENERIC_BYLINE_TERMS.has(norm)) return true;
  const normOutlet = normalizeForCompare(outlet);
  if (normOutlet && norm === normOutlet) return true;
  return false;
}

/**
 * isPlaceholderByline() applied to a review-text record, with the shared
 * "criticName must actually be present" guard both callers need: a record
 * with NO criticName field at all (byline identity conveyed only by the
 * filename — every fixture in this codebase's tests, never a real corpus
 * record) is NOT judged a placeholder from data alone — isPlaceholderByline
 * treats an empty criticName as vacuously true, which would wrongly flag
 * every filename-only real byline. Centralizing this guard here (instead of
 * two separate ad-hoc copies in fix-circular-duplicate-pairs.js and
 * dedupe-same-url-bylines.js) is what keeps the two callers from silently
 * drifting out of sync (Codex adversarial review, card #1907).
 * Pure — no I/O.
 *
 * @param {{criticName?: string|null, outlet?: string|null}} data
 * @param {{defaultCritic?: string|null}} [opts]
 * @returns {boolean}
 */
function isPlaceholderRecord(data, opts = {}) {
  if (!data || typeof data.criticName !== 'string' || !data.criticName.trim()) return false;
  return isPlaceholderByline(data.criticName, data.outlet, opts);
}

module.exports = { isPlaceholderByline, isPlaceholderRecord, normalizeForCompare, GENERIC_BYLINE_TERMS };
