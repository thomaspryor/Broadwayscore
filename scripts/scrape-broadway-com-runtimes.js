#!/usr/bin/env node
/**
 * Broadway.com Runtime Enrichment Script
 *
 * Scrapes runtime and intermission data from Broadway.com and updates shows.json.
 *
 * Usage:
 *   node scripts/scrape-broadway-com-runtimes.js [options]
 *
 * Options:
 *   --dry-run          Preview changes without writing
 *   --show=SLUG        Process a single show only
 *   --current-only     Only scrape the centralized page (1 request, open shows only)
 *   --force            Overwrite existing runtime values
 *   --batch-size=N     Shows per batch for individual page scraping (default 25)
 *   --status=STATUS    Filter by status: open, closed, previews (default: all)
 */

const fs = require('fs');
const path = require('path');
const {
  scrapeCurrentRuntimes,
  scrapeShowRuntime,
  matchRuntimesToShows,
  batchScrapeAgeRecommendations,
  parseRuntimeText,
} = require('./lib/broadway-com-runtimes');
const { cleanup } = require('./lib/scraper');

const SHOWS_PATH = path.join(__dirname, '../data/shows.json');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = {};
for (const arg of args) {
  if (arg.startsWith('--')) {
    const [key, val] = arg.slice(2).split('=');
    flags[key] = val || true;
  }
}

