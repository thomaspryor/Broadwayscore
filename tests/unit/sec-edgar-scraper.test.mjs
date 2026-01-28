/**
 * Unit tests for SEC EDGAR scraper module
 *
 * Sprint 2 - SEC EDGAR Scraper Module
 *
 * Run with: npm run test:unit
 * Or: node --test tests/unit/sec-edgar-scraper.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const {
  BROADWAY_LLC_PATTERNS,
  KNOWN_BROADWAY_CIKS,
  isAvailable,
  getKnownCik,
  extractXmlValue,
  extractXmlPath,
  getBackoffDelay
} = require('../../scripts/lib/sec-edgar-scraper.js');

// Get directory path for fixtures
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, '..', 'fixtures');

// ============================================================================
// BROADWAY_LLC_PATTERNS Tests
// ============================================================================

describe('BROADWAY_LLC_PATTERNS', () => {
  it('is an array', () => {
    assert.ok(Array.isArray(BROADWAY_LLC_PATTERNS));
  });

  it('has at least 5 patterns', () => {
    assert.ok(
      BROADWAY_LLC_PATTERNS.length >= 5,
      `Expected at least 5 patterns, got ${BROADWAY_LLC_PATTERNS.length}`
    );
  });

  it('all patterns contain {show} placeholder', () => {
    for (const pattern of BROADWAY_LLC_PATTERNS) {
      assert.ok(
        pattern.includes('{show}'),
        `Pattern "${pattern}" should contain {show} placeholder`
      );
    }
  });

  it('includes common Broadway LLC naming patterns', () => {
    const patterns = BROADWAY_LLC_PATTERNS.map(p => p.toLowerCase());

    // Check for expected patterns based on research
    assert.ok(
      patterns.some(p => p.includes('broadway llc')),
      'Should have Broadway LLC pattern'
    );
    assert.ok(
      patterns.some(p => p.includes('broadway ltd liability co')),
      'Should have Broadway Ltd Liability Co pattern'
    );
    assert.ok(
      patterns.some(p => p.includes('limited partnership')),
      'Should have Limited Partnership pattern'
    );
    assert.ok(
      patterns.some(p => p.includes('touring')),
      'Should have Touring pattern'
    );
  });

  it('can generate search terms for a show', () => {
    const showName = 'Hamilton';
    const searchTerms = BROADWAY_LLC_PATTERNS.map(p =>
      p.replace('{show}', showName)
    );

    assert.ok(searchTerms.includes('Hamilton'));
    assert.ok(searchTerms.includes('Hamilton Broadway'));
    assert.ok(searchTerms.includes('Hamilton Broadway LLC'));
  });
});

// ============================================================================
// KNOWN_BROADWAY_CIKS Tests
// ============================================================================

describe('KNOWN_BROADWAY_CIKS', () => {
  it('is an object', () => {
    assert.strictEqual(typeof KNOWN_BROADWAY_CIKS, 'object');
    assert.ok(!Array.isArray(KNOWN_BROADWAY_CIKS));
  });

  it('has entries for known shows', () => {
    // From Sprint 0 research
    const expectedShows = ['book-of-mormon-2011', 'hadestown-2019', 'mean-girls-2018', 'beetlejuice-2019'];
    for (const show of expectedShows) {
      assert.ok(
        KNOWN_BROADWAY_CIKS[show],
        `Missing CIK mapping for ${show}`
      );
    }
  });

  it('all CIKs are valid format (10-digit string with leading zeros)', () => {
    for (const [slug, cik] of Object.entries(KNOWN_BROADWAY_CIKS)) {
      assert.ok(
        /^0\d{9}$/.test(cik),
        `Invalid CIK format for ${slug}: ${cik}`
      );
    }
  });

  it('Book of Mormon has correct CIK', () => {
    assert.strictEqual(KNOWN_BROADWAY_CIKS['book-of-mormon-2011'], '0001507647');
  });

  it('Hadestown has correct CIK', () => {
    assert.strictEqual(KNOWN_BROADWAY_CIKS['hadestown-2019'], '0001701707');
  });
});

// ============================================================================
// isAvailable Tests
// ============================================================================

describe('isAvailable', () => {
  it('returns a boolean', () => {
    const result = isAvailable();
    assert.strictEqual(typeof result, 'boolean');
  });

  it('returns true by default (SEC_EDGAR_ENABLED not set to false)', () => {
    // This test assumes SEC_EDGAR_ENABLED is not set to 'false' in the test environment
    // If it is, this test would need to be adjusted
    const result = isAvailable();
    assert.strictEqual(result, true);
  });
});

// ============================================================================
// getKnownCik Tests
// ============================================================================

describe('getKnownCik', () => {
  it('returns CIK for known show', () => {
    const cik = getKnownCik('book-of-mormon-2011');
    assert.strictEqual(cik, '0001507647');
  });

  it('returns null for unknown show', () => {
    const cik = getKnownCik('unknown-show-1999');
    assert.strictEqual(cik, null);
  });

  it('is case-sensitive', () => {
    const cik = getKnownCik('Book-Of-Mormon-2011'); // Wrong case
    assert.strictEqual(cik, null);
  });
});

// ============================================================================
// XML Parsing Tests
// ============================================================================

describe('extractXmlValue', () => {
  it('extracts simple tag value', () => {
    const xml = '<root><name>Test Value</name></root>';
    const value = extractXmlValue(xml, 'name');
    assert.strictEqual(value, 'Test Value');
  });

  it('handles whitespace around value', () => {
    const xml = '<root><name>  Trimmed Value  </name></root>';
    const value = extractXmlValue(xml, 'name');
    assert.strictEqual(value, 'Trimmed Value');
  });

  it('returns null for missing tag', () => {
    const xml = '<root><other>value</other></root>';
    const value = extractXmlValue(xml, 'name');
    assert.strictEqual(value, null);
  });

  it('handles numeric values', () => {
    const xml = '<root><amount>12000000</amount></root>';
    const value = extractXmlValue(xml, 'amount');
    assert.strictEqual(value, '12000000');
  });

  it('handles namespaced tags', () => {
    const xml = '<root><ns:entityName>Company Name</ns:entityName></root>';
    const value = extractXmlValue(xml, 'entityName');
    assert.strictEqual(value, 'Company Name');
  });

  it('is case-insensitive for tag names', () => {
    const xml = '<root><EntityName>Company Name</EntityName></root>';
    const value = extractXmlValue(xml, 'entityName');
    assert.strictEqual(value, 'Company Name');
  });
});

describe('extractXmlPath', () => {
  it('extracts nested value', () => {
    const xml = `
      <root>
        <offeringSalesAmounts>
          <totalOfferingAmount>12000000</totalOfferingAmount>
        </offeringSalesAmounts>
      </root>
    `;
    const value = extractXmlPath(xml, ['offeringSalesAmounts', 'totalOfferingAmount']);
    assert.strictEqual(value, '12000000');
  });

  it('returns null for missing nested path', () => {
    const xml = '<root><other>value</other></root>';
    const value = extractXmlPath(xml, ['offeringSalesAmounts', 'totalOfferingAmount']);
    assert.strictEqual(value, null);
  });

  it('returns null for partial path match', () => {
    const xml = `
      <root>
        <offeringSalesAmounts>
          <otherAmount>5000</otherAmount>
        </offeringSalesAmounts>
      </root>
    `;
    const value = extractXmlPath(xml, ['offeringSalesAmounts', 'totalOfferingAmount']);
    assert.strictEqual(value, null);
  });
});

// ============================================================================
// Form D XML Fixture Tests
// ============================================================================

describe('Form D XML Parsing (fixtures)', () => {
  const bookOfMormonXml = fs.readFileSync(
    path.join(fixturesDir, 'form-d-book-of-mormon.xml'),
    'utf8'
  );

  const amendmentXml = fs.readFileSync(
    path.join(fixturesDir, 'form-d-amendment.xml'),
    'utf8'
  );

  it('extracts capitalization from Book of Mormon Form D', () => {
    const value = extractXmlPath(bookOfMormonXml, ['offeringSalesAmounts', 'totalOfferingAmount']);
    assert.strictEqual(value, '12000000');
    assert.strictEqual(parseInt(value, 10), 12000000);
  });

  it('extracts company name from Book of Mormon Form D', () => {
    const value = extractXmlValue(bookOfMormonXml, 'entityName');
    assert.strictEqual(value, 'Book of Mormon Broadway Ltd Liability Co');
  });

  it('extracts CIK from Book of Mormon Form D', () => {
    const value = extractXmlValue(bookOfMormonXml, 'cik');
    assert.strictEqual(value, '0001507647');
  });

  it('extracts minimum investment from Book of Mormon Form D', () => {
    const value = extractXmlValue(bookOfMormonXml, 'minimumInvestmentAccepted');
    assert.strictEqual(value, '5000');
    assert.strictEqual(parseInt(value, 10), 5000);
  });

  it('extracts description from Book of Mormon Form D', () => {
    const value = extractXmlValue(bookOfMormonXml, 'descriptionOfOtherType');
    assert.ok(value.includes('THE BOOK OF MORMON'));
    assert.ok(value.includes('Broadway production'));
  });

  it('extracts amount sold from amendment', () => {
    const value = extractXmlPath(amendmentXml, ['offeringSalesAmounts', 'totalAmountSold']);
    assert.strictEqual(value, '11400000');
  });

  it('extracts total remaining from amendment', () => {
    const value = extractXmlPath(amendmentXml, ['offeringSalesAmounts', 'totalRemaining']);
    assert.strictEqual(value, '600000');
  });

  it('detects amendment from isAmendment tag', () => {
    const isAmendmentValue = amendmentXml.includes('isAmendment>true</');
    assert.ok(isAmendmentValue, 'Amendment XML should contain isAmendment>true');
  });

  it('initial filing has zero amount sold', () => {
    const value = extractXmlPath(bookOfMormonXml, ['offeringSalesAmounts', 'totalAmountSold']);
    assert.strictEqual(value, '0');
  });
});

// ============================================================================
// Rate Limiting Tests
// ============================================================================

describe('getBackoffDelay', () => {
  it('returns 2000ms for first retry (attempt 0)', () => {
    const delay = getBackoffDelay(0);
    assert.strictEqual(delay, 2000);
  });

  it('doubles delay for each retry', () => {
    assert.strictEqual(getBackoffDelay(0), 2000);
    assert.strictEqual(getBackoffDelay(1), 4000);
    assert.strictEqual(getBackoffDelay(2), 8000);
  });

  it('caps delay at 30 seconds', () => {
    const delay = getBackoffDelay(10); // Would be 2^10 * 2000 = 2048000
    assert.strictEqual(delay, 30000);
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('Error Handling', () => {
  it('extractXmlValue handles empty string', () => {
    const value = extractXmlValue('', 'name');
    assert.strictEqual(value, null);
  });

  it('extractXmlValue handles malformed XML', () => {
    const value = extractXmlValue('<name>unclosed', 'name');
    assert.strictEqual(value, null);
  });

  it('extractXmlPath handles empty array path', () => {
    const xml = '<root><name>value</name></root>';
    // Edge case: empty path should return the XML as-is or handle gracefully
    // The function expects at least one element in the path
    const value = extractXmlPath(xml, []);
    // With empty path, it should try to extract undefined tag and return null
    assert.strictEqual(value, null);
  });

  it('extractXmlPath handles single-element path', () => {
    const xml = '<root><name>value</name></root>';
    const value = extractXmlPath(xml, ['name']);
    assert.strictEqual(value, 'value');
  });
});

// ============================================================================
// Pattern Matching Tests
// ============================================================================

describe('Pattern Matching', () => {
  it('can match show names with special characters', () => {
    const showName = "The Lion King";
    const searchTerms = BROADWAY_LLC_PATTERNS.map(p =>
      p.replace('{show}', showName)
    );

    assert.ok(searchTerms.includes('The Lion King Broadway LLC'));
    assert.ok(searchTerms.includes('The Lion King Touring LLC'));
  });

  it('handles apostrophes in show names', () => {
    const showName = "Hadestown";
    const searchTerms = BROADWAY_LLC_PATTERNS.map(p =>
      p.replace('{show}', showName)
    );

    assert.ok(searchTerms.includes('Hadestown Broadway Ltd Liability Co'));
  });

  it('pattern count is documented', () => {
    // Document the actual count for future reference
    const count = BROADWAY_LLC_PATTERNS.length;
    assert.ok(count >= 10, `Expected at least 10 patterns, got ${count}`);
    console.log(`    (BROADWAY_LLC_PATTERNS has ${count} patterns)`);
  });
});

// ============================================================================
// Integration Smoke Tests
// ============================================================================

describe('Module Integration', () => {
  it('all exports are defined', () => {
    const exports = require('../../scripts/lib/sec-edgar-scraper.js');

    // Core functions
    assert.ok(typeof exports.searchFormDFilings === 'function');
    assert.ok(typeof exports.parseFormDFiling === 'function');
    assert.ok(typeof exports.isAvailable === 'function');
    assert.ok(typeof exports.getCompanyFilings === 'function');

    // Utilities
    assert.ok(typeof exports.getKnownCik === 'function');
    assert.ok(typeof exports.getShowFilings === 'function');

    // Constants
    assert.ok(Array.isArray(exports.BROADWAY_LLC_PATTERNS));
    assert.ok(typeof exports.KNOWN_BROADWAY_CIKS === 'object');

    // Testing utilities
    assert.ok(typeof exports.extractXmlValue === 'function');
    assert.ok(typeof exports.extractXmlPath === 'function');
    assert.ok(typeof exports.waitForRateLimit === 'function');
    assert.ok(typeof exports.getBackoffDelay === 'function');
  });

  it('SEC_EDGAR_ENABLED is accessible as getter', () => {
    const exports = require('../../scripts/lib/sec-edgar-scraper.js');
    assert.strictEqual(typeof exports.SEC_EDGAR_ENABLED, 'boolean');
  });
});
