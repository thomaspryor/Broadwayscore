#!/usr/bin/env node
/**
 * IBDB Cast Backfill Script
 *
 * Scrapes Opening Night Cast (and optionally Current Cast) from IBDB
 * for all shows and writes per-show files to data/cast/{show-id}.json.
 *
 * Each file is its own checkpoint — idempotent and shard-safe (no merge conflicts).
 *
 * Usage:
 *   node scripts/backfill-cast.js [options]
 *
 * Options:
 *   --shard N          Shard index (0-based)
 *   --total-shards M   Total number of shards
 *   --show-filter ID   Process only a specific show by ID or slug
 *   --force            Re-scrape even if cast file already exists
 *   --dry-run          Show what would be processed without scraping
 *   --open-only        Only process open/previews shows (for current cast updates)
 */

const fs = require('fs');
const path = require('path');
const { lookupIBDBCast, RATE_LIMIT_MS } = require('./lib/ibdb-cast');
const { shouldTombstone, shouldAbortMassWipe } = require('./lib/cast-tombstone');
const { isBroadwayCategory } = require('./lib/venue-classification');
const { cleanup } = require('./lib/scraper');
const showsWriteGuard = require('./lib/shows-write-guard');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `backfill-cast.js — IBDB Cast Backfill Script.

Usage:
  node scripts/backfill-cast.js [options]
  node scripts/backfill-cast.js --help, -h    print this usage and exit
`;
const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const CAST_DIR = path.join(__dirname, '..', 'data', 'cast');

// Parse arguments
const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');
const openOnly = args.includes('--open-only');

const shardArg = args.find(a => a.startsWith('--shard'));
const shardIdx = shardArg ? parseInt(args[args.indexOf(shardArg) + 1] || shardArg.split('=')[1]) : null;

const totalShardsArg = args.find(a => a.startsWith('--total-shards'));
const totalShards = totalShardsArg ? parseInt(args[args.indexOf(totalShardsArg) + 1] || totalShardsArg.split('=')[1]) : null;

const showFilterArg = args.find(a => a.startsWith('--show-filter'));
const showFilter = showFilterArg ? (args[args.indexOf(showFilterArg) + 1] || showFilterArg.split('=')[1]) : null;

function loadShows() {
  const data = showsWriteGuard.loadShows();
  return data.shows;
}

function castFileExists(showId) {
  return fs.existsSync(path.join(CAST_DIR, `${showId}.json`));
}

