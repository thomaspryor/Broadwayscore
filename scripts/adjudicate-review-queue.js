#!/usr/bin/env node

/**
 * Adjudicate Review Queue
 *
 * Auto-resolves flagged reviews where LLM scores disagree with aggregator thumbs.
 * Reads needs-human-review.json (produced by rebuild-all-reviews.js at 4 AM),
 * calls Claude Sonnet to re-evaluate each review, and writes humanReviewScore
 * to source files when confident.
 *
 * After 3 uncertain adjudication attempts, auto-accepts the LLM original score
 * to permanently clear the review from the queue.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { isLondonMarket } = require('./lib/venue-classification');
const { KNOWN_STAR_OUTLETS, buildUserPrompt } = require('./lib/adjudication-prompt');
const { shouldSkipWrongProductionAudit } = require('./lib/review-guards');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const QUEUE_FILE = path.join(ROOT, 'data', 'audit', 'needs-human-review.json');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const SHOWS_FILE = path.join(ROOT, 'data', 'shows.json');

const MAX_ADJUDICATION_ATTEMPTS = 3;
const DRY_RUN = process.argv.includes('--dry-run');

// Bucket score ranges (from scripts/llm-scoring/config.ts)
const BUCKET_RANGES = {
  Rave: { min: 83, max: 100 },
  Positive: { min: 70, max: 82 },
  Mixed: { min: 55, max: 69 },
  Negative: { min: 35, max: 54 },
  Pan: { min: 0, max: 34 }
};

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Build the adjudication system prompt
 */
function buildSystemPrompt() {
  return `You are an expert Broadway theater review adjudicator. Your job is to resolve disagreements between an automated LLM scoring system and human aggregator editors about how positive or negative a review is.

## Context

Broadway Scorecard aggregates critic reviews and scores them 0-100. When the LLM score and aggregator thumbs (Up/Flat/Down) disagree, the review is flagged for adjudication.

## Your Task

Read the review text carefully and determine the correct sentiment bucket and score.

## Scoring Buckets

| Bucket | Score Range | Description |
|--------|-------------|-------------|
| Rave | 83-100 | Enthusiastic, must-see recommendation |
| Positive | 70-82 | Recommends seeing it |
| Mixed | 55-69 | Neither recommends nor discourages |
| Negative | 35-54 | Does not recommend |
| Pan | 0-34 | Strongly negative |

## Important Guidelines

1. **VERDICT OVER SETUP**: Many reviews open negatively before delivering a positive verdict. Score the FINAL RECOMMENDATION.
2. **Aggregator editors read the full review** — their thumbs (Up/Down/Flat) carry real weight.
3. **BUT: Meh/Flat thumbs were wrong 83% of the time** in our audit. Be skeptical of Flat thumbs.
4. **PERFORMER PRAISE DOES NOT REDEEM A PAN** — score the overall verdict, not the best element.
5. **Star ratings override language** — if a critic gave 4/5 stars but sounds measured, trust the stars. (Only included when the outlet is known to publish its own star ratings.)
6. **Excerpt-only reviews are harder** — if you only have a short excerpt, acknowledge uncertainty.

## Output Format

Respond with ONLY this JSON (no markdown fences):
{
  "bucket": "Positive",
  "score": 78,
  "confidence": "high",
  "sidedWith": "thumbs",
  "reasoning": "1-2 sentence explanation"
}

Confidence levels:
- **high**: Clear verdict, unambiguous tone, confident in bucket placement
- **medium**: Some ambiguity but overall direction is clear
- **low**: Genuinely uncertain — mixed signals, insufficient text, or truncated review`;
}

/**
 * Parse Claude's response into a structured result
 */
function parseResponse(text) {
  try {
    // Try parsing as JSON directly
    const cleaned = text.trim().replace(/^```json?\s*/, '').replace(/\s*```$/, '');
    const result = JSON.parse(cleaned);

    // Validate required fields
    if (!result.bucket || result.score == null || !result.confidence) {
      return null;
    }

    // Validate bucket
    if (!BUCKET_RANGES[result.bucket]) {
      return null;
    }

    // Clamp score to bucket range
    const range = BUCKET_RANGES[result.bucket];
    result.score = Math.max(range.min, Math.min(range.max, Math.round(result.score)));

    return result;
  } catch {
    return null;
  }
}

