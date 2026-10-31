#!/usr/bin/env node
/**
 * Enrich shows.json cast arrays from existing data/cast/*.json files.
 *
 * Reads per-show IBDB cast files and writes simplified {name, role} arrays
 * into shows.json for mobile app and content-matching consumers.
 * Also fills castBilling from saved Playbill production-page HTML at
 * data/cache/playbill-cast/<show-id>.html, verified against playbill-urls.json.
 * Cache collection/backfill is separate; absent HTML leaves billing alone.
 *
 * Zero network requests — purely local file transformation.
 *
 * Usage:
 *   node scripts/enrich-cast-from-files.js [options]
 *
 * Options:
 *   --dry-run           Show changes without writing
 *   --force             Overwrite existing cast entries and billing
 *   --category=CAT      Filter: broadway, off-broadway, west-end (default: all)
 *   --status=STATUS     Filter: open, previews, closed (default: all)
 *   --max-members=N     Max principals per show (default: 15)
 *   --show-filter=ID    Process a single show by ID
 */

const fs = require('fs');
const { castFileMismatchReason } = require('./lib/cast-tombstone');
const { extractCast: extractCastPrincipals } = require('./lib/cast-principals');
const { enrichCastBilling } = require('./lib/playbill-cast-billing');
const path = require('path');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `enrich-cast-from-files.js — Enrich shows.json cast arrays from existing data/cast/*.json files.

Usage:
  node scripts/enrich-cast-from-files.js [options]
  node scripts/enrich-cast-from-files.js --help, -h    print this usage and exit
`;
const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const CAST_DIR = path.join(__dirname, '..', 'data', 'cast');
const PLAYBILL_CAST_DIR = path.join(__dirname, '..', 'data', 'cache', 'playbill-cast');
const PLAYBILL_URLS_FILE = path.join(__dirname, '..', 'data', 'playbill-urls.json');

// Parse CLI arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

function getArgValue(prefix) {
  const arg = args.find(a => a.startsWith(prefix));
  if (!arg) return null;
  return arg.includes('=') ? arg.split('=')[1] : args[args.indexOf(arg) + 1];
}

const categoryFilter = getArgValue('--category');
const statusFilter = getArgValue('--status');
const maxMembers = parseInt(getArgValue('--max-members') || '15', 10);
const showFilter = getArgValue('--show-filter');

// --- Filtering logic ---

// Principal-filter rules live in scripts/lib/cast-principals.js (tested).
function extractCast(castData, showStatus) {
  return extractCastPrincipals(castData, showStatus, maxMembers);
}

