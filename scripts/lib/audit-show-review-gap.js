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
    .filter(x => x.reason === 'serp-census-gate-off' || x.reason === 'unregistered-host' || (censusUrls.has(x.url) && !x.censusGateOn)).map(x => x.url));
  const missing = currentRunOnly(r.missing)
    .filter(m => !resolved.has(m.url) && !reportOnly.has(m.url) && !(ignoreCensusTagged && m.serpCensus) && isCollectable(m)).length;
  const citedNoUrl = currentRunCount(r.citedNoUrl);
  return missing + citedNoUrl;
}

// BRO-5627: an undated gap ingest skips the date-plausibility guard (it only
// judges a date it can read), so on a revival a prior production's review can
// land in the new run's folder and later be scored there (the-ask-off-broadway-2026:
// a 2024 New Yorker capsule stored with publishDate null). When the show carries
// ANY evidence of an earlier dated run, an ingest must resolve a publish date or
// be refused. Returns a short audit-trail reason, or null when there is no evidence.
const DAY_MS = 24 * 60 * 60 * 1000;
// Same 30-day pre-opening slack isCurrentRunRoundup gives a current-run article.
const RUN_WINDOW_SLACK_DAYS = 30;
// Days before previews/opening a HELD review must be dated to evidence an earlier run.
const HELD_PRIOR_RUN_MIN_DAYS = 180;

function runWindowStartMs(show) {
  const starts = [show && show.previewsStartDate, show && show.openingDate]
    .map(d => (d ? Date.parse(d) : NaN)).filter(Number.isFinite);
  return starts.length ? Math.min(...starts) - RUN_WINDOW_SLACK_DAYS * DAY_MS : null;
}

function earlierDatedCitation(result, show, { heldDates = [] } = {}) {
  const r = result || {};
  const priorArt = (r.priorRunArticles || []).find(a => a && a.url);
  if (priorArt) return `prior-run-article:${priorArt.publishDate || priorArt.url}`;
  const priorRow = [...(r.missing || []), ...(r.flaggedMisses || [])].find(m => m && m.priorRun);
  if (priorRow) return `prior-run-citation:${priorRow.priorRunSource || priorRow.url}`;
  if (show && Array.isArray(show.priorRuns) && show.priorRuns.length) return 'declared-prior-run';
  // A held file only counts when dated well before this run: preview features
  // and interviews land weeks before previews (53 of 161 live shows had one
  // inside 90 days), a prior production lands a season or more earlier.
  const start = runWindowStartMs(show);
  if (start !== null) {
    const cutoff = start - (HELD_PRIOR_RUN_MIN_DAYS - RUN_WINDOW_SLACK_DAYS) * DAY_MS;
    const early = heldDates.map(d => (d ? Date.parse(d) : NaN)).find(ms => Number.isFinite(ms) && ms < cutoff);
    if (early !== undefined) return `held-review-dated:${new Date(early).toISOString().slice(0, 10)}`;
  }
  return null;
}

// Whether one gap ingest must resolve a publish date before it may write.
// A row cited only by an undated aggregator article is the articleRunIdentity
// fail-open (no date, so no production identity) and needs a date of its own.
function gapIngestRequiresPublishDate(row, evidence) {
  return !!evidence || !!(row && row.datelessCitationOnly);
}

module.exports = { currentRunUncollected, earlierDatedCitation, gapIngestRequiresPublishDate, runWindowStartMs };
