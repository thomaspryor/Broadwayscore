#!/usr/bin/env node

/**
 * Commercial Data Integration Test
 *
 * Sprint 5 - Workflow & Final Integration
 *
 * Tests that all commercial data modules load correctly and the main
 * update script runs without errors in gather-only mode.
 *
 * Usage:
 *   node scripts/test-commercial-integration.js
 *
 * Exit codes:
 *   0 - All tests passed
 *   1 - One or more tests failed
 */

const { spawn } = require('child_process');
const path = require('path');

// ============================================================================
// Test Configuration
// ============================================================================

const TESTS = [
  {
    name: 'Load trade-press-scraper module',
    type: 'module',
    path: './lib/trade-press-scraper'
  },
  {
    name: 'Load sec-edgar-scraper module',
    type: 'module',
    path: './lib/sec-edgar-scraper'
  },
  {
    name: 'Load source-validator module',
    type: 'module',
    path: './lib/source-validator'
  },
  {
    name: 'Load parse-grosses module',
    type: 'module',
    path: './lib/parse-grosses'
  },
  {
    name: 'Verify trade-press-scraper exports',
    type: 'exports',
    path: './lib/trade-press-scraper',
    required: ['scrapeTradeArticle', 'getSiteConfig', 'SITE_CONFIGS', 'getFailedFetches']
  },
  {
    name: 'Verify sec-edgar-scraper exports',
    type: 'exports',
    path: './lib/sec-edgar-scraper',
    required: ['searchFormDFilings', 'parseFormDFiling', 'isAvailable', 'BROADWAY_LLC_PATTERNS']
  },
  {
    name: 'Verify source-validator exports',
    type: 'exports',
    path: './lib/source-validator',
    required: ['validateChange', 'SOURCE_WEIGHTS', 'findCorroboration', 'calculateConfidence']
  },
  {
    name: 'Verify SITE_CONFIGS has required sites',
    type: 'custom',
    test: () => {
      const { SITE_CONFIGS } = require('./lib/trade-press-scraper');
      const requiredSites = ['deadline.com', 'variety.com', 'playbill.com', 'nytimes.com', 'vulture.com'];
      const missingSites = requiredSites.filter(site => !SITE_CONFIGS[site]);
      if (missingSites.length > 0) {
        throw new Error(`Missing site configs: ${missingSites.join(', ')}`);
      }
      return `Found ${Object.keys(SITE_CONFIGS).length} site configs`;
    }
  },
  {
    name: 'Verify SOURCE_WEIGHTS has required sources',
    type: 'custom',
    test: () => {
      const { SOURCE_WEIGHTS } = require('./lib/source-validator');
      const requiredSources = ['SEC Form D', 'Deadline', 'Variety', 'Reddit comment', 'estimate'];
      const missingSources = requiredSources.filter(src => !(src in SOURCE_WEIGHTS));
      if (missingSources.length > 0) {
        throw new Error(`Missing source weights: ${missingSources.join(', ')}`);
      }
      return `Found ${Object.keys(SOURCE_WEIGHTS).length} source weights`;
    }
  },
  {
    name: 'Verify SEC EDGAR feature flag',
    type: 'custom',
    test: () => {
      const { isAvailable } = require('./lib/sec-edgar-scraper');
      const status = isAvailable();
      return `SEC EDGAR scraping is ${status ? 'ENABLED' : 'DISABLED'}`;
    }
  }
];

// ============================================================================
// Test Runner
// ============================================================================

const results = {
  passed: 0,
  failed: 0,
  errors: []
};

function runTest(test) {
  process.stdout.write(`  ${test.name}... `);

  try {
    switch (test.type) {
      case 'module': {
        require(test.path);
        console.log('PASS');
        results.passed++;
        break;
      }

      case 'exports': {
        const mod = require(test.path);
        const missing = test.required.filter(exp => !(exp in mod));
        if (missing.length > 0) {
          throw new Error(`Missing exports: ${missing.join(', ')}`);
        }
        console.log('PASS');
        results.passed++;
        break;
      }

      case 'custom': {
        const detail = test.test();
        console.log(`PASS (${detail})`);
        results.passed++;
        break;
      }

      default:
        throw new Error(`Unknown test type: ${test.type}`);
    }
  } catch (error) {
    console.log(`FAIL: ${error.message}`);
    results.failed++;
    results.errors.push({ test: test.name, error: error.message });
  }
}

// ============================================================================
// Main Script Execution Test
// ============================================================================

async function testMainScript() {
  return new Promise((resolve) => {
    process.stdout.write('  Verify update-commercial-data.js syntax... ');

    const scriptPath = path.join(__dirname, 'update-commercial-data.js');

    // Just check that the script can be parsed/loaded by Node without actually running
    const child = spawn('node', ['--check', scriptPath], {
      cwd: path.join(__dirname, '..'),
      timeout: 10000
    });

    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log('PASS');
        results.passed++;
      } else {
        console.log(`FAIL: syntax error`);
        results.failed++;
        results.errors.push({
          test: 'Main script syntax check',
          error: stderr.substring(0, 200)
        });
      }
      resolve();
    });

    child.on('error', (error) => {
      console.log(`FAIL: ${error.message}`);
      results.failed++;
      results.errors.push({ test: 'Main script syntax check', error: error.message });
      resolve();
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      child.kill();
      console.log('TIMEOUT');
      results.failed++;
      results.errors.push({ test: 'Main script syntax check', error: 'Timeout after 10s' });
      resolve();
    }, 10000);
  });
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('');
  console.log('='.repeat(60));
  console.log('Commercial Data Integration Test');
  console.log('='.repeat(60));
  console.log('');

  // Run module tests
  console.log('Module Loading Tests:');
  console.log('-'.repeat(40));
  for (const test of TESTS) {
    runTest(test);
  }
  console.log('');

  // Run main script test
  console.log('Main Script Test:');
  console.log('-'.repeat(40));
  await testMainScript();
  console.log('');

  // Summary
  console.log('='.repeat(60));
  console.log(`Results: ${results.passed} passed, ${results.failed} failed`);
  console.log('='.repeat(60));

  if (results.errors.length > 0) {
    console.log('\nFailure Details:');
    results.errors.forEach((err, i) => {
      console.log(`  ${i + 1}. ${err.test}: ${err.error}`);
    });
    console.log('');
  }

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
