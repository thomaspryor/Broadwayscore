#!/usr/bin/env node

/**
 * Test the review submission validation locally
 *
 * Usage: node scripts/test-review-submission.js <review-url> [show-name] [outlet-name]
 *
 * Examples:
 *   node scripts/test-review-submission.js "https://www.nytimes.com/2024/04/25/theater/stereophonic-review.html"
 *   node scripts/test-review-submission.js "https://variety.com/review/hamilton" "Hamilton" "Variety"
 */

import { Anthropic } from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load data files
const showsPath = path.join(__dirname, '../data/shows.json');
const reviewsPath = path.join(__dirname, '../data/reviews.json');
const reviewTextsPath = path.join(__dirname, '../data/review-texts');

const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf-8'));
const shows = showsData.shows || showsData; // Handle both formats
const reviewsData = JSON.parse(fs.readFileSync(reviewsPath, 'utf-8'));
const reviews = reviewsData.reviews || reviewsData; // Handle both formats

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Check if review already exists in our database
 */
function checkDuplicateReview(url, showId) {
  // Check reviews.json
  for (const review of reviews) {
    if (review.url && review.url.toLowerCase() === url.toLowerCase()) {
      return { isDuplicate: true, location: 'reviews.json', showId: review.showId };
    }
  }

  // Check review-texts directory if showId is provided
  if (showId && fs.existsSync(path.join(reviewTextsPath, showId))) {
    const files = fs.readdirSync(path.join(reviewTextsPath, showId));

    for (const file of files) {
      if (!file.endsWith('.json') || file === 'failed-fetches.json') continue;

      const reviewData = JSON.parse(
        fs.readFileSync(path.join(reviewTextsPath, showId, file), 'utf-8')
      );

      if (reviewData.url && reviewData.url.toLowerCase() === url.toLowerCase()) {
        return { isDuplicate: true, location: `review-texts/${showId}/${file}`, showId };
      }
    }
  }

  return { isDuplicate: false };
}

/**
 * Find matching show in database
 */
function findMatchingShow(showName) {
  if (!showName) return null;

  const normalizedInput = showName.toLowerCase().trim();

  // Exact title match
  let match = shows.find(s => s.title.toLowerCase() === normalizedInput);
  if (match) return match;

  // Check if input matches slug
  match = shows.find(s => s.id === normalizedInput || s.slug === normalizedInput);
  if (match) return match;

  // Partial match
  match = shows.find(s =>
    s.title.toLowerCase().includes(normalizedInput) ||
    normalizedInput.includes(s.title.toLowerCase())
  );

  return match;
}

/**
 * Use Claude API to validate the submission
 */
async function validateWithClaude(submissionData) {
  const showsList = shows.map(s => `- ${s.title} (${s.id})`).join('\n');

  const prompt = `You are validating a Broadway review submission for our database. Analyze the following submission and determine if it's valid.

SUBMISSION DATA:
- Review URL: ${submissionData.reviewUrl}
${submissionData.showName ? `- Show Name (user provided): ${submissionData.showName}` : ''}
${submissionData.outletName ? `- Outlet Name (user provided): ${submissionData.outletName}` : ''}
${submissionData.criticName ? `- Critic Name (user provided): ${submissionData.criticName}` : ''}
${submissionData.additionalNotes ? `- Additional Notes: ${submissionData.additionalNotes}` : ''}

OUR DATABASE SHOWS:
${showsList}

VALIDATION CRITERIA:
1. Is this a valid, accessible URL?
2. Based on the URL domain and path, is this likely a professional theater review (not a news article, listicle, or aggregator page)?
3. Is this specifically a BROADWAY show review (not Off-Broadway, regional, touring, or international)?
4. Is the show in our database? If so, which one?
5. Is the outlet a legitimate theater publication or major media outlet?

Respond in this JSON format:
{
  "isValid": true/false,
  "validationDetails": {
    "isValidUrl": true/false,
    "isReview": true/false,
    "isBroadway": true/false,
    "isLegitimateOutlet": true/false,
    "showInDatabase": true/false
  },
  "extractedData": {
    "showId": "show-id-from-our-database" or null,
    "showTitle": "extracted show title" or null,
    "outlet": "extracted outlet name" or null,
    "outletId": "normalized-outlet-id" or null,
    "critic": "extracted critic name" or null
  },
  "reasoning": "Brief explanation of your decision",
  "recommendation": "approve" or "reject" or "needs-manual-review"
}`;

  console.log('\n🤖 Sending to Claude API for validation...\n');

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ]
  });

  const responseText = message.content[0].text;

  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Could not parse Claude response as JSON');
  }

  return JSON.parse(jsonMatch[0]);
}

