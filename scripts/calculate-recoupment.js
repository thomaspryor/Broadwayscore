#!/usr/bin/env node
/**
 * Calculate Recoupment for Broadway Shows
 *
 * Runs the recoupment financial model against all shows with sufficient data,
 * validates against known recouped=true/false, and outputs results.
 *
 * Usage:
 *   node scripts/calculate-recoupment.js [options]
 *
 * Options:
 *   --show=SLUG          Calculate for a single show
 *   --validate           Run validation against known recoupment data
 *   --output=FILE        Write results to JSON file
 *   --verbose            Show detailed per-show breakdown
 *   --coverage           Show data coverage statistics
 */

const fs = require('fs');
const path = require('path');
const { calculateRecoupment } = require('./lib/recoupment-model');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const GROSSES_PATH = path.join(DATA_DIR, 'grosses.json');
const GROSSES_HISTORY_PATH = path.join(DATA_DIR, 'grosses-history.json');
const COMMERCIAL_PATH = path.join(DATA_DIR, 'commercial.json');

const args = process.argv.slice(2);
const flags = {};
for (const arg of args) {
  if (arg.startsWith('--')) {
    const [key, val] = arg.slice(2).split('=');
    flags[key] = val || true;
  }
}

const SINGLE_SHOW = flags['show'] || null;
const VALIDATE = flags['validate'] === true;
const OUTPUT_FILE = flags['output'] || null;
const VERBOSE = flags['verbose'] === true;
const COVERAGE = flags['coverage'] === true;

// ---------------------------------------------------------------------------
// Load Data
// ---------------------------------------------------------------------------

const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
const allShows = Object.values(showsData.shows);

let commercial;
try {
  commercial = JSON.parse(fs.readFileSync(COMMERCIAL_PATH, 'utf8'));
} catch {
  // Try symlink target
  commercial = JSON.parse(fs.readFileSync(
    path.join(require('os').homedir(), 'broadway-scorecard-data', 'commercial.json'), 'utf8'
  ));
}

const grosses = JSON.parse(fs.readFileSync(GROSSES_PATH, 'utf8'));

let grossesHistory = { weeks: {} };
try {
  grossesHistory = JSON.parse(fs.readFileSync(GROSSES_HISTORY_PATH, 'utf8'));
} catch {
  // No history available
}

// ---------------------------------------------------------------------------
// Build weekly data lookup by show slug
// ---------------------------------------------------------------------------

// Build a map of all slugs in weekly history for fuzzy matching
const weeklyHistorySlugs = new Set();
for (const shows of Object.values(grossesHistory.weeks || {})) {
  for (const slug of Object.keys(shows)) weeklyHistorySlugs.add(slug);
}

function resolveWeeklySlug(showSlug, showId) {
  // Exact match first
  if (weeklyHistorySlugs.has(showSlug)) return showSlug;
  if (showId && weeklyHistorySlugs.has(showId)) return showId;

  // Try without year suffix: "appropriate-2023" → "appropriate"
  const base = showSlug.replace(/-\d{4}$/, '');
  if (weeklyHistorySlugs.has(base)) return base;
  if (showId) {
    const baseId = showId.replace(/-\d{4}$/, '');
    if (weeklyHistorySlugs.has(baseId)) return baseId;
  }

  // Try with year suffix if we have the base: "appropriate" → "appropriate-2023"
  for (const s of weeklyHistorySlugs) {
    if (s.startsWith(base + '-') || s === base) return s;
  }

  return null;
}