const DRY_RUN = flags['dry-run'] === true;
const SINGLE_SHOW = flags['show'] || null;
const CURRENT_ONLY = flags['current-only'] === true;
const FORCE = flags['force'] === true;
const BATCH_SIZE = parseInt(flags['batch-size']) || 25;
const STATUS_FILTER = flags['status'] || null;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('🎭 Broadway.com Runtime Enrichment');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  if (SINGLE_SHOW) console.log(`  Show: ${SINGLE_SHOW}`);
  if (CURRENT_ONLY) console.log(`  Current shows only (centralized page)`);
  if (FORCE) console.log(`  Force overwrite: ON`);
  if (STATUS_FILTER) console.log(`  Status filter: ${STATUS_FILTER}`);

  // Load shows
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows || showsData;

  // Track changes
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  const changes = [];

  // Single show mode
  if (SINGLE_SHOW) {
    const show = shows.find(s => s.id === SINGLE_SHOW || s.slug === SINGLE_SHOW);
    if (!show) {
      console.error(`❌ Show not found: ${SINGLE_SHOW}`);
      process.exit(1);
    }

    if (show.runtime && !FORCE) {
      console.log(`  ⏭️  "${show.title}" already has runtime: ${show.runtime} (use --force to overwrite)`);
      return;
    }

    console.log(`\nLooking up runtime for "${show.title}"...`);

    // Try centralized page first
    const currentEntries = await scrapeCurrentRuntimes();
    const enrichments = matchRuntimesToShows(currentEntries, shows);

    if (enrichments[show.id]) {
      const { runtime, intermissions } = enrichments[show.id];
      changes.push({ show, runtime, intermissions, source: 'centralized' });
    } else {
      // Try individual page
      const result = await scrapeShowRuntime(show.title);
      if (result.runtime) {
        changes.push({ show, ...result, source: 'individual' });
      } else {
        console.log(`  ❌ No runtime found for "${show.title}"`);
      }
    }
  } else {
    // --- Phase 1: Centralized page (all current shows) ---
    console.log('\n--- Phase 1: Centralized run-times page ---');
    const currentEntries = await scrapeCurrentRuntimes();
    const enrichments = matchRuntimesToShows(currentEntries, shows);

    for (const show of shows) {
      if (STATUS_FILTER && show.status !== STATUS_FILTER) continue;

      if (enrichments[show.id]) {
        const { runtime, intermissions } = enrichments[show.id];

        if (show.runtime && !FORCE) {
          skipped++;
          continue;
        }

        changes.push({ show, runtime, intermissions, source: 'centralized' });
      }
    }

    console.log(`  Phase 1: ${changes.length} shows to update, ${skipped} skipped (already have runtime)`);

    // --- Phase 1.5: Age recommendations from individual pages ---
    const showsMissingAge = shows.filter(s => !s.ageRecommendation && (s.status === 'open' || s.status === 'previews'));
    if (showsMissingAge.length > 0 && currentEntries.length > 0) {
      console.log(`\n--- Phase 1.5: Age recommendations (${showsMissingAge.length} open/preview shows missing) ---`);
      await batchScrapeAgeRecommendations(currentEntries, shows, enrichments);
      // Apply any age recommendations found
      for (const show of shows) {
        if (enrichments[show.id] && enrichments[show.id].ageRecommendation && !show.ageRecommendation) {
          show.ageRecommendation = enrichments[show.id].ageRecommendation;
        }
      }
    }

    // --- Phase 2: Individual pages (closed/missing shows) ---
    if (!CURRENT_ONLY) {
      console.log('\n--- Phase 2: Individual show pages ---');

      // Filter to shows still missing runtime
      const updatedIds = new Set(changes.map(c => c.show.id));
      const needRuntime = shows.filter(s => {
        if (STATUS_FILTER && s.status !== STATUS_FILTER) return false;
        if (updatedIds.has(s.id)) return false;
        if (s.runtime && !FORCE) return false;
        return true;
      });

      console.log(`  ${needRuntime.length} shows need individual lookup`);

      // Process in batches
      for (let i = 0; i < needRuntime.length; i += BATCH_SIZE) {
        const batch = needRuntime.slice(i, i + BATCH_SIZE);
        console.log(`\n  Batch ${Math.floor(i / BATCH_SIZE) + 1}: shows ${i + 1}-${Math.min(i + BATCH_SIZE, needRuntime.length)}`);

        for (const show of batch) {
          try {
            const result = await scrapeShowRuntime(show.title);
            if (result.runtime) {
              changes.push({ show, ...result, source: 'individual' });
            } else {
              errors++;
            }
          } catch (err) {
            console.warn(`  ⚠️  Error for "${show.title}": ${err.message}`);
            errors++;
          }

          // Rate limit: 2s between requests
          await new Promise(r => setTimeout(r, 2000));
        }

        // Checkpoint: write progress after each batch
        if (!DRY_RUN && changes.length > 0) {
          applyChanges(shows, changes);
          writeShows(showsData, shows);
          console.log(`  💾 Checkpoint: ${changes.length} total updates written`);
        }
      }
    }
  }

  // --- Summary ---
  console.log('\n--- Summary ---');
  for (const { show, runtime, intermissions, source } of changes) {
    const prev = show.runtime ? ` (was: ${show.runtime})` : '';
    console.log(`  ✅ ${show.title}: ${runtime || '?'}, ${intermissions != null ? intermissions : '?'} intermissions [${source}]${prev}`);
    updated++;
  }

  console.log(`\n  Updated: ${updated}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Errors:  ${errors}`);

  // --- Write ---
  if (!DRY_RUN && changes.length > 0) {
    applyChanges(shows, changes);
    writeShows(showsData, shows);
    console.log('\n✅ shows.json updated');
  } else if (DRY_RUN) {
    console.log('\n🏁 Dry run complete — no changes written');
  }

  await cleanup();
}

/**
 * Apply runtime changes to the shows array.
 */
function applyChanges(shows, changes) {
  for (const change of changes) {
    const s = shows.find(x => x.id === change.show.id);
    if (!s) continue;
    if (change.runtime) s.runtime = change.runtime;
    if (change.intermissions != null) s.intermissions = change.intermissions;
    if (change.ageRecommendation && !s.ageRecommendation) s.ageRecommendation = change.ageRecommendation;
  }
}

/**
 * Write shows.json back to disk.
 */
function writeShows(showsData, shows) {
  if (Array.isArray(showsData)) {
    fs.writeFileSync(SHOWS_PATH, JSON.stringify(shows, null, 2) + '\n');
  } else {
    showsData.shows = shows;
    fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsData, null, 2) + '\n');
  }
}

main().catch(err => {
  console.error('💥 Fatal error:', err);
  cleanup().then(() => process.exit(1));
});
