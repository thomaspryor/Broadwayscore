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

const fs = require('fs');
const path = require('path');
const os = require('os');
const { calculateRecoupment, calculateLifetimeRecoupment, classifyShow } = require('./lib/recoupment-model');
const { createCommercialWriteGuard } = require('./lib/commercial-write-guard');
const { classifyTier } = require('./lib/model-return-v2');
const { clearStaleModelFields, applyShadowReturnFields } = require('./lib/model-run-fields');
const { modelContradictsDesignation } = require('./lib/commercial-designations');

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

const weeklyHistorySlugs = new Set();
for (const shows of Object.values(grossesHistory.weeks || {})) {
  for (const slug of Object.keys(shows)) weeklyHistorySlugs.add(slug);
}

function resolveWeeklySlug(showSlug, showId) {
  if (weeklyHistorySlugs.has(showSlug)) return showSlug;
  if (showId && weeklyHistorySlugs.has(showId)) return showId;
  const base = showSlug.replace(/-\d{4}$/, '');
  if (weeklyHistorySlugs.has(base)) return base;
  if (showId) {
    const baseId = showId.replace(/-\d{4}$/, '');
    if (weeklyHistorySlugs.has(baseId)) return baseId;
  }
  for (const s of weeklyHistorySlugs) {
    if (s.startsWith(base + '-') || s === base) return s;
  }
  return null;
}

function getWeeklyData(slug, showId) {
  const resolved = resolveWeeklySlug(slug, showId);
  if (!resolved) return null;
  const weekly = {};
  for (const [date, shows] of Object.entries(grossesHistory.weeks || {})) {
    if (shows[resolved]) weekly[date] = shows[resolved];
  }
  return Object.keys(weekly).length > 0 ? weekly : null;
}

function getGrossesAllTime(slug, showId) {
  const base = slug.replace(/-\d{4}$/, '');
  return grosses.shows?.[slug]?.allTime
    || grosses.shows?.[showId]?.allTime
    || grosses.shows?.[base]?.allTime
    || null;
}

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
    const tier = classifyTier(show, comm, grossAllTime);

    let result;
    if (tier === 'weekly-model') {
      const weeklyData = getWeeklyData(slug, show.id);
      result = calculateRecoupment(show, comm, grossAllTime, weeklyData);
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
      result = calculateLifetimeRecoupment(show, comm, grossAllTime);
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
    comm.modelCostBasis = comm.weeklyRunningCost || null;
    comm.modelDataQuality = result.dataQuality;
    comm.modelMethod = tier;
    comm.modelCategory = result.category;
    comm.modelLastRun = today;
    comm.modelWarnings = result.warnings;
    // Shadow fields (BRO-4989 G): SVOG-denominator fix + investor multiple.
    // Nothing reads them yet; modelRecoupmentPct above stays the live value.
    applyShadowReturnFields(comm, result, show);

    // Flag designation contradictions
    if (comm.designation && result.recoupmentPctCentral != null) {
      const pct = result.recoupmentPctCentral;
      const desig = comm.designation;
      const isContradiction = modelContradictsDesignation(pct, desig);

      if (isContradiction) {
        comm.modelDesignationFlag = `Model: ${pct.toFixed(0)}% vs designation: ${desig}`;
        contradictions++;
      } else {
        delete comm.modelDesignationFlag;
      }
    }

    if (DRY_RUN) {
      console.log(`${key}: ${tier} | ${result.recoupmentPctLow}–${result.recoupmentPctCentral}–${result.recoupmentPctHigh}%`);
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
  console.log(`  Total:                          ${tier1 + tier2 + tier3} shows`);
}

main();
