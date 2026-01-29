#!/usr/bin/env node
/**
 * validate-data.js
 *
 * Comprehensive data validation for Broadway Scorecard.
 * Runs automatically in CI to catch issues before they reach production.
 *
 * Checks:
 * 1. JSON is valid and parseable
 * 2. No duplicate shows (using deduplication module)
 * 3. Required fields present on all shows
 * 4. Data format validation (dates, slugs, URLs)
 * 5. Logical consistency (status vs dates)
 * 6. Catastrophic change detection
 *
 * Usage: node scripts/validate-data.js [--strict]
 * Exit codes: 0 = OK, 1 = Errors found
 */

const fs = require('fs');
const path = require('path');

// Import deduplication module for duplicate detection
let checkForDuplicate;
try {
  const dedup = require('./lib/deduplication');
  checkForDuplicate = dedup.checkForDuplicate;
} catch (e) {
  console.warn('Deduplication module not found, using basic duplicate check');
  checkForDuplicate = null;
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');
const GROSSES_FILE = path.join(DATA_DIR, 'grosses.json');
const COMMERCIAL_FILE = path.join(DATA_DIR, 'commercial.json');

const strictMode = process.argv.includes('--strict');

// Safety thresholds
const THRESHOLDS = {
  MIN_TOTAL_SHOWS: 30,
  MIN_OPEN_SHOWS: 15,
  MAX_DELETED_SHOWS: 0,
  REQUIRED_FIELDS: ['id', 'title', 'slug', 'status'],
  REQUIRED_FIELDS_OPEN: ['id', 'title', 'slug', 'status', 'venue'],
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

function info(msg) {
  console.log(`ℹ️  ${msg}`);
}

// ===========================================
// DUPLICATE DETECTION
// ===========================================

function validateNoDuplicates(shows) {
  info('Checking for duplicate shows...');

  // Check duplicate IDs
  const ids = shows.map(s => s.id);
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupIds.length > 0) {
    error(`Duplicate show IDs: ${[...new Set(dupIds)].join(', ')}`);
  } else {
    ok('No duplicate IDs');
  }

  // Check duplicate slugs
  const slugs = shows.map(s => s.slug);
  const dupSlugs = slugs.filter((slug, i) => slugs.indexOf(slug) !== i);
  if (dupSlugs.length > 0) {
    error(`Duplicate slugs: ${[...new Set(dupSlugs)].join(', ')}`);
  } else {
    ok('No duplicate slugs');
  }

  // Use deduplication module for comprehensive title matching
  if (checkForDuplicate) {
    info('Running comprehensive duplicate detection...');
    const duplicatesFound = [];

    for (let i = 1; i < shows.length; i++) {
      const show = shows[i];
      const previousShows = shows.slice(0, i);
      const check = checkForDuplicate(show, previousShows);

      if (check.isDuplicate) {
        duplicatesFound.push({
          show: show.title,
          showId: show.id,
          existingShow: check.existingShow?.title,
          existingId: check.existingShow?.id,
          reason: check.reason,
        });
      }
    }

    if (duplicatesFound.length > 0) {
      for (const dup of duplicatesFound) {
        error(`Duplicate: "${dup.show}" (${dup.showId}) matches "${dup.existingShow}" (${dup.existingId}) - ${dup.reason}`);
      }
    } else {
      ok('No duplicate titles detected by deduplication module');
    }
  }
}

// ===========================================
// FIELD VALIDATION
// ===========================================

function validateRequiredFields(shows) {
  info('Checking required fields...');
  let missingCount = 0;

  for (const show of shows) {
    const fields = show.status === 'open' ? THRESHOLDS.REQUIRED_FIELDS_OPEN : THRESHOLDS.REQUIRED_FIELDS;

    for (const field of fields) {
      if (!show[field]) {
        if (field === 'venue' && show.status === 'open') {
          warn(`Open show "${show.title}" (${show.id}) missing venue`);
        } else {
          error(`Show "${show.title || show.id}" missing required field: ${field}`);
        }
        missingCount++;
      }
    }
  }

  if (missingCount === 0) {
    ok('All shows have required fields');
  }
}

function validateStatus(shows) {
  info('Checking status values...');
  const validStatuses = ['open', 'closed', 'previews'];
  let invalid = 0;

  for (const show of shows) {
    if (!validStatuses.includes(show.status)) {
      error(`Show "${show.title}" has invalid status: "${show.status}"`);
      invalid++;
    }
  }

  if (invalid === 0) {
    ok('All status values are valid');
  }
}

function validateDates(shows) {
  info('Checking date formats and logic...');
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  const today = new Date().toISOString().split('T')[0];
  let issues = 0;

  for (const show of shows) {
    // Format check
    if (show.openingDate && !dateRegex.test(show.openingDate)) {
      error(`Show "${show.title}" has invalid openingDate format: "${show.openingDate}"`);
      issues++;
    }
    if (show.closingDate && !dateRegex.test(show.closingDate)) {
      error(`Show "${show.title}" has invalid closingDate format: "${show.closingDate}"`);
      issues++;
    }

    // Logic checks
    if (show.status === 'closed' && show.closingDate && show.closingDate > today) {
      error(`Show "${show.title}" marked closed but closingDate is future: ${show.closingDate}`);
      issues++;
    }

    if (show.status === 'open' && show.closingDate && show.closingDate < today) {
      warn(`Show "${show.title}" still open but closingDate has passed: ${show.closingDate}`);
    }

    if (show.status === 'previews' && show.openingDate && show.openingDate < today) {
      warn(`Show "${show.title}" still previews but openingDate has passed: ${show.openingDate}`);
    }
  }

  if (issues === 0) {
    ok('All dates are valid');
  }
}

function validateSlugs(shows) {
  info('Checking slug formats...');
  const slugRegex = /^[a-z0-9-]+$/;
  let invalid = 0;

  for (const show of shows) {
    if (show.slug && !slugRegex.test(show.slug)) {
      error(`Show "${show.title}" has invalid slug: "${show.slug}"`);
      invalid++;
    }
  }

  if (invalid === 0) {
    ok('All slugs are URL-safe');
  }
}

function validateImageUrls(shows) {
  info('Checking image URLs...');
  // Accept both external URLs (https://) and local paths (/images/)
  const urlRegex = /^(https?:\/\/.+|\/images\/.+)/;
  let invalid = 0;

  for (const show of shows) {
    if (show.images) {
      for (const [key, url] of Object.entries(show.images)) {
        if (url && typeof url === 'string' && !urlRegex.test(url)) {
          error(`Show "${show.title}" has invalid ${key} URL: "${url}"`);
          invalid++;
        }
      }
    }
  }

  if (invalid === 0) {
    ok('All image URLs are valid');
  }
}

// ===========================================
// SAFETY CHECKS
// ===========================================

function validateMinimumCounts(shows) {
  info('Checking minimum counts...');

  if (shows.length < THRESHOLDS.MIN_TOTAL_SHOWS) {
    error(`Only ${shows.length} shows (minimum: ${THRESHOLDS.MIN_TOTAL_SHOWS})`);
  } else {
    ok(`Total shows: ${shows.length} (minimum: ${THRESHOLDS.MIN_TOTAL_SHOWS})`);
  }

  const openShows = shows.filter(s => s.status === 'open');
  if (openShows.length < THRESHOLDS.MIN_OPEN_SHOWS) {
    error(`Only ${openShows.length} open shows (minimum: ${THRESHOLDS.MIN_OPEN_SHOWS})`);
  } else {
    ok(`Open shows: ${openShows.length} (minimum: ${THRESHOLDS.MIN_OPEN_SHOWS})`);
  }
}

function checkForCatastrophicChanges() {
  info('Checking for suspicious changes...');

  try {
    const { execSync } = require('child_process');
    const diff = execSync('git diff --numstat data/shows.json 2>/dev/null || echo ""', { encoding: 'utf8' });

    if (diff.trim()) {
      const [additions, deletions] = diff.trim().split('\t');
      const adds = parseInt(additions) || 0;
      const dels = parseInt(deletions) || 0;

      if (dels > 500 && dels > adds * 2) {
        error(`Suspicious deletion: ${dels} lines deleted vs ${adds} added`);
      } else {
        ok(`Changes look reasonable: +${adds} -${dels} lines`);
      }
    } else {
      ok('No pending changes to shows.json');
    }
  } catch (e) {
    ok('Skipped git diff check');
  }
}

// ===========================================
// GROSSES VALIDATION
// ===========================================

function validateGrossesJson() {
  info('Checking grosses.json...');

  if (!fs.existsSync(GROSSES_FILE)) {
    warn('grosses.json does not exist (optional)');
    return;
  }

  try {
    const data = JSON.parse(fs.readFileSync(GROSSES_FILE, 'utf8'));
    ok('grosses.json is valid JSON');

    if (!data.shows || typeof data.shows !== 'object') {
      warn('grosses.json missing "shows" object');
    } else {
      ok(`Grosses data for ${Object.keys(data.shows).length} shows`);
    }
  } catch (e) {
    error(`grosses.json parse error: ${e.message}`);
  }
}

// ===========================================
// REVIEW DATA VALIDATION
// ===========================================

function validateReviewData(shows) {
  info('Checking review-texts directories...');
  const reviewTextsDir = path.join(DATA_DIR, 'review-texts');

  if (!fs.existsSync(reviewTextsDir)) {
    info('No review-texts directory found, skipping');
    return;
  }

  const showIds = new Set(shows.map(s => s.id));
  const reviewDirs = fs.readdirSync(reviewTextsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name);

  let orphaned = 0;
  for (const dir of reviewDirs) {
    if (!showIds.has(dir)) {
      warn(`Orphaned review directory: ${dir}`);
      orphaned++;
    }
  }

  if (orphaned === 0) {
    ok('All review directories match show IDs');
  }
}

function validateReviewsJson() {
  info('Checking reviews.json for duplicate outlet+critic combos...');
  const reviewsFile = path.join(DATA_DIR, 'reviews.json');

  if (!fs.existsSync(reviewsFile)) {
    info('reviews.json does not exist, skipping');
    return;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
  } catch (e) {
    error(`reviews.json parse error: ${e.message}`);
    return;
  }

  const reviews = data.reviews || [];
  ok(`Loaded ${reviews.length} reviews from reviews.json`);

  // Check for duplicate outlet+critic per show
  const byShow = {};
  const duplicates = [];

  for (const r of reviews) {
    const showId = r.showId || 'unknown';
    const outletKey = (r.outlet || 'unknown').toLowerCase().trim();
    const criticKey = (r.criticName || 'unknown').toLowerCase().trim();
    const key = `${outletKey}|${criticKey}`;

    if (!byShow[showId]) {
      byShow[showId] = new Set();
    }

    if (byShow[showId].has(key)) {
      duplicates.push({ showId, outlet: r.outlet, critic: r.criticName });
    } else {
      byShow[showId].add(key);
    }
  }

  if (duplicates.length > 0) {
    error(`Found ${duplicates.length} duplicate outlet+critic combos in reviews.json:`);
    duplicates.slice(0, 10).forEach(d => {
      error(`  ${d.showId}: ${d.outlet} + ${d.critic}`);
    });
    if (duplicates.length > 10) {
      error(`  ...and ${duplicates.length - 10} more`);
    }
  } else {
    ok('No duplicate outlet+critic combos in reviews.json');
  }

  // Check for known critic misattribution
  // Note: Many critics have worked at multiple outlets over their careers
  const KNOWN_CRITICS = {
    'jesse green': ['the new york times', 'nytimes', 'nyt', 'vulture', 'new york magazine', 'ny mag'],
    'maya phillips': ['the new york times', 'nytimes', 'nyt'],
    'peter marks': ['the washington post', 'washington post', 'washpost'],
    'adam feldman': ['time out', 'time out new york', 'timeout', 'theatermania', 'variety'],
    'charles isherwood': ['the wall street journal', 'wsj', 'the new york times', 'nytimes', 'nyt', 'variety'],
    'ben brantley': ['the new york times', 'nytimes', 'nyt'],
    'frank scheck': ['the hollywood reporter', 'hollywood reporter', 'newsday'],
    'david rooney': ['the hollywood reporter', 'hollywood reporter', 'variety'],
    'helen shaw': ['vulture', 'new york magazine', 'time out', 'timeout'],
    'sara holdren': ['vulture', 'new york magazine'],
    'johnny oleksinski': ['new york post', 'nypost'],
    'chris jones': ['chicago tribune', 'chicagotribune', 'new york daily news', 'nydailynews'],
  };

  const misattributed = [];
  for (const r of reviews) {
    const criticLower = (r.criticName || '').toLowerCase().trim();
    const outletLower = (r.outlet || '').toLowerCase().trim();

    if (KNOWN_CRITICS[criticLower]) {
      const allowedOutlets = KNOWN_CRITICS[criticLower];
      const isAllowed = allowedOutlets.some(o => outletLower.includes(o) || o.includes(outletLower));

      if (!isAllowed) {
        misattributed.push({ showId: r.showId, outlet: r.outlet, critic: r.criticName });
      }
    }
  }

  if (misattributed.length > 0) {
    // Downgraded to warning - critics often freelance for multiple outlets
    warn(`Found ${misattributed.length} reviews where critic is at unexpected outlet (may be freelance):`);
    misattributed.slice(0, 5).forEach(m => {
      warn(`  ${m.showId}: ${m.critic} at ${m.outlet}`);
    });
    if (misattributed.length > 5) {
      warn(`  ...and ${misattributed.length - 5} more`);
    }
  } else {
    ok('No known critic misattributions detected');
  }
}

// ===========================================
// COMMERCIAL DATA VALIDATION
// ===========================================

// Valid costMethodology values for commercial data
const VALID_COST_METHODOLOGIES = [
  'reddit-standard',
  'trade-reported',
  'sec-filing',
  'producer-confirmed',
  'deep-research',
  'industry-estimate'
];

function validateCommercialJson() {
  info('Checking commercial.json...');

  if (!fs.existsSync(COMMERCIAL_FILE)) {
    warn('commercial.json does not exist (optional)');
    return;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(COMMERCIAL_FILE, 'utf8'));
    ok('commercial.json is valid JSON');
  } catch (e) {
    error(`commercial.json parse error: ${e.message}`);
    return;
  }

  // Validate _meta.designations exists
  if (!data._meta || !data._meta.designations || typeof data._meta.designations !== 'object') {
    error('commercial.json missing _meta.designations object');
  } else {
    ok('commercial.json has _meta.designations');
  }

  if (!data.shows || typeof data.shows !== 'object') {
    warn('commercial.json missing "shows" object');
    return;
  }

  const validProductionTypes = ['original', 'tour-stop', 'return-engagement'];
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  const showKeys = Object.keys(data.shows);
  let issues = 0;

  for (const showId of showKeys) {
    const show = data.shows[showId];

    // Validate productionType
    if (show.productionType !== undefined) {
      if (!validProductionTypes.includes(show.productionType)) {
        error(`commercial.json: "${showId}" has invalid productionType: "${show.productionType}" (must be one of: ${validProductionTypes.join(', ')})`);
        issues++;
      }
    }

    // Validate estimatedRecoupmentPct
    if (show.estimatedRecoupmentPct !== undefined) {
      if (!Array.isArray(show.estimatedRecoupmentPct) || show.estimatedRecoupmentPct.length !== 2) {
        error(`commercial.json: "${showId}" estimatedRecoupmentPct must be a 2-element array [low, high]`);
        issues++;
      } else {
        const [low, high] = show.estimatedRecoupmentPct;
        if (typeof low !== 'number' || typeof high !== 'number') {
          error(`commercial.json: "${showId}" estimatedRecoupmentPct values must be numbers`);
          issues++;
        } else if (low < 0 || high > 100 || low > high) {
          error(`commercial.json: "${showId}" estimatedRecoupmentPct must satisfy 0 <= low <= high <= 100, got [${low}, ${high}]`);
          issues++;
        }
      }
    }

    // Validate originalProductionId references an existing show
    if (show.originalProductionId !== undefined) {
      if (!data.shows[show.originalProductionId]) {
        error(`commercial.json: "${showId}" originalProductionId "${show.originalProductionId}" does not reference an existing show in commercial.json`);
        issues++;
      }
    }

    // Validate isEstimate is an object with boolean values
    if (show.isEstimate !== undefined) {
      if (typeof show.isEstimate !== 'object' || Array.isArray(show.isEstimate) || show.isEstimate === null) {
        error(`commercial.json: "${showId}" isEstimate must be an object`);
        issues++;
      } else {
        for (const [key, val] of Object.entries(show.isEstimate)) {
          if (typeof val !== 'boolean') {
            error(`commercial.json: "${showId}" isEstimate.${key} must be a boolean, got ${typeof val}`);
            issues++;
          }
        }
      }
    }

    // Validate estimatedRecoupmentDate format
    if (show.estimatedRecoupmentDate !== undefined) {
      if (!dateRegex.test(show.estimatedRecoupmentDate)) {
        error(`commercial.json: "${showId}" estimatedRecoupmentDate must be YYYY-MM-DD format, got "${show.estimatedRecoupmentDate}"`);
        issues++;
      }
    }

    // Cross-validation: Tour Stop designation must have tour-stop or return-engagement productionType
    if (show.designation === 'Tour Stop') {
      if (show.productionType !== 'tour-stop' && show.productionType !== 'return-engagement') {
        error(`commercial.json: "${showId}" has designation "Tour Stop" but productionType is "${show.productionType || 'missing'}" (must be "tour-stop" or "return-engagement")`);
        issues++;
      }
    }

    // Cross-validation: tour-stop productionType must have Tour Stop designation
    if (show.productionType === 'tour-stop') {
      if (show.designation !== 'Tour Stop') {
        error(`commercial.json: "${showId}" has productionType "tour-stop" but designation is "${show.designation || 'missing'}" (must be "Tour Stop")`);
        issues++;
      }
    }

    // Validate costMethodology
    if (show.costMethodology && !VALID_COST_METHODOLOGIES.includes(show.costMethodology)) {
      error(`commercial.json: "${showId}" has invalid costMethodology "${show.costMethodology}". Valid values: ${VALID_COST_METHODOLOGIES.join(', ')}`);
      issues++;
    }

    // Validate deepResearch object if present
    if (show.deepResearch) {
      const dr = show.deepResearch;

      // verifiedFields must be an array of strings
      if (!Array.isArray(dr.verifiedFields)) {
        error(`commercial.json: "${showId}" deepResearch.verifiedFields must be an array`);
        issues++;
      } else if (dr.verifiedFields.length === 0) {
        error(`commercial.json: "${showId}" deepResearch.verifiedFields cannot be empty`);
        issues++;
      } else if (!dr.verifiedFields.every(f => typeof f === 'string')) {
        error(`commercial.json: "${showId}" deepResearch.verifiedFields must contain only strings`);
        issues++;
      }

      // verifiedDate must be an ISO date string (YYYY-MM-DD)
      if (!dr.verifiedDate) {
        error(`commercial.json: "${showId}" deepResearch.verifiedDate is required`);
        issues++;
      } else if (!dateRegex.test(dr.verifiedDate)) {
        error(`commercial.json: "${showId}" deepResearch.verifiedDate must be in YYYY-MM-DD format`);
        issues++;
      }

      // verifiedBy is optional but must be string if present
      if (dr.verifiedBy !== undefined && typeof dr.verifiedBy !== 'string') {
        error(`commercial.json: "${showId}" deepResearch.verifiedBy must be a string`);
        issues++;
      }

      // notes is optional but must be string if present
      if (dr.notes !== undefined && typeof dr.notes !== 'string') {
        error(`commercial.json: "${showId}" deepResearch.notes must be a string`);
        issues++;
      }
    }
  }

  if (issues === 0) {
    ok(`Commercial data valid for ${showKeys.length} shows`);
  }
}

