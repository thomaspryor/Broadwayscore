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
 * Card #640 extends the same measured-evidence approach to coverageExpectation
 * (the "this outlet does NOT review theatre" / evidence-of-active-coverage
 * determinations, scripts/lib/coverage-expectation.js) — see
 * evaluateCoverageExpectationDrift() below. Those claims carry their own
 * DECAY_DAYS re-probe window; unlike standingCoverage, nothing was re-deriving
 * them, so a wrong one just aged out silently with no re-decision prompt.
 *
 * Usage:
 *   node scripts/audit-standing-coverage.js                       # table + drift summary
 *   node scripts/audit-standing-coverage.js --json                # machine-readable
 *   node scripts/audit-standing-coverage.js --strict               # exit 1 if registry drifted
 *   node scripts/audit-standing-coverage.js --coverage-expectation # coverageExpectation drift report
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const { CI_UNFETCHABLE_OUTLETS } = require('./lib/review-census');
const { DECAY_DAYS: COVERAGE_EXPECTATION_DECAY_DAYS } = require('./lib/coverage-expectation');

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
// A "no review expected" claim contradicted by measured coverage at/above this
// rate is a wrong determination hiding a real gap, not a selective outlet.
const COVERAGE_EXPECTATION_CONTRADICTION_RATE = 0.5;

function isoDaysBefore(nowMs, days) {
  return new Date(nowMs - days * 86400000).toISOString().slice(0, 10);
}

/**
 * Pure: bucket shows.json into trailing seasons and index scored outlets per
 * show. Shared by evaluateStandingCoverage and evaluateCoverageExpectationDrift
 * so both derive coverage rates from the exact same evidence.
 * @param {object[]} shows shows.json rows
 * @param {object[]} reviews reviews.json rows
 * @param {number} nowMs
 * @returns {{scored: object[], allShows: string[], outletsByShow: Map<string,Set<string>>}}
 */
function computeSeasonWindows(shows, reviews, nowMs) {
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
  return { scored, allShows, outletsByShow };
}

/**
 * Pure: measured coverage summary for one outlet against the pre-computed
 * season windows. `hasEvidence: false` means no opinion is possible (too few
 * in-window shows) — callers must not treat that as "0% coverage".
 * @param {string} outletId
 * @param {object[]} scored season windows from computeSeasonWindows()
 * @param {string[]} allShows flattened show ids from computeSeasonWindows()
 * @param {Map<string,Set<string>>} outletsByShow from computeSeasonWindows()
 * @returns {{hasEvidence: boolean, overall: number, minSeason: number, latestSeason: number, seasonRates: object[]}}
 */