function getWeeklyData(slug, showId) {
  const resolvedSlug = resolveWeeklySlug(slug, showId);
  if (!resolvedSlug) return null;

  const weekly = {};
  for (const [weekDate, shows] of Object.entries(grossesHistory.weeks || {})) {
    if (shows[resolvedSlug]) {
      weekly[weekDate] = shows[resolvedSlug];
    }
  }
  return Object.keys(weekly).length > 0 ? weekly : null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Find shows with enough data to model
  const results = [];
  let modeled = 0;
  let skipped = 0;

  const targetShows = SINGLE_SHOW
    ? allShows.filter(s => s.slug === SINGLE_SHOW || s.id === SINGLE_SHOW)
    : allShows.filter(s => {
        // Broadway only
        if (s.id?.includes('west-end') || s.id?.includes('off-broadway') || s.id?.includes('off-west-end')) return false;
        // Must have commercial data
        const comm = commercial.shows[s.slug] || commercial.shows[s.id];
        if (!comm) return false;
        // Must have capitalization
        if (!comm.capitalization) return false;
        return true;
      });

  for (const show of targetShows) {
    const slug = show.slug || show.id;
    const comm = commercial.shows[slug] || commercial.shows[show.id] || {};
    // Grosses lookup: try slug, then id, then base slug without year
    const baseSlug = slug.replace(/-\d{4}$/, '');
    const grossesAllTime = grosses.shows?.[slug]?.allTime
      || grosses.shows?.[show.id]?.allTime
      || grosses.shows?.[baseSlug]?.allTime
      || null;
    const weeklyData = getWeeklyData(slug, show.id);

    const result = calculateRecoupment(show, comm, grossesAllTime, weeklyData);

    if (result.error) {
      if (VERBOSE) console.log(`  SKIP ${slug}: ${result.error}`);
      skipped++;
      continue;
    }

    results.push(result);
    modeled++;

    if (VERBOSE || SINGLE_SHOW) {
      console.log(`\n=== ${result.title} (${result.slug}) ===`);
      console.log(`Category: ${result.category} | Data: ${result.dataQuality} | Gross source: ${result.grossDataSource}`);
      console.log(`Cap: $${(result.capitalization / 1e6).toFixed(1)}M | Effective cap: $${(result.effectiveCapitalization / 1e6).toFixed(1)}M`);
      console.log(`Weekly nut: $${(result.weeklyFixedCosts / 1000).toFixed(0)}K (${result.weeklyFixedCostSource}) | Breakeven: $${(result.weeklyBreakeven / 1000).toFixed(0)}K`);
      console.log(`SVOG: $${(result.svogGrant / 1e6).toFixed(1)}M | Tax credit: $${(result.taxCreditAmount / 1e6).toFixed(1)}M | Reserve: $${(result.reserveFund / 1000).toFixed(0)}K`);
      console.log(`Preview: ${result.previewWeeks} weeks | Run: ${result.totalRunWeeks} weeks`);
      console.log(`Variable rate: ${(result.baseVariableRate * 100).toFixed(1)}%`);
      console.log('');
      console.log(`                Pessimistic    Central     Optimistic`);
      console.log(`Recoup %:       ${String(result.pessimistic.recoupmentPct + '%').padStart(8)}    ${String(result.central.recoupmentPct + '%').padStart(8)}    ${String(result.optimistic.recoupmentPct + '%').padStart(8)}`);
      console.log(`Cum profit:     $${(result.pessimistic.cumulativeProfit / 1e6).toFixed(1)}M       $${(result.central.cumulativeProfit / 1e6).toFixed(1)}M       $${(result.optimistic.cumulativeProfit / 1e6).toFixed(1)}M`);
      console.log(`Recouped:       ${result.pessimistic.recouped ? 'YES' : 'no'}            ${result.central.recouped ? 'YES' : 'no'}           ${result.optimistic.recouped ? 'YES' : 'no'}`);
      if (result.warnings.length > 0) {
        console.log(`Warnings: ${result.warnings.join('; ')}`);
      }
    }
  }

  console.log(`\n📊 Modeled: ${modeled} shows | Skipped: ${skipped} (no cap data)`);

  // --- Validation ---
  if (VALIDATE) {
    console.log('\n=== VALIDATION ===\n');

    let correct = 0;
    let wrong = 0;
    let ambiguous = 0;
    const mismatches = [];

    for (const result of results) {
      const comm = commercial.shows[result.slug] || {};
      const knownRecouped = comm.recouped;

      if (knownRecouped === true || knownRecouped === false) {
        const modelRecouped = result.modelRecouped;

        if (modelRecouped === knownRecouped) {
          correct++;
        } else {
          // Check if the range is ambiguous (pessimistic says no, optimistic says yes)
          if (result.pessimistic.recouped !== result.optimistic.recouped) {
            ambiguous++;
          } else {
            wrong++;
          }
          mismatches.push({
            slug: result.slug,
            known: knownRecouped,
            modelCentral: modelRecouped,
            pctRange: `${result.recoupmentPctLow}-${result.recoupmentPctHigh}%`,
            designation: comm.designation,
          });
        }
      }
    }

    const total = correct + wrong + ambiguous;
    console.log(`Binary accuracy: ${correct}/${total} = ${total > 0 ? Math.round(correct / total * 100) : 0}%`);
    console.log(`  Correct: ${correct} | Wrong: ${wrong} | Ambiguous (range spans threshold): ${ambiguous}`);

    if (mismatches.length > 0) {
      console.log('\nMismatches:');
      for (const m of mismatches) {
        console.log(`  ${m.slug}: known=${m.known}, model=${m.modelCentral}, range=${m.pctRange}, designation=${m.designation}`);
      }
    }

    // Validate against AI-estimated ranges
    let rangeOverlap = 0;
    let rangeTotal = 0;
    for (const result of results) {
      const comm = commercial.shows[result.slug] || {};
      if (comm.estimatedRecoupmentPct && Array.isArray(comm.estimatedRecoupmentPct)) {
        rangeTotal++;
        const [aiLow, aiHigh] = comm.estimatedRecoupmentPct;
        // Check if model range overlaps AI range
        if (result.recoupmentPctHigh >= aiLow && result.recoupmentPctLow <= aiHigh) {
          rangeOverlap++;
        } else {
          if (VERBOSE) {
            console.log(`  Range mismatch: ${result.slug} — model: ${result.recoupmentPctLow}-${result.recoupmentPctHigh}%, AI: ${aiLow}-${aiHigh}%`);
          }
        }
      }
    }

    if (rangeTotal > 0) {
      console.log(`\nRange overlap with AI estimates: ${rangeOverlap}/${rangeTotal} = ${Math.round(rangeOverlap / rangeTotal * 100)}%`);
    }
  }

  // --- Coverage ---
  if (COVERAGE) {
    console.log('\n=== COVERAGE ===\n');
    const bwShows = allShows.filter(s =>
      !s.id?.includes('west-end') && !s.id?.includes('off-broadway') && !s.id?.includes('off-west-end')
    );
    const withComm = bwShows.filter(s => commercial.shows[s.slug] || commercial.shows[s.id]);
    const withCap = withComm.filter(s => (commercial.shows[s.slug] || commercial.shows[s.id])?.capitalization);
    const withCost = withComm.filter(s => (commercial.shows[s.slug] || commercial.shows[s.id])?.weeklyRunningCost);
    const withGross = withCap.filter(s => grosses.shows?.[s.slug]?.allTime);

    console.log(`Broadway shows: ${bwShows.length}`);
    console.log(`With commercial data: ${withComm.length}`);
    console.log(`With capitalization: ${withCap.length}`);
    console.log(`With weekly cost: ${withCost.length}`);
    console.log(`With grosses: ${withGross.length}`);
    console.log(`Modelable (cap + grosses): ${modeled}`);
  }

  // --- Summary table ---
  if (!SINGLE_SHOW && !VERBOSE) {
    console.log('\n=== RESULTS ===\n');
    console.log('Show'.padEnd(45) + 'Recoup%'.padStart(8) + '  Range'.padStart(15) + '  Designation');
    console.log('-'.repeat(85));

    results.sort((a, b) => b.central.recoupmentPct - a.central.recoupmentPct);
    for (const r of results) {
      const comm = commercial.shows[r.slug] || {};
      const known = comm.recouped === true ? ' ✓' : comm.recouped === false ? ' ✗' : '  ';
      const range = `${r.recoupmentPctLow}–${r.recoupmentPctHigh}%`;
      console.log(
        `${known} ${r.title}`.padEnd(45) +
        `${r.central.recoupmentPct}%`.padStart(8) +
        range.padStart(15) +
        `  ${comm.designation || 'TBD'}`
      );
    }
  }

  // --- Output ---
  if (OUTPUT_FILE) {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
    console.log(`\nResults written to ${OUTPUT_FILE}`);
  }
}

main();
