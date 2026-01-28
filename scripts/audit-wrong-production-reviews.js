#!/usr/bin/env node
/**
 * Sprint 2: Wrong Production Review Detection
 *
 * Detects reviews that may have been extracted from wrong production archives
 * (e.g., a 2024 revival review file containing content from the 2002 original).
 *
 * Tasks implemented:
 * - Task 2.1: Wrong-production detector base
 * - Task 2.2: Our Town 2024 detection
 * - Task 2.3: Suffs 2024 detection
 * - Task 2.4: Tommy 2024 detection
 * - Task 2.5a-d: Generic revival identification and audit
 * - Task 2.5.5: Handle shows without historical data
 * - Task 2.6: Generate wrong-production report
 * - Task 2.7: Sprint 2 validation
 *
 * Output: data/audit/wrong-production-reviews.json
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'audit', 'wrong-production-reviews.json');

// ============================================================================
// Task 2.2-2.4: Known wrong-production indicators for specific shows
// ============================================================================

/**
 * Manual configuration for shows with KNOWN wrong-production risk.
 * Each entry specifies:
 * - expectedIndicators: Terms that SHOULD appear (current production)
 * - wrongIndicators: Terms that indicate WRONG production
 * - minWrongIndicators: Minimum wrong indicators needed to flag (default 2)
 */
const KNOWN_WRONG_INDICATORS = {
  // Task 2.2: Our Town 2024
  'our-town-2024': {
    expectedIndicators: ['2024', 'Barrymore Theatre', 'Jim Parsons', 'Zoey Deutch', 'Kenny Leon', 'Katie Holmes'],
    wrongIndicators: ['2002', 'Booth Theatre', 'Paul Newman', '2003', '1988', 'Spalding Gray', 'Lincoln Center'],
    minWrongIndicators: 1  // Our Town is distinctive enough
  },

  // Task 2.3: Suffs 2024
  'suffs-2024': {
    expectedIndicators: ['2024', 'Music Box Theatre', 'Broadway', 'Shaina Taub', 'Nikki M. James', 'Jenn Colella'],
    wrongIndicators: ['2022', 'Public Theater', 'off-Broadway', 'Off-Broadway', 'off Broadway', 'downtown'],
    minWrongIndicators: 2  // Need 2 indicators since "Public Theater" could be mentioned in context
  },

  // Task 2.4: Tommy 2024 (The Who's Tommy)
  'the-whos-tommy-2024': {
    expectedIndicators: ['2024', 'Nederlander Theatre', 'Ali Louis Bourzgui', 'Adam Jacobs', 'Alison Luff'],
    wrongIndicators: ['2019', 'Kennedy Center', 'Casey Cott', '1993', 'St. James Theatre', 'Michael Cerveris', 'Marcia Mitzman'],
    minWrongIndicators: 2
  },

  // Cabaret 2024 (for validation)
  'cabaret-2024': {
    expectedIndicators: ['2024', 'August Wilson Theatre', 'Eddie Redmayne', 'Gayle Rankin', 'Kit Kat Club', 'Rebecca Frecknall'],
    wrongIndicators: ['1998', 'Studio 54', 'Alan Cumming', 'Natasha Richardson', 'Sam Mendes', 'Roundabout', '1966', 'Jill Haworth'],
    minWrongIndicators: 2
  },

  // Additional revivals with known prior productions
  'merrily-we-roll-along-2023': {
    expectedIndicators: ['2023', 'Hudson Theatre', 'Jonathan Groff', 'Daniel Radcliffe', 'Lindsay Mendez', 'Maria Friedman'],
    wrongIndicators: ['1981', 'Alvin Theatre', 'Jim Walton', 'Lonny Price', 'Ann Morrison', 'Off-Broadway', 'York Theatre'],
    minWrongIndicators: 2
  },

  'doubt-2024': {
    expectedIndicators: ['2024', 'Todd Haimes Theatre', 'Amy Ryan', 'Liev Schreiber', 'Zoe Kazan'],
    wrongIndicators: ['2005', 'Walter Kerr Theatre', 'Cherry Jones', 'Brian F. O\'Byrne', 'Heather Goldenhersh'],
    minWrongIndicators: 2
  },

  'an-enemy-of-the-people-2024': {
    expectedIndicators: ['2024', 'Circle in the Square', 'Jeremy Strong', 'Sam Gold', 'Michael Imperioli'],
    wrongIndicators: ['1971', 'Vivian Beaumont', 'Stephen Elliott', 'Impossible Dreams', 'Off-Broadway'],
    minWrongIndicators: 2
  },

  'appropriate-2023': {
    expectedIndicators: ['2023', '2024', 'Hayes Theater', 'Sarah Paulson', 'Corey Stoll', 'Lila Neugebauer'],
    wrongIndicators: ['2014', 'Signature Theatre', 'Mark Barton', 'Off-Broadway'],
    minWrongIndicators: 2
  },

  'the-wiz-2024': {
    expectedIndicators: ['2024', 'Marquis Theatre', 'Wayne Brady', 'Deborah Cox', 'Amber Ruffin'],
    wrongIndicators: ['1975', 'Majestic Theatre', 'Stephanie Mills', 'Andre De Shields', 'Geoffrey Holder'],
    minWrongIndicators: 2
  },

  'purlie-victorious-2023': {
    expectedIndicators: ['2023', 'Music Box Theatre', 'Leslie Odom Jr.', 'Kara Young', 'Heather Headley'],
    wrongIndicators: ['1961', 'Cort Theatre', 'Ossie Davis', 'Ruby Dee', 'Godfrey Cambridge'],
    minWrongIndicators: 2
  }
};

