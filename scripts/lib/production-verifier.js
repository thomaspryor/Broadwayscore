/**
 * Production Verifier Module
 *
 * Verifies that a review is for the correct production before saving.
 * Prevents off-Broadway, touring, West End, or wrong revival reviews
 * from being added to Broadway show folders.
 *
 * Used by:
 * - gather-reviews.js (pre-save hook)
 * - collect-review-texts.js (validation)
 */

const fs = require('fs');
const path = require('path');

// Known wrong-production indicators from audit-wrong-production-reviews.js
const KNOWN_WRONG_INDICATORS = {
  'our-town-2024': {
    expectedIndicators: ['2024', 'Barrymore Theatre', 'Jim Parsons', 'Zoey Deutch', 'Kenny Leon', 'Katie Holmes'],
    wrongIndicators: ['2002', 'Booth Theatre', 'Paul Newman', '2003', '1988', 'Spalding Gray', 'Lincoln Center'],
    minWrongIndicators: 1
  },
  'suffs-2024': {
    expectedIndicators: ['2024', 'Music Box Theatre', 'Broadway', 'Shaina Taub', 'Nikki M. James', 'Jenn Colella'],
    wrongIndicators: ['2022', 'Public Theater', 'off-Broadway', 'Off-Broadway', 'off Broadway', 'downtown'],
    minWrongIndicators: 2
  },
  'the-whos-tommy-2024': {
    expectedIndicators: ['2024', 'Nederlander Theatre', 'Ali Louis Bourzgui', 'Adam Jacobs', 'Alison Luff'],
    wrongIndicators: ['2019', 'Kennedy Center', 'Casey Cott', '1993', 'St. James Theatre', 'Michael Cerveris'],
    minWrongIndicators: 2
  },
  'cabaret-2024': {
    expectedIndicators: ['2024', 'August Wilson Theatre', 'Eddie Redmayne', 'Gayle Rankin', 'Kit Kat Club', 'Rebecca Frecknall'],
    wrongIndicators: ['1998', 'Studio 54', 'Alan Cumming', 'Natasha Richardson', 'Sam Mendes', 'Roundabout', '1966'],
    minWrongIndicators: 2
  },
  'merrily-we-roll-along-2023': {
    expectedIndicators: ['2023', 'Hudson Theatre', 'Jonathan Groff', 'Daniel Radcliffe', 'Lindsay Mendez', 'Maria Friedman'],
    wrongIndicators: ['1981', 'Alvin Theatre', 'Jim Walton', 'Lonny Price', 'Ann Morrison', 'Off-Broadway', 'York Theatre'],
    minWrongIndicators: 2
  },
  'hadestown-2019': {
    expectedIndicators: ['2019', 'Walter Kerr Theatre', 'Broadway', 'Reeve Carney', 'Eva Noblezada', 'Patrick Page'],
    wrongIndicators: ['2016', 'New York Theatre Workshop', 'NYTW', 'off-Broadway', 'Off-Broadway', 'Citadel Theatre', '2017'],
    minWrongIndicators: 1
  },
  'an-enemy-of-the-people-2024': {
    expectedIndicators: ['2024', 'Circle in the Square', 'Jeremy Strong', 'Sam Gold', 'Michael Imperioli'],
    wrongIndicators: ['2012', 'Samuel J. Friedman', 'Boyd Gaines', 'Richard Thomas'],
    minWrongIndicators: 1
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
  },
  'doubt-2024': {
    expectedIndicators: ['2024', 'Todd Haimes Theatre', 'Amy Ryan', 'Liev Schreiber', 'Zoe Kazan'],
    wrongIndicators: ['2005', 'Walter Kerr Theatre', 'Cherry Jones', 'Brian F. O\'Byrne'],
    minWrongIndicators: 2
  },
  'appropriate-2023': {
    expectedIndicators: ['2023', '2024', 'Hayes Theater', 'Sarah Paulson', 'Corey Stoll', 'Lila Neugebauer'],
    wrongIndicators: ['2014', 'Signature Theatre', 'Off-Broadway'],
    minWrongIndicators: 2
  }
};

// West End venues (for detecting UK reviews)
const WEST_END_VENUES = [
  'Phoenix Theatre', 'Piccadilly Theatre', 'Prince Edward Theatre',
  'Prince of Wales Theatre', 'Dominion Theatre', 'Adelphi Theatre',
  'Gielgud Theatre', 'Savoy Theatre', 'Lyceum Theatre London',
  'London Palladium', 'Theatre Royal Drury Lane', 'Apollo Theatre',
  'Wyndham\'s Theatre', 'National Theatre', 'Old Vic', 'Young Vic',
  'Barbican', 'Donmar Warehouse', 'Hampstead Theatre', 'Almeida Theatre'
];

// UK publication indicators
const UK_PUBLICATIONS = [
  'guardian', 'telegraph', 'independent.co.uk', 'standard.co.uk',
  'timeout.com/london', 'whatsonstage', 'thestage.co.uk', 'observer'
];

/**
 * Verify a review is for the correct production
 * @param {Object} params
 * @param {string} params.showId - Show ID (e.g., "hadestown-2019")
 * @param {string} params.url - Review URL
 * @param {string} params.publishDate - Publish date string
 * @param {string} params.text - Review text content (fullText or excerpt)
 * @param {Object} params.showData - Show metadata from shows.json (optional)
 * @returns {Object} { isValid, issues, confidence, shouldReject }
 */