function writeCastFile(showId, castData) {
  const filePath = path.join(CAST_DIR, `${showId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(castData, null, 2) + '\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  console.log('='.repeat(60));
  console.log('IBDB CAST BACKFILL');
  console.log('='.repeat(60));

  // Ensure cast directory exists
  if (!fs.existsSync(CAST_DIR)) {
    fs.mkdirSync(CAST_DIR, { recursive: true });
  }

  let shows = loadShows();
  console.log(`Total shows in database: ${shows.length}`);

  // IBDB is Broadway-only. Off-Broadway/West End cast files come from
  // web-search or manual entry, not IBDB — lookupIBDBCast market-skips them
  // (found:false, fetchFailed:false), which shouldTombstone() reads as a
  // genuine empty. Filtering here means this script never touches
  // independently-sourced non-Broadway cast data (task #712 — the crocodile
  // wipe: an off-west-end show with real web-search cast data got tombstoned
  // by this exact path). Exempted for --show-filter so a targeted test run
  // can still probe a specific non-Broadway show.
  if (!showFilter) {
    const beforeMarket = shows.length;
    shows = shows.filter(isBroadwayCategory);
    const skippedMarket = beforeMarket - shows.length;
    if (skippedMarket > 0) {
      console.log(`Skipping ${skippedMarket} non-Broadway shows (IBDB is Broadway-only)`);
    }
  }

  // Apply filters
  if (showFilter) {
    shows = shows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (shows.length === 0) {
      console.error(`❌ No show found with id/slug: ${showFilter}`);
      process.exit(1);
    }
    console.log(`Show filter: ${showFilter} (${shows.length} match)`);
  }

  if (openOnly) {
    shows = shows.filter(s => s.status === 'open' || s.status === 'previews');
    console.log(`Open/previews only: ${shows.length} shows`);
  }

  // Sort by ID for consistent sharding
  shows.sort((a, b) => a.id.localeCompare(b.id));

  // Apply sharding
  if (shardIdx !== null && totalShards !== null) {
    shows = shows.filter((_, i) => i % totalShards === shardIdx);
    console.log(`Shard ${shardIdx}/${totalShards}: ${shows.length} shows`);
  }

  // Skip shows that already have cast files (unless --force)
  if (!force) {
    const before = shows.length;
    shows = shows.filter(s => !castFileExists(s.id));
    const skipped = before - shows.length;
    if (skipped > 0) {
      console.log(`Skipping ${skipped} shows with existing cast files`);
    }
  }

  console.log(`Shows to process: ${shows.length}`);
  if (dryRun) {
    console.log('\n--- DRY RUN ---');
    shows.forEach(s => console.log(`  Would process: ${s.id} (${s.title})`));
    console.log(`\nTotal: ${shows.length} shows`);
    return;
  }

  if (shows.length === 0) {
    console.log('✅ No shows need cast backfill');
    return;
  }

  console.log('');

  // Mass-wipe circuit breaker (--force only): count how many shows about to
  // be reprocessed currently have a populated cast file, so a scraper
  // regression that empties everything can be caught mid-run instead of
  // silently landing (task #712 — this exact class wiped 29-30 shows twice).
  let populatedBefore = 0;
  if (force) {
    for (const s of shows) {
      try {
        const existing = JSON.parse(fs.readFileSync(path.join(CAST_DIR, `${s.id}.json`), 'utf8'));
        if (Array.isArray(existing.openingNightCast) && existing.openingNightCast.length > 0) populatedBefore++;
      } catch { /* no existing file or unreadable — not "populated" */ }
    }
  }
  const wipedBackups = [];

  // Process shows
  let success = 0;
  let failed = 0;
  let empty = 0;

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    const openingYear = show.openingDate ? parseInt(show.openingDate.split('-')[0]) : null;

    console.log(`\n📌 [${i + 1}/${shows.length}] ${show.title} (${show.id})`);

    try {
      const result = await lookupIBDBCast(show.title, {
        openingYear,
        venue: show.venue,
        ibdbUrl: show.ibdbUrl || null,
        category: show.category || 'broadway'
      });

      if (!result.found || result.openingNightCast.length === 0) {
        // Market skip (off-broadway/west-end show slipped past the earlier
        // filter, e.g. via --show-filter): IBDB was never even queried, so
        // this is "not applicable," not an empty — never tombstone.
        if (result.skipped) {
          console.log(`  ⏭️  Not on IBDB (non-Broadway) — leaving existing cast file untouched`);
          failed++;
          continue;
        }

        // A TRANSIENT scrape failure must NOT be tombstoned — a tombstone
        // permanently blocks re-scraping (default runs skip shows with an
        // existing cast file), so one bad scrape would empty a show forever.
        // This is exactly how Hamilton lost its cast on 2026-06-24. Leave the
        // file untouched (existing good data survives; a never-scraped show
        // stays "missing" and is retried next run). Decision in shared lib.
        if (!shouldTombstone(result)) {
          console.log(`  ⏳ Transient scrape failure — NOT tombstoning; will retry next run`);
          failed++;
          continue;
        }

        console.log(`  ⚠️  No cast data found`);
        empty++;

        // Back up the existing file before overwriting IF it was populated —
        // the mass-wipe circuit breaker below needs to be able to restore it.
        const existingPath = path.join(CAST_DIR, `${show.id}.json`);
        let wasPopulated = false;
        if (force && fs.existsSync(existingPath)) {
          try {
            const existingRaw = fs.readFileSync(existingPath, 'utf8');
            const existingParsed = JSON.parse(existingRaw);
            if (Array.isArray(existingParsed.openingNightCast) && existingParsed.openingNightCast.length > 0) {
              wasPopulated = true;
              wipedBackups.push({ path: existingPath, content: existingRaw });
            }
          } catch { /* unreadable existing file — nothing to back up */ }
        }

        // Genuine empty (page loaded fine, production has no IBDB cast): write an
        // empty tombstone so we don't re-scrape a production that truly has none.
        writeCastFile(show.id, {
          showId: show.id,
          ibdbUrl: result.ibdbUrl || null,
          scrapedAt: new Date().toISOString(),
          openingNightCast: [],
          currentCast: null
        });

        if (wasPopulated && shouldAbortMassWipe(populatedBefore, wipedBackups.length)) {
          console.error(`\n🛑 MASS-WIPE CIRCUIT BREAKER: ${wipedBackups.length}/${populatedBefore} previously-populated cast files came back empty this run.`);
          console.error(`   Restoring all ${wipedBackups.length} and aborting before more damage.`);
          for (const b of wipedBackups) fs.writeFileSync(b.path, b.content);
          try { await cleanup(); } catch { /* best-effort */ }
          process.exit(1);
        }
        continue;
      }

      // Build the cast file
      const castFile = {
        showId: show.id,
        ibdbUrl: result.ibdbUrl,
        scrapedAt: new Date().toISOString(),
        openingNightCast: result.openingNightCast
      };

      // Include current cast if available (for open shows)
      if (result.currentCast && result.currentCast.length > 0) {
        castFile.currentCast = result.currentCast;
        castFile.currentCastUpdatedAt = new Date().toISOString();
      } else if ((show.status === 'open' || show.status === 'previews') && result.openingNightCast.length > 0) {
        // IBDB only creates a CurrentCast section after replacements are recorded.
        // For shows with no replacements yet, the OBC IS the current cast.
        castFile.currentCast = result.openingNightCast;
        castFile.currentCastUpdatedAt = new Date().toISOString();
        console.log(`  ℹ️  No CurrentCast on IBDB — using OBC as current (${result.openingNightCast.length} members)`);
      }

      // Include replacements if available
      if (result.replacements && result.replacements.length > 0) {
        castFile.replacements = result.replacements;
      }

      writeCastFile(show.id, castFile);
      console.log(`  ✅ Saved: ${result.openingNightCast.length} OBC` +
        (castFile.replacements ? ` + ${castFile.replacements.length} replacements` : '') +
        (castFile.currentCast ? ` + ${castFile.currentCast.length} current` : ''));
      success++;

    } catch (e) {
      console.log(`  ❌ Error: ${e.message}`);
      failed++;
    }

    // Rate limit between requests (skip after last one)
    if (i < shows.length - 1) {
      await sleep(RATE_LIMIT_MS);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('BACKFILL COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Success:  ${success}`);
  console.log(`  Empty:    ${empty}`);
  console.log(`  Failed:   ${failed}`);
  console.log(`  Total:    ${shows.length}`);

  // Sync ibdbUrl from cast files back to shows.json (non-sharded runs only)
  if (shardIdx === null && success > 0) {
    try {
      const showsData = showsWriteGuard.loadShows();
      let synced = 0;
      for (const show of showsData.shows) {
        const castPath = path.join(CAST_DIR, `${show.id}.json`);
        if (!fs.existsSync(castPath)) continue;
        const castData = JSON.parse(fs.readFileSync(castPath, 'utf8'));
        if (castData.ibdbUrl && castData.ibdbUrl !== show.ibdbUrl) {
          show.ibdbUrl = castData.ibdbUrl;
          synced++;
        }
      }
      if (synced > 0) {
        showsWriteGuard.saveShows(showsData);
        console.log(`\n📎 Synced ibdbUrl for ${synced} show(s) into shows.json`);
      }
    } catch (e) {
      console.log(`\n⚠️  ibdbUrl sync failed (non-fatal): ${e.message}`);
    }
  }

  // Cleanup any browser instances from scraper
  try {
    await cleanup();
  } catch {
    // Ignore cleanup errors
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
