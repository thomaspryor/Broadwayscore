#!/usr/bin/env node
/**
 * SEC EDGAR Form D Scraper for Broadway Shows
 *
 * Searches SEC EDGAR for Form D filings related to Broadway shows
 * to extract capitalization data from LLC offerings.
 *
 * Sprint 2 - Commercial Data Automation Enhancement
 *
 * Usage:
 *   const { searchFormDFilings, parseFormDFiling, isAvailable } = require('./lib/sec-edgar-scraper');
 *
 *   // Check if SEC scraping is enabled
 *   if (isAvailable()) {
 *     const filings = await searchFormDFilings({ showName: 'Hamilton' });
 *     for (const filing of filings) {
 *       const data = await parseFormDFiling(filing.filingUrl);
 *       console.log(data.totalOfferingAmount);
 *     }
 *   }
 *
 * CLI:
 *   node scripts/lib/sec-edgar-scraper.js --search "Hamilton"
 *   node scripts/lib/sec-edgar-scraper.js --cik 0001507647
 *
 * Environment variables:
 *   SEC_EDGAR_ENABLED - Set to 'false' to disable (default: true)
 *
 * Data sources:
 *   - data.sec.gov/submissions API (company filings)
 *   - SEC EDGAR archives (Form D XML files)
 *
 * Rate limiting:
 *   - 1 second delay between requests (SEC fair access policy)
 *   - Exponential backoff on 429/503 errors
 */

const https = require('https');

// ============================================================================
// Feature Flag
// ============================================================================

/**
 * Feature flag to enable/disable SEC EDGAR scraping
 * Allows graceful degradation if SEC becomes unreliable
 */
const SEC_EDGAR_ENABLED = process.env.SEC_EDGAR_ENABLED !== 'false';

// ============================================================================
// Broadway LLC Naming Patterns
// ============================================================================

/**
 * Common naming patterns for Broadway show LLCs in SEC filings
 * Used to search for Form D filings by show name
 *
 * Based on research findings from Sprint 0:
 * - "{Show Name} Broadway, LLC" - Most common (Mean Girls, Beetlejuice)
 * - "{Show Name} Broadway Ltd Liability Co" - Second most common (Book of Mormon, Hadestown)
 * - "{Show Name} Limited Partnership" - Some shows (Broadway Goes Wrong)
 * - "{Show Name} Stage Development, LLC" - Development phase
 * - "{Show Name} Touring LLC" - Tours
 */
const BROADWAY_LLC_PATTERNS = [
  '{show}',                              // Basic name search
  '{show} Broadway',                     // With Broadway suffix
  '{show} LLC',                          // Generic LLC
  '{show} Broadway LLC',                 // Broadway LLC
  '{show} Broadway Ltd Liability Co',    // Full liability company name
  '{show} Musical LLC',                  // Musical variant
  '{show} Theatrical',                   // Theatrical variant
  '{show} Productions',                  // Productions variant
  '{show} Limited Partnership',          // LP variant
  '{show} Touring LLC',                  // Touring company
  '{show} First National Tour LLC',      // First national tour
  '{show} Stage Development LLC',        // Development phase
  '{show} Stage Development, LLC'        // With comma variant
];

// ============================================================================
// Rate Limiting
// ============================================================================

let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 1000; // 1 second between requests

/**
 * Wait for rate limit interval
 */
async function waitForRateLimit() {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
    await new Promise(resolve =>
      setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest)
    );
  }
  lastRequestTime = Date.now();
}

/**
 * Exponential backoff delay
 * @param {number} attempt - Current attempt number (0-based)
 * @returns {number} Delay in milliseconds
 */
function getBackoffDelay(attempt) {
  // Base delay of 2 seconds, doubles each retry: 2s, 4s, 8s
  return Math.min(2000 * Math.pow(2, attempt), 30000);
}

// ============================================================================
// HTTP Utilities
// ============================================================================

/**
 * Make an HTTP GET request with proper headers for SEC API
 * @param {string} url - URL to fetch
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<{statusCode: number, data: string}>}
 */