function verifyProduction({ showId, url, publishDate, text, showData }) {
  const issues = [];
  let confidence = 'low';

  // Extract expected year from show ID
  const yearMatch = showId.match(/-(\d{4})$/);
  const expectedYear = yearMatch ? parseInt(yearMatch[1]) : null;

  // Get show-specific indicators
  const indicators = KNOWN_WRONG_INDICATORS[showId];

  // 1. Check URL for wrong year
  if (url && expectedYear) {
    const urlYearMatch = url.match(/\/(\d{4})\//);
    if (urlYearMatch) {
      const urlYear = parseInt(urlYearMatch[1]);
      // Allow 1 year before expected (for previews)
      if (urlYear < expectedYear - 1 && urlYear >= 2000) {
        issues.push({
          type: 'url_year_mismatch',
          message: `URL year ${urlYear} doesn't match expected ${expectedYear}`,
          severity: 'high'
        });
        confidence = 'high';
      }
    }
  }

  // 2. Check publish date for wrong year
  if (publishDate && expectedYear) {
    const dateYearMatch = publishDate.match(/\b(20\d{2})\b/);
    if (dateYearMatch) {
      const dateYear = parseInt(dateYearMatch[1]);
      // Allow 1 year before expected (for previews)
      if (dateYear < expectedYear - 1) {
        issues.push({
          type: 'publish_date_mismatch',
          message: `Publish date year ${dateYear} doesn't match expected ${expectedYear}`,
          severity: 'high'
        });
        confidence = 'high';
      }
    }
  }

  // 3. Check for West End indicators (wrong geographic production)
  if (url) {
    const urlLower = url.toLowerCase();
    for (const ukPub of UK_PUBLICATIONS) {
      if (urlLower.includes(ukPub)) {
        // UK publication - check if show has had UK production
        issues.push({
          type: 'uk_publication',
          message: `URL appears to be from UK publication (${ukPub})`,
          severity: 'medium'
        });
        if (confidence === 'low') confidence = 'medium';
      }
    }
  }

  // 4. Check text for wrong production indicators
  if (text && indicators) {
    const textLower = text.toLowerCase();
    let wrongFound = 0;
    let expectedFound = 0;
    const wrongMatches = [];

    for (const wrong of indicators.wrongIndicators) {
      if (textLower.includes(wrong.toLowerCase())) {
        // Check context to avoid false positives
        const idx = textLower.indexOf(wrong.toLowerCase());
        const context = text.slice(Math.max(0, idx - 100), Math.min(text.length, idx + wrong.length + 100));

        // Skip if in comparison context
        const comparisonPatterns = [
          'originally', 'first production', 'premiere', 'debut',
          'in the original', 'previous revival', 'last revival',
          'transferred to', 'moving to', 'prior to'
        ];

        const isComparison = comparisonPatterns.some(p => context.toLowerCase().includes(p));
        if (!isComparison) {
          wrongFound++;
          wrongMatches.push(wrong);
        }
      }
    }

    for (const expected of indicators.expectedIndicators) {
      if (textLower.includes(expected.toLowerCase())) {
        expectedFound++;
      }
    }

    // Flag if wrong indicators found without expected indicators
    if (wrongFound >= (indicators.minWrongIndicators || 2)) {
      if (expectedFound === 0) {
        issues.push({
          type: 'wrong_production_text',
          message: `Found wrong production indicators: ${wrongMatches.join(', ')}`,
          severity: 'high'
        });
        confidence = 'high';
      } else {
        issues.push({
          type: 'mixed_production_text',
          message: `Found both wrong (${wrongMatches.join(', ')}) and expected indicators`,
          severity: 'low'
        });
      }
    }
  }

  // 5. Check for West End venues in text
  if (text) {
    const textLower = text.toLowerCase();
    for (const venue of WEST_END_VENUES) {
      if (textLower.includes(venue.toLowerCase())) {
        issues.push({
          type: 'west_end_venue',
          message: `Found West End venue: ${venue}`,
          severity: 'medium'
        });
        if (confidence === 'low') confidence = 'medium';
      }
    }
  }

  // Determine if we should reject
  const highSeverityIssues = issues.filter(i => i.severity === 'high');
  const shouldReject = highSeverityIssues.length > 0;

  return {
    isValid: issues.length === 0,
    issues,
    confidence,
    shouldReject,
    showId,
    expectedYear
  };
}

/**
 * Quick check for date mismatch (fast, no text analysis)
 * @returns {boolean} True if dates look OK
 */
function quickDateCheck(showId, url, publishDate) {
  const yearMatch = showId.match(/-(\d{4})$/);
  if (!yearMatch) return true;

  const expectedYear = parseInt(yearMatch[1]);

  // Check URL year
  if (url) {
    const urlYearMatch = url.match(/\/(\d{4})\//);
    if (urlYearMatch) {
      const urlYear = parseInt(urlYearMatch[1]);
      if (urlYear < expectedYear - 1 && urlYear >= 2000) {
        return false;
      }
    }
  }

  // Check publish date year
  if (publishDate) {
    const dateYearMatch = publishDate.match(/\b(20\d{2})\b/);
    if (dateYearMatch) {
      const dateYear = parseInt(dateYearMatch[1]);
      if (dateYear < expectedYear - 1) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Load shows.json and return show data for a show ID
 */
function getShowData(showId) {
  try {
    const showsPath = path.join(__dirname, '..', '..', 'data', 'shows.json');
    const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    const shows = showsData.shows || showsData;
    return shows.find(s => s.id === showId);
  } catch (e) {
    return null;
  }
}

module.exports = {
  verifyProduction,
  quickDateCheck,
  getShowData,
  KNOWN_WRONG_INDICATORS,
  WEST_END_VENUES,
  UK_PUBLICATIONS
};
