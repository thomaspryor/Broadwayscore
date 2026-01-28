#!/usr/bin/env node
/**
 * Test LLM Content Verification Module
 *
 * Tests the content-verifier.js module against sample reviews
 * to validate its accuracy before integrating into production pipelines.
 */

const fs = require('fs');
const path = require('path');
const { verifyContent, heuristicVerify, quickValidityCheck } = require('./lib/content-verifier');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

// Test cases - known good and known bad content
const testCases = [
  {
    name: 'Good review with fullText',
    showTitle: 'Hamilton',
    excerpt: 'Lin-Manuel Miranda\'s revolutionary musical',
    text: 'Hamilton is a revolutionary musical that transforms American history into hip-hop gold. Lin-Manuel Miranda has created something truly remarkable with this show. The performances are electrifying, the music is unforgettable, and the staging is innovative.',
    expectedValid: true
  },
  {
    name: 'Truncated content (paywall)',
    showTitle: 'Wicked',
    excerpt: 'Defying gravity',
    text: 'Wicked is a spectacular musical that... Subscribe to continue reading. Already a member? Sign in.',
    expectedValid: false,
    expectedTruncated: true
  },
  {
    name: 'Wrong article (movie review)',
    showTitle: 'The Lion King',
    excerpt: 'Circle of life',
    text: 'The Lion King (2019) is Disney\'s live-action remake of the animated classic. Director Jon Favreau brings photorealistic CGI to create an impressive visual spectacle. Simba\'s journey from cub to king is rendered in stunning detail.',
    expectedValid: false,
    expectedWrongArticle: true
  },
  {
    name: 'Navigation junk',
    showTitle: 'Chicago',
    excerpt: 'All that jazz',
    text: 'Home About Contact Privacy Policy Terms of Use Cookie Policy All Rights Reserved © 2024 Advertisement Related Articles More Stories',
    expectedValid: false
  }
];

async function runTests() {
  console.log('=== LLM Content Verification Tests ===\n');

  // Test 1: Heuristic verification (no API)
  console.log('--- Test 1: Heuristic Verification (no API) ---\n');

  for (const tc of testCases) {
    const result = heuristicVerify({
      scrapedText: tc.text,
      excerpt: tc.excerpt,
      showTitle: tc.showTitle
    });

    const passed = result.isValid === tc.expectedValid;
    console.log(`[${passed ? 'PASS' : 'FAIL'}] ${tc.name}`);
    console.log(`  Expected valid: ${tc.expectedValid}, Got: ${result.isValid}`);
    console.log(`  Issues: ${result.issues.join(', ') || 'none'}`);
    if (tc.expectedTruncated !== undefined) {
      console.log(`  Truncated: ${result.truncated} (expected: ${tc.expectedTruncated})`);
    }
    console.log();
  }

  // Test 2: Quick validity check
  console.log('--- Test 2: Quick Validity Check ---\n');

  const quickTests = [
    { text: 'This Broadway musical features amazing performances on stage. The theater was packed.', show: 'Hamilton', expected: true },
    { text: 'Privacy policy. Terms of use.', show: 'Hamilton', expected: false },
    { text: 'Short', show: 'Hamilton', expected: false }
  ];

  for (const qt of quickTests) {
    const result = quickValidityCheck(qt.text, qt.show);
    const passed = result === qt.expected;
    console.log(`[${passed ? 'PASS' : 'FAIL'}] "${qt.text.substring(0, 30)}..." = ${result} (expected: ${qt.expected})`);
  }

  // Test 3: Real review samples (if available)
  console.log('\n--- Test 3: Real Review Samples ---\n');

  // Find a few real reviews with fullText
  let samplesChecked = 0;
  const shows = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(f => fs.statSync(path.join(REVIEW_TEXTS_DIR, f)).isDirectory())
    .slice(0, 10); // Check first 10 shows

  for (const show of shows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, show);
    const files = fs.readdirSync(showDir)
      .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json')
      .slice(0, 3); // 3 reviews per show

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));

        if (data.fullText && data.fullText.length > 500) {
          const excerpt = data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || '';

          const result = heuristicVerify({
            scrapedText: data.fullText,
            excerpt: excerpt,
            showTitle: show.replace(/-\d{4}$/, '').replace(/-/g, ' ')
          });

          const status = result.isValid ? '✓' : '✗';
          console.log(`${status} ${show}/${file}:`);
          console.log(`    Valid: ${result.isValid}, Issues: ${result.issues.length}`);
          if (result.issues.length > 0) {
            console.log(`    Issues: ${result.issues.slice(0, 2).join('; ')}`);
          }
          samplesChecked++;

          if (samplesChecked >= 15) break;
        }
      } catch (e) {
        // Skip invalid files
      }
    }
    if (samplesChecked >= 15) break;
  }

  console.log(`\nChecked ${samplesChecked} real review samples`);

  // Test 4: LLM verification (if API key available)
  if (process.env.ANTHROPIC_API_KEY) {
    console.log('\n--- Test 4: LLM Verification (with API) ---\n');

    // Test a few cases with the actual API
    const llmTest = testCases[0]; // Good review
    console.log(`Testing "${llmTest.name}" with Claude API...`);

    try {
      const result = await verifyContent({
        scrapedText: llmTest.text,
        excerpt: llmTest.excerpt,
        showTitle: llmTest.showTitle,
        outletName: 'Test Outlet',
        criticName: 'Test Critic'
      });

      const passed = result.isValid === llmTest.expectedValid;
      console.log(`[${passed ? 'PASS' : 'FAIL'}] LLM verification`);
      console.log(`  Valid: ${result.isValid}`);
      console.log(`  Confidence: ${result.confidence}`);
      console.log(`  Verified by: ${result.verifiedBy}`);
      if (result.reasoning) console.log(`  Reasoning: ${result.reasoning}`);
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
    }
  } else {
    console.log('\n--- Test 4: SKIPPED (no ANTHROPIC_API_KEY) ---\n');
  }

  console.log('\n=== Tests Complete ===\n');
}

runTests().catch(console.error);
