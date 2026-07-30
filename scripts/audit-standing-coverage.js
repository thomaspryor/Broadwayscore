#!/usr/bin/env node
/**
 * audit-standing-coverage.js — derive, and keep honest, the set of outlets
 * carrying `standingCoverage: true` in data/outlet-registry.json.
 *
 * Why this exists (card #627): B1's standingOutlets pseudo-source
 * (scripts/lib/standing-outlets.js) makes a standing outlet's silence a
 * visible census GAP even when no roundup names it. That only works if the
 * flagged set is the set of outlets that genuinely review virtually every
 * Broadway opening. Tier is NOT a proxy for that — measured over the last
 * three seasons, tier-1 Hollywood Reporter covers ~20% of Broadway openings
 * while tier-2 New York Stage Review covers ~98%. Flag an outlet that covers
 * 20% and 4 of every 5 cells it produces is a false GAP.
 *
 * So the set is derived from observed behaviour, not asserted:
 *
 *   PROMOTE  overall >= PROMOTE_OVERALL across the window AND every season
 *            >= PROMOTE_MIN_SEASON (one strong season can't carry a fading
 *            outlet, and one soft season can't sink a consistent one).
 *   DEMOTE   overall < DEMOTE_OVERALL OR the most recent season <
 *            DEMOTE_LATEST_SEASON.
 *
 * The gap between the promote and demote bars is deliberate hysteresis: an
 * outlet hovering at the boundary must not flip flag state season to season,
 * because every flip rewrites what "expected" means for every in-window show
 * at once (the fan-out risk lib/standing-outlets.js caps).
 *
 * Denominator = Broadway openings that drew real press (>= MIN_PRESS_OUTLETS
 * distinct outlets). A show nobody reviewed says nothing about any single
 * outlet's reliability, and including it would penalise every outlet equally.
 *
 * CI-unfetchable outlets (review-census.js CI_UNFETCHABLE_OUTLETS — WSJ, The
 * New Yorker) are never promoted: a GAP cell we can never close by fetching
 * is noise in the dispatch path, not a signal.
 *
 * Standing coverage is Broadway-only by construction — computeShowCells()
 * gates the pseudo-source on `category === 'broadway'`, so a West End outlet
 * flagged here would do nothing. West End completeness has its own gate
 * (memory/project_we_completeness_gate.md).
 *
 * Usage:
 *   node scripts/audit-standing-coverage.js            # table + drift summary
 *   node scripts/audit-standing-coverage.js --json     # machine-readable
 *   node scripts/audit-standing-coverage.js --strict   # exit 1 if registry drifted
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const { CI_UNFETCHABLE_OUTLETS } = require('./lib/review-census');

const REPO_ROOT = path.resolve(__dirname, '..');

const SEASONS = 3; // trailing 12-month windows
const SEASON_DAYS = 365;
const MIN_PRESS_OUTLETS = 5; // a show below this drew no real press — not evidence about any outlet
const MIN_SEASON_SHOWS = 8; // a season thinner than this can't support a rate
const PROMOTE_OVERALL = 0.84;
const PROMOTE_MIN_SEASON = 0.75;
const DEMOTE_OVERALL = 0.7;
const DEMOTE_LATEST_SEASON = 0.6;
const MAX_TIER = 2; // T1/T2 only — the dispatch tiers the SLA ledger acts on

function isoDaysBefore(nowMs, days) {
  return new Date(nowMs - days * 86400000).toISOString().slice(0, 10);
}

/**
 * Pure: measured Broadway coverage per T1/T2 outlet + the registry drift it implies.
 * @param {object[]} shows shows.json rows
 * @param {object[]} reviews reviews.json rows
 * @param {object} outlets outlet-registry.json `outlets` map
 * @param {number} nowMs
 * @returns {{rows: object[], promote: string[], demote: string[], seasons: object[]}}
 */
