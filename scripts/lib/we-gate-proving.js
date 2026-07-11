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
    const sources = weReference.sources || {};
    const floors =
      (weReference.allSourcesFailed ? 1 : 0) +
      Object.values(sources).filter(src => src && (src.emptyParse || src.error)).length;
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

module.exports = { recordGateObservation, evaluateProving, emptyTracker, baseTitleKey, GATE_LIVE_DATE, DEFAULTS };
