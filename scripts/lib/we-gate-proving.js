/**
 * WE completeness gate — self-proving auto-enable (2026-07-11).
 *
 * The gate shipped report-only with the rollout rule "enable auto-ingest after
 * the report proves itself on ≥2 real openings". A human was never going to
 * remember to flip the variable (user rule: automate it). This lib
 * operationalizes "proves itself", tracked per WE opening in
 * data/audit/we-gate-proving.json; the audit auto-enables WE_GAP_INGEST when
 * the criteria are met and emails the owner.
 *
 * Ship-check P0 (2026-07-11): the first draft measured detector UPTIME (rows
 * appeared, no floors) — satisfiable by prior-run-only roundups whose rows are
 * permanently ingest-blocked. Proving must measure CORRECTNESS. A show now
 * QUALIFIES only when ALL hold:
 *   - NEW opening (openingDate strictly after GATE_LIVE_DATE)
 *   - audited ≥ minAudits times
 *   - the reference produced ≥ minRows CURRENT-RUN rows at least once
 *     (prior-run rows never count — they can't be ingested, so they can't
 *     prove ingest safety)
 *   - ≥ minCorroborated of those citations were CORROBORATED at least once:
 *     the reference named reviews we independently already have (covered
 *     files). Corroboration is the machine-checkable accuracy signal — if the
 *     roundup's citations match reality where we CAN check, ingesting the ones
 *     we lack is justified.
 *   - ZERO detector-failure floors across all observations (one
 *     emptyParse/blackout/error permanently disqualifies the show as evidence)
 *
 * Enable fires when ≥ minShows qualifying shows remain after deduping by base
 * title (a WE + off-WE sibling pair of the same production counts once —
 * ship-check P1).
 *
 * Pure functions per CLAUDE.md §15 — the audit wires them; tests require() them.
 */

const GATE_LIVE_DATE = '2026-07-10';

const DEFAULTS = { minShows: 2, minAudits: 2, minRows: 3, minCorroborated: 2 };

// Per-aggregator trust (2026-07-11): corroboration is tracked PER SOURCE so the
// accuracy of each aggregator's citations is a measured quantity, not just an
// input to the one-time binary enable. A source needs ≥ minCited checkable
// citations before its accuracy means anything (fail-open below that), and a
// source below the accuracy floor loses auto-ingest privileges (its rows stay
// report-only) even while trusted sources keep ingesting.
const ACCURACY_DEFAULTS = { minCited: 5, minAccuracy: 0.6 };

function emptyTracker() {
  return { version: 2, shows: {}, enabledAt: null, provenAt: null, lastEnableAttemptAt: null, notifyPending: false };
}

/** Base-title key so sibling entries of one production can't double-count. */
function baseTitleKey(showId) {
  return String(showId || '')
    .replace(/-(off-)?(west-end|broadway)(-\d{4})?$/,'')
    .replace(/-\d{4}$/,'');
}

/**
 * Record one audit observation of a WE in-window show.
 * @param {object} tracker  mutated in place (and returned)
 * @param {object} show     shows.json record ({id, openingDate})
 * @param {object} weReference  result.weReference from auditShow
 *   ({rowCount, currentRunRows, corroborated, sources, allSourcesFailed})
 * @param {string} [nowIso]
 */
function recordGateObservation(tracker, show, weReference, nowIso = new Date().toISOString()) {
  if (!tracker.shows) tracker.shows = {};
  const e = tracker.shows[show.id] || {
    openingDate: show.openingDate || null,
    audits: 0,
    currentRunRowsMax: 0,
    corroboratedMax: 0,
    floorErrors: 0,
    firstAt: nowIso,
  };
  e.audits += 1;
  e.lastAt = nowIso;
  e.openingDate = show.openingDate || e.openingDate;
  if (weReference) {
    e.currentRunRowsMax = Math.max(e.currentRunRowsMax, weReference.currentRunRows || 0);
    e.corroboratedMax = Math.max(e.corroboratedMax, weReference.corroborated || 0);
    // Per-source corroboration: keep each source's FULLEST-and-LATEST observation
    // for this show (max cited; on equal cited the LATEST observation wins).
    // Max-of-observation semantics — NOT a running sum — so the hourly cron
    // re-observing the same citations doesn't double-count them; latest-on-tie
    // (codex review 2026-07-11) so a corroboration REGRESSION (covered files
    // later flagged out) updates accuracy instead of preserving the flattering
    // early snapshot forever. A lower-cited observation (partial fetch) never
    // erases fuller evidence.
    if (weReference.perSource) {
      e.perSource = e.perSource || {};
      for (const [src, obs] of Object.entries(weReference.perSource)) {
        const cited = obs.cited || 0, corroborated = obs.corroborated || 0;
        const prev = e.perSource[src];
        if (!prev || cited >= prev.cited) {
          e.perSource[src] = { cited, corroborated };
        }
      }
    }
    const sources = weReference.sources || {};
    // Passive (archive-only) sources never count as floors: they're bonus
    // coverage, and a stale/paywall-stub archive artifact must not permanently
    // disqualify a show from proving while the fetching sources are healthy
    // (QA review 2026-07-11 — floorErrors===0 is required and never resets).
    const floors =
      (weReference.allSourcesFailed ? 1 : 0) +
      Object.values(sources).filter(src => src && !src.passive && (src.emptyParse || src.error)).length;
    e.floorErrors += floors;
  } else {
    // The WE branch threw before producing a reference — that IS a floor.
    e.floorErrors += 1;
  }
  tracker.shows[show.id] = e;
  return tracker;
}

