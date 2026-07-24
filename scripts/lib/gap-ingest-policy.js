/**
 * gap-ingest-policy.js — ingest-safety policy for the review-gap audit.
 *
 * Production-identity check for the BROADWAY discovery path (2026-07-11).
 * The WE reference already date-gates roundups (isCurrentRunRoundup): a roundup
 * whose post date falls outside the current opening window is priorRun and its
 * URLs are permanently ingest-blocked. The Broadway path (SERP-found Playbill
 * Verdict / BWW Review Roundup articles) had NO such check — urlMatchesShow is
 * a wrong-SHOW filter, not a wrong-PRODUCTION filter, so a same-title prior
 * production's roundup passes it (2026-07-10 first-run incident: the 2018
 * Broadway TKAM BWW RR ingested 2018 US reviews onto the WE 2026 entry; same
 * class hit Midsummer/Taymor 2013, Last Ship 2014, JLP 2025). Broadway
 * revivals have the identical exposure with no WE gate to catch them.
 *
 * articleRunIdentity() dates an aggregator ARTICLE (publish-date metadata from
 * the fetched HTML — never from the URL, per CLAUDE.md core data rules) against
 * the show's opening window via the SAME canonical predicate the WE reference
 * uses. A missing date fails open (treated as current) to match the WE
 * convention — Playbill/BWW roundups carry JSON-LD/OpenGraph dates reliably,
 * and the incident class is old dated articles.
 *
 * ingestBlockReason() is the single ingest-eligibility predicate for the
 * audit's --ingest-missing and flaggedMiss-recovery paths (previously two
 * inline copies that only blocked priorRun on weRef rows — meaning the moment
 * WE_GAP_INGEST auto-enables, Broadway-path prior-production URLs on WE shows
 * became ingestable again). priorRun blocks UNCONDITIONALLY, on every path.
 *
 * Pure functions per CLAUDE.md §15 — the audit wires them; tests require() them.
 */

'use strict';

const { extractPublishDate } = require('./article-extractor');
const { isCurrentRunRoundup } = require('./gap-reference-sources');

/**
 * Date an aggregator article against the show's current opening window.
 * @param {string|null} html  fetched article HTML
 * @param {object} show shows.json record ({openingDate})
 * @param {string} [url]  the article's fetch URL, so extractPublishDate can scope
 *   JSON-LD to the entity matching this canonical URL (rejects related-article dates)
 * @returns {{publishDate: string|null, priorRun: boolean}}
 */
function articleRunIdentity(html, show, url) {
  const publishDate = extractPublishDate(html, url);
  return { publishDate, priorRun: !isCurrentRunRoundup(publishDate, show) };
}

/**
 * Why an aggregator-listed URL must NOT be auto-ingested (null = ingestable).
 * @param {object} m    missing/flaggedMiss entry ({priorRun, weRef, weRefSources, serpCensus})
 * @param {object} ctx  {showIsWe: boolean, weGateOn: boolean, lowTrustSources?: Set<string>, serpCensusGateOn?: boolean}
 * @returns {'prior-run'|'we-gate-off'|'serp-census-gate-off'|'low-trust-source'|null}
 */
function ingestBlockReason(m, { showIsWe, weGateOn, lowTrustSources, serpCensusGateOn }) {
  // Production identity: a URL cited only by a prior production's article/roundup
  // is NEVER auto-ingested, on any market, regardless of gate state.
  if (m.priorRun) return 'prior-run';
  // WE completeness gate (default OFF, fails closed): on WE shows ALL missing
  // URLs wait for WE_GAP_INGEST=1; weRef-derived URLs wait for it everywhere.
  if ((showIsWe || m.weRef) && !weGateOn) return 'we-gate-off';
  // SERP census gate (#371, ship-check 2026-07-24): a plain "<title> review"
  // Google query carries no site: restriction — weaker specificity than the
  // aggregator-article queries (Playbill/BWW) that vouch for every OTHER
  // Broadway-path ingest. Without this, a serpCensus-only miss on a Broadway
  // show would auto-ingest via --ingest-missing with zero extra scrutiny, at
  // exactly the moment the generic-title disambiguation guard is weakest
  // (single-token titles like "Oh, Mary!"/"Life of Pi"). Start conservative —
  // same "prove corroboration before auto-enabling" posture the WE gate used
  // (WE_GAP_INGEST) — default OFF via SERP_CENSUS_INGEST. Only reached for
  // non-WE rows; a WE show's serpCensus row is already blocked above.
  if (m.serpCensus && !serpCensusGateOn) return 'serp-census-gate-off';
  // Per-aggregator trust (lib/we-gate-proving.js aggregatorAccuracy): a URL
  // vouched for ONLY by sources whose citations have measurably failed
  // corroboration stays report-only. One trusted citing source is enough to
  // ingest; no source attribution (Broadway-path URLs) is never low-trust.
  if (m.weRef && lowTrustSources && lowTrustSources.size > 0 &&
      Array.isArray(m.weRefSources) && m.weRefSources.length > 0 &&
      m.weRefSources.every((s) => lowTrustSources.has(s))) {
    return 'low-trust-source';
  }
  return null;
}

module.exports = { articleRunIdentity, ingestBlockReason };