// ============================================================================
// Task 2.5a: Revival Identification Function
// ============================================================================

/**
 * Identify shows with -YYYY suffix that may have earlier productions.
 * @returns {string[]} Array of revival show IDs
 */
function identifyRevivals(shows) {
  const revivals = [];
  const yearSuffixPattern = /-\d{4}$/;

  for (const show of shows) {
    if (yearSuffixPattern.test(show.id)) {
      // Check if it's marked as a revival or is a well-known revival title
      const isMarkedRevival = show.type === 'revival' ||
                              (show.tags && show.tags.includes('revival'));

      // Even if not explicitly marked, year-suffixed shows with known prior productions
      const hasKnownIndicators = KNOWN_WRONG_INDICATORS[show.id] !== undefined;

      // Classic plays/musicals that have had multiple productions
      const classicTitles = [
        'our town', 'cabaret', 'chicago', 'the wiz', 'tommy', 'doubt',
        'enemy of the people', 'uncle vanya', 'long day\'s journey',
        'death of a salesman', 'gypsy', 'carousel', 'oklahoma',
        'sweeney todd', 'west side story', 'hello dolly', 'the music man',
        'fiddler on the roof', 'merrily we roll along', 'company', 'follies',
        'ragtime', 'chess', 'mamma mia', 'purlie', 'appropriate'
      ];

      const titleLower = show.title.toLowerCase();
      const isClassic = classicTitles.some(classic => titleLower.includes(classic));

      if (isMarkedRevival || hasKnownIndicators || isClassic) {
        revivals.push(show.id);
      }
    }
  }

  return revivals;
}

// ============================================================================
// Task 2.5b: Extract Expected Metadata for Revivals
// ============================================================================

/**
 * Extract expected metadata for revival shows from shows.json
 * @returns {Map<string, {year: string, venue: string, cast: string[]}>}
 */
function extractRevivalMetadata(shows) {
  const metadata = new Map();

  for (const show of shows) {
    if (show.id.match(/-\d{4}$/)) {
      const year = show.id.match(/-(\d{4})$/)[1];
      const cast = (show.cast || []).map(c => c.name).filter(Boolean);
      const creative = (show.creativeTeam || []).map(c => c.name).filter(Boolean);

      metadata.set(show.id, {
        year,
        venue: show.venue || null,
        cast: [...cast, ...creative],
        openingDate: show.openingDate,
        title: show.title
      });
    }
  }

  return metadata;
}

// ============================================================================
// Task 2.5c: Build Wrong-Production Indicators
// ============================================================================

/**
 * For revivals without manually specified indicators, build generic ones
 */
