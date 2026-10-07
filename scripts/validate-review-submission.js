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
import { isBlockedReviewUrl } from './lib/domain-filters.js';
import outletCanonicalize from './lib/outlet-canonicalize.js';
import reviewNormalization from './lib/review-normalization.js';

import reviewGuards from './lib/review-guards.js';
import submissionShowMatch from './lib/submission-show-match.js';

const { lookupOutletForHost } = outletCanonicalize;
const { resolveOutletFromUrlIfPathInformed } = reviewNormalization;
const { canonicalizeUrlForDedup } = reviewGuards;
const { findMatchingShows: findMatchingShowsIn } = submissionShowMatch;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load data files
const showsPath = path.join(__dirname, '../data/shows.json');
const reviewsPath = path.join(__dirname, '../data/reviews.json');
const outletRegistryPath = path.join(__dirname, '../data/outlet-registry.json');
const criticRegistryPath = path.join(__dirname, '../data/critic-registry.json');

const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf-8'));
const shows = showsData.shows || showsData; // Handle both formats
const reviewsData = JSON.parse(fs.readFileSync(reviewsPath, 'utf-8'));
const reviews = reviewsData.reviews || reviewsData; // Handle both formats

// Host -> registered outlet, exact or parent domain (newspaper.dailymail.com
// -> daily-mail). Delegates to the same lookupOutletForHost the ingest step
// uses (scripts/ingest-review-from-url.js), so validation and ingest can never
// disagree about which outlet a URL belongs to.
function findMatchingOutletByDomain(url) {
  let outletId;
  try {
    // Path-informed edition splits (timeout.com/london vs /newyork) first —
    // lookupOutletForHost only ever sees a bare hostname and would otherwise
    // report a shared host as unresolvable (BRO-4153).
    const pathResolved = resolveOutletFromUrlIfPathInformed(url);
    outletId = pathResolved ? pathResolved.outletId : lookupOutletForHost(new URL(url).hostname);
  } catch {
    return null;
  }
  if (!outletId) return null;
  try {
    const registryData = JSON.parse(fs.readFileSync(outletRegistryPath, 'utf-8'));
    const o = (registryData.outlets || registryData)[outletId] || {};
    return { id: outletId, displayName: o.displayName || outletId, tier: o.tier };
  } catch {
    return { id: outletId, displayName: outletId, tier: undefined };
  }
}

// Loaded once at module load — critic id/displayName -> registry entry
// (knownOutlets, totalReviews, etc.), used to corroborate a submitter-
// provided critic name against an outlet match.
const CRITIC_REGISTRY = (() => {
  try {
    const data = JSON.parse(fs.readFileSync(criticRegistryPath, 'utf-8'));
    return data.critics || data;
  } catch (err) {
    console.error('Could not load critic-registry.json for critic matching (non-fatal):', err.message);
    return {};
  }
})();

/**
 * Find a registered critic matching a submitter-provided name — exact match
 * on the registry id (slug) or displayName, case-insensitive.
 */
function findMatchingCritic(criticName) {
  if (!criticName) return null;
  const normalized = criticName.toLowerCase().trim();
  const slug = normalized.replace(/\s+/g, '-');
  for (const [id, c] of Object.entries(CRITIC_REGISTRY)) {
    if (id.toLowerCase() === slug || (c.displayName || '').toLowerCase() === normalized) {
      return { id, ...c };
    }
  }
  return null;
}

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
    // canonicalizeUrlForDedup: utm params / param order / fragments must not let
    // a listed review through as "new".
    if (review.url && canonicalizeUrlForDedup(review.url) === canonicalizeUrlForDedup(url)) {
      return { isDuplicate: true, location: 'reviews.json', showId: review.showId };
    }
  }

  // Only reviews.json (what the site shows) counts as "already in our
  // database". A review-texts file that the rebuild EXCLUDES is not on the
  // site; rejecting a resubmission because of it made a hidden review
  // impossible to retry (Golden Boy / Daily Mail, issue #908). Approving lets
  // ingest merge into the existing file and check-submission-landed.js report
  // whether it reached the site this time.

  return { isDuplicate: false };
}

