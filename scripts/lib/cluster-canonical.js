/**
 * cluster-canonical.js
 *
 * Pure disposition logic for byline-explosion review-URL clusters (see
 * scripts/lib/review-url-clusters.js for detection). Given the files that share
 * ONE (outlet, url) cluster plus per-file signals, decide whether a real review
 * can be RECOVERED (and which file is canonical) or the cluster must be SKIPPED
 * (no recoverable review — wrong production, wrong show, roundup, or empty
 * extractions of the right URL that need a fresh re-gather).
 *
 * Extracted + pure (no I/O) per CLAUDE.md rule 15 so every verdict is locked by
 * tests/unit/cluster-canonical.test.mjs. It is REMEDIATION logic and lives apart
 * from the always-on CI detector (review-url-clusters.js) on purpose: the
 * detector must stay honest about raw files, this decides what to do about them.
 *
 * The caller (scripts/audit-review-url-clusters.js) materialises the per-file
 * signal object — contentMatchesFiledUnderVenue → venueMatch, verifyAggregatorUrl
 * rejectReason → hardReject, isIncludableForRebuild → includable — so this stays
 * data-free and testable against fixtures.
 */

'use strict';

const { isPlaceholderRecord } = require('./placeholder-byline');

const STAR_RE = /(\d(?:\.\d)?)\s*\/\s*5/;
function hasStar(s) {
  return typeof s === 'string' && STAR_RE.test(s);
}

/**
 * A body dominated by cookie/consent boilerplate is NOT a review even when it is
 * long. Length must never substitute for content quality: a 10.7k-char consent
 * wall would otherwise beat genuine prose on the length tiebreak and get scored
 * (the WhatsOnStage/Birmingham-Rep cookie-banner failure, 2026-07-05 plan review).
 * Flags only when consent markers dominate the head AND no review vocabulary is
 * present, so a real review that merely mentions "cookies" in passing survives.
 *
 * @param {string} head  first ~400 chars of the body (lowercased ok)
 * @returns {boolean}
 */
function looksLikeConsentWall(head) {
  if (!head || typeof head !== 'string') return false;
  const h = head.slice(0, 400).toLowerCase();
  const consent = /(your choices|manage (your )?consent|we and our partners|store and\/or access|privacy (policy|choices)|consent(?:,| preferences)|subdomains|allow all|reject all)/.test(h);
  const review = /(review|production|directed|staging|theatre|theater|revival|stars? as|\bact\b|performance)/.test(h);
  return consent && !review;
}

/**
 * @typedef {Object} ClusterFileSignal
 * @property {string}  file            basename (with .json)
 * @property {string}  [contentTier]   complete|excerpt|truncated|stub|invalid
 * @property {number}  [fullTextLen]   length of fullText
 * @property {string}  [fullTextHead]  first ~400 chars of fullText (for consent-wall check)
 * @property {boolean} [wrongProduction]
 * @property {boolean} [wrongProductionManualClear]  an operator already cleared
 *   wrongProduction on this file (mirrors review-guards.js's real scoring gate)
 * @property {boolean} [wrongShow]
 * @property {string}  [aggregatorStars]
 * @property {string}  [originalScore]
 * @property {boolean} [venueMatch]    body names the filed-under venue (overrides a stale wrongShow)
 * @property {boolean} [includable]    isIncludableForRebuild(file) — already scoring
 * @property {number}  [humanReviewScore] set when a human vouched — pins as canonical
 * @property {string}  [criticName]
 * @property {string}  [outlet]        outlet DISPLAY name, e.g. "The Times (UK)" —
 *   needed alongside criticName to detect an outlet-name-as-byline placeholder
 *   (isPlaceholderRecord); the filename prefix alone (bylineSlug vs outletSlug)
 *   misses the exact shape that survived undetected in card #1907
 *   (`times-uk--the-times.json`: filename slug "the-times" != outletSlug
 *   "times-uk", but criticName "The Times" IS the outlet's display name).
 * @property {string}  [duplicateOf]
 */

/**
 * Decide the disposition of one byline-explosion cluster.
 *
 * @param {ClusterFileSignal[]} files  the files sharing this (outlet,url) cluster
 * @param {Object} [opts]
 * @param {boolean} [opts.hardReject]        verifyAggregatorUrl returned a HARD reject
 *   (date-out-of-window | page-title-mismatch) — the URL belongs to a different
 *   show/production, so nothing here is recoverable. (url-token-mismatch is a SOFT
 *   reject — apostrophe/hash URLs like "Ain't No Mo'" — and is NOT passed as hard.)
 * @param {string|null} [opts.preferredCanonical]  driver-supplied canonical override
 *   for clusters where identical bodies carry invented bylines and the genuine
 *   critic is externally known (e.g. aint-no-mo → variety--aramide-tinubu).
 * @returns {{action:'recover'|'skip', reason:string, canonical:string|null}}
 */