function evaluateStandingCoverage(shows, reviews, outlets, nowMs) {
  const seasons = [];
  for (let i = 0; i < SEASONS; i++) {
    const end = isoDaysBefore(nowMs, i * SEASON_DAYS);
    const start = isoDaysBefore(nowMs, (i + 1) * SEASON_DAYS);
    seasons.push({ label: `${start}..${end}`, start, end, shows: [] });
  }
  const inWindowIds = new Set();
  for (const s of shows) {
    if (!s || s.category !== 'broadway' || !s.openingDate) continue;
    const season = seasons.find((w) => s.openingDate >= w.start && s.openingDate < w.end);
    if (!season) continue;
    season.shows.push(s.id);
    inWindowIds.add(s.id);
  }

  const outletsByShow = new Map();
  for (const id of inWindowIds) outletsByShow.set(id, new Set());
  for (const r of reviews) {
    const set = r && outletsByShow.get(r.showId);
    if (set) set.add(r.outletId);
  }
  // Drop shows that drew no real press — see MIN_PRESS_OUTLETS.
  for (const season of seasons) {
    season.shows = season.shows.filter((id) => outletsByShow.get(id).size >= MIN_PRESS_OUTLETS);
  }
  const scored = seasons.filter((s) => s.shows.length >= MIN_SEASON_SHOWS);
  const allShows = scored.flatMap((s) => s.shows);

  const rows = [];
  const promote = [];
  const demote = [];
  for (const [outletId, o] of Object.entries(outlets || {})) {
    if (!o || typeof o.tier !== 'number' || o.tier > MAX_TIER) continue;
    const flagged = !!o.standingCoverage;
    const unfetchable = CI_UNFETCHABLE_OUTLETS.has(outletId);
    const seasonRates = scored.map((s) => ({
      label: s.label,
      shows: s.shows.length,
      rate: s.shows.filter((id) => outletsByShow.get(id).has(outletId)).length / s.shows.length,
    }));
    const overall = allShows.length
      ? allShows.filter((id) => outletsByShow.get(id).has(outletId)).length / allShows.length
      : 0;
    const minSeason = seasonRates.length ? Math.min(...seasonRates.map((s) => s.rate)) : 0;
    const latestSeason = seasonRates.length ? seasonRates[0].rate : 0;

    // No season data at all → no opinion; never churn the registry on silence.
    const qualifies = seasonRates.length > 0 && !unfetchable
      && overall >= PROMOTE_OVERALL && minSeason >= PROMOTE_MIN_SEASON;
    const disqualifies = seasonRates.length > 0
      && (unfetchable || overall < DEMOTE_OVERALL || latestSeason < DEMOTE_LATEST_SEASON);

    if (!flagged && qualifies) promote.push(outletId);
    if (flagged && disqualifies) demote.push(outletId);
    rows.push({ outletId, tier: o.tier, flagged, unfetchable, overall, minSeason, latestSeason, seasonRates });
  }
  rows.sort((a, b) => b.overall - a.overall || a.outletId.localeCompare(b.outletId));
  return { rows, promote: promote.sort(), demote: demote.sort(), seasons: scored.map((s) => ({ label: s.label, shows: s.shows.length })) };
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
}

function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) {
    console.log('Usage: node scripts/audit-standing-coverage.js [--json] [--strict]');
    console.log('  Reports measured Broadway coverage per T1/T2 outlet and any');
    console.log('  outlet-registry.json standingCoverage drift. Read-only.');
    process.exit(0);
  }
  const jsonOut = args.includes('--json');
  const strict = args.includes('--strict');

  const shows = readJson('data/shows.json').shows;
  const reviews = readJson('data/reviews.json').reviews;
  const outlets = readJson('data/outlet-registry.json').outlets;
  const result = evaluateStandingCoverage(shows, reviews, outlets, Date.now());

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`=== standingCoverage audit — ${result.seasons.map((s) => `${s.label} (${s.shows} shows)`).join(', ')} ===`);
    console.log('  all%  ' + result.seasons.map((_, i) => `S${i + 1}`.padStart(5)).join('') + '  tier  flag  outlet');
    for (const r of result.rows) {
      if (r.overall < 0.5 && !r.flagged) continue; // long tail of selective outlets — never candidates
      const pct = (p) => `${(p * 100).toFixed(0)}%`.padStart(5);
      console.log(`  ${pct(r.overall)}  ${r.seasonRates.map((s) => pct(s.rate)).join('')}  t${r.tier}   ${r.flagged ? ' ✓  ' : '    '}  ${r.outletId}${r.unfetchable ? '  (CI-unfetchable)' : ''}`);
    }
    console.log('');
    console.log(`  promote (unflagged, clears the bar): ${result.promote.length ? result.promote.join(', ') : '(none)'}`);
    console.log(`  demote  (flagged, below the floor):  ${result.demote.length ? result.demote.join(', ') : '(none)'}`);
  }

  const drifted = result.promote.length + result.demote.length;
  process.exit(strict && drifted ? 1 : 0);
}

if (require.main === module) main();

module.exports = {
  evaluateStandingCoverage,
  PROMOTE_OVERALL,
  PROMOTE_MIN_SEASON,
  DEMOTE_OVERALL,
  DEMOTE_LATEST_SEASON,
  MIN_PRESS_OUTLETS,
  MIN_SEASON_SHOWS,
};
