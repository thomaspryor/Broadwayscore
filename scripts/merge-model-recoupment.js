#!/usr/bin/env node
/**
 * Merge Recoupment Model Results into commercial.json
 *
 * Runs the recoupment model against all shows and writes model_ prefixed
 * fields into commercial.json. Three tiers:
 *
 *   weekly-model:       Full weekly simulation (shows < 10yr with grosses data)
 *   simplified-lifetime: Lifetime formula (shows 10+ years)
 *   ai-estimated:       Passthrough of existing AI estimates (no cap/grosses)
 *
 * Usage:
 *   node scripts/merge-model-recoupment.js [--dry-run] [--show=SLUG]
 */

require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const os = require('os');
const { calculateRecoupment, calculateLifetimeRecoupment, classifyShow } = require('./lib/recoupment-model');
const { createCommercialWriteGuard } = require('./lib/commercial-write-guard');
const { classifyTier } = require('./lib/model-return-v2');
const { clearStaleModelFields, applyShadowReturnFields, applyReturnedSoFarFields, RETURNED_SO_FAR_OPTS } = require('./lib/model-run-fields');
const { makeGrossesLookup } = require('./lib/grosses-lookup');
const { makeCapEstimator, optsWithCapEstimate } = require('./lib/cap-comparables');
const { modelInputBasis, canResizeByModel } = require('./lib/model-input-basis');
const { modelContradictsDesignation, planModelLossResizes, MODEL_LOSS_RESIZE_LIMIT } = require('./lib/commercial-designations');
const { findStaleReturns, queueStaleReturns } = require('./lib/commercial-return-freshness');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const GROSSES_PATH = path.join(DATA_DIR, 'grosses.json');
const GROSSES_HISTORY_PATH = path.join(DATA_DIR, 'grosses-history.json');
// CI uses data/commercial.json (checkout-core-data copies it there); local uses ~/broadway-scorecard-data/
const COMMERCIAL_PATH = fs.existsSync(path.join(DATA_DIR, 'commercial.json'))
  ? path.join(DATA_DIR, 'commercial.json')
  : path.join(os.homedir(), 'broadway-scorecard-data', 'commercial.json');
// Bound to the resolved CI-vs-local path above rather than the module's
// default-path singleton (which always points at data/commercial.json).
const { loadCommercial, saveCommercial } = createCommercialWriteGuard(COMMERCIAL_PATH);

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SINGLE = args.find(a => a.startsWith('--show='))?.split('=')[1];
// Live (BRO-5849 step 5): a record with no capitalization runs on a comparables figure, kept in
// modelCapitalizationEstimate and labelled an estimate. `capitalization` itself is never written.
// --opt=capComparables=false turns it off.
const CAP_COMPARABLES = !args.includes('--opt=capComparables=false');

// ---------------------------------------------------------------------------
// Data Loading
// ---------------------------------------------------------------------------

const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
const allShows = Object.values(showsData.shows);
const grosses = JSON.parse(fs.readFileSync(GROSSES_PATH, 'utf8'));
const commercial = loadCommercial();

let grossesHistory = { weeks: {} };
try {
  grossesHistory = JSON.parse(fs.readFileSync(GROSSES_HISTORY_PATH, 'utf8'));
} catch { /* No history */ }

// ---------------------------------------------------------------------------
// Slug Resolution (shared logic from calculate-recoupment.js)
// ---------------------------------------------------------------------------

// Exact slug keys only (scripts/lib/grosses-lookup.js, BRO-5016).
const { getWeeklyData, getGrossesAllTime } = makeGrossesLookup(grosses, grossesHistory);

// ---------------------------------------------------------------------------
// Tier Classification
// ---------------------------------------------------------------------------

