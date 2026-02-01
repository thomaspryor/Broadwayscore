#!/usr/bin/env node
/**
 * IBDB Date Enrichment Script
 *
 * Enriches shows.json with accurate preview, opening, and closing dates
 * from IBDB (Internet Broadway Database).
 *
 * Usage:
 *   node scripts/enrich-ibdb-dates.js [options]
 *
 * Options:
 *   --dry-run       Show what would change without modifying files
 *   --show=SLUG     Only process a specific show by slug
 *   --missing-only  Only fill in null/missing dates (default behavior)
 *   --verify        Compare IBDB dates vs shows.json, report discrepancies (no writes)
 *   --force         Overwrite all dates with IBDB values
 *   --status=STATUS Filter by show status (open, previews, closed)
 */

const fs = require('fs');
const path = require('path');
const { lookupIBDBDates, batchLookupIBDBDates } = require('./lib/ibdb-dates');
const { cleanup } = require('./lib/scraper');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');

// Parse arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verify = args.includes('--verify');
const force = args.includes('--force');
const missingOnly = !force; // Default: only fill missing

const showArg = args.find(a => a.startsWith('--show='));
const showSlug = showArg ? showArg.split('=')[1] : null;

const statusArg = args.find(a => a.startsWith('--status='));
const statusFilter = statusArg ? statusArg.split('=')[1] : null;

function loadShows() {
  return JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
}

