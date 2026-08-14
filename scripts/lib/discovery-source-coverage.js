'use strict';

/**
 * Per-source discovery contribution telemetry (card #1445).
 *
 * discover-new-shows.js unions several sources (TodayTix, Playbill Broadway
 * schedule, Playbill OB schedule, OB venue listings, West End sources,
 * ShowScore candidates). Before this existed, Broadway.org was wired as an
 * `if (discoveredShows.length === 0)` fallback that TodayTix's reliable
 * ~40-show return effectively disabled forever — dead code that looked like
 * redundancy while Broadway discovery silently depended on TodayTix alone
 * for months. Nothing ever reported "source B contributed 0" because source
 * B never ran.
 *
 * This module tracks, per source, how many consecutive runs it contributed
 * ZERO candidates. A source hitting the streak threshold is a defect
 * signal — the source is blind, broken, or its selector/API drifted — not
 * silence to shrug off. Pure decision function (computeNextState) is
 * exported separately from the state I/O so it can be tested without
 * touching the filesystem (CLAUDE.md §15).
 */

const fs = require('fs');
const path = require('path');

const AUDIT_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'discovery-source-coverage.json');

// A source alerts once it has contributed 0 candidates for this many
// consecutive runs it participated in. 3 rather than 1: a single-run zero
// is often a transient scrape failure (Cloudflare, timeout) already logged
// by its own try/catch — the coverage guard exists to catch SUSTAINED
// blindness, not every hiccup.
const ZERO_STREAK_ALERT_THRESHOLD = 3;

/**
 * prevState: { sources: { [name]: { lastCount, zeroStreak, totalRuns, lastNonZeroAt, lastRunAt } } } | null
 * sourceCounts: { [name]: number } — this run's candidate count per source that ran
 * nowIso: ISO timestamp for this run
 * Returns { nextState, silentSources: [{ name, zeroStreak, lastNonZeroAt }] }
 */
function computeNextState(prevState, sourceCounts, nowIso) {
  const sources = { ...(prevState && prevState.sources) };
  const silentSources = [];

  for (const [name, count] of Object.entries(sourceCounts)) {
    const prev = sources[name] || { lastCount: null, zeroStreak: 0, totalRuns: 0, lastNonZeroAt: null, lastRunAt: null };
    const zeroStreak = count > 0 ? 0 : prev.zeroStreak + 1;
    const next = {
      lastCount: count,
      zeroStreak,
      totalRuns: prev.totalRuns + 1,
      lastNonZeroAt: count > 0 ? nowIso : prev.lastNonZeroAt,
      lastRunAt: nowIso,
    };
    sources[name] = next;
    if (zeroStreak >= ZERO_STREAK_ALERT_THRESHOLD) {
      silentSources.push({ name, zeroStreak, lastNonZeroAt: next.lastNonZeroAt });
    }
  }

  return { nextState: { sources, updatedAt: nowIso }, silentSources };
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
  fs.writeFileSync(AUDIT_PATH, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Loads the persisted state, applies this run's sourceCounts, writes the
 * result back to data/audit/discovery-source-coverage.json, and returns
 * which sources (if any) have crossed the silent-source threshold.
 */
function recordDiscoveryRun(sourceCounts, nowIso = new Date().toISOString()) {
  const prevState = loadState();
  const { nextState, silentSources } = computeNextState(prevState, sourceCounts, nowIso);
  saveState(nextState);
  return { state: nextState, silentSources };
}

module.exports = {
  AUDIT_PATH,
  ZERO_STREAK_ALERT_THRESHOLD,
  computeNextState,
  loadState,
  saveState,
  recordDiscoveryRun,
};