function buildGenericIndicators(showId, metadata) {
  if (KNOWN_WRONG_INDICATORS[showId]) {
    return KNOWN_WRONG_INDICATORS[showId];
  }

  const info = metadata.get(showId);
  if (!info) return null;

  // Build expected indicators from metadata
  const expectedIndicators = [info.year];
  if (info.venue) expectedIndicators.push(info.venue);
  expectedIndicators.push(...info.cast.slice(0, 5)); // Top 5 cast members

  // Generic wrong indicators - we can't know specific past productions
  // without manual research, so use general patterns
  const wrongIndicators = [];

  // Previous common years for Broadway revivals
  const currentYear = parseInt(info.year);
  const previousDecades = [
    currentYear - 30, currentYear - 40, currentYear - 50
  ].filter(y => y >= 1950);

  // Don't flag these years - too generic
  // wrongIndicators.push(...previousDecades.map(y => y.toString()));

  return {
    expectedIndicators,
    wrongIndicators,
    minWrongIndicators: 2,
    isGeneric: true // Flag that this is auto-generated, not manually verified
  };
}

// ============================================================================
// Task 2.5.5: Handle Shows Without Historical Data
// ============================================================================

/**
 * Determine if a show should skip wrong-production checks
 * @returns {{skip: boolean, reason: string}}
 */
function shouldSkipShow(showId, shows, reviewCount) {
  const show = shows.find(s => s.id === showId);
  if (!show) return { skip: true, reason: 'Show not found in shows.json' };

  // Skip if less than 5 reviews (insufficient data)
  if (reviewCount < 5) {
    return { skip: true, reason: 'Insufficient reviews (<5)' };
  }

  // Skip if opened less than 30 days ago
  if (show.openingDate) {
    const openingDate = new Date(show.openingDate);
    const daysSinceOpening = (Date.now() - openingDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceOpening < 30) {
      return { skip: true, reason: 'Show opened <30 days ago' };
    }
  }

  return { skip: false, reason: null };
}

// ============================================================================
// False Positive Mitigation
// ============================================================================

/**
 * Check if a wrong indicator match should be ignored based on context
 * @param {string} text - Full text to check
 * @param {string} indicator - The indicator that was matched
 * @param {number} matchIndex - Position of the match in text
 * @returns {boolean} True if this match should be ignored
 */
function shouldIgnoreMatch(text, indicator, matchIndex) {
  const contextRadius = 150; // Characters before/after to check (increased for better context)
  const start = Math.max(0, matchIndex - contextRadius);
  const end = Math.min(text.length, matchIndex + indicator.length + contextRadius);
  const context = text.slice(start, end).toLowerCase();

  // Ignore venue mentions near transfer/move language
  const transferPatterns = [
    'moving to', 'transferring to', 'transferred to', 'moves to',
    'relocated to', 'before moving', 'after transferring',
    'transfer from', 'moved from', 'originally at', 'premiered at',
    'debuted at', 'opened at', 'prior to', 'previous production'
  ];

  for (const pattern of transferPatterns) {
    if (context.includes(pattern)) {
      return true;
    }
  }

  // Ignore historical references discussing the show's history
  // These are legitimate comparisons to previous productions
  const historicalPatterns = [
    'originally', 'first production', 'premiere', 'debut',
    'in the original', 'the original production', 'when it first',
    'back in', 'years ago', 'previous revival', 'last revival',
    // Comparison patterns - critic comparing to past productions
    'originally played by', 'first played by', 'was played by',
    'in the original cast', 'the original cast', 'created the role',
    // Year-in-context patterns - "the 1961 reviews", "the 1998 revival"
    'the 19', 'that 19', 'a 19', // catches "the 1961 reviews said", "the 1998 revival"
    // Revival comparison patterns
    'revival led by', 'revival starred', 'revival starring',
    'production starred', 'production starring', 'production directed by',
    // Historical discussion patterns
    'over the years', 'has become', 'has been', 'history of',
    'remounted', 'revived in', 'was revived', 'returned to broadway',
    // Film/adaptation comparisons
    'film adaptation', 'movie version', 'film version',
    // Award/legacy mentions
    'won the tony', 'tony award', 'won a tony'
  ];

  for (const pattern of historicalPatterns) {
    if (context.includes(pattern)) {
      return true;
    }
  }

  // Check if indicator is in a "X in YEAR" comparison pattern
  // e.g., "Alan Cumming in 1998" - this is comparison, not wrong production
  if (/\b(in|from|during|of|the)\s+\d{4}\b/.test(context)) {
    // Likely historical comparison context
    return true;
  }

  // Check for "previously portrayed by" pattern
  if (/previously\s+(portrayed|played|performed)\s+by/i.test(context)) {
    return true;
  }

  // Check for "role previously portrayed by X, Y, Z" pattern with commas
  if (/role.{0,30}(by|include|including).{0,100}(fonda|newman|grey|wilder|davis|dee|cumming)/i.test(context)) {
    return true;
  }

  return false;
}

