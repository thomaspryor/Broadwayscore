#!/usr/bin/env node
/**
 * Validate tony-nominations.json data quality
 *
 * Checks:
 * 1. Coverage: >= 95% of expected shows scraped successfully
 * 2. Category mapping: No unmapped categories (raw IBDB names leaking through)
 * 3. Person ID matching: ibdbPersonId matches cast/creative files where possible
 * 4. Win/nomination counts: Reasonable vs awards.json expected counts
 * 5. Duplicates: No duplicate entries
 * 6. Data integrity: Required fields present
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TONY_FILE = path.join(DATA_DIR, 'tony-nominations.json');
const AWARDS_FILE = path.join(DATA_DIR, 'awards.json');
const CAST_DIR = path.join(DATA_DIR, 'cast');

// Known short-form categories from src/config/awards.ts
const VALID_CATEGORIES = new Set([
  'Best Musical', 'Best Play',
  'Best Revival of a Musical', 'Best Revival of a Play',
  'Best Book of a Musical', 'Best Original Score',
  'Best Actor in a Musical', 'Best Actress in a Musical',
  'Best Actor in a Play', 'Best Actress in a Play',
  'Best Featured Actor in a Musical', 'Best Featured Actress in a Musical',
  'Best Featured Actor in a Play', 'Best Featured Actress in a Play',
  'Best Direction of a Musical', 'Best Direction of a Play',
  'Best Choreography', 'Best Orchestrations',
  'Best Scenic Design of a Musical', 'Best Scenic Design of a Play',
  'Best Scenic Design', // pre-split category
  'Best Costume Design of a Musical', 'Best Costume Design of a Play',
  'Best Costume Design', // pre-split category
  'Best Lighting Design of a Musical', 'Best Lighting Design of a Play',
  'Best Lighting Design', // pre-split category
  'Best Sound Design of a Musical', 'Best Sound Design of a Play',
  'Best Sound Design', // pre-split category
]);

function validate() {
  const errors = [];
  const warnings = [];

  // Load data
  if (!fs.existsSync(TONY_FILE)) {
    console.error('ERROR: tony-nominations.json not found');
    process.exit(1);
  }

  const tonyData = JSON.parse(fs.readFileSync(TONY_FILE, 'utf8'));
  const awardsData = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
  const nominations = tonyData.nominations;
  const meta = tonyData._meta;

  console.log('=== Tony Nominations Validation ===\n');
  console.log(`Total nominations: ${nominations.length}`);
  console.log(`Total wins: ${nominations.filter(n => n.won).length}`);
  console.log(`Shows processed: ${meta.actualShowCount}/${meta.expectedShowCount}`);
  console.log();

  // 1. Coverage check
  const coveragePct = (meta.actualShowCount / meta.expectedShowCount) * 100;
  console.log(`Coverage: ${coveragePct.toFixed(1)}%`);
  if (coveragePct < 95) {
    errors.push(`Coverage ${coveragePct.toFixed(1)}% is below 95% threshold (${meta.actualShowCount}/${meta.expectedShowCount} shows)`);
  }

  // Count shows with actual data vs expected
  const showsWithData = new Set(nominations.map(n => n.showId));
  const expectedShows = Object.keys(awardsData.shows).filter(id => {
    const show = awardsData.shows[id];
    return show.tony && show.tony.nominations > 0;
  });
  const missingShows = expectedShows.filter(id => !showsWithData.has(id));
  if (missingShows.length > 0) {
    const missingCount = missingShows.length;
    const pct = ((expectedShows.length - missingCount) / expectedShows.length * 100).toFixed(1);
    if (missingCount > expectedShows.length * 0.05) {
      errors.push(`${missingCount} shows missing nominations data (${pct}% coverage): ${missingShows.slice(0, 10).join(', ')}${missingCount > 10 ? '...' : ''}`);
    } else {
      warnings.push(`${missingCount} shows missing nominations data (${pct}% coverage): ${missingShows.join(', ')}`);
    }
  }

  // 2. Category mapping check
  const unmappedCategories = new Set();
  for (const nom of nominations) {
    if (!VALID_CATEGORIES.has(nom.category)) {
      unmappedCategories.add(nom.category);
    }
  }
  if (unmappedCategories.size > 0) {
    warnings.push(`${unmappedCategories.size} unmapped categories: ${Array.from(unmappedCategories).join(', ')}`);
  }

  // 3. Required fields check
  let missingFields = 0;
  for (const nom of nominations) {
    if (!nom.showId || !nom.category || nom.won === undefined) {
      missingFields++;
    }
    if (!nom.name) {
      missingFields++;
    }
  }
  if (missingFields > 0) {
    errors.push(`${missingFields} nominations with missing required fields`);
  }

  // 4. Duplicate check
  const seen = new Set();
  let dupes = 0;
  for (const nom of nominations) {
    const key = `${nom.showId}|${nom.category}|${nom.ibdbPersonId}`;
    if (seen.has(key)) {
      dupes++;
    }
    seen.add(key);
  }
  if (dupes > 0) {
    errors.push(`${dupes} duplicate entries found`);
  }

  // 5. Person ID matching against cast files
  let matchedPersonIds = 0;
  let unmatchedPersonIds = 0;
  const castPersonIds = new Set();

  // Build set of all known person IDs from cast files
  const castFiles = fs.readdirSync(CAST_DIR).filter(f => f.endsWith('.json'));
  for (const file of castFiles) {
    try {
      const cast = JSON.parse(fs.readFileSync(path.join(CAST_DIR, file), 'utf8'));
      const allMembers = [
        ...(cast.openingNightCast || []),
        ...(cast.currentCast || []),
        ...(cast.replacements || []),
      ];
      for (const member of allMembers) {
        if (member.ibdbPersonId) castPersonIds.add(member.ibdbPersonId);
      }
    } catch (e) { /* skip bad files */ }
  }

  const actingNoms = nominations.filter(n =>
    n.ibdbPersonId && (
      n.category.includes('Actor') ||
      n.category.includes('Actress') ||
      n.category.includes('Featured')
    )
  );

  for (const nom of actingNoms) {
    if (castPersonIds.has(nom.ibdbPersonId)) {
      matchedPersonIds++;
    } else {
      unmatchedPersonIds++;
    }
  }

  const matchRate = actingNoms.length > 0 ? (matchedPersonIds / actingNoms.length * 100).toFixed(1) : 'N/A';
  console.log(`\nPerson ID match rate (acting noms vs cast files): ${matchRate}% (${matchedPersonIds}/${actingNoms.length})`);
  if (unmatchedPersonIds > actingNoms.length * 0.5) {
    warnings.push(`Only ${matchRate}% of acting nominations match cast file person IDs`);
  }

  // 6. Win count sanity check per show
  let countMismatches = 0;
  for (const showId of showsWithData) {
    const showNoms = nominations.filter(n => n.showId === showId);
    const expectedNoms = awardsData.shows[showId]?.tony?.nominations || 0;
    // Allow some variance (IBDB may count differently than awards.json)
    if (expectedNoms > 0 && Math.abs(showNoms.length - expectedNoms) > expectedNoms * 0.5) {
      countMismatches++;
      if (countMismatches <= 5) {
        warnings.push(`${showId}: expected ~${expectedNoms} nominations, got ${showNoms.length}`);
      }
    }
  }
  if (countMismatches > 5) {
    warnings.push(`...and ${countMismatches - 5} more count mismatches`);
  }

  // 7. Summary stats
  console.log(`\nCategory distribution:`);
  const catCounts = {};
  for (const nom of nominations) {
    catCounts[nom.category] = (catCounts[nom.category] || 0) + 1;
  }
  const sortedCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sortedCats.slice(0, 15)) {
    console.log(`  ${cat}: ${count}`);
  }
  if (sortedCats.length > 15) {
    console.log(`  ... and ${sortedCats.length - 15} more categories`);
  }

  // Report
  console.log('\n=== Results ===');
  if (errors.length === 0 && warnings.length === 0) {
    console.log('✅ All checks passed!');
  }

  if (warnings.length > 0) {
    console.log(`\n⚠️  ${warnings.length} warnings:`);
    for (const w of warnings) {
      console.log(`  - ${w}`);
    }
  }

  if (errors.length > 0) {
    console.log(`\n❌ ${errors.length} errors:`);
    for (const e of errors) {
      console.log(`  - ${e}`);
    }
    process.exit(1);
  }

  console.log('\n✅ Validation passed');
}

validate();
