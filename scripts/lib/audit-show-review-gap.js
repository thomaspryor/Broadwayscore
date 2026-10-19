'use strict';

// Shared count for the audit checkpoint and coverage alerts. No I/O.
const { currentRunOnly, currentRunCount } = require('./prior-production-citations');
const { classifyGapCandidateUrl } = require('./non-review-url-patterns');
const { classifyIngestSkip, classifyReason } = require('./ingest-skip-classify');

function defaultCollectable(m) {
  return !m || !m.url || classifyGapCandidateUrl(m.url).ok;
}

// Older audit rows retained the writer's diagnosis without the expected flag.
// A reroute resolves the citation for its source show, even when the ingest
// subsequently fails to merge at the destination. Ownership conflicts alone
// are insufficient evidence that the citation belongs to another production.
function isResolvedIngest(result, showId) {
  if (result.ok) return true;
  if (result.conflict) return false;
  if (result.expected) return true;
  const reason = String(result.reason || '');
  const rawReason = result.expectedReason || (/^[a-z0-9-]+(?::|$)/i.test(reason) ? reason : null);
  if (classifyReason(rawReason).kind === 'expected'
    || classifyIngestSkip(reason).kind === 'expected') return true;
  if (/^unknown-outlet-aggregator-host\s*\(/.test(reason)
    || reason === 'syndicated-reprint') return true;
  const reroute = reason.match(/(?:^|\n)\s*(?:⚠️\s*)?Cross-market reroute:\s*([a-z0-9-]+)\s*→\s*([a-z0-9-]+)\s*\(/i);
  return !!(reroute && reroute[1] === showId && reroute[2] !== showId);
}

function currentRunUncollected(r, { isCollectable = defaultCollectable, ignoreCensusTagged = false } = {}) {
  // BRO-5134: an ingest the writer correctly and permanently refused (expected
  // rejection: e.g. a Time Out listing capsule) can never be collected, so it
  // must not re-fire the alert hourly. Conflicts and unclassified skips still count.
  const resolved = new Set((r.ingestResults || []).filter(x => isResolvedIngest(x, r.showId)).map(x => x.url));
  // BRO-5252: SERP-census rows are report-only until SERP_CENSUS_INGEST=1, so
  // this audit can never collect them. Counting them made the opening-window
  // alert unresolvable (Alice in Wonderland: 7 un-ingestable census hits, wrong
  // productions, re-fired hourly). They stay in r.missing / the audit JSON.
  // BRO-5513: ingestBlockReason returns the FIRST matching reason, so on a WE
  // show a census-only URL is blocked as 'we-gate-off' and never carries
  // 'serp-census-gate-off' (Measure for Measure, Riverside: Folger DC, Austin,
  // RSC Stratford hits re-fired the alert hourly). Judge by provenance: a
  // census-tagged row blocked while the census gate is OFF is report-only (with
  // the gate ON, a we-gate-off hold is a real pending gap and still counts).
  const censusUrls = new Set((r.missing || []).filter(m => m && m.serpCensus).map(m => m.url));
  const reportOnly = new Set((r.weIngestBlocked || [])
    .filter(x => x.reason === 'serp-census-gate-off' || (censusUrls.has(x.url) && !x.censusGateOn)).map(x => x.url));
  const missing = currentRunOnly(r.missing)
    .filter(m => !resolved.has(m.url) && !reportOnly.has(m.url) && !(ignoreCensusTagged && m.serpCensus) && isCollectable(m)).length;
  const citedNoUrl = currentRunCount(r.citedNoUrl);
  return missing + citedNoUrl;
}

module.exports = { currentRunUncollected };
