#!/usr/bin/env node

/**
 * Validates a review submission from a GitHub issue
 *
 * Usage: node scripts/validate-review-submission.js <issue-number>
 *
 * Validates:
 * 1. Is it a valid URL?
 * 2. Is it a review of a show in a market we cover — NYC (Broadway or
 *    Off-Broadway) or London (West End or Off-West-End)?
 * 3. Is the show in our database?
 * 4. Is it from a legitimate outlet?
 * 5. Is it already in our reviews?
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
 * Extract issue data from GitHub issue body
 */
function parseIssueBody(issueBody) {
  const data = {};

  // Extract review URL
  const urlMatch = issueBody.match(/### Review URL\s*\n\s*(.+)/);
  if (urlMatch) data.reviewUrl = urlMatch[1].trim();

  // Extract show name
  const showMatch = issueBody.match(/### Show Name\s*\n\s*(.+)/);
  if (showMatch && showMatch[1].trim() !== '_No response_') {
    data.showName = showMatch[1].trim();
  }

  // Extract outlet name
  const outletMatch = issueBody.match(/### Outlet Name\s*\n\s*(.+)/);
  if (outletMatch && outletMatch[1].trim() !== '_No response_') {
    data.outletName = outletMatch[1].trim();
  }

  // Extract critic name
  const criticMatch = issueBody.match(/### Critic Name\s*\n\s*(.+)/);
  if (criticMatch && criticMatch[1].trim() !== '_No response_') {
    data.criticName = criticMatch[1].trim();
  }

  // Extract additional notes
  const notesMatch = issueBody.match(/### Additional Notes\s*\n\s*(.+)/s);
  if (notesMatch && notesMatch[1].trim() !== '_No response_') {
    data.additionalNotes = notesMatch[1].trim();
  }

  return data;
}

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

  const today = new Date().toISOString().split('T')[0];
  const prompt = `You are validating a theater review submission for Broadway Scorecard. We cover all professional theater in New York City (Broadway AND Off-Broadway) and London (West End AND Off-West-End). Analyze the following submission and determine if it's valid.

TODAY'S DATE: ${today} — use this when evaluating publication dates in URLs or metadata. Review URLs with dates in 2025 or 2026 are expected and valid.

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
3. Is this a review of a production in a market we cover — New York City (Broadway or Off-Broadway) OR London (West End or Off-West-End)? A London/West End review is fully in scope. Reject only productions outside these markets (e.g. US regional theater, touring productions, or international productions elsewhere).
4. Is the show in our database? If so, which one? Match on the show title regardless of market — database IDs may include a market suffix such as "off-west-end" or "off-broadway"; that suffix does NOT disqualify the submission. Set showInDatabase to true whenever the production matches a database entry.
   IMPORTANT — never guess a show: only set showId (and showInDatabase=true) when you can confidently identify the specific production from the review URL or the user-provided details — e.g. the show title appears in the URL slug/path, or in the Show Name / Additional Notes. You are given ONLY the URL and any user-provided fields; you cannot open the page. If the URL is opaque (e.g. a numeric or hashed id like "post.cfm?p=28354" with no readable show title in the path) and no other field names the show, you CANNOT know which production it is: set showId=null, showInDatabase=false, and recommend "needs-manual-review". Do NOT pick a plausible-looking show id.
5. Is the outlet a legitimate theater publication or major media outlet?

RECOMMENDATION GUIDANCE:
- "approve" when the URL is a valid professional review from a legitimate outlet, the production is in a covered market (NYC or London), AND you have confidently matched it to a specific show in our database (showId is set).
- "needs-manual-review" when it's a valid covered-market review from a legitimate outlet but either the show is NOT yet in our database, OR you cannot confidently identify which production the URL reviews (opaque URL). In both cases set showId=null.
- "reject" when the URL is not a review, the outlet is illegitimate, or the production is outside our covered markets.

Respond in this JSON format:
{
  "isValid": true/false,
  "validationDetails": {
    "isValidUrl": true/false,
    "isReview": true/false,
    "isCoveredMarket": true/false,
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
 * Main validation function
 */
async function validateSubmission(issueBody) {
  const submissionData = parseIssueBody(issueBody);

  console.log('Parsed submission data:', JSON.stringify(submissionData, null, 2));

  // Basic validation
  if (!submissionData.reviewUrl) {
    return {
      isValid: false,
      error: 'No review URL found in submission',
      recommendation: 'reject'
    };
  }

  // Check for duplicate
  const duplicateCheck = checkDuplicateReview(submissionData.reviewUrl);
  if (duplicateCheck.isDuplicate) {
    return {
      isValid: false,
      error: `This review is already in our database at ${duplicateCheck.location}`,
      recommendation: 'reject',
      isDuplicate: true,
      existingLocation: duplicateCheck.location
    };
  }

  // Check if user-provided show name matches our database
  let matchedShow = null;
  if (submissionData.showName) {
    matchedShow = findMatchingShow(submissionData.showName);
    if (matchedShow) {
      console.log(`Matched show: ${matchedShow.title} (${matchedShow.id})`);

      // Re-check duplicate with specific show ID
      const showDuplicateCheck = checkDuplicateReview(submissionData.reviewUrl, matchedShow.id);
      if (showDuplicateCheck.isDuplicate) {
        return {
          isValid: false,
          error: `This review is already in our database at ${showDuplicateCheck.location}`,
          recommendation: 'reject',
          isDuplicate: true,
          existingLocation: showDuplicateCheck.location
        };
      }
    }
  }

  // Use Claude API for intelligent validation
  console.log('Validating with Claude API...');
  const claudeValidation = await validateWithClaude(submissionData);

  console.log('Claude validation result:', JSON.stringify(claudeValidation, null, 2));

  // Guard: an 'approve' recommendation must resolve to a real database show id,
  // otherwise the downstream scrape job (which gates on approve and needs a
  // showId to ingest) fails AFTER the submitter already got an approval email.
  // Fall back to the deterministic title match; if neither resolves, downgrade
  // to manual review rather than approving a review we can't attach.
  if (claudeValidation.recommendation === 'approve') {
    const llmShowId = claudeValidation.extractedData?.showId;
    const resolvedId =
      (llmShowId && shows.some(s => s.id === llmShowId) && llmShowId) ||
      matchedShow?.id ||
      null;
    if (resolvedId) {
      if (claudeValidation.extractedData) {
        claudeValidation.extractedData.showId = resolvedId;
      }
    } else {
      claudeValidation.recommendation = 'needs-manual-review';
      claudeValidation.reasoning =
        `Approved as a covered-market review, but could not resolve a matching show id in our database` +
        `${llmShowId ? ` (extracted "${llmShowId}" is not a known show id)` : ''}. ` +
        `Routing to manual review so the show can be added or matched before ingest.`;
    }
  }

  // Combine results
  return {
    ...claudeValidation,
    submissionData,
    matchedShow: matchedShow ? {
      id: matchedShow.id,
      title: matchedShow.title
    } : null
  };
}

/**
 * Format validation result as GitHub comment
 */
function formatValidationComment(result) {
  if (result.recommendation === 'approve') {
    return `## ✅ Submission Approved!

Thank you for contributing to Broadway Scorecard! This submission has been validated and approved.

### Extracted Information
- **Show**: ${result.extractedData.showTitle || result.matchedShow?.title || 'Unknown'}
${result.extractedData.outlet ? `- **Outlet**: ${result.extractedData.outlet}` : ''}
${result.extractedData.critic ? `- **Critic**: ${result.extractedData.critic}` : ''}

### Next Steps
Our automated system will now:
1. Scrape the review content from the provided URL
2. Extract the review score and text
3. Add it to our database
4. Trigger a site rebuild with the new data

You'll see updates on this issue as the process completes. This issue will be automatically closed once the review is successfully added.

---
*Validated by automated system • ${new Date().toISOString()}*`;
  }

  if (result.recommendation === 'reject') {
    return `## ❌ Submission Rejected

Thank you for your submission, but we cannot accept this review for the following reason:

**${result.reasoning || result.error}**

### Validation Details
${result.validationDetails ? Object.entries(result.validationDetails)
  .map(([key, value]) => `- ${key}: ${value ? '✓' : '✗'}`)
  .join('\n') : ''}

${result.isDuplicate ? `\n**This review already exists in our database:**\n- Location: \`${result.existingLocation}\`\n` : ''}

If you believe this is an error, please reply to this issue with additional context.

---
*Validated by automated system • ${new Date().toISOString()}*`;
  }

  // needs-manual-review
  return `## ⚠️ Manual Review Required

This submission needs manual review by our team.

**Reason**: ${result.reasoning}

### Validation Details
${result.validationDetails ? Object.entries(result.validationDetails)
  .map(([key, value]) => `- ${key}: ${value ? '✓' : '✗'}`)
  .join('\n') : ''}

A maintainer will review this submission and provide feedback shortly.

---
*Validated by automated system • ${new Date().toISOString()}*`;
}

// Main execution
async function main() {
  const issueBody = process.env.ISSUE_BODY;

  if (!issueBody) {
    console.error('Error: ISSUE_BODY environment variable not set');
    process.exit(1);
  }

  try {
    const result = await validateSubmission(issueBody);

    // Output results
    console.log('\n=== VALIDATION RESULT ===');
    console.log(JSON.stringify(result, null, 2));

    // Format GitHub comment
    const comment = formatValidationComment(result);
    console.log('\n=== GITHUB COMMENT ===');
    console.log(comment);

    // Write outputs for GitHub Actions
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `recommendation=${result.recommendation}\n`
      );
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `show_id=${result.extractedData?.showId || result.matchedShow?.id || ''}\n`
      );
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `review_url=${result.submissionData?.reviewUrl || ''}\n`
      );

      // Write comment to file for GitHub Actions to read
      const commentPath = path.join(__dirname, '../.github-comment.md');
      fs.writeFileSync(commentPath, comment);
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `comment_file=${commentPath}\n`
      );
    }

    // Exit with appropriate code
    process.exit(result.recommendation === 'approve' ? 0 : 1);

  } catch (error) {
    console.error('Validation error:', error);

    const errorComment = `## ⚠️ Validation Error

An error occurred while validating this submission:

\`\`\`
${error.message}
\`\`\`

A maintainer will review this manually.`;

    console.log('\n=== GITHUB COMMENT ===');
    console.log(errorComment);

    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `recommendation=needs-manual-review\n`
      );
      const commentPath = path.join(__dirname, '../.github-comment.md');
      fs.writeFileSync(commentPath, errorComment);
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `comment_file=${commentPath}\n`
      );
    }

    process.exit(1);
  }
}

main();