/**
 * Decide whether the gate has proven itself.
 * @returns {{enable: boolean, qualifying: string[], reason: string}}
 */
function evaluateProving(tracker, opts = {}) {
  const { minShows, minAudits, minRows, minCorroborated } = { ...DEFAULTS, ...opts };
  if (!tracker || tracker.enabledAt) {
    return { enable: false, qualifying: [], reason: tracker && tracker.enabledAt ? 'already enabled' : 'no tracker' };
  }
  const qualifyingIds = Object.entries(tracker.shows || {})
    .filter(([, e]) =>
      e.openingDate && e.openingDate > GATE_LIVE_DATE &&
      e.audits >= minAudits &&
      (e.currentRunRowsMax || 0) >= minRows &&
      (e.corroboratedMax || 0) >= minCorroborated &&
      e.floorErrors === 0)
    .map(([id]) => id);
  // Dedupe siblings of the same production (WE + off-WE entries) by base title.
  const seenTitles = new Set();
  const qualifying = qualifyingIds.filter((id) => {
    const k = baseTitleKey(id);
    if (seenTitles.has(k)) return false;
    seenTitles.add(k);
    return true;
  });
  if (qualifying.length >= minShows) {
    return {
      enable: true,
      qualifying,
      reason: `${qualifying.length} new opening(s) whose reference citations were corroborated against independently-gathered reviews, with zero detector failures`,
    };
  }
  return { enable: false, qualifying, reason: `${qualifying.length}/${minShows} qualifying opening(s) so far` };
}

/**
 * Roll up per-source corroboration across every tracked show.
 * @returns {Record<string, {cited: number, corroborated: number, accuracy: number|null, shows: number}>}
 *   accuracy is null while cited < minCited (not enough evidence to judge).
 */
function aggregatorAccuracy(tracker, opts = {}) {
  const { minCited } = { ...ACCURACY_DEFAULTS, ...opts };
  const out = {};
  for (const e of Object.values((tracker && tracker.shows) || {})) {
    for (const [src, obs] of Object.entries(e.perSource || {})) {
      const agg = out[src] = out[src] || { cited: 0, corroborated: 0, accuracy: null, shows: 0 };
      agg.cited += obs.cited || 0;
      agg.corroborated += obs.corroborated || 0;
      agg.shows += 1;
    }
  }
  for (const agg of Object.values(out)) {
    if (agg.cited >= minCited) agg.accuracy = agg.corroborated / agg.cited;
  }
  return out;
}

/**
 * Sources that have PROVEN untrustworthy: enough checkable citations, low
 * corroboration rate. Fail-open — a source with a thin sample is NOT low-trust.
 * @returns {Set<string>}
 */
function lowTrustSources(tracker, opts = {}) {
  const { minAccuracy } = { ...ACCURACY_DEFAULTS, ...opts };
  const low = new Set();
  for (const [src, agg] of Object.entries(aggregatorAccuracy(tracker, opts))) {
    if (agg.accuracy !== null && agg.accuracy < minAccuracy) low.add(src);
  }
  return low;
}

module.exports = {
  recordGateObservation, evaluateProving, emptyTracker, baseTitleKey,
  aggregatorAccuracy, lowTrustSources,
  GATE_LIVE_DATE, DEFAULTS, ACCURACY_DEFAULTS,
};