// ===========================================
// MAIN
// ===========================================

function runValidation() {
  console.log('='.repeat(60));
  console.log('BROADWAY SCORECARD DATA VALIDATION');
  console.log('='.repeat(60));
  console.log(`Mode: ${strictMode ? 'STRICT' : 'STANDARD'}`);
  console.log('');

  // Check shows.json exists and is valid JSON
  if (!fs.existsSync(SHOWS_FILE)) {
    error('shows.json does not exist');
    process.exit(1);
  }

  let shows;
  try {
    const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
    shows = data.shows || data;
    ok(`Loaded ${shows.length} shows from shows.json`);
  } catch (e) {
    error(`shows.json parse error: ${e.message}`);
    process.exit(1);
  }

  console.log('');

  // Run all validations
  validateNoDuplicates(shows);
  console.log('');
  validateRequiredFields(shows);
  console.log('');
  validateStatus(shows);
  validateDates(shows);
  validateSlugs(shows);
  validateImageUrls(shows);
  console.log('');
  validateMinimumCounts(shows);
  console.log('');
  checkForCatastrophicChanges();
  console.log('');
  validateGrossesJson();
  console.log('');
  validateCommercialJson();
  console.log('');
  validateReviewData(shows);
  console.log('');
  validateReviewsJson();

  // Summary
  console.log('');
  console.log('='.repeat(60));
  console.log('VALIDATION RESULT');
  console.log('='.repeat(60));

  if (errors.length > 0) {
    console.log(`\n❌ FAILED: ${errors.length} error(s) found\n`);
    errors.forEach((e, i) => console.log(`   ${i + 1}. ${e}`));
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.log(`\n⚠️  PASSED WITH ${warnings.length} WARNING(S)\n`);
    warnings.forEach((w, i) => console.log(`   ${i + 1}. ${w}`));
  } else {
    console.log('\n✅ ALL VALIDATIONS PASSED\n');
  }

  process.exit(0);
}

runValidation();
