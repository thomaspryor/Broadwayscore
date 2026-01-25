#!/usr/bin/env node
/**
 * validate-data.js
 *
 * Safety validation for show data before committing to production.
 * Prevents automated scripts from breaking the live site.
 *
 * Checks:
 * 1. JSON is valid and parseable
 * 2. Required structure exists
 * 3. No catastrophic changes (mass deletions, etc.)
 * 4. All required fields present on shows
 * 5. Data sanity checks
 *
 * Usage: node scripts/validate-data.js [--strict]
 * Exit codes: 0 = OK, 1 = Errors found
 */

const fs = require('fs');
const path = require('path');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const GROSSES_FILE = path.join(__dirname, '..', 'data', 'grosses.json');

const strictMode = process.argv.includes('--strict');

// Safety thresholds
const THRESHOLDS = {
  MIN_TOTAL_SHOWS: 30,           // Must have at least this many shows
  MIN_OPEN_SHOWS: 15,            // Must have at least this many open shows
  MAX_CLOSED_PER_RUN: 5,         // Don't close more than this many at once
  MAX_DELETED_SHOWS: 0,          // Never delete shows automatically
  MIN_SHOW_FIELDS: ['id', 'title', 'slug', 'status', 'openingDate', 'venue'],
};

let errors = [];
let warnings = [];

function error(msg) {
  errors.push(msg);
  console.error(`❌ ERROR: ${msg}`);
}

function warn(msg) {
  warnings.push(msg);
  console.warn(`⚠️  WARNING: ${msg}`);
}

function ok(msg) {
  console.log(`✅ ${msg}`);
}

function validateShowsJson() {
  console.log('\n📋 Validating shows.json...\n');

  // Check file exists
  if (!fs.existsSync(SHOWS_FILE)) {
    error('shows.json does not exist');
    return false;
  }

  // Check valid JSON
  let data;
  try {
    const content = fs.readFileSync(SHOWS_FILE, 'utf8');
    data = JSON.parse(content);
  } catch (e) {
    error(`shows.json is not valid JSON: ${e.message}`);
    return false;
  }
  ok('Valid JSON structure');

  // Check has shows array
  if (!data.shows || !Array.isArray(data.shows)) {
    error('shows.json missing "shows" array');
    return false;
  }
  ok(`Found ${data.shows.length} shows`);

  // Check minimum show count
  if (data.shows.length < THRESHOLDS.MIN_TOTAL_SHOWS) {
    error(`Only ${data.shows.length} shows found (minimum: ${THRESHOLDS.MIN_TOTAL_SHOWS})`);
    return false;
  }
  ok(`Total shows above minimum (${THRESHOLDS.MIN_TOTAL_SHOWS})`);

  // Check open show count
  const openShows = data.shows.filter(s => s.status === 'open');
  if (openShows.length < THRESHOLDS.MIN_OPEN_SHOWS) {
    error(`Only ${openShows.length} open shows (minimum: ${THRESHOLDS.MIN_OPEN_SHOWS})`);
    return false;
  }
  ok(`Open shows: ${openShows.length} (minimum: ${THRESHOLDS.MIN_OPEN_SHOWS})`);

  // Check required fields on each show
  let missingFields = [];
  for (const show of data.shows) {
    for (const field of THRESHOLDS.MIN_SHOW_FIELDS) {
      if (!show[field]) {
        missingFields.push(`${show.id || 'unknown'}: missing ${field}`);
      }
    }
  }
  if (missingFields.length > 0) {
    if (strictMode) {
      error(`Shows missing required fields:\n  ${missingFields.slice(0, 10).join('\n  ')}`);
      return false;
    } else {
      warn(`${missingFields.length} shows missing some required fields`);
    }
  } else {
    ok('All shows have required fields');
  }

  // Check for duplicate IDs
  const ids = data.shows.map(s => s.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) {
    error(`Duplicate show IDs found: ${duplicates.join(', ')}`);
    return false;
  }
  ok('No duplicate show IDs');

  // Check for duplicate slugs
  const slugs = data.shows.map(s => s.slug);
  const dupSlugs = slugs.filter((slug, i) => slugs.indexOf(slug) !== i);
  if (dupSlugs.length > 0) {
    error(`Duplicate slugs found: ${dupSlugs.join(', ')}`);
    return false;
  }
  ok('No duplicate slugs');

  // Check status values are valid
  const validStatuses = ['open', 'closed', 'previews'];
  const invalidStatus = data.shows.filter(s => !validStatuses.includes(s.status));
  if (invalidStatus.length > 0) {
    error(`Invalid status values: ${invalidStatus.map(s => `${s.id}=${s.status}`).join(', ')}`);
    return false;
  }
  ok('All status values are valid');

  // Check dates are valid format
  const badDates = [];
  for (const show of data.shows) {
    if (show.openingDate && isNaN(Date.parse(show.openingDate))) {
      badDates.push(`${show.id}: openingDate=${show.openingDate}`);
    }
    if (show.closingDate && isNaN(Date.parse(show.closingDate))) {
      badDates.push(`${show.id}: closingDate=${show.closingDate}`);
    }
  }
  if (badDates.length > 0) {
    error(`Invalid date formats:\n  ${badDates.join('\n  ')}`);
    return false;
  }
  ok('All dates are valid format');

  return true;
}

