#!/usr/bin/env node
/**
 * Fail loudly when a discovery source is blind (S4-T3, 2026 data audit
 * BRO-4204). Runs in update-show-status.yml's own `discovery-source-blind`
 * job (needs: update-shows, if: always()) — a separate job rather than a
 * final step of update-shows, so the RUN turns red while update-shows itself
 * stays green and the downstream jobs that gate on its success (create-issue,
 * trigger-data-agent, catchup-zero-review-shows, check-opening-night-
 * readiness) keep running (owner decision 2026-09-28).
 *
 * Two blindness signals were already being WRITTEN on every run, and nothing
 * ever read them, so playbillBroadway sat at a 24-run zero streak (olt and
 * theatremonkey at 23) while every run stayed green:
 *
 *   1. data/audit/discovery-source-coverage.json — per-source `zeroStreak`
 *      (scripts/lib/discovery-source-coverage.js). A watched source whose
 *      streak has reached ZERO_STREAK_ALERT_THRESHOLD (3) is blind: the
 *      market it feeds is being discovered by one fewer source than we
 *      think, and the "independent" cross-check is not independent.
 *   2. data/audit/broadway-source-coverage-state.json `guard.blind` —
 *      written by scripts/check-broadway-source-coverage.js (S4-T2) when the
 *      Playbill parser has rotted (0 entries for >24h).
 *
 * Read-only: never writes data/audit/. Exits 1 on either signal so the run
 * goes red; exits 1 (fail closed) when the coverage file itself is missing
 * or unparseable, because "cannot tell" is not "fine". The pure decision
 * (evaluateDiscoveryBlindness) is exported for the unit test (CLAUDE.md §15).
 *
 * Usage:
 *   node scripts/check-discovery-source-blind.js
 *       [--coverage=<path>] [--state=<path>] [--ob-state=<path>] [--json]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { ZERO_STREAK_ALERT_THRESHOLD } = require('./lib/discovery-source-coverage.js');

const USAGE = `check-discovery-source-blind.js — exit 1 when a Broadway / West End
discovery source is blind (read-only; the red-run step of update-show-status).

Usage:
  node scripts/check-discovery-source-blind.js [--coverage=<path>] [--state=<path>] [--ob-state=<path>] [--json]

Options:
  --coverage=<path>   discovery-source-coverage.json (default data/audit/…)
  --state=<path>      broadway-source-coverage-state.json (default data/audit/…)
  --ob-state=<path>   off-broadway-source-coverage-state.json (default data/audit/…)
  --json              machine-readable verdict
  --help, -h          this help

Exit codes: 0 = every watched source is contributing; 1 = a watched source has
zeroStreak >= ${ZERO_STREAK_ALERT_THRESHOLD}, the Broadway coverage guard is blind, or the coverage
file cannot be read.`;

const ROOT = path.join(__dirname, '..');
const DEFAULT_COVERAGE_PATH = path.join(ROOT, 'data', 'audit', 'discovery-source-coverage.json');
const DEFAULT_STATE_PATH = path.join(ROOT, 'data', 'audit', 'broadway-source-coverage-state.json');
const DEFAULT_OB_STATE_PATH = path.join(ROOT, 'data', 'audit', 'off-broadway-source-coverage-state.json');

// The three sources S4-T3 names: Playbill's announced Broadway schedule, and
// the two West End listing sources (Official London Theatre, TheatreMonkey).
// TodayTix / Playbill OB / the venue crawls are not watched here — they are
// either the primary source (a TodayTix outage already fails discovery on
// its own) or advisory.
// BRO-4381 adds TheaterMania's Off-Broadway listings, the independent OB
// source that found the 16 productions BRO-4377 had to add by hand.
const WATCHED_SOURCES = ['playbillBroadway', 'olt', 'theatremonkey', 'theatermaniaOB'];

/**
 * Pure decision.
 *
 * @param {{ coverage: object|null, guardState: object|null }} input
 *   coverage   — parsed discovery-source-coverage.json, or null if unreadable
 *   guardState — parsed broadway-source-coverage-state.json, or null if absent
 *   obGuardState — parsed off-broadway-source-coverage-state.json (BRO-4381), or null if absent
 * @param {{ threshold?: number, watched?: string[] }} [opts]
 * @returns {{ blind: boolean, reasons: string[] }}
 */