async function secFetch(url, maxRetries = 3) {
  await waitForRateLimit();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const options = {
          hostname: urlObj.hostname,
          path: urlObj.pathname + urlObj.search,
          method: 'GET',
          headers: {
            'User-Agent': 'BroadwayScorecard Research (contact@broadwayscorecard.com)',
            'Accept': 'application/json, application/xml, text/xml, */*',
            'Accept-Encoding': 'identity'
          }
        };

        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            resolve({ statusCode: res.statusCode, data });
          });
        });

        req.on('error', reject);
        req.setTimeout(30000, () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });
        req.end();
      });

      // Success
      if (result.statusCode === 200) {
        return result;
      }

      // Rate limited or server error - retry with backoff
      if (result.statusCode === 429 || result.statusCode === 503) {
        if (attempt < maxRetries) {
          const delay = getBackoffDelay(attempt);
          console.warn(`SEC API returned ${result.statusCode}, retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }

      // Other errors - return as-is
      return result;
    } catch (error) {
      if (attempt < maxRetries) {
        const delay = getBackoffDelay(attempt);
        console.warn(`SEC API request failed: ${error.message}, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}

// ============================================================================
// XML Parsing (Simple regex-based for Form D structure)
// ============================================================================

/**
 * Extract a single value from XML using regex
 * @param {string} xml - XML content
 * @param {string} tagName - Tag name to extract
 * @returns {string|null} - Tag value or null if not found
 */
function extractXmlValue(xml, tagName) {
  // Handle both <tagName>value</tagName> and <ns:tagName>value</ns:tagName>
  const regex = new RegExp(`<(?:[a-z0-9]+:)?${tagName}>([^<]*)</(?:[a-z0-9]+:)?${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

/**
 * Extract nested value from XML path
 * @param {string} xml - XML content
 * @param {string[]} path - Path of tag names
 * @returns {string|null} - Value or null if not found
 */
function extractXmlPath(xml, path) {
  let current = xml;
  for (let i = 0; i < path.length - 1; i++) {
    const tagName = path[i];
    const regex = new RegExp(`<(?:[a-z0-9]+:)?${tagName}[^>]*>([\\s\\S]*?)</(?:[a-z0-9]+:)?${tagName}>`, 'i');
    const match = current.match(regex);
    if (!match) return null;
    current = match[1];
  }
  return extractXmlValue(current, path[path.length - 1]);
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Check if SEC EDGAR scraping is available
 * @returns {boolean} - True if SEC scraping is enabled
 */
function isAvailable() {
  return SEC_EDGAR_ENABLED;
}

/**
 * Get company filings from SEC data API by CIK
 * @param {string} cik - Company CIK number (with or without leading zeros)
 * @returns {Promise<object|null>} - Company data with filings or null
 */
async function getCompanyFilings(cik) {
  // Normalize CIK to 10 digits with leading zeros
  const normalizedCik = cik.toString().replace(/^0+/, '').padStart(10, '0');
  const url = `https://data.sec.gov/submissions/CIK${normalizedCik}.json`;

  const response = await secFetch(url);
  if (response.statusCode !== 200) {
    return null;
  }

  try {
    return JSON.parse(response.data);
  } catch (e) {
    console.error(`Failed to parse SEC response for CIK ${cik}`);
    return null;
  }
}

/**
 * Search for Form D filings related to a Broadway show
 *
 * Note: SEC's full-text search requires browser automation.
 * This function uses the data.sec.gov API which requires a known CIK.
 * For initial discovery, use the SEC company search UI or known CIK mappings.
 *
 * @param {object} options - Search options
 * @param {string} [options.showName] - Show name to search for
 * @param {string} [options.cik] - Known CIK number to look up directly
 * @param {string[]} [options.patterns] - Custom patterns to use (default: BROADWAY_LLC_PATTERNS)
 * @returns {Promise<Array<{cik: string, companyName: string, filingDate: string, filingUrl: string, form: string}>>}
 */
async function searchFormDFilings(options = {}) {
  if (!isAvailable()) {
    console.warn('SEC EDGAR scraping is disabled');
    return [];
  }

  const { showName, cik, patterns = BROADWAY_LLC_PATTERNS } = options;
  const results = [];

  // If we have a CIK, look it up directly
  if (cik) {
    const companyData = await getCompanyFilings(cik);
    if (companyData && companyData.filings && companyData.filings.recent) {
      const recent = companyData.filings.recent;
      const formDIndices = [];

      // Find all Form D and D/A filings
      for (let i = 0; i < recent.form.length; i++) {
        if (recent.form[i] === 'D' || recent.form[i] === 'D/A') {
          formDIndices.push(i);
        }
      }

      for (const idx of formDIndices) {
        const accessionNumber = recent.accessionNumber[idx].replace(/-/g, '');
        const filingUrl = `https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, '')}/${accessionNumber}/primary_doc.xml`;

        results.push({
          cik: companyData.cik,
          companyName: companyData.name,
          filingDate: recent.filingDate[idx],
          filingUrl,
          form: recent.form[idx],
          isAmendment: recent.form[idx] === 'D/A'
        });
      }
    }
    return results;
  }

  // If we have a show name but no CIK, we need to use the company search
  // The SEC company search requires browser automation (returns HTML)
  // For now, log a message and return empty - users should use known CIK mappings
  if (showName) {
    console.log(`Note: Full-text search for "${showName}" requires browser automation.`);
    console.log('Use the SEC company search UI at https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany');
    console.log('Or provide a known CIK number directly.');

    // Generate search patterns for manual lookup
    const searchPatterns = patterns.map(p => p.replace('{show}', showName));
    console.log(`\nSuggested search patterns:\n${searchPatterns.slice(0, 5).join('\n')}`);
  }

  return results;
}

/**
 * Parse a Form D filing XML to extract capitalization data
 *
 * @param {string} filingUrl - URL to the Form D XML file
 * @returns {Promise<{totalOfferingAmount: number|null, amountSold: number|null, amountRemaining: number|null, filingDate: string|null, isAmendment: boolean, companyName: string|null, description: string|null, minimumInvestment: number|null, relatedPersons: Array<{name: string, role: string}>}>}
 */
async function parseFormDFiling(filingUrl) {
  if (!isAvailable()) {
    throw new Error('SEC EDGAR scraping is disabled');
  }

  const response = await secFetch(filingUrl);

  if (response.statusCode !== 200) {
    throw new Error(`Failed to fetch Form D filing: HTTP ${response.statusCode}`);
  }

  const xml = response.data;

  // Extract offering amounts
  const totalOfferingAmount = extractXmlPath(xml, ['offeringSalesAmounts', 'totalOfferingAmount']);
  const totalAmountSold = extractXmlPath(xml, ['offeringSalesAmounts', 'totalAmountSold']);
  const totalRemaining = extractXmlPath(xml, ['offeringSalesAmounts', 'totalRemaining']);
  const minimumInvestment = extractXmlValue(xml, 'minimumInvestmentAccepted');

  // Extract company info
  const companyName = extractXmlValue(xml, 'entityName');
  const cik = extractXmlValue(xml, 'cik');

  // Extract description
  const description = extractXmlValue(xml, 'descriptionOfOtherType');

  // Check if amendment
  const isAmendment = xml.includes('isAmendment>true</') ||
                      xml.includes('isAmendment>1</') ||
                      filingUrl.includes('D/A') ||
                      xml.toLowerCase().includes('amendment');

  // Extract filing date from submission header if present
  const filingDate = extractXmlValue(xml, 'filedDate') ||
                     extractXmlValue(xml, 'FILED-DATE') ||
                     null;

  // Extract related persons (producers/managing members)
  const relatedPersons = [];
  const personMatches = xml.matchAll(/<relatedPersonInfo[^>]*>([\s\S]*?)<\/relatedPersonInfo>/gi);
  for (const match of personMatches) {
    const personXml = match[1];
    const firstName = extractXmlValue(personXml, 'firstName') || '';
    const lastName = extractXmlValue(personXml, 'lastName') || '';
    const role = extractXmlValue(personXml, 'relationshipClarification') || 'Related Person';

    if (firstName || lastName) {
      relatedPersons.push({
        name: `${firstName} ${lastName}`.trim(),
        role
      });
    }
  }

  return {
    totalOfferingAmount: totalOfferingAmount ? parseInt(totalOfferingAmount, 10) : null,
    amountSold: totalAmountSold ? parseInt(totalAmountSold, 10) : null,
    amountRemaining: totalRemaining ? parseInt(totalRemaining, 10) : null,
    minimumInvestment: minimumInvestment ? parseInt(minimumInvestment, 10) : null,
    filingDate,
    isAmendment,
    companyName,
    cik,
    description,
    relatedPersons
  };
}

/**
 * Known CIK mappings for Broadway shows (from Sprint 0 research)
 * This allows direct lookup without full-text search
 */
const KNOWN_BROADWAY_CIKS = {
  'book-of-mormon-2011': '0001507647',
  'hadestown-2019': '0001701707',
  'broadway-goes-wrong-2017': '0001698120',
  'mean-girls-2018': '0001713348',
  'beetlejuice-2019': '0001739068',
  // Development/Touring LLCs
  'hadestown-development': '0001647653',
  'hadestown-tour': '0001812675',
  'hadestown-west-end': '0001989666',
  'mean-girls-london': '0002026198',
  'mean-girls-development': '0001700094',
  'mean-girls-tour': '0001995327',
  'beetlejuice-tour': '0001954277'
};

/**
 * Look up a show by slug using known CIK mappings
 * @param {string} showSlug - Show slug from shows.json
 * @returns {string|null} - CIK number or null if not known
 */
function getKnownCik(showSlug) {
  return KNOWN_BROADWAY_CIKS[showSlug] || null;
}

/**
 * Get all filings for a show using known CIK mapping
 * @param {string} showSlug - Show slug
 * @returns {Promise<Array>} - Array of filing data
 */
async function getShowFilings(showSlug) {
  const cik = getKnownCik(showSlug);
  if (!cik) {
    return [];
  }
  return searchFormDFilings({ cik });
}

// ============================================================================
// Module Exports
// ============================================================================

module.exports = {
  // Core functions
  searchFormDFilings,
  parseFormDFiling,
  isAvailable,
  getCompanyFilings,

  // Utilities
  getKnownCik,
  getShowFilings,
  BROADWAY_LLC_PATTERNS,
  KNOWN_BROADWAY_CIKS,

  // For testing
  extractXmlValue,
  extractXmlPath,
  waitForRateLimit,
  getBackoffDelay,

  // Feature flag (read-only)
  get SEC_EDGAR_ENABLED() { return SEC_EDGAR_ENABLED; }
};

// ============================================================================
// CLI Mode
// ============================================================================

if (require.main === module) {
  const args = process.argv.slice(2);

  async function main() {
    console.log('SEC EDGAR Broadway Form D Scraper');
    console.log('=================================\n');

    // Check feature flag
    if (!isAvailable()) {
      console.log('SEC EDGAR scraping is DISABLED (SEC_EDGAR_ENABLED=false)');
      process.exit(0);
    }

    console.log('SEC EDGAR scraping is ENABLED\n');

    // Parse arguments
    let searchTerm = null;
    let cik = null;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--search' && args[i + 1]) {
        searchTerm = args[i + 1];
        i++;
      } else if (args[i] === '--cik' && args[i + 1]) {
        cik = args[i + 1];
        i++;
      } else if (args[i] === '--help' || args[i] === '-h') {
        console.log('Usage:');
        console.log('  node sec-edgar-scraper.js --search "Show Name"');
        console.log('  node sec-edgar-scraper.js --cik 0001507647');
        console.log('');
        console.log('Options:');
        console.log('  --search <name>  Search for Form D filings by show name');
        console.log('  --cik <number>   Look up filings by CIK number');
        console.log('  --help           Show this help message');
        console.log('');
        console.log('Known CIKs:');
        for (const [slug, knownCik] of Object.entries(KNOWN_BROADWAY_CIKS).slice(0, 5)) {
          console.log(`  ${slug}: ${knownCik}`);
        }
        console.log('  ...(and more)');
        process.exit(0);
      }
    }

    // Default: show known CIKs and test with Book of Mormon
    if (!searchTerm && !cik) {
      console.log('No search term or CIK provided. Running demo with Book of Mormon...\n');
      cik = '0001507647'; // Book of Mormon
    }

    try {
      // Search for filings
      console.log(cik ? `Looking up CIK: ${cik}` : `Searching for: ${searchTerm}`);
      console.log('---');

      const filings = await searchFormDFilings({ showName: searchTerm, cik });

      if (filings.length === 0) {
        console.log('\nNo Form D filings found.');
        if (searchTerm) {
          console.log('\nTip: Full-text search requires browser automation.');
          console.log('Try using a known CIK number instead with --cik');
        }
        process.exit(0);
      }

      console.log(`\nFound ${filings.length} Form D filing(s):\n`);

      for (const filing of filings) {
        console.log(`Company: ${filing.companyName}`);
        console.log(`CIK: ${filing.cik}`);
        console.log(`Form: ${filing.form}${filing.isAmendment ? ' (Amendment)' : ''}`);
        console.log(`Filed: ${filing.filingDate}`);
        console.log(`URL: ${filing.filingUrl}`);

        // Parse the filing to get capitalization
        try {
          console.log('\nParsing filing details...');
          const data = await parseFormDFiling(filing.filingUrl);

          if (data.totalOfferingAmount) {
            console.log(`  Capitalization: $${data.totalOfferingAmount.toLocaleString()}`);
          }
          if (data.amountSold) {
            console.log(`  Amount Sold: $${data.amountSold.toLocaleString()}`);
          }
          if (data.minimumInvestment) {
            console.log(`  Min Investment: $${data.minimumInvestment.toLocaleString()}`);
          }
          if (data.description) {
            console.log(`  Description: ${data.description.slice(0, 100)}...`);
          }
          if (data.relatedPersons.length > 0) {
            console.log('  Related Persons:');
            data.relatedPersons.slice(0, 3).forEach(p => {
              console.log(`    - ${p.name} (${p.role})`);
            });
            if (data.relatedPersons.length > 3) {
              console.log(`    ... and ${data.relatedPersons.length - 3} more`);
            }
          }
        } catch (parseError) {
          console.log(`  Error parsing: ${parseError.message}`);
        }

        console.log('\n---');
      }

      console.log('\nDone!');
    } catch (error) {
      console.error(`\nError: ${error.message}`);
      process.exit(1);
    }
  }

  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