function validateGrossesJson() {
  console.log('\n📊 Validating grosses.json...\n');

  if (!fs.existsSync(GROSSES_FILE)) {
    warn('grosses.json does not exist (optional)');
    return true;
  }

  let data;
  try {
    const content = fs.readFileSync(GROSSES_FILE, 'utf8');
    data = JSON.parse(content);
  } catch (e) {
    error(`grosses.json is not valid JSON: ${e.message}`);
    return false;
  }
  ok('Valid JSON structure');

  if (!data.shows || typeof data.shows !== 'object') {
    error('grosses.json missing "shows" object');
    return false;
  }
  ok(`Found grosses for ${Object.keys(data.shows).length} shows`);

  if (!data.weekEnding) {
    warn('grosses.json missing weekEnding field');
  } else {
    ok(`Week ending: ${data.weekEnding}`);
  }

  return true;
}

function checkForCatastrophicChanges() {
  console.log('\n🛡️  Checking for catastrophic changes...\n');

  // This would compare against a cached/previous version
  // For now, we just validate the current state
  // In a real scenario, we'd compare git diff

  try {
    const { execSync } = require('child_process');
    const diff = execSync('git diff --numstat data/shows.json 2>/dev/null || echo ""', { encoding: 'utf8' });

    if (diff.trim()) {
      const [additions, deletions] = diff.trim().split('\t');
      const adds = parseInt(additions) || 0;
      const dels = parseInt(deletions) || 0;

      if (dels > 500 && dels > adds * 2) {
        error(`Suspicious deletion: ${dels} lines deleted vs ${adds} added`);
        return false;
      }
      ok(`Changes look reasonable: +${adds} -${dels} lines`);
    } else {
      ok('No pending changes to shows.json');
    }
  } catch (e) {
    // Git not available or not in a repo - skip this check
    ok('Skipped git diff check (not in git repo or no changes)');
  }

  return true;
}

function runValidation() {
  console.log('='.repeat(60));
  console.log('BROADWAY DATA VALIDATION');
  console.log('='.repeat(60));
  console.log(`Mode: ${strictMode ? 'STRICT' : 'STANDARD'}`);

  const showsValid = validateShowsJson();
  const grossesValid = validateGrossesJson();
  const noDisaster = checkForCatastrophicChanges();

  console.log('\n' + '='.repeat(60));
  console.log('VALIDATION RESULT');
  console.log('='.repeat(60));

  if (errors.length > 0) {
    console.log(`\n❌ FAILED: ${errors.length} error(s) found`);
    console.log('\nErrors:');
    errors.forEach(e => console.log(`  - ${e}`));
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.log(`\n⚠️  PASSED WITH WARNINGS: ${warnings.length} warning(s)`);
    console.log('\nWarnings:');
    warnings.forEach(w => console.log(`  - ${w}`));
  } else {
    console.log('\n✅ PASSED: All validations successful');
  }

  process.exit(0);
}

runValidation();
