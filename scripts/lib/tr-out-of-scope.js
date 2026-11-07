'use strict';

/**
 * tr-out-of-scope.js (BRO-6096): which unmatched theatre.reviews round-ups are
 * not ours to track, so the coverage report only lists real gaps.
 *
 * Scope policy: West End historical coverage is West End houses only
 * (venue-classification isWestEndVenue); Off-West-End is tracked from
 * 2026-01-01. A round-up for an Off-West-End house dated before that has no
 * show to match by design. Anything the venue rule cannot decide (no venue in
 * the post, opera, touring, non-London) is recorded with evidence in
 * data/theatre-reviews-scope-overrides.json, keyed by round-up slug.
 */

const { isWestEndVenue } = require('./venue-classification');

const OWE_TRACKING_START = '2026-01-01';

/**
 * True when ANY house named in the round-up venue is a West End one. TR writes
 * transfers as "menier chocolate factory / Garrick Theatre" and National
 * stages as "Dorfman at the national theatre"; judging the whole string would
 * call those Off-West-End and hide a real gap.
 */
function namesWestEndHouse(venue) {
  // TR also writes "Kit Kat Club at the Playhouse Theatre" (company at house) and
  // "Sohoplace" for Soho Place; each piece is judged on its own.
  const parts = String(venue).split(/\s*\/\s*|\s+at the\s+/i)
    .map((v) => v.trim().replace(/^@?sohoplace$/i, 'Soho Place')).filter(Boolean);
  return parts.some((v) => isWestEndVenue(v));
}

function slugOf(url) {
  return String(url || '').replace(/\/+$/, '').split('/').pop();
}

/** @returns {string|null} reason when the round-up is out of scope */
function classifyOutOfScope(entry, overrides = {}) {
  const ov = overrides[slugOf(entry.url)];
  if (ov && ov.outOfScope) return String(ov.outOfScope);
  // An override may supply the venue (with evidence) for posts that carry none.
  const venue = entry.venue || (ov && ov.venue) || null;
  if (venue && !namesWestEndHouse(venue) && entry.date && String(entry.date) < OWE_TRACKING_START) {
    return `Off-West-End venue (${venue}) before the ${OWE_TRACKING_START} tracking window`;
  }
  return null;
}

/** {slug: showId} pins from the overrides file. */
function pinsFromOverrides(overrides = {}) {
  const pins = {};
  for (const [slug, ov] of Object.entries(overrides)) if (ov && typeof ov.pin === 'string') pins[slug] = ov.pin;
  return pins;
}

/** Adds outOfScope / outOfScopeReason to each report entry (never removes an entry). */
function markOutOfScope(entries, overrides = {}) {
  return entries.map((e) => {
    const reason = classifyOutOfScope(e, overrides);
    return reason ? { ...e, outOfScope: true, outOfScopeReason: reason } : e;
  });
}

module.exports = { classifyOutOfScope, pinsFromOverrides, markOutOfScope, slugOf, OWE_TRACKING_START };