// --- Main ---

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  console.log('='.repeat(60));
  console.log('ENRICH SHOWS.JSON CAST FROM CAST FILES');
  console.log('='.repeat(60));

  if (dryRun) console.log('  MODE: dry-run (no writes)');
  if (force) console.log('  MODE: force (overwrite existing)');
  if (categoryFilter) console.log('  Category filter:', categoryFilter);
  if (statusFilter) console.log('  Status filter:', statusFilter);
  if (showFilter) console.log('  Show filter:', showFilter);
  console.log('  Max members per show:', maxMembers);
  console.log('');

  // Load shows.json
  const showsData = loadShows();
  let shows = showsData.shows;
  console.log(`Total shows in database: ${shows.length}`);

  // Check cast directory exists
  if (!fs.existsSync(CAST_DIR)) {
    console.error('Cast directory not found:', CAST_DIR);
    process.exit(1);
  }

  const castFiles = new Set(
    fs.readdirSync(CAST_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
  );
  console.log(`Cast files found: ${castFiles.size}`);

  // Apply filters
  let targets = shows;
  if (showFilter) {
    targets = targets.filter(s => s.id === showFilter || s.slug === showFilter);
    if (targets.length === 0) {
      console.error(`No show found with id/slug: ${showFilter}`);
      process.exit(1);
    }
  }
  if (categoryFilter) {
    targets = targets.filter(s => (s.category || 'broadway') === categoryFilter);
  }
  if (statusFilter) {
    targets = targets.filter(s => s.status === statusFilter);
  }

  console.log(`Shows after filters: ${targets.length}`);

  // Optional local source, so ordinary cast enrichment still works without it.
  let playbillUrls = {};
  if (fs.existsSync(PLAYBILL_CAST_DIR) && fs.existsSync(PLAYBILL_URLS_FILE)) {
    try {
      playbillUrls = JSON.parse(fs.readFileSync(PLAYBILL_URLS_FILE, 'utf8')).shows || {};
    } catch (e) {
      console.log(`  Warning: Failed to read Playbill URLs: ${e.message}`);
    }
  }

  // Process
  let enriched = 0;
  let billingEnriched = 0;
  let skippedExisting = 0;
  let skippedNoCastFile = 0;
  let skippedEmptySource = 0;
  let skippedNoPrincipals = 0;
  let skippedMismatch = 0;
  const enrichedShows = [];

  for (const show of targets) {
    // Independent of the alphabetical cast array and its early exits below.
    // Most affected shows already have cast, so they must reach this writer.
    if (['open', 'previews'].includes(show.status) && (!show.castBilling?.length || force) && playbillUrls[show.id]) {
      const htmlFile = path.join(PLAYBILL_CAST_DIR, `${show.id}.html`);
      if (fs.existsSync(htmlFile)) {
        try {
          const html = fs.readFileSync(htmlFile, 'utf8');
          if (enrichCastBilling(show, html, playbillUrls[show.id], { force })) {
            billingEnriched++;
            if (dryRun) console.log(`  Would enrich billing: ${show.id} - ${show.castBilling.slice(0, 4).join(', ')}`);
          }
        } catch (e) {
          console.log(`  Warning: Failed to read Playbill cast for ${show.id}: ${e.message}`);
        }
      }
    }

    // Skip if already has cast and not forcing
    if (show.cast && show.cast.length > 0 && !force) {
      skippedExisting++;
      continue;
    }

    // Check for cast file
    if (!castFiles.has(show.id)) {
      skippedNoCastFile++;
      continue;
    }

    // Load cast file
    let castData;
    try {
      castData = JSON.parse(fs.readFileSync(path.join(CAST_DIR, `${show.id}.json`), 'utf8'));
    } catch (e) {
      console.log(`  Warning: Failed to read cast file for ${show.id}: ${e.message}`);
      continue;
    }

    // BRO-5809: refuse a cast file from a different production of the same title
    const mismatch = castFileMismatchReason(castData, show);
    if (mismatch) {
      console.log(`  Skipping ${show.id}: cast file rejected (${mismatch})`);
      skippedMismatch++;
      continue;
    }

    // Extract principal cast
    const cast = extractCast(castData, show.status);
    if (!cast || cast.length === 0) {
      skippedEmptySource++;
      continue;
    }

    // Validate: every entry must have a name string
    const valid = cast.every(c => typeof c.name === 'string' && c.name.length > 0);
    if (!valid) {
      console.log(`  Warning: Invalid cast entries for ${show.id}, skipping`);
      continue;
    }

    if (dryRun) {
      console.log(`  Would enrich: ${show.id} (${show.title}) — ${cast.length} members`);
    }

    show.cast = cast;
    enriched++;
    enrichedShows.push({ id: show.id, title: show.title, count: cast.length });
  }

  // Write
  if (!dryRun && (enriched > 0 || billingEnriched > 0)) {
    saveShows(showsData);
    if (skippedMismatch) console.log(`Skipped (wrong production): ${skippedMismatch}`);
    console.log(`\nWrote shows.json with ${enriched} enriched cast arrays and ${billingEnriched} billing lists`);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Enriched:              ${enriched}`);
  console.log(`  Billing enriched:      ${billingEnriched}`);
  console.log(`  Skipped (existing):    ${skippedExisting}`);
  console.log(`  Skipped (no file):     ${skippedNoCastFile}`);
  console.log(`  Skipped (empty src):   ${skippedEmptySource}`);

  // Category breakdown
  if (!categoryFilter) {
    const byCat = {};
    for (const s of enrichedShows) {
      const show = shows.find(sh => sh.id === s.id);
      const cat = (show && show.category) || 'broadway';
      byCat[cat] = (byCat[cat] || 0) + 1;
    }
    if (Object.keys(byCat).length > 1) {
      console.log('\n  By category:');
      for (const [cat, count] of Object.entries(byCat).sort()) {
        console.log(`    ${cat}: ${count}`);
      }
    }
  }

  // GitHub Actions output
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `enriched_count=${enriched}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `shows_processed=${targets.length}\n`);
  }

  console.log(`\nDone.`);
}

main();