// ============================================================================
// Core Detection Logic
// ============================================================================

/**
 * Check if publish date or URL suggests wrong production
 * This is a HIGH CONFIDENCE signal - but needs to account for preview reviews
 * @param {Object} reviewData - Review data object
 * @param {string} expectedYear - Expected year from show ID
 * @param {Object} showData - Show metadata (optional, for preview date checking)
 */
function checkDateMismatch(reviewData, expectedYear, showData = null) {
  const issues = [];
  const expected = parseInt(expectedYear);

  // If show has opening date, calculate valid review period
  // Reviews can legitimately appear 3-4 months before opening (during previews)
  let earliestValidYear = expected - 1; // Default: allow previous year
  if (showData && showData.openingDate) {
    const openingDate = new Date(showData.openingDate);
    // Allow reviews starting 6 months before opening
    const earliestValid = new Date(openingDate);
    earliestValid.setMonth(earliestValid.getMonth() - 6);
    earliestValidYear = earliestValid.getFullYear();
  }

  // Check URL for wrong year
  if (reviewData.url) {
    const urlYearMatch = reviewData.url.match(/\/(\d{4})\//);
    if (urlYearMatch) {
      const urlYear = parseInt(urlYearMatch[1]);
      // Only flag if the year is SIGNIFICANTLY earlier (not just previous year for previews)
      if (urlYear < earliestValidYear && urlYear >= 2000) {
        issues.push({
          type: 'url_year_mismatch',
          found: urlYear,
          expected: expected,
          message: `URL contains year ${urlYear}, expected ${expectedYear} (or ${expectedYear-1} for previews)`
        });
      }
    }
  }

  // Check publishDate for wrong year
  if (reviewData.publishDate) {
    const dateYearMatch = reviewData.publishDate.match(/\b(20\d{2})\b/);
    if (dateYearMatch) {
      const dateYear = parseInt(dateYearMatch[1]);
      // Only flag if year is SIGNIFICANTLY earlier
      if (dateYear < earliestValidYear) {
        issues.push({
          type: 'publish_date_mismatch',
          found: dateYear,
          expected: expected,
          message: `Publish date shows year ${dateYear}, expected ${expectedYear} (or ${expectedYear-1} for previews)`
        });
      }
    }
  }

  return issues;
}

/**
 * Scan a review file for wrong-production indicators
 * @returns {Object|null} Detection result or null if clean
 */
function detectWrongProduction(reviewData, indicators, expectedYear, showData = null) {
  // First check for date/URL mismatches (HIGH CONFIDENCE)
  const dateMismatches = expectedYear ? checkDateMismatch(reviewData, expectedYear, showData) : [];

  if (!indicators || indicators.wrongIndicators.length === 0) {
    // Even without text indicators, date mismatches are significant
    if (dateMismatches.length > 0) {
      return {
        wrongIndicatorsFound: dateMismatches.map(d => ({ indicator: d.message, type: d.type })),
        expectedIndicatorsFound: [],
        confidence: 'high', // Date mismatches are HIGH confidence
        isDateMismatch: true
      };
    }
    return null;
  }

  // Collect all text content to search
  const textFields = [
    reviewData.fullText,
    reviewData.dtliExcerpt,
    reviewData.bwwExcerpt,
    reviewData.showScoreExcerpt
  ].filter(Boolean);

  if (textFields.length === 0) {
    // No text content but we have date mismatches
    if (dateMismatches.length > 0) {
      return {
        wrongIndicatorsFound: dateMismatches.map(d => ({ indicator: d.message, type: d.type })),
        expectedIndicatorsFound: [],
        confidence: 'high',
        isDateMismatch: true
      };
    }
    return null;
  }

  const combinedText = textFields.join(' ');
  const foundWrongIndicators = [];
  const foundExpectedIndicators = [];

  // Check for wrong indicators
  for (const wrongInd of indicators.wrongIndicators) {
    const regex = new RegExp(wrongInd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    let match;
    while ((match = regex.exec(combinedText)) !== null) {
      // Check if this match should be ignored due to context
      if (!shouldIgnoreMatch(combinedText, wrongInd, match.index)) {
        foundWrongIndicators.push({
          indicator: wrongInd,
          position: match.index,
          context: combinedText.slice(
            Math.max(0, match.index - 50),
            Math.min(combinedText.length, match.index + wrongInd.length + 50)
          )
        });
        break; // One match per indicator is enough
      }
    }
  }

  // Check for expected indicators (for confidence scoring)
  for (const expectedInd of indicators.expectedIndicators) {
    const regex = new RegExp(expectedInd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    if (regex.test(combinedText)) {
      foundExpectedIndicators.push(expectedInd);
    }
  }

  // Calculate confidence
  const wrongCount = foundWrongIndicators.length;
  const expectedCount = foundExpectedIndicators.length;
  const minRequired = indicators.minWrongIndicators || 2;
  const hasDateMismatch = dateMismatches.length > 0;

  // Need at least minWrongIndicators to flag (unless we have date mismatch)
  if (wrongCount < minRequired && !hasDateMismatch) {
    return null;
  }

  // Determine confidence level
  let confidence;
  if (hasDateMismatch) {
    // Date/URL mismatches are HIGH confidence
    confidence = 'high';
  } else if (wrongCount >= 3 && expectedCount === 0) {
    confidence = 'high';
  } else if (wrongCount >= 2) {
    confidence = expectedCount > 0 ? 'medium' : 'high';
  } else {
    confidence = 'low';
  }

  // Combine all found indicators
  const allWrongIndicators = [
    ...foundWrongIndicators,
    ...dateMismatches.map(d => ({ indicator: d.message, type: d.type }))
  ];

  return {
    wrongIndicatorsFound: allWrongIndicators,
    expectedIndicatorsFound: foundExpectedIndicators,
    confidence,
    isGenericIndicators: indicators.isGeneric || false,
    isDateMismatch: hasDateMismatch
  };
}

// ============================================================================
// Main Audit Function
// ============================================================================

function runWrongProductionAudit() {
  console.log('=== Sprint 2: Wrong Production Review Detection ===\n');

  // Load shows data
  let shows;
  try {
    const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    shows = showsData.shows || showsData; // Handle both wrapped and unwrapped formats
  } catch (e) {
    console.error('ERROR: Cannot load shows.json:', e.message);
    process.exit(1);
  }

  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      shows_checked: 0,
      shows_with_indicators: 0,
      files_scanned: 0,
      files_flagged: 0,
      baseline_pending: 0,
      false_positive_mitigated: 0
    },
    flagged: [],
    baseline_pending: [],
    shows_audited: []
  };

  // Task 2.5a: Identify revivals
  const revivals = identifyRevivals(shows);
  console.log(`Found ${revivals.length} potential revivals with year suffixes\n`);

  // Task 2.5b: Extract metadata
  const revivalMetadata = extractRevivalMetadata(shows);

  // Get all show directories
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(f => {
      const fullPath = path.join(REVIEW_TEXTS_DIR, f);
      return fs.statSync(fullPath).isDirectory();
    });

  for (const showId of showDirs) {
    const showPath = path.join(REVIEW_TEXTS_DIR, showId);
    const files = fs.readdirSync(showPath)
      .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    const reviewCount = files.length;

    // Task 2.5.5: Check if show should be skipped
    const skipResult = shouldSkipShow(showId, shows, reviewCount);
    if (skipResult.skip) {
      report.baseline_pending.push({
        showId,
        reason: skipResult.reason,
        reviewCount
      });
      report.summary.baseline_pending++;
      continue;
    }

    report.summary.shows_checked++;

    // Get indicators for this show
    let indicators = KNOWN_WRONG_INDICATORS[showId];

    if (!indicators && revivals.includes(showId)) {
      // Task 2.5c: Build generic indicators
      indicators = buildGenericIndicators(showId, revivalMetadata);
    }

    if (indicators && indicators.wrongIndicators.length > 0) {
      report.summary.shows_with_indicators++;
    }

    // Record what we're auditing
    report.shows_audited.push({
      showId,
      reviewCount,
      hasManualIndicators: KNOWN_WRONG_INDICATORS[showId] !== undefined,
      hasGenericIndicators: indicators && indicators.isGeneric === true,
      isIdentifiedRevival: revivals.includes(showId)
    });

    // Get expected year from show ID and show data
    const yearMatch = showId.match(/-(\d{4})$/);
    const expectedYear = yearMatch ? yearMatch[1] : null;
    const showData = shows.find(s => s.id === showId);

    // Task 2.5d: Run audit on each review file
    for (const file of files) {
      const filePath = path.join(showPath, file);
      report.summary.files_scanned++;

      let reviewData;
      try {
        reviewData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        // Skip invalid JSON (handled by file-integrity audit)
        continue;
      }

      // Run detection
      const detection = detectWrongProduction(reviewData, indicators, expectedYear, showData);

      if (detection) {
        report.summary.files_flagged++;

        // Classify the flag:
        // - "likely_wrong_production" if date mismatch OR no expected indicators found
        // - "comparison_mentions" if has expected indicators (review is correct but mentions history)
        let classification;
        if (detection.isDateMismatch) {
          classification = 'likely_wrong_production';
        } else if (detection.expectedIndicatorsFound.length >= 2) {
          classification = 'comparison_mentions';
        } else if (detection.expectedIndicatorsFound.length === 0) {
          classification = 'likely_wrong_production';
        } else {
          classification = 'needs_review';
        }

        report.flagged.push({
          showId,
          file,
          outlet: reviewData.outlet || reviewData.outletId,
          critic: reviewData.criticName,
          url: reviewData.url,
          publishDate: reviewData.publishDate,
          indicators_found: detection.wrongIndicatorsFound.map(w => w.indicator),
          expected_found: detection.expectedIndicatorsFound,
          confidence: detection.confidence,
          classification,
          isGenericIndicators: detection.isGenericIndicators || false,
          isDateMismatch: detection.isDateMismatch || false,
          contexts: detection.wrongIndicatorsFound.filter(w => w.context).map(w => w.context)
        });
      }
    }
  }

  // Sort flagged by classification (likely_wrong_production first), then confidence
  const classificationOrder = { likely_wrong_production: 0, needs_review: 1, comparison_mentions: 2 };
  const confidenceOrder = { high: 0, medium: 1, low: 2 };
  report.flagged.sort((a, b) => {
    const classSort = (classificationOrder[a.classification] || 3) - (classificationOrder[b.classification] || 3);
    if (classSort !== 0) return classSort;
    return (confidenceOrder[a.confidence] || 3) - (confidenceOrder[b.confidence] || 3);
  });

  // Add classification summary
  report.summary.likely_wrong_production = report.flagged.filter(f => f.classification === 'likely_wrong_production').length;
  report.summary.comparison_mentions = report.flagged.filter(f => f.classification === 'comparison_mentions').length;
  report.summary.needs_review = report.flagged.filter(f => f.classification === 'needs_review').length;

  // Print summary
  console.log('Summary:');
  console.log(`  Shows checked: ${report.summary.shows_checked}`);
  console.log(`  Shows with wrong-production indicators: ${report.summary.shows_with_indicators}`);
  console.log(`  Files scanned: ${report.summary.files_scanned}`);
  console.log(`  Files flagged: ${report.summary.files_flagged}`);
  console.log(`    - Likely wrong production: ${report.summary.likely_wrong_production}`);
  console.log(`    - Comparison mentions (false positives): ${report.summary.comparison_mentions}`);
  console.log(`    - Needs manual review: ${report.summary.needs_review}`);
  console.log(`  Shows in baseline pending: ${report.summary.baseline_pending}`);

  if (report.flagged.length > 0) {
    console.log('\nFlagged reviews:');
    for (const flag of report.flagged.slice(0, 20)) {
      console.log(`  [${flag.confidence.toUpperCase()}] ${flag.showId}/${flag.file}`);
      console.log(`    Indicators found: ${flag.indicators_found.join(', ')}`);
    }
    if (report.flagged.length > 20) {
      console.log(`  ... and ${report.flagged.length - 20} more`);
    }
  }

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write report
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nReport saved to: ${OUTPUT_PATH}`);

  return report;
}

// ============================================================================
// Task 2.7: Validation Tests
// ============================================================================

function runValidationTests() {
  console.log('\n=== Sprint 2 Validation Tests ===\n');

  const tests = [];

  // Test 1: Hamilton 2015 should have ZERO flags (no prior Broadway production)
  const hamiltonIndicators = KNOWN_WRONG_INDICATORS['hamilton-2015'];
  tests.push({
    name: 'Hamilton 2015 - No manual indicators defined',
    passed: hamiltonIndicators === undefined,
    expected: 'No wrong indicators',
    actual: hamiltonIndicators ? 'Has indicators' : 'No indicators'
  });

  // Test 2: Our Town 2024 should have "Booth Theatre" in wrong indicators
  const ourTownIndicators = KNOWN_WRONG_INDICATORS['our-town-2024'];
  tests.push({
    name: 'Our Town 2024 - Has Booth Theatre wrong indicator',
    passed: ourTownIndicators && ourTownIndicators.wrongIndicators.includes('Booth Theatre'),
    expected: 'Booth Theatre in wrongIndicators',
    actual: ourTownIndicators ? ourTownIndicators.wrongIndicators.join(', ') : 'No indicators'
  });

  // Test 3: Cabaret 2024 should have "Studio 54" in wrong indicators
  const cabaretIndicators = KNOWN_WRONG_INDICATORS['cabaret-2024'];
  tests.push({
    name: 'Cabaret 2024 - Has Studio 54 wrong indicator',
    passed: cabaretIndicators && cabaretIndicators.wrongIndicators.includes('Studio 54'),
    expected: 'Studio 54 in wrongIndicators',
    actual: cabaretIndicators ? cabaretIndicators.wrongIndicators.join(', ') : 'No indicators'
  });

  // Test 4: Tommy 2024 should have "Kennedy Center" in wrong indicators
  const tommyIndicators = KNOWN_WRONG_INDICATORS['the-whos-tommy-2024'];
  tests.push({
    name: 'Tommy 2024 - Has Kennedy Center wrong indicator',
    passed: tommyIndicators && tommyIndicators.wrongIndicators.includes('Kennedy Center'),
    expected: 'Kennedy Center in wrongIndicators',
    actual: tommyIndicators ? tommyIndicators.wrongIndicators.join(', ') : 'No indicators'
  });

  // Test 5: Suffs 2024 should have "Public Theater" in wrong indicators
  const suffsIndicators = KNOWN_WRONG_INDICATORS['suffs-2024'];
  tests.push({
    name: 'Suffs 2024 - Has Public Theater wrong indicator',
    passed: suffsIndicators && suffsIndicators.wrongIndicators.includes('Public Theater'),
    expected: 'Public Theater in wrongIndicators',
    actual: suffsIndicators ? suffsIndicators.wrongIndicators.join(', ') : 'No indicators'
  });

  // Test 6: False positive mitigation - "transferred to" context
  const testText = 'The show transferred to Broadway from the Public Theater.';
  const ignored = shouldIgnoreMatch(testText, 'Public Theater', testText.indexOf('Public Theater'));
  tests.push({
    name: 'False positive mitigation - Transfer context ignored',
    passed: ignored === true,
    expected: 'Match should be ignored',
    actual: ignored ? 'Ignored' : 'Not ignored'
  });

  // Print results
  let passCount = 0;
  for (const test of tests) {
    const status = test.passed ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${test.name}`);
    if (!test.passed) {
      console.log(`       Expected: ${test.expected}`);
      console.log(`       Actual: ${test.actual}`);
    }
    if (test.passed) passCount++;
  }

  console.log(`\nValidation: ${passCount}/${tests.length} tests passed`);

  return passCount === tests.length;
}