function evaluateDiscoveryBlindness({ coverage, guardState, obGuardState = null }, opts = {}) {
  const threshold = opts.threshold ?? ZERO_STREAK_ALERT_THRESHOLD;
  const watched = opts.watched ?? WATCHED_SOURCES;
  const reasons = [];

  if (!coverage || typeof coverage !== 'object' || !coverage.sources || typeof coverage.sources !== 'object') {
    reasons.push('discovery-source-coverage.json is missing or has no `sources` — cannot tell whether any source is contributing (failing closed)');
  } else {
    for (const name of watched) {
      const s = coverage.sources[name];
      if (!s) continue; // never ran under this name — nothing to judge yet
      const streak = Number(s.zeroStreak) || 0;
      if (streak >= threshold) {
        reasons.push(`${name}: 0 candidates for ${streak} consecutive runs (threshold ${threshold}; last non-zero ${s.lastNonZeroAt || 'never'})`);
      }
    }
  }

  const guard = guardState && typeof guardState === 'object' ? guardState.guard : null;
  if (guard && guard.blind === true) {
    reasons.push(`Broadway source-coverage guard is blind (${guard.reason || 'unknown'} at ${guard.at || 'unknown time'}) — Playbill parser rotted`);
  }

  const obGuard = obGuardState && typeof obGuardState === 'object' ? obGuardState.guard : null;
  if (obGuard && obGuard.blind === true) {
    reasons.push(`Off-Broadway source-coverage guard is blind (${obGuard.reason || 'unknown'} at ${obGuard.at || 'unknown time'}) — TheaterMania OB feed failed or changed shape`);
  }

  return { blind: reasons.length > 0, reasons };
}

function readJsonOrNull(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function argValue(argv, flag) {
  const hit = argv.find(a => a.startsWith(flag + '='));
  return hit ? hit.slice(flag.length + 1) : null;
}

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }

  const coveragePath = argValue(argv, '--coverage') || DEFAULT_COVERAGE_PATH;
  const statePath = argValue(argv, '--state') || DEFAULT_STATE_PATH;
  const obStatePath = argValue(argv, '--ob-state') || DEFAULT_OB_STATE_PATH;
  const asJson = argv.includes('--json');

  const verdict = evaluateDiscoveryBlindness({
    coverage: readJsonOrNull(coveragePath),
    guardState: readJsonOrNull(statePath),
    obGuardState: readJsonOrNull(obStatePath),
  });

  if (asJson) {
    console.log(JSON.stringify({ ...verdict, coveragePath, statePath, obStatePath, watched: WATCHED_SOURCES, threshold: ZERO_STREAK_ALERT_THRESHOLD }, null, 2));
  } else if (verdict.blind) {
    console.error(`::error::${verdict.reasons.length} discovery blindness signal(s) — failing the run (S4-T3):`);
    for (const r of verdict.reasons) console.error(`  - ${r}`);
    console.error('Fix the source (parser/DOM drift, blocked fetch, missing secret) and confirm the streak resets in data/audit/discovery-source-coverage.json on the next run.');
  } else {
    console.log(`Discovery sources contributing: ${WATCHED_SOURCES.join(', ')} all below the ${ZERO_STREAK_ALERT_THRESHOLD}-run zero-streak threshold; Broadway and Off-Broadway coverage guards not blind.`);
  }

  return verdict.blind ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { evaluateDiscoveryBlindness, main, WATCHED_SOURCES, USAGE };