/**
 * Find ALL shows in the database matching a title — a title can span multiple
 * productions (different markets, different eras, e.g. two "Golden Boy"
 * entries), so callers need every candidate rather than an arbitrary first hit.
 */
function findMatchingShows(showName) {
  return findMatchingShowsIn(showName, shows);
}

/**
 * Find matching show in database (first candidate — see findMatchingShows
 * for the full list used to disambiguate duplicate titles).
 */
function findMatchingShow(showName) {
  return findMatchingShows(showName)[0] || null;
}

/**
 * Use Claude API to validate the submission
 */
async function validateWithClaude(submissionData, matchedShowCandidates = [], matchedOutlet = null, matchedCritic = null) {
  const showsList = shows.map(s => `- ${s.title} (${s.id})`).join('\n');

  const today = new Date().toISOString().split('T')[0];
  // BRO: a deterministic title lookup already ran before this call. Surface
  // its result explicitly rather than relying on the model to re-find the
  // same entry unaided inside the full show list below — issue #908 (Golden
  // Boy / Daily Mail) rejected a review as "no current production in our
  // database" even though golden-boy-off-west-end-2026 was present verbatim
  // in showsList; the model just didn't spot its own evidence. A named
  // candidate line removes that burden.
  const candidateNote = matchedShowCandidates.length
    ? `\nDETERMINISTIC TITLE MATCH: the submitter's show name ("${submissionData.showName}") exactly matches ${matchedShowCandidates.length} entr${matchedShowCandidates.length > 1 ? 'ies' : 'y'} already in our database — these ARE present in OUR DATABASE SHOWS below, do not conclude the show is missing just because you don't independently re-spot it there:\n${matchedShowCandidates.map(s => `  - ${s.title} (${s.id}) — category=${s.category || 'unknown'}, status=${s.status || 'unknown'}, opened=${s.openingDate || 'unknown'}`).join('\n')}\nUse the review URL and any other submitted details to decide which (if any) of these candidates is the actual production being reviewed. If exactly one candidate's market/era plausibly matches the URL, prefer it over declaring the show unmatched.\n`
    : '';
  // Same problem, one layer down: after the title-match fix above, issue #908
  // was STILL rejected — this time because the URL's host (a Daily Mail
  // digital-edition subdomain the model didn't recognize) read as "suspicious"
  // next to a tabloid-style headline, despite matching our own outlet
  // registry's registered domain alias for Daily Mail. Give the same explicit
  // treatment to outlet-domain matches as to show matches: a registry hit
  // means the host family is a known, tracked outlet, not a judgment call.
  const outletNote = matchedOutlet
    ? `\nDETERMINISTIC OUTLET DOMAIN MATCH: the review URL's host resolves to a domain family we already track as a registered outlet: ${matchedOutlet.displayName} (outletId "${matchedOutlet.id}", tier ${matchedOutlet.tier ?? 'unknown'}). This match is against our outlet registry's domain + domainAliases, so treat the outlet itself as legitimate and known — an unfamiliar subdomain (e.g. a paper's digital-edition or e-paper subdomain) is NOT evidence against legitimacy. Focus isReview/isLegitimateOutlet on whether the URL path and any user-provided critic name plausibly describe a review, not on whether you personally recognize this exact subdomain shape.\n`
    : '';
  // Third leg of the same pattern: a submitter-provided critic name that
  // matches a REAL critic already on record for the matched outlet is strong,
  // hard-to-fake corroboration that this is a genuine review, not tabloid/
  // celebrity content wearing a theatre-section URL path.
  const criticNote = (matchedCritic && matchedOutlet && (matchedCritic.knownOutlets || []).includes(matchedOutlet.id))
    ? `\nDETERMINISTIC CRITIC MATCH: "${submissionData.criticName}" is a known critic in our database with ${matchedCritic.totalReviews || 'multiple'} prior review(s) already on record for ${matchedOutlet.displayName}. This corroborates both the outlet match above and that this is a genuine critic review, not a non-review article.\n`
    : '';

  const prompt = `You are validating a theater review submission for Broadway Scorecard. We cover all professional theater in New York City (Broadway AND Off-Broadway) and London (West End AND Off-West-End). Analyze the following submission and determine if it's valid.

TODAY'S DATE: ${today} — use this when evaluating publication dates in URLs or metadata. Review URLs with dates in 2025 or 2026 are expected and valid.

SUBMISSION DATA:
- Review URL: ${submissionData.reviewUrl}
${submissionData.showName ? `- Show Name (user provided): ${submissionData.showName}` : ''}
${submissionData.outletName ? `- Outlet Name (user provided): ${submissionData.outletName}` : ''}
${submissionData.criticName ? `- Critic Name (user provided): ${submissionData.criticName}` : ''}
${submissionData.additionalNotes ? `- Additional Notes: ${submissionData.additionalNotes}` : ''}
${candidateNote}${outletNote}${criticNote}
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

  // Deterministic pre-filter for known non-review domains (ticket/listing/
  // social/reference/venue/PR-firm — domain-filters.js's isBlockedReviewUrl,
  // the same predicate rebuild-all-reviews.js uses to exclude these from
  // scoring). BRO-2712: the Claude classifier below approved BOTH a venue
  // "what's on" page (southbank.london) and a PR firm's press release
  // (spincyclenyc.com) as legitimate reviews — 2/2 on this exact class. A
  // deterministic host check ahead of the LLM call closes that reliability
  // gap for every domain we already know about, and skips the API call.
  if (isBlockedReviewUrl(submissionData.reviewUrl)) {
    return {
      isValid: false,
      error: 'This URL is on a known non-review domain (ticket/listing/social/reference/venue/PR-firm site), not a theater review outlet.',
      recommendation: 'reject',
      submissionData,
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

  // Check if user-provided show name matches our database. A title can match
  // multiple productions (different markets/eras), so keep every candidate —
  // not just the first — for the LLM prompt and duplicate check below.
  let matchedShowCandidates = [];
  if (submissionData.showName) {
    matchedShowCandidates = findMatchingShows(submissionData.showName);
    if (matchedShowCandidates.length) {
      console.log(`Matched show candidates: ${matchedShowCandidates.map(s => `${s.title} (${s.id})`).join(', ')}`);

      // Re-check duplicate against every candidate show ID
      for (const candidate of matchedShowCandidates) {
        const showDuplicateCheck = checkDuplicateReview(submissionData.reviewUrl, candidate.id);
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
  }
  const matchedShow = matchedShowCandidates[0] || null;
  const matchedOutlet = findMatchingOutletByDomain(submissionData.reviewUrl);
  if (matchedOutlet) {
    console.log(`Matched outlet by domain: ${matchedOutlet.displayName} (${matchedOutlet.id})`);
  }
  const matchedCritic = findMatchingCritic(submissionData.criticName);
  if (matchedCritic) {
    console.log(`Matched critic: ${matchedCritic.displayName || matchedCritic.id} (knownOutlets: ${(matchedCritic.knownOutlets || []).join(', ')})`);
  }

  // Use Claude API for intelligent validation
  console.log('Validating with Claude API...');
  const claudeValidation = await validateWithClaude(submissionData, matchedShowCandidates, matchedOutlet, matchedCritic);

  console.log('Claude validation result:', JSON.stringify(claudeValidation, null, 2));

  // Guard: an 'approve' recommendation must resolve to a real database show id,
  // otherwise the downstream scrape job (which gates on approve and needs a
  // showId to ingest) fails AFTER the submitter already got an approval email.
  // Fall back to the deterministic title match ONLY when it's unambiguous
  // (exactly one candidate) — multiple same-title candidates (e.g. two
  // "Golden Boy" productions) must not be silently guessed.
  if (claudeValidation.recommendation === 'approve') {
    const llmShowId = claudeValidation.extractedData?.showId;
    const resolvedId =
      (llmShowId && shows.some(s => s.id === llmShowId) && llmShowId) ||
      (matchedShowCandidates.length === 1 ? matchedShowCandidates[0].id : null) ||
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