function decideClusterAction(files, opts = {}) {
  const list = Array.isArray(files) ? files : [];
  const hardReject = !!opts.hardReject;

  const isCandidate = (f) => {
    if (!f) return false;
    // A human-vouched review is ALWAYS a candidate (and pinned by rank below) —
    // never let a longer junk sibling out-rank and bury real human work.
    if (f.humanReviewScore != null) return true;
    // Mirrors review-guards.js's real isIncludableForRebuild gate (the one that
    // actually decides scoring): wrongProduction is excluded UNLESS a manual
    // clear is already on file. Without this, a file an operator already
    // vetted and cleared (death-of-a-salesman-2022 wsj--charles-isherwood.json,
    // 2026-08-15) is invisible to candidacy, so the driver can never point
    // preferredCanonical at it — the override is silently ignored and a worse
    // file (an --unknown-byline copy) gets recovered instead.
    if (f.wrongProduction === true && f.wrongProductionManualClear !== true) return false;
    // A stale wrongShow flag is overridable ONLY when the body names the venue.
    if (f.wrongShow === true && f.venueMatch !== true) return false;
    // MUST carry a genuine review body. A star / `includable` flag ALONE is not
    // enough: an unflagged wrong-production tour stub (moulin-rouge Chicago
    // `herbert-paine` — 4/5 aggregatorStars, includable via circular-dup
    // recovery, empty body, at a Nederlander-tour URL the show-match gate does
    // not hard-reject) would otherwise be "recovered" and score a US tour review
    // on the West End production. A body is the only per-file signal that
    // positively ties the review to THIS show (2026-07-05 dry-run). Empty
    // extractions of the RIGHT URL (a real review that failed to scrape) return
    // no candidate here too — the driver reports them for a targeted re-gather,
    // which is correct: we must not fabricate a score from a star with no prose.
    return (f.fullTextLen | 0) >= 1500 && !looksLikeConsentWall(f.fullTextHead);
  };

  const candidates = list.filter(isCandidate);
  if (candidates.length === 0) {
    return { action: 'skip', reason: 'no-recoverable-review', canonical: null };
  }
  if (hardReject) {
    return { action: 'skip', reason: 'cluster-url-wrong-show', canonical: null };
  }

  if (opts.preferredCanonical) {
    const pref = candidates.find((c) => c.file === opts.preferredCanonical);
    if (pref) return { action: 'recover', reason: 'preferred-canonical', canonical: pref.file };
  }

  // Rank: human-vouched > real complete body > longest body > already-includable >
  // has a star > concrete (non-placeholder) byline. Final tiebreak on filename =
  // deterministic.
  //
  // BRO-2409 (the placeholder-byline half of its title): the byline check used
  // to be a bare `criticName !== 'unknown'`, which treats an outlet-name-as-
  // byline placeholder ("The Times" at outlet "The Times (UK)") as EQUALLY
  // "concrete" as a real critic's name — so two candidates tied on every
  // earlier rank fell through to filename order, letting the placeholder win a
  // 5+-file byline-explosion cluster exactly like card #1907's 2-file case.
  // isPlaceholderRecord (data fields, not the filename slug) is the same check
  // fix-circular-duplicate-pairs.js's chooseCanonical already uses for the
  // 2-member case. No `defaultCritic` override is threaded through here (the
  // self-branded-solo-critic exception, e.g. carole-di-tosti) — a 5+-byline
  // explosion cluster on a solo-critic outlet is not a real corpus shape, so
  // the imprecision is accepted rather than plumbing outlet-registry lookups
  // through this deliberately data-free (no I/O) module.
  // isPlaceholderRecord alone treats an ABSENT criticName as "not a
  // placeholder" (by design — see its docstring: that case is meant to be
  // handled by a separate, filename-based unknown-byline check upstream,
  // which this module doesn't have). Re-add that half explicitly so an
  // empty/"unknown" byline still ranks as weak, exactly like before.
  const bylineWeak = (f) => {
    const name = (f.criticName || '').trim().toLowerCase();
    if (!name || name === 'unknown') return true;
    return isPlaceholderRecord({ criticName: f.criticName, outlet: f.outlet });
  };
  const rankVec = (f) => [
    f.humanReviewScore != null ? 1 : 0,
    f.contentTier === 'complete' ? 1 : 0,
    f.fullTextLen | 0,
    f.includable === true ? 1 : 0,
    (hasStar(f.aggregatorStars) || hasStar(f.originalScore)) ? 1 : 0,
    !bylineWeak(f) ? 1 : 0,
  ];
  candidates.sort((a, b) => {
    const ra = rankVec(a);
    const rb = rankVec(b);
    for (let i = 0; i < ra.length; i++) {
      if (rb[i] !== ra[i]) return rb[i] - ra[i];
    }
    return a.file < b.file ? -1 : 1;
  });
  return { action: 'recover', reason: 'canonical-selected', canonical: candidates[0].file };
}

module.exports = { decideClusterAction, looksLikeConsentWall, hasStar };
