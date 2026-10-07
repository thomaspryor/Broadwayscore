'use strict';

/**
 * audience-buzz-contamination-gate.js — pure block/pass decision for
 * `audit-audience-buzz-contamination.js --gate` (the per-push trunk catastrophe floor).
 *
 * Extracted (CLAUDE.md §15) so the gate logic is unit-tested independently of the
 * data/audience-buzz.json scan, matching contamination-gate / non-review-gate.
 * audience-buzz.json is rewritten by the Reddit / Show Score / Mezzanine / Theatr
 * scrapers on weekly-to-monthly crons.
 *
 * This is the audit whose hard-fail-on-any-FAIL actually reddened main: run
 * f8abff972 (2026-06-30) failed because glengarry-glen-ross-west-end-2026 tripped
 * REDDIT_SCORE_DIVERGENCE at diff=EXACTLY 40 (reddit 48 vs median 88). A single
 * 40-point divergence is NOT zero-FP — it is just as likely a genuine
 * audience/critic split as a misrouted Reddit search, so it must not block an
 * unrelated push. The zero-tolerance catastrophe for this file is a SPIKE: several
 * shows diverging at once is the signature of a scraper regression (a search-query
 * or matching change that misrouted many titles), not data noise.
 *
 * So unlike the other three contamination gates this one uses a non-zero floor:
 * gateHits = the count of REDDIT_SCORE_DIVERGENCE (FAIL) shows; block only when it
 * exceeds `floor` (default 2 — one or two borderline divergences ride the digest,
 * 3+ simultaneous is a regression). The single glengarry-class divergence, and all
 * WARN-severity drift (OTHER_SOURCE_STALE, BROADWAYCOM_URL_NO_TITLE,
 * REDDIT_GENERIC_VOLUME_INFLATION, SHOW_NOT_IN_DB), surface daily and non-blocking
 * via the FULL --strict run in check-corpus-drift.yml → digest, where a human
 * triages whether the score is genuine or contaminated.
 *
 * @param {{gateHits:number, floor?:number}} counts
 * @returns {boolean} true if the trunk should be BLOCKED (exit 1)
 */
const DIVERGENCE_SPIKE_FLOOR = 2;

function shouldBlockAudienceBuzzContaminationGate({ gateHits, floor = DIVERGENCE_SPIKE_FLOOR }) {
  return gateHits > floor;
}

module.exports = { shouldBlockAudienceBuzzContaminationGate, DIVERGENCE_SPIKE_FLOOR };