function saveShows(data) {
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

async function main() {
  console.log('='.repeat(60));
  console.log('IBDB DATE ENRICHMENT');
  console.log('='.repeat(60));
  console.log(`Mode: ${verify ? 'VERIFY' : dryRun ? 'DRY RUN' : 'LIVE'}`);
  if (force) console.log('⚠️  FORCE mode: will overwrite existing dates');
  if (showSlug) console.log(`Show filter: ${showSlug}`);
  if (statusFilter) console.log(`Status filter: ${statusFilter}`);
  console.log('');

  const data = loadShows();
  let shows = data.shows;

  // Apply filters
  if (showSlug) {
    shows = shows.filter(s => s.slug === showSlug || s.id === showSlug);
    if (shows.length === 0) {
      console.error(`❌ No show found with slug/id: ${showSlug}`);
      process.exit(1);
    }
  }

  if (statusFilter) {
    shows = shows.filter(s => s.status === statusFilter);
  }

  // If missing-only mode, filter to shows with incomplete dates
  if (missingOnly && !verify && !showSlug) {
    shows = shows.filter(s =>
      !s.previewsStartDate || !s.openingDate || !s.closingDate
    );
  }

  console.log(`Shows to process: ${shows.length}`);
  console.log('');

  if (shows.length === 0) {
    console.log('✅ No shows need date enrichment');
    return;
  }

  // Prepare batch lookup
  const lookupList = shows.map(s => ({
    title: s.title,
    openingYear: s.openingDate ? parseInt(s.openingDate.split('-')[0]) : null,
    venue: s.venue,
    slug: s.slug,
    id: s.id
  }));

  const ibdbResults = await batchLookupIBDBDates(lookupList);

  // Process results
  const changes = [];
  const discrepancies = [];
  let updated = 0;

  for (const show of shows) {
    const ibdb = ibdbResults.get(show.title);
    if (!ibdb || !ibdb.found) continue;

    const showChanges = [];

    // Check previewsStartDate
    if (ibdb.previewsStartDate) {
      if (!show.previewsStartDate) {
        showChanges.push({
          field: 'previewsStartDate',
          old: show.previewsStartDate,
          new: ibdb.previewsStartDate
        });
      } else if (show.previewsStartDate !== ibdb.previewsStartDate) {
        discrepancies.push({
          show: show.title,
          slug: show.slug,
          field: 'previewsStartDate',
          current: show.previewsStartDate,
          ibdb: ibdb.previewsStartDate
        });
        if (force) {
          showChanges.push({
            field: 'previewsStartDate',
            old: show.previewsStartDate,
            new: ibdb.previewsStartDate
          });
        }
      }
    }

    // Check openingDate
    if (ibdb.openingDate) {
      if (!show.openingDate) {
        showChanges.push({
          field: 'openingDate',
          old: show.openingDate,
          new: ibdb.openingDate
        });
      } else if (show.openingDate !== ibdb.openingDate) {
        discrepancies.push({
          show: show.title,
          slug: show.slug,
          field: 'openingDate',
          current: show.openingDate,
          ibdb: ibdb.openingDate
        });
        if (force) {
          showChanges.push({
            field: 'openingDate',
            old: show.openingDate,
            new: ibdb.openingDate
          });
        }
      }
    }

    // Check closingDate
    if (ibdb.closingDate) {
      if (!show.closingDate) {
        showChanges.push({
          field: 'closingDate',
          old: show.closingDate,
          new: ibdb.closingDate
        });
      } else if (show.closingDate !== ibdb.closingDate) {
        discrepancies.push({
          show: show.title,
          slug: show.slug,
          field: 'closingDate',
          current: show.closingDate,
          ibdb: ibdb.closingDate
        });
        if (force) {
          showChanges.push({
            field: 'closingDate',
            old: show.closingDate,
            new: ibdb.closingDate
          });
        }
      }
    }

    // Data integrity guards
    const filteredChanges = showChanges.filter(c => {
      // Never set previewsStartDate >= openingDate
      if (c.field === 'previewsStartDate' && ibdb.openingDate) {
        if (c.new >= ibdb.openingDate) {
          console.log(`  ⚠️  Skipping ${show.title}: previewsStartDate (${c.new}) >= openingDate (${ibdb.openingDate})`);
          return false;
        }
      }

      // Never overwrite non-null with null (unless --force)
      if (c.new === null && c.old !== null && !force) {
        return false;
      }

      return true;
    });

    if (filteredChanges.length > 0) {
      changes.push({ show: show.title, slug: show.slug, changes: filteredChanges });
    }
  }

  // Report discrepancies
  if (discrepancies.length > 0) {
    console.log('');
    console.log('📊 Date Discrepancies (shows.json vs IBDB):');
    console.log('-'.repeat(60));
    for (const d of discrepancies) {
      console.log(`  ${d.show} (${d.slug})`);
      console.log(`    ${d.field}: current=${d.current} → IBDB=${d.ibdb}`);
    }
    console.log('');
  }

  // Report planned changes
  if (changes.length > 0) {
    console.log('');
    console.log(`📝 ${verify ? 'Potential' : 'Planned'} Changes:`);
    console.log('-'.repeat(60));
    for (const c of changes) {
      console.log(`  ${c.show} (${c.slug}):`);
      for (const ch of c.changes) {
        console.log(`    ${ch.field}: ${ch.old || 'null'} → ${ch.new}`);
      }
    }
    console.log('');
  }

  // Apply changes (unless dry-run or verify)
  if (!dryRun && !verify && changes.length > 0) {
    for (const c of changes) {
      const showRecord = data.shows.find(s => s.slug === c.slug);
      if (!showRecord) continue;

      for (const ch of c.changes) {
        showRecord[ch.field] = ch.new;
      }
      updated++;
    }

    saveShows(data);
    console.log(`✅ Updated ${updated} show(s) in shows.json`);

    // Run validation
    console.log('');
    console.log('Running data validation...');
    try {
      const { execSync } = require('child_process');
      execSync('node scripts/validate-data.js', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
      console.log('✅ Validation passed');
    } catch (e) {
      console.error('❌ Validation failed! Review changes.');
      process.exit(1);
    }
  } else if (changes.length === 0) {
    console.log('✅ No changes needed');
  } else {
    console.log(`ℹ️  ${changes.length} change(s) would be applied (${dryRun ? 'dry run' : 'verify mode'})`);
  }

  // Summary
  console.log('');
  console.log('📊 Summary:');
  console.log(`   Shows processed: ${shows.length}`);
  console.log(`   IBDB matches: ${Array.from(ibdbResults.values()).filter(r => r.found).length}`);
  console.log(`   Discrepancies: ${discrepancies.length}`);
  console.log(`   Changes ${verify || dryRun ? 'identified' : 'applied'}: ${changes.reduce((acc, c) => acc + c.changes.length, 0)}`);

  // GitHub Actions outputs
  if (process.env.GITHUB_OUTPUT) {
    const outputFile = process.env.GITHUB_OUTPUT;
    fs.appendFileSync(outputFile, `shows_processed=${shows.length}\n`);
    fs.appendFileSync(outputFile, `ibdb_matches=${Array.from(ibdbResults.values()).filter(r => r.found).length}\n`);
    fs.appendFileSync(outputFile, `discrepancies=${discrepancies.length}\n`);
    fs.appendFileSync(outputFile, `changes_applied=${verify || dryRun ? 0 : changes.reduce((acc, c) => acc + c.changes.length, 0)}\n`);
  }
}

main()
  .catch(e => {
    console.error('IBDB enrichment failed:', e);
    process.exit(1);
  })
  .finally(() => {
    cleanup().catch(() => {});
  });