/**
 * Format validation result for console output
 */
function formatValidationResult(result) {
  const checkMark = (value) => value ? '✅' : '❌';

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    VALIDATION RESULT                         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log(`📊 Recommendation: ${result.recommendation.toUpperCase()}`);
  console.log(`\n💭 Reasoning: ${result.reasoning}\n`);

  console.log('🔍 Validation Details:');
  if (result.validationDetails) {
    Object.entries(result.validationDetails).forEach(([key, value]) => {
      console.log(`   ${checkMark(value)} ${key}: ${value}`);
    });
  }

  console.log('\n📝 Extracted Data:');
  if (result.extractedData) {
    console.log(`   Show Title: ${result.extractedData.showTitle || 'N/A'}`);
    console.log(`   Show ID: ${result.extractedData.showId || 'N/A'}`);
    console.log(`   Outlet: ${result.extractedData.outlet || 'N/A'}`);
    console.log(`   Outlet ID: ${result.extractedData.outletId || 'N/A'}`);
    console.log(`   Critic: ${result.extractedData.critic || 'N/A'}`);
  }

  if (result.matchedShow) {
    console.log(`\n🎭 Matched Show: ${result.matchedShow.title} (${result.matchedShow.id})`);
  }

  if (result.isDuplicate) {
    console.log(`\n⚠️  DUPLICATE: This review already exists at ${result.existingLocation}`);
  }

  console.log('\n' + '═'.repeat(64) + '\n');
}

/**
 * Main test function
 */
async function testSubmission() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(`
Usage: node scripts/test-review-submission.js <review-url> [show-name] [outlet-name] [critic-name]

Examples:
  node scripts/test-review-submission.js "https://www.nytimes.com/2024/04/25/theater/stereophonic-review.html"

  node scripts/test-review-submission.js \\
    "https://variety.com/review/hamilton" \\
    "Hamilton" \\
    "Variety"

  node scripts/test-review-submission.js \\
    "https://vulture.com/article/cabaret-review.html" \\
    "Cabaret" \\
    "Vulture" \\
    "Jesse Green"
`);
    process.exit(1);
  }

  const submissionData = {
    reviewUrl: args[0],
    showName: args[1] || null,
    outletName: args[2] || null,
    criticName: args[3] || null,
  };

  console.log('\n📋 Testing Review Submission:');
  console.log(`   URL: ${submissionData.reviewUrl}`);
  if (submissionData.showName) console.log(`   Show: ${submissionData.showName}`);
  if (submissionData.outletName) console.log(`   Outlet: ${submissionData.outletName}`);
  if (submissionData.criticName) console.log(`   Critic: ${submissionData.criticName}`);

  try {
    // Check for duplicate
    console.log('\n🔍 Checking for duplicates...');
    const duplicateCheck = checkDuplicateReview(submissionData.reviewUrl);
    if (duplicateCheck.isDuplicate) {
      console.log(`❌ DUPLICATE FOUND: ${duplicateCheck.location}`);
      return {
        isValid: false,
        isDuplicate: true,
        existingLocation: duplicateCheck.location,
        recommendation: 'reject'
      };
    }
    console.log('✅ No duplicates found');

    // Check if user-provided show name matches our database
    let matchedShow = null;
    if (submissionData.showName) {
      console.log('\n🔍 Checking if show exists in database...');
      matchedShow = findMatchingShow(submissionData.showName);
      if (matchedShow) {
        console.log(`✅ Matched: ${matchedShow.title} (${matchedShow.id})`);

        // Re-check duplicate with specific show ID
        const showDuplicateCheck = checkDuplicateReview(submissionData.reviewUrl, matchedShow.id);
        if (showDuplicateCheck.isDuplicate) {
          console.log(`❌ DUPLICATE FOUND: ${showDuplicateCheck.location}`);
          return {
            isValid: false,
            isDuplicate: true,
            existingLocation: showDuplicateCheck.location,
            recommendation: 'reject'
          };
        }
      } else {
        console.log('⚠️  No exact match found in database');
      }
    }

    // Use Claude API for intelligent validation
    const claudeValidation = await validateWithClaude(submissionData);

    // Format and display results
    const result = {
      ...claudeValidation,
      submissionData,
      matchedShow: matchedShow ? {
        id: matchedShow.id,
        title: matchedShow.title
      } : null,
      isDuplicate: false
    };

    formatValidationResult(result);

    // Exit with appropriate code
    process.exit(result.recommendation === 'approve' ? 0 : 1);

  } catch (error) {
    console.error('\n❌ Validation Error:', error.message);
    console.error('\nStack trace:', error.stack);
    process.exit(1);
  }
}

// Run the test
testSubmission();