/**
 * Call Claude Sonnet for adjudication
 */
async function adjudicateReview(review, sourceData, showTitle) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 300,
        temperature: 0.3,
        system: buildSystemPrompt(),
        messages: [{
          role: 'user',
          content: buildUserPrompt(review, sourceData, showTitle),
        }],
      });

      const responseText = message.content[0].text;
      return parseResponse(responseText);
    } catch (err) {
      const isRetryable = err.status === 429 || err.status >= 500 ||
        err.message?.includes('overloaded') || err.message?.includes('ECONNRESET');
      if (isRetryable && attempt < 2) {
        console.log(`    API error (${err.status || err.message}), retrying in ${(attempt + 1) * 5}s...`);
        await new Promise(r => setTimeout(r, (attempt + 1) * 5000));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Find the source file path for a flagged review
 */
function findSourceFile(review) {
  const showDir = path.join(REVIEW_TEXTS_DIR, review.showId);
  if (!fs.existsSync(showDir)) return null;

  // Build expected filename
  const outletId = review.outletId;
  const criticName = review.criticName;

  if (!outletId || !criticName) return null;

  // Normalize critic name to kebab-case (file naming convention)
  const kebabCritic = criticName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const filename = `${outletId}--${kebabCritic}.json`;
  const filePath = path.join(showDir, filename);

  if (fs.existsSync(filePath)) return filePath;

  // Try case-insensitive fallback with original name
  const files = fs.readdirSync(showDir);
  const origFilename = `${outletId}--${criticName}.json`;
  const match = files.find(f => f.toLowerCase() === origFilename.toLowerCase());
  if (match) return path.join(showDir, match);

  // Try matching just the outlet prefix + kebab critic
  const outletMatch = files.find(f => f.startsWith(outletId + '--') && f.toLowerCase().includes(kebabCritic));
  if (outletMatch) return path.join(showDir, outletMatch);

  return null;
}

/**
 * Main execution
 */
async function main() {
  console.log('🔍 Review Queue Adjudication\n');

  if (DRY_RUN) {
    console.log('  DRY RUN — no files will be modified\n');
  }

  // Check API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is required');
    process.exit(1);
  }

  // Load queue
  if (!fs.existsSync(QUEUE_FILE)) {
    console.log('No queue file found. Nothing to adjudicate.');
    process.exit(0);
  }

  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));

  if (!queue.reviews || queue.reviews.length === 0) {
    console.log('Queue is empty. Nothing to adjudicate.');
    process.exit(0);
  }

  console.log(`Found ${queue.reviews.length} flagged review(s) in queue.\n`);

  // Load shows for title + category lookup
  const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf-8'));
  const showTitleMap = {};
  const showCategoryMap = {};
  for (const show of showsData.shows) {
    showTitleMap[show.id] = show.title;
    showCategoryMap[show.id] = show.category || 'broadway';
  }

  // Process each flagged review
  const results = {
    resolved: 0,
    skipped: 0,
    autoAccepted: 0,
    errors: 0,
    missingFile: 0,
  };
  const changedFiles = [];

  for (const review of queue.reviews) {
    const label = `${review.showId} / ${review.outletId}--${review.criticName || 'unknown'}`;
    console.log(`\n--- ${label}`);

    // Find source file
    const filePath = findSourceFile(review);
    if (!filePath) {
      console.log('  ⚠️  Source file not found — skipping');
      results.missingFile++;
      continue;
    }

    // Load source data
    let sourceData;
    try {
      sourceData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      console.log(`  ⚠️  Failed to parse source file: ${err.message}`);
      results.errors++;
      continue;
    }

    // Skip if already has humanReviewScore (resolved outside this script)
    if (sourceData.humanReviewScore && sourceData.humanReviewScore >= 1) {
      console.log(`  ⏭️  Already has humanReviewScore (${sourceData.humanReviewScore}) — skipping`);
      results.skipped++;
      continue;
    }

    // Skip if already resolved as wrongProduction or verified clean
    if (sourceData.wrongProduction === true || sourceData.tourCheckVerified) {
      console.log(`  ⏭️  Already resolved (wrongProduction=${sourceData.wrongProduction}, tourCheckVerified=${sourceData.tourCheckVerified}) — skipping`);
      results.skipped++;
      continue;
    }

    // Contamination flags need a different adjudication approach:
    // For tour/film/TV flags, we need to determine if this is a Broadway review or not,
    // not score it. Use Claude to make a binary decision.
    if (review.reason === 'possible-tour-fulltext' || review.reason === 'possible-film-tv-fulltext') {
      if (DRY_RUN) {
        console.log(`  [DRY RUN] Would adjudicate contamination flag: ${review.reason}`);
        results.skipped++;
        continue;
      }

      const text = sourceData.fullText || sourceData.dtliExcerpt || sourceData.bwwExcerpt || '';
      if (!text || text.length < 50) {
        console.log(`  ⚠️  No text to adjudicate contamination — skipping`);
        results.skipped++;
        continue;
      }

      try {
        const showCategory = showCategoryMap[review.showId] || 'broadway';
        const expectedType = showCategory === 'off-broadway' ? 'Off-Broadway'
          : showCategory === 'west-end' ? 'West End'
          : showCategory === 'off-west-end' ? 'Off-West End'
          : 'Broadway';
        const wrongTypes = showCategory === 'off-broadway'
          ? 'national tour, regional theater, film/TV adaptation, streaming special, or a BROADWAY (not Off-Broadway) production'
          : isLondonMarket(showCategory)
          ? 'national tour, regional theater, film/TV adaptation, streaming special, or a Broadway/Off-Broadway (not West End) production'
          : 'national tour, regional theater, pre-Broadway tryout, film/TV adaptation, streaming special';
        const contaminationPrompt = `You are a theater review classifier. Determine if this review is about a **${expectedType}** production or a NON-${expectedType.toUpperCase()} production (${wrongTypes}).

**Show:** ${sourceData.showId}
**Expected production type:** ${expectedType}
**Outlet:** ${sourceData.outlet || review.outletId}
**Flag reason:** ${review.reason} — ${review.detail || ''}

**Review text (first 1500 chars):**
${text.slice(0, 1500)}

A FORWARD-LOOKING mention of a future tour ("before it embarks on a national tour", "which will then transfer to...", "ahead of its upcoming tour") is NOT evidence this review is ABOUT a tour production — it is background context in a review of the CURRENT ${expectedType} run. Only mark "wrong-market" when the review's own opinion-bearing content (the critic's actual assessment) is evaluating a performance the critic attended at a different venue/production — not when it merely name-checks a later tour in passing.

Respond with ONLY this JSON (no markdown fences):
{
  "verdict": "correct-market" or "wrong-market",
  "confidence": "high" or "medium" or "low",
  "reasoning": "1-2 sentence explanation",
  "productionType": "broadway" or "off-broadway" or "west-end" or "national-tour" or "regional" or "pre-broadway" or "film-tv" or "other"
}`;
        let resp;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const message = await anthropic.messages.create({
              model: 'claude-sonnet-4-5-20250929',
              max_tokens: 300,
              temperature: 0.2,
              messages: [{ role: 'user', content: contaminationPrompt }],
            });
            resp = message.content[0].text;
            break;
          } catch (apiErr) {
            const isRetryable = apiErr.status === 429 || apiErr.status >= 500 ||
              apiErr.message?.includes('overloaded') || apiErr.message?.includes('ECONNRESET');
            if (isRetryable && attempt < 2) {
              console.log(`    API error (${apiErr.status || apiErr.message}), retrying in ${(attempt + 1) * 5}s...`);
              await new Promise(r => setTimeout(r, (attempt + 1) * 5000));
              continue;
            }
            throw apiErr;
          }
        }
        if (!resp) throw new Error('All retry attempts failed');

        const result = JSON.parse(resp);

        // Normalize verdict from both old and new format
        const isWrongMarket = result.verdict === 'wrong-market' || result.verdict === 'not-broadway';
        if (result.confidence === 'high' || result.confidence === 'medium') {
          if (isWrongMarket) {
            // Honor manual clears — don't re-flag a human-verified review.
            if (shouldSkipWrongProductionAudit(sourceData)) {
              console.log(`  ⏭️  Skipping wrongProduction set — file has manual-clear breadcrumb`);
              results.skipped++;
              continue;
            }
            // CV-affirms bailout (#651, Heathers zafar-arif FP): when the
            // file's own contentVerification already confirmed — high
            // confidence — that this review IS of the current production
            // (not wrongProduction, not wrongArticle), a Sonnet contamination
            // classifier's "wrong-market" verdict off a 1500-char excerpt is
            // more likely a false positive than CV's full-text pass. Defer
            // to CV instead of overwriting it.
            const cv = sourceData.contentVerification;
            const cvAffirmsProduction = cv && cv.isValid === true && cv.confidence === 'high'
              && cv.wrongProduction !== true && cv.wrongArticle !== true;
            if (cvAffirmsProduction) {
              console.log(`  ⏭️  Skipping wrongProduction set — contentVerification already affirms this production (${cv.verifiedBy}, high confidence)`);
              sourceData.tourCheckVerified = 'false-positive';
              sourceData.tourCheckNote = `Auto-adjudicated wrong-market verdict overridden by CV affirmation: ${cv.reasoning ? cv.reasoning.slice(0, 200) : 'CV isValid=true, high confidence'}`;
              fs.writeFileSync(filePath, JSON.stringify(sourceData, null, 2) + '\n');
              console.log(`  ✅ Contamination adjudicated: correct-market (CV override) — ${result.reasoning}`);
              results.resolved++;
              await new Promise(resolve => setTimeout(resolve, 1000));
              continue;
            }
            sourceData.wrongProduction = true;
            sourceData.wrongProductionNote = `Auto-adjudicated: ${result.productionType}. ${result.reasoning}`;
          } else {
            sourceData.tourCheckVerified = 'false-positive';
            sourceData.tourCheckNote = `Auto-adjudicated: legitimate ${expectedType} review. ${result.reasoning}`;
          }
          fs.writeFileSync(filePath, JSON.stringify(sourceData, null, 2) + '\n');
          console.log(`  ✅ Contamination adjudicated: ${result.verdict} (${result.confidence}) — ${result.reasoning}`);
          results.resolved++;
        } else {
          sourceData.adjudicationAttempts = (sourceData.adjudicationAttempts || 0) + 1;
          fs.writeFileSync(filePath, JSON.stringify(sourceData, null, 2) + '\n');
          console.log(`  ❓ Low confidence — attempt ${sourceData.adjudicationAttempts}, skipping`);
          results.skipped++;
        }
      } catch (err) {
        console.log(`  ⚠️  Contamination adjudication failed: ${err.message}`);
        results.errors++;
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }

    const attempts = sourceData.adjudicationAttempts || 0;

    // Check max attempts — auto-accept LLM score
    // NOTE: Do NOT use humanReviewScore here — that's reserved for actual human overrides.
    // Using it makes the LLM score permanent and blocks future rescoring.
    if (attempts >= MAX_ADJUDICATION_ATTEMPTS) {
      const llmScore = review.llmScore || (sourceData.llmScore && sourceData.llmScore.score) || 65;
      console.log(`  🔄 Max attempts reached (${attempts}) — auto-accepting LLM score: ${llmScore}`);

      if (!DRY_RUN) {
        sourceData.adjudicatedScore = llmScore;
        sourceData.adjudicationNote = `Auto-accepted after ${MAX_ADJUDICATION_ATTEMPTS} uncertain adjudications - LLM original score retained`;
        sourceData.humanReviewAt = new Date().toISOString();
        sourceData.adjudicationAttempts = attempts;

        fs.writeFileSync(filePath, JSON.stringify(sourceData, null, 2) + '\n');
        changedFiles.push(filePath);
      }

      results.autoAccepted++;
      continue;
    }

    // Call Claude for adjudication
    const showTitle = showTitleMap[review.showId] || review.showId;
    let result;

    try {
      result = await adjudicateReview(review, sourceData, showTitle);
    } catch (err) {
      console.log(`  ❌ API error: ${err.message}`);
      // Don't increment adjudicationAttempts on API errors (transient failure)
      results.errors++;
      continue;
    }

    if (!result) {
      console.log('  ❌ Failed to parse Claude response');
      results.errors++;
      continue;
    }

    console.log(`  Claude says: ${result.bucket} (${result.score}), confidence: ${result.confidence}, sided with: ${result.sidedWith || 'N/A'}`);
    console.log(`  Reasoning: ${result.reasoning || 'N/A'}`);

    // Build attempt record
    const attemptRecord = {
      timestamp: new Date().toISOString(),
      bucket: result.bucket,
      score: result.score,
      confidence: result.confidence,
      sidedWith: result.sidedWith || null,
      reasoning: result.reasoning || null,
    };

    if (result.confidence === 'high' || result.confidence === 'medium') {
      // Confident — write adjudicated score
      // NOTE: Use adjudicatedScore, NOT humanReviewScore. humanReviewScore is reserved
      // for actual human overrides. Using it here makes LLM scores permanent and blocks
      // future rescoring and manual corrections.
      console.log(`  ✅ Confident adjudication — writing adjudicatedScore: ${result.score}`);

      if (!DRY_RUN) {
        sourceData.adjudicatedScore = result.score;
        sourceData.adjudicationNote = `Auto-adjudicated (${result.confidence} confidence, sided with ${result.sidedWith || 'analysis'}): ${result.reasoning || ''}`.trim();
        sourceData.adjudicationPreviousScore = review.llmScore || (sourceData.llmScore && sourceData.llmScore.score) || null;
        sourceData.humanReviewAt = new Date().toISOString();
        sourceData.adjudicationAttempts = attempts + 1;
        sourceData.adjudicationHistory = [
          ...(sourceData.adjudicationHistory || []),
          attemptRecord,
        ];

        fs.writeFileSync(filePath, JSON.stringify(sourceData, null, 2) + '\n');
        changedFiles.push(filePath);
      }

      results.resolved++;
    } else {
      // Low confidence — skip, increment attempts
      console.log(`  ⏳ Low confidence — skipping (attempt ${attempts + 1}/${MAX_ADJUDICATION_ATTEMPTS})`);

      if (!DRY_RUN) {
        sourceData.adjudicationAttempts = attempts + 1;
        sourceData.adjudicationHistory = [
          ...(sourceData.adjudicationHistory || []),
          attemptRecord,
        ];

        fs.writeFileSync(filePath, JSON.stringify(sourceData, null, 2) + '\n');
        changedFiles.push(filePath);
      }

      results.skipped++;
    }

    // Rate limiting — 1 second between API calls
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Summary
  console.log('\n\n=== ADJUDICATION SUMMARY ===\n');
  console.log(`  Resolved (confident):  ${results.resolved}`);
  console.log(`  Skipped (low conf):    ${results.skipped}`);
  console.log(`  Auto-accepted (max):   ${results.autoAccepted}`);
  console.log(`  Missing source file:   ${results.missingFile}`);
  console.log(`  Errors:                ${results.errors}`);
  console.log(`  Files changed:         ${changedFiles.length}`);

  if (DRY_RUN) {
    console.log('\n  DRY RUN — no files were modified');
  }

  // Write summary for GitHub Actions
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      '## Review Queue Adjudication Results',
      '',
      `| Metric | Count |`,
      `|--------|-------|`,
      `| Resolved (confident) | ${results.resolved} |`,
      `| Skipped (low confidence) | ${results.skipped} |`,
      `| Auto-accepted (max attempts) | ${results.autoAccepted} |`,
      `| Missing source file | ${results.missingFile} |`,
      `| Errors | ${results.errors} |`,
      `| Files changed | ${changedFiles.length} |`,
      '',
      DRY_RUN ? '*Dry run — no files modified*' : '',
    ].join('\n');

    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }

  // Return changed count for CI use
  console.log(`\n::set-output name=changed_count::${changedFiles.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