// classifyTier / LONG_RUN_WEEKS live in scripts/lib/model-return-v2.js (BRO-4989:
// one definition shared with the shadow SVOG-fix diff).

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const today = new Date().toISOString().split('T')[0];
  let tier1 = 0, tier2 = 0, tier3 = 0, contradictions = 0;

  // Build show lookup by slug
  const showBySlug = {};
  for (const show of allShows) {
    if (show.slug) showBySlug[show.slug] = show;
    if (show.id) showBySlug[show.id] = show;
  }

  const runOpts = CAP_COMPARABLES
    ? { capComparables: true, capEstimator: makeCapEstimator(allShows, commercial.shows) }
    : {};
  const keys = SINGLE ? [SINGLE] : Object.keys(commercial.shows);

  for (const key of keys) {
    const comm = commercial.shows[key];
    if (!comm) continue;

    // Find matching show in shows.json
    const show = showBySlug[key] || showBySlug[comm.slug] || showBySlug[key.replace(/-\d{4}$/, '')];
    if (!show) {
      // Orphan in commercial.json — no shows.json match
      clearStaleModelFields(comm);
      comm.modelMethod = 'ai-estimated';
      comm.modelLastRun = today;
      tier3++;
      continue;
    }

    const slug = show.slug || show.id;
    const grossAllTime = getGrossesAllTime(slug, show.id);
    const rowOpts = optsWithCapEstimate(runOpts, show, comm);
    const tier = classifyTier(show, comm, grossAllTime, rowOpts);

    let result;
    let weeklyData = null;
    if (tier === 'weekly-model') {
      weeklyData = getWeeklyData(slug, show.id);
      result = calculateRecoupment(show, comm, grossAllTime, weeklyData, rowOpts);
      if (result.error) {
        // Fall back to ai-estimated
        clearStaleModelFields(comm);
        comm.modelMethod = 'ai-estimated';
        comm.modelLastRun = today;
        tier3++;
        continue;
      }
      tier1++;
    } else if (tier === 'simplified-lifetime') {
      result = calculateLifetimeRecoupment(show, comm, grossAllTime, rowOpts);
      if (result.error) {
        clearStaleModelFields(comm);
        comm.modelMethod = 'ai-estimated';
        comm.modelLastRun = today;
        tier3++;
        continue;
      }
      tier2++;
    } else {
      // ai-estimated passthrough
      clearStaleModelFields(comm);
      comm.modelMethod = 'ai-estimated';
      comm.modelRecoupmentPct = comm.estimatedRecoupmentPct || null;
      comm.modelRecouped = comm.recouped != null ? comm.recouped : null;
      comm.modelDataQuality = 'low';
      comm.modelLastRun = today;
      tier3++;
      continue;
    }

    // Write model_ fields
    comm.modelRecoupmentPct = [result.recoupmentPctLow, result.recoupmentPctCentral, result.recoupmentPctHigh];
    comm.modelRecouped = result.modelRecouped;
    comm.modelBreakeven = result.weeklyBreakeven;
    // The cost the break-even was built on (null: the model estimated it).
    // commercial-write-guard rescales the break-even when a writer changes
    // weeklyRunningCost before the next model run (BRO-4985).
    // An implied cost does not follow the record's, so a cost edit waits for the next run.
    comm.modelCostBasis = result.impliedNut ? null : (comm.weeklyRunningCost || null);
    comm.modelDataQuality = result.dataQuality;
    comm.modelMethod = tier;
    comm.modelCategory = result.category;
    comm.modelLastRun = today;
    comm.modelWarnings = result.warnings;
    // Which inputs are guesses (BRO-5849): separate from dataQuality, which the display floor reads.
    const basis = modelInputBasis(comm, result);
    if (basis.length) comm.modelInputBasis = basis; else delete comm.modelInputBasis;
    if (result.capitalizationEstimate) comm.modelCapitalizationEstimate = result.capitalizationEstimate; else delete comm.modelCapitalizationEstimate;
    // Shadow fields (BRO-4989 G): SVOG-denominator fix + investor multiple.
    // Nothing reads them yet; modelRecoupmentPct above stays the live value.
    applyShadowReturnFields(comm, result, show);
    applyReturnedSoFarFields(comm, tier === 'weekly-model'
      ? calculateRecoupment(show, comm, grossAllTime, weeklyData, { ...RETURNED_SO_FAR_OPTS, capEstimate: rowOpts.capEstimate })
      : calculateLifetimeRecoupment(show, comm, grossAllTime, { ...RETURNED_SO_FAR_OPTS, capEstimate: rowOpts.capEstimate }));

    if (DRY_RUN) {
      console.log(`${key}: ${tier} | ${result.recoupmentPctLow}–${result.recoupmentPctCentral}–${result.recoupmentPctHigh}%`);
    }
  }

  // Labels follow their estimates (BRO-5643, BRO-6187), after every branch above:
  // one that cleared a record's model fields leaves no estimate, so a Fizzle
  // or Flop the model sized becomes Did Not Recoup. Too many moves at once are
  // held for review instead of written.
  const resize = planModelLossResizes(
    // A guess or comparable never relabels a show publicly (BRO-5849).
    keys.map((key) => [key, commercial.shows[key]]).filter(([, entry]) => canResizeByModel(entry)),
  );
  for (const { key, from, to } of resize.moves) {
    console.log(`  [SIZE] ${key}.designation: ${from} -> ${to} (by its recorded estimate)${resize.held ? ', held' : ''}`);
    if (!resize.held) commercial.shows[key].designation = to;
  }
  if (resize.held) {
    console.log(`::warning title=Designation sizes held::${resize.moves.length} designations would move with the model's new figures (limit ${MODEL_LOSS_RESIZE_LIMIT}); none written. Check the [SIZE] lines and relabel by data plan.`);
  }

  // Check the final labels so a resized estimate never keeps a contradiction
  // flag naming the old tier. Failed/passthrough runs clear these fields above.
  for (const key of keys) {
    const comm = commercial.shows[key];
    if (comm.modelMethod === 'ai-estimated') continue;
    const pct = comm.modelRecoupmentPct?.[1];
    if (!comm.designation || !Number.isFinite(pct)) continue;
    if (modelContradictsDesignation(pct, comm.designation)) {
      comm.modelDesignationFlag = `Model: ${pct.toFixed(0)}% vs designation: ${comm.designation}`;
      contradictions++;
    } else {
      delete comm.modelDesignationFlag;
    }
  }

  // Final sweep: normalize sources[] for every show. LLM-generated source entries
  // frequently have type="other" or non-YYYY-MM-DD dates that fail validation.
  // This runs AFTER all other commercial pipeline steps, catching any bad records
  // that slipped through earlier normalization. Idempotent on already-clean data.
  const { normalizeSources } = require('./lib/commercial-sources');
  let normalizedCount = 0;
  for (const entry of Object.values(commercial.shows || {})) {
    if (Array.isArray(entry.sources) && entry.sources.length > 0) {
      const before = JSON.stringify(entry.sources);
      entry.sources = normalizeSources(entry.sources);
      if (JSON.stringify(entry.sources) !== before) normalizedCount++;
    }
  }
  if (normalizedCount > 0) {
    console.log(`Normalized sources[] for ${normalizedCount} shows (type/date coercion)`);
  }

  // The daily commercial pending-review job already runs this refresh and
  // persists the pending queue. Local math only; holds can never auto-apply.
  const staleReturns = findStaleReturns({
    shows: SINGLE ? allShows.filter(s => s.slug === SINGLE || s.id === SINGLE) : allShows,
    commercial, grossesHistory,
  });
  console.log(`Stale return snapshots: ${staleReturns.length} candidate(s)`);
  for (const row of staleReturns) {
    console.log(`  [RETURN REVIEW] ${row.slug}: as of ${row.snapshotAsOf}, ${row.ageDays} days; estimated ${row.estimate.investorMultiple ?? 'unknown'}x${row.estimate.usesEstimatedCost ? ' (category cost estimate)' : ''}`);
  }
  if (!DRY_RUN && staleReturns.length) {
    const pendingPath = path.join(DATA_DIR, 'commercial-pending-review.json');
    const archivePath = path.join(DATA_DIR, 'commercial-pending-archive.json');
    const readQueue = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { shows: {} };
    const pending = readQueue(pendingPath);
    const { added } = queueStaleReturns(pending, readQueue(archivePath), staleReturns);
    if (added) {
      fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2) + '\n');
      console.log(`Queued ${added} return snapshot review hold(s); no labels changed by this check.`);
    }
  }

  // Save
  if (!DRY_RUN) {
    commercial.modelLastRun = today;
    if (!commercial._meta) commercial._meta = {};
    commercial._meta.lastUpdated = new Date().toISOString();
    saveCommercial(commercial);
    console.log(`Written to ${COMMERCIAL_PATH}`);
  }

  console.log(`\nMerge complete:`);
  console.log(`  Tier 1 (weekly-model):        ${tier1} shows`);
  console.log(`  Tier 2 (simplified-lifetime):  ${tier2} shows`);
  console.log(`  Tier 3 (ai-estimated):         ${tier3} shows`);
  console.log(`  Designation contradictions:     ${contradictions}`);
  console.log(`  Designations re-sized:          ${resize.held ? `0 (${resize.moves.length} held)` : resize.moves.length}`);
  console.log(`  Total:                          ${tier1 + tier2 + tier3} shows`);
}

main();