// ============================================================================
// Main Entry Point
// ============================================================================

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--validate-only')) {
    // Run validation tests only
    const success = runValidationTests();
    process.exit(success ? 0 : 1);
  }

  // Run full audit
  const report = runWrongProductionAudit();

  if (args.includes('--validate')) {
    // Also run validation tests
    const validationPassed = runValidationTests();
    if (!validationPassed) {
      console.log('\nWARNING: Some validation tests failed');
    }
  }

  // Calculate false positive rate estimate
  // A "false positive" would be flagging a review that actually IS for the correct production
  // We can't fully automate this, but we can estimate based on confidence levels
  const highConfidence = report.flagged.filter(f => f.confidence === 'high').length;
  const mediumConfidence = report.flagged.filter(f => f.confidence === 'medium').length;
  const lowConfidence = report.flagged.filter(f => f.confidence === 'low').length;

  console.log(`\nConfidence breakdown:`);
  console.log(`  High: ${highConfidence}`);
  console.log(`  Medium: ${mediumConfidence}`);
  console.log(`  Low: ${lowConfidence}`);

  // Exit code based on findings
  // We don't fail just because we found issues - this is an audit
  process.exit(0);
}

module.exports = {
  runWrongProductionAudit,
  runValidationTests,
  identifyRevivals,
  extractRevivalMetadata,
  detectWrongProduction,
  shouldIgnoreMatch,
  KNOWN_WRONG_INDICATORS
};
