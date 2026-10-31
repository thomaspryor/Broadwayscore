/**
 * Baseline-diff logic for audit-show-score-urls.js (BRO-3471).
 *
 * Mirrors scripts/lib/duplicate-shows-baseline.js: Show Score serves ONE page
 * per title (the current/most recent production), so when two showIds in
 * data/show-score-urls.json map to the same URL, at most one side is the
 * page's real subject — the other is silently ingesting the wrong
 * production's reviews (the she-loves-me-1994 case: 21 of 22 review files
 * were actually the 2016 revival, BRO-3416).
 *
 * Which side is correct is a per-pair data-judgment call (which production is
 * the page actually describing?) that this script cannot make automatically —
 * see BRO-3471's PARKED rationale. So the gate does NOT try to resolve
 * existing collisions; it only stops a NEW collision from landing invisibly.
 * Pre-existing collisions are frozen in
 * data/audit/show-score-urls-baseline.json and never fail CI; only a
 * (url, showIds) combination not already in that baseline fails under
 * --strict.
 *
 * Identity is normalized-url PLUS the sorted set of colliding showIds, not
 * the URL alone (adversarial review, BRO-3471 round 2): baselining just the
 * URL would let a THIRD show silently join an already-accepted collision —
 * e.g. adding `wicked-west-end-2026` to the already-baselined wicked-london
 * URL would pass --strict unnoticed, exactly the invisible-contamination
 * class this gate exists to catch. Keying on the full showIds set means any
 * change to WHO collides on a URL — a new id joining, or a baselined pair
 * shrinking to one id as it's resolved — is a different identity and must be
 * re-baselined deliberately via --update-baseline.
 *
 * Pure functions only — no fs — so both the CLI and the test require() the
 * same logic (CLAUDE.md rule 15).
 */
'use strict';

function normalizeUrl(url) {
  return String(url || '').trim().toLowerCase().replace(/\/+$/, '');
}

// { url, showIds } => "normalizedUrl::sorted,show,ids" — order-independent in
// showIds so [a,b] and [b,a] collide to the same identity.
function identityKey(entry) {
  const ids = [...(entry.showIds || [])].sort().join(',');
  return `${normalizeUrl(entry.url)}::${ids}`;
}

// baselineUrls: array of { url, showIds } as stored in the baseline JSON's
// `urls` array. Returns a Set for O(1) membership checks.
function baselineKeySet(baselineUrls) {
  return new Set((baselineUrls || []).map(identityKey));
}

// duplicates: array of { url, showIds } as produced by
// audit-show-score-urls.js's duplicate-URL check. baselineSet: Set from
// baselineKeySet(). Returns the subset whose (url, showIds) identity is NOT
// in the baseline.
function computeNewViolators(duplicates, baselineSet) {
  return (duplicates || []).filter((d) => !baselineSet.has(identityKey(d)));
}

module.exports = { normalizeUrl, identityKey, baselineKeySet, computeNewViolators };