function measureOutletCoverage(outletId, scored, allShows, outletsByShow) {
  if (!scored.length) return { hasEvidence: false, overall: 0, minSeason: 0, latestSeason: 0, seasonRates: [] };
  const seasonRates = scored.map((s) => ({
    label: s.label,
    shows: s.shows.length,
    rate: s.shows.filter((id) => outletsByShow.get(id).has(outletId)).length / s.shows.length,
  }));
  const overall = allShows.length
    ? allShows.filter((id) => outletsByShow.get(id).has(outletId)).length / allShows.length
    : 0;
  const minSeason = Math.min(...seasonRates.map((s) => s.rate));
  const latestSeason = seasonRates[0].rate;
  return { hasEvidence: true, overall, minSeason, latestSeason, seasonRates };
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
  const { scored, allShows, outletsByShow } = computeSeasonWindows(shows, reviews, nowMs);

  const rows = [];
  const promote = [];
  const demote = [];
  for (const [outletId, o] of Object.entries(outlets || {})) {
    if (!o || typeof o.tier !== 'number' || o.tier > MAX_TIER) continue;
    const flagged = !!o.standingCoverage;
    const unfetchable = CI_UNFETCHABLE_OUTLETS.has(outletId);
    const measured = measureOutletCoverage(outletId, scored, allShows, outletsByShow);
    const { overall, minSeason, latestSeason, seasonRates } = measured;

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

/**
 * Pure predicate (card #640) — classify a single outlet's coverageExpectation
 * claim against measured evidence. Returns null when the outlet carries no
 * claim at all (nothing to re-decide).
 *
 *   active       — claim decided within COVERAGE_EXPECTATION_DECAY_DAYS, not contradicted
 *   decayed      — decidedAt missing or older than the decay window; needs a re-probe
 *   contradicted — a "no review expected" claim (coverageExpectation:'none' /
 *                  reviewsTheater:false) but measured coverage is non-trivial —
 *                  the suppression is hiding a real gap. Fires regardless of
 *                  age, same as detectReactivation() in coverage-expectation.js.
 *   no-evidence  — too few in-window shows to measure; no opinion either way
 *
 * @param {object} outletEntry outlet-registry.json entry (or undefined)
 * @param {{hasEvidence: boolean, overall: number}} measured from measureOutletCoverage()
 * @param {number} nowMs
 * @returns {{status: string, ageDays: number|null, isNoReviewClaim: boolean}|null}
 */
function classifyCoverageExpectationDrift(outletEntry, measured, nowMs) {
  const o = outletEntry || {};
  const isNoReviewClaim = o.coverageExpectation === 'none' || o.reviewsTheater === false;
  const hasClaim = isNoReviewClaim || o.coverageExpectation === 'reviews';
  if (!hasClaim) return null;

  const decidedAt = o.coverageExpectationDecidedAt;
  const decidedMs = decidedAt ? Date.parse(decidedAt) : NaN;
  const ageDays = Number.isFinite(decidedMs) ? (nowMs - decidedMs) / 86400000 : null;

  const hasEvidence = !!(measured && measured.hasEvidence);
  const overall = hasEvidence ? measured.overall : null;

  if (isNoReviewClaim && hasEvidence && overall >= COVERAGE_EXPECTATION_CONTRADICTION_RATE) {
    return { status: 'contradicted', ageDays, isNoReviewClaim };
  }
  if (!hasEvidence) {
    return { status: 'no-evidence', ageDays, isNoReviewClaim };
  }
  if (ageDays == null || ageDays > COVERAGE_EXPECTATION_DECAY_DAYS) {
    return { status: 'decayed', ageDays, isNoReviewClaim };
  }
  return { status: 'active', ageDays, isNoReviewClaim };
}

/**
 * Every outlet carrying a coverageExpectation claim, classified against
 * measured 3-season Broadway coverage. Unlike evaluateStandingCoverage this is
 * NOT tier-filtered — a stale claim on any outlet is worth surfacing.
 * @param {object[]} shows shows.json rows
 * @param {object[]} reviews reviews.json rows
 * @param {object} outlets outlet-registry.json `outlets` map
 * @param {number} nowMs
 * @returns {{rows: object[], needsReprobe: string[]}}
 */
function evaluateCoverageExpectationDrift(shows, reviews, outlets, nowMs) {
  const { scored, allShows, outletsByShow } = computeSeasonWindows(shows, reviews, nowMs);
  const rows = [];
  for (const [outletId, o] of Object.entries(outlets || {})) {
    const measured = measureOutletCoverage(outletId, scored, allShows, outletsByShow);
    const verdict = classifyCoverageExpectationDrift(o, measured, nowMs);
    if (!verdict) continue;
    rows.push({
      outletId,
      coverageExpectation: o.coverageExpectation || (o.reviewsTheater === false ? 'reviewsTheater:false' : null),
      decidedAt: o.coverageExpectationDecidedAt || null,
      hasEvidence: measured.hasEvidence,
      overall: measured.hasEvidence ? measured.overall : null,
      ...verdict,
    });
  }
  rows.sort((a, b) => (b.ageDays ?? Infinity) - (a.ageDays ?? Infinity) || a.outletId.localeCompare(b.outletId));
  const needsReprobe = rows.filter((r) => r.status === 'decayed' || r.status === 'contradicted').map((r) => r.outletId).sort();
  return { rows, needsReprobe };
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
}

function printCoverageExpectationReport(result) {
  console.log('=== coverageExpectation audit (card #640) ===');
  console.log('  status        age(d)  meas%   claim     outlet');
  for (const r of result.rows) {
    const age = r.ageDays == null ? 'n/a' : String(Math.round(r.ageDays));
    const pct = r.hasEvidence ? `${(r.overall * 100).toFixed(0)}%` : 'n/a';
    console.log(`  ${r.status.padEnd(12)}  ${age.padStart(6)}  ${pct.padStart(5)}   ${(r.coverageExpectation || '').padEnd(8)}  ${r.outletId}`);
  }
  console.log('');
  console.log(`  needs re-probe (decayed/contradicted): ${result.needsReprobe.length ? result.needsReprobe.join(', ') : '(none)'}`);
}

function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) {
    console.log('Usage: node scripts/audit-standing-coverage.js [--json] [--strict] [--coverage-expectation]');
    console.log('  Reports measured Broadway coverage per T1/T2 outlet and any');
    console.log('  outlet-registry.json standingCoverage drift. Read-only.');
    console.log('  --coverage-expectation: report coverageExpectation claim drift instead');
    console.log('    (card #640) — every outlet with coverageExpectation set, classified');
    console.log('    active/decayed/contradicted/no-evidence against measured coverage.');
    process.exit(0);
  }
  const jsonOut = args.includes('--json');
  const strict = args.includes('--strict');
  const coverageExpectationMode = args.includes('--coverage-expectation');

  const shows = readJson('data/shows.json').shows;
  const reviews = readJson('data/reviews.json').reviews;
  const outlets = readJson('data/outlet-registry.json').outlets;

  if (coverageExpectationMode) {
    const result = evaluateCoverageExpectationDrift(shows, reviews, outlets, Date.now());
    if (jsonOut) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printCoverageExpectationReport(result);
    }
    process.exit(strict && result.needsReprobe.length ? 1 : 0);
  }

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
  evaluateCoverageExpectationDrift,
  classifyCoverageExpectationDrift,
  measureOutletCoverage,
  PROMOTE_OVERALL,
  PROMOTE_MIN_SEASON,
  DEMOTE_OVERALL,
  DEMOTE_LATEST_SEASON,
  MIN_PRESS_OUTLETS,
  MIN_SEASON_SHOWS,
  COVERAGE_EXPECTATION_DECAY_DAYS,
  COVERAGE_EXPECTATION_CONTRADICTION_RATE,
};
