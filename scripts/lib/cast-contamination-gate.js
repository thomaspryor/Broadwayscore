'use strict';

/**
 * cast-contamination-gate.js — pure block/pass decision for
 * `audit-cast-contamination.js --gate` (the per-push trunk catastrophe floor).
 *
 * Extracted (CLAUDE.md §15) so the gate logic is unit-tested independently of the
 * data/cast/*.json scan, matching contamination-gate / non-review-gate. The split
 * exists because data/cast/ is mutated by the backfill bots (scripts/backfill-
 * cast-web.js does SERP → LLM extraction), so blocking on ANY flagged file
 * reddened the trunk for every unrelated code push whenever one pre-existing
 * contaminated file sat in the corpus.
 *
 * The per-push CATASTROPHE class is a cast file whose orphan rows carry a
 * wrong-SHOW contamination signal — opera-title roles on a non-opera show, TV /
 * film "known for" role text, LASTNAME-FIRSTNAME name swaps, bare column-header
 * roles ("Original"/"Replacement"), or an opera-publication sourceUrl on a
 * non-opera show. These are the signature of the 2026-05-23 incident (12 files
 * with Met-Opera singers written as Kavalier-Clay cast) and have no legitimate
 * false positives — a real cast file never lists opera roles for a Broadway play.
 * Floor defaults to 0: a single such file is user-facing-wrong if the orphan-cast
 * manifest skip is ever lifted, and it is NOT auto-healable on the timescale that
 * matters.
 *
 * The SOFT signals (SRC_URL_NO_TITLE — a URL-token heuristic that FPs when a real
 * source URL just omits title tokens; SHOW_NOT_IN_DB — an orphaned file that is
 * usually a show-add timing artifact, warn-only in the sibling audits) are NOT
 * counted here. They stay advisory: the FULL audit (fails + warns) runs daily and
 * non-blocking in check-corpus-drift.yml, surfaced in the digest.
 *
 * @param {{gateHits:number, floor?:number}} counts
 * @returns {boolean} true if the trunk should be BLOCKED (exit 1)
 */
function shouldBlockCastContaminationGate({ gateHits, floor = 0 }) {
  return gateHits > floor;
}

// The wrong-show-cast contamination signals that gate the trunk (zero-FP class).
// Soft heuristics (SRC_URL_NO_TITLE, SHOW_NOT_IN_DB) are warn-only — drift, not gate.
const GATE_SIGNALS = new Set([
  'OPERA_ROLES',
  'TV_ROLES',
  'NAME_SWAP',
  'ROLE_IS_COLUMN_HEADER',
  'SRC_URL_OPERA_DOMAIN',
]);

module.exports = { shouldBlockCastContaminationGate, GATE_SIGNALS };
