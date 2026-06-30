'use strict';

/**
 * roundup-digest.js — detect a review record that is actually a REVIEW-ROUNDUP
 * digest (an aggregator's "Reviews are in for X" compilation), not an individual
 * critic's review.
 *
 * Why this exists (2026-06-30): WestEndTheatre.com roundup landing pages were
 * scraped and stored under INDIVIDUAL outlet ids (telegraph/timeout/standard)
 * with the WET staff byline ("Ghenet Pinderhughes Randall", "West End Theatre",
 * "Luke Dillon", "Julianna Barnaby") or an outlet-name-as-critic. 63 such files;
 * the write-time roundup guard only covered BWW (/article/Review-Roundup-/) and
 * LBO URLs, never WET. These digests carry a blended score (78-97) and, if ever
 * scored/included, would be a phantom review. (Only 1 of the 63 was a true
 * individual review — a real critic excerpt relayed via WET — so detection must
 * NOT fire on those.)
 *
 * Precision: a real critic's relayed excerpt (e.g. Tim Bano / FT prose on a WET
 * url) is a legitimate aggregator-sourced review and must be preserved. So we
 * flag ONLY on high-confidence digest signals:
 *   1. fullText opens with roundup-digest phrasing ("reviews are in/out/coming",
 *      "round-up of reviews", "the critics have delivered", "unanimous praise
 *      from the critics", ...).
 *   2. criticName is a PUBLICATION name (an outlet can't be an individual critic —
 *      that's an aggregation artifact).
 *   3. criticName is a known WET roundup author AND the url is a WET page (these
 *      names appear only/overwhelmingly on westendtheatre.com roundup pages).
 *
 * Pure function; unit-tested. Used by review-file-writer.js (write-time guard)
 * and the one-time flag-wet-roundup-misattributions.js cleanup.
 */

// Tight, roundup-SPECIFIC openings only — loose phrasing like "the critics have
// had their say" appears in ordinary reviews and caused false positives on legit
// ft.com / thestage.co.uk reviews (2026-06-30).
const ROUNDUP_DIGEST_TEXT = /(the\s+)?reviews are (in|out|coming out)\b|round-?up of reviews|review(s)? round-?up|a reviews round-?up|reviews are coming out from/i;

// criticName values that are actually publication names — an aggregation artifact.
const PUBLICATION_NAMES = new Set([
  'daily telegraph', 'the telegraph', 'the times', 'the independent',
  'evening standard', 'daily mail', 'the guardian', 'the stage',
  'financial times', 'metro', 'the observer', 'the sun', 'time out',
]);

// Known WestEndTheatre roundup compilers (grep-verified to appear only/almost-only
// on westendtheatre.com urls, never as a standalone outlet critic).
const WET_ROUNDUP_AUTHORS = new Set([
  'west end theatre', 'west end theatre editorial',
  'ghenet pinderhughes randall', 'luke dillon', 'julianna barnaby',
]);

function isWetUrl(url) {
  return typeof url === 'string' && /westendtheatre\.com/i.test(url);
}

/**
 * Detect a review record that is actually a WestEndTheatre review-roundup digest
 * mis-stored under an individual outlet id.
 *
 * PRECONDITION (eliminates false positives): the url must be a WestEndTheatre.com
 * page AND the outletId must NOT be westendtheatre. A legitimate review on its own
 * domain (ft.com bylined "Financial Times", thestage.co.uk) never matches — the
 * url/outlet mismatch is what makes a WET page mis-attributed. Within that set,
 * digest phrasing / publication-name byline / known WET roundup author separate a
 * roundup DIGEST (flag) from a real critic's excerpt relayed via WET (keep — e.g.
 * Tim Bano / FT).
 *
 * @param {object} rec - { fullText, criticName, url, outletId }
 * @returns {{ isRoundup: true, reason: string } | null}
 */
function detectRoundupDigest(rec) {
  if (!rec) return null;
  // Precondition: WET url mis-attributed to a non-WET outlet.
  if (!isWetUrl(rec.url)) return null;
  const outlet = (rec.outletId || '').trim().toLowerCase();
  if (outlet === 'westendtheatre' || outlet === '') return null;

  const text = (rec.fullText || '').slice(0, 300);
  const critic = (rec.criticName || '').trim().toLowerCase();

  if (text && ROUNDUP_DIGEST_TEXT.test(text)) {
    return { isRoundup: true, reason: 'WET roundup digest: text opens with review-roundup phrasing' };
  }
  if (critic && PUBLICATION_NAMES.has(critic)) {
    return { isRoundup: true, reason: `WET roundup digest: criticName is a publication name ("${rec.criticName}")` };
  }
  if (critic && WET_ROUNDUP_AUTHORS.has(critic)) {
    return { isRoundup: true, reason: `WET roundup digest: WestEndTheatre roundup author ("${rec.criticName}")` };
  }
  return null;
}

module.exports = { detectRoundupDigest, ROUNDUP_DIGEST_TEXT, PUBLICATION_NAMES, WET_ROUNDUP_AUTHORS };
