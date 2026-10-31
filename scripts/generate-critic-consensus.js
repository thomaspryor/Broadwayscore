#!/usr/bin/env node

/**
 * Generate Critics' Take for all shows using Claude API
 * Concise 1-2 sentence summaries (max 280 chars) capturing critical reception
 */

import models from './lib/models.js';
const { COPY_SONNET } = models;
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
// The scored-review floor below which a Critics' Take is not generated. Shared
// with opening-night-checks/critics-take-present.check.js so the check cannot
// demand a consensus this script is coded to refuse (task #389).
import { MIN_SCORED_REVIEWS, MAX_STALE_PRUNE, isConsensusEligible, liveScoredCounts, staleConsensusIds, pruneConsensusEntries, liveOutletKeys } from './lib/critic-consensus-eligibility.js';
import { finalResponseText, describeResponse } from './lib/anthropic-response-text.js';
import { loadReviewTexts as loadConsensusInputs, consensusFingerprint } from './lib/critic-consensus-inputs.js';
import { requestWithRefusalRetry, REFUSAL_RETRY_EXCERPT_CHARS } from './lib/critic-consensus-refusal.js';
// --shows=a,b / --show=a filter (BRO-4595). List form lets the opening-night
// poller dispatch update-critic-consensus.yml ONCE for every polled show; its
// concurrency group keeps a single pending run, so per-show dispatches were
// cancelling each other (56 of 58 lost on 2026-10-04).
import { parseShowListArg, describeShowFilter } from './lib/parse-show-list-arg.js';
import reviewNormalization from './lib/review-normalization.js';
const { normalizeOutlet } = reviewNormalization;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const SHOWS_FILE = path.join(ROOT, 'data', 'shows.json');
const CONSENSUS_FILE = path.join(ROOT, 'data', 'critic-consensus.json');
const REVIEWS_FILE = path.join(ROOT, 'data', 'reviews.json');

// Lazy: --prune-only runs in rebuild-fast with no ANTHROPIC_API_KEY (BRO-4960).
let anthropicClient = null;
const anthropic = {
  messages: {
    create: (...args) => {
      anthropicClient = anthropicClient || new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      return anthropicClient.messages.create(...args);
    },
  },
};

// loadReviewTexts / consensusFingerprint live in scripts/lib so the
// contamination audit counts the same inputs this script stores (BRO-4869).
function loadReviewTexts(showId, liveOutlets = null) {
  return loadConsensusInputs(showId, liveOutlets, {
    onWarn: (msg) => console.warn(`  ⚠️  ${msg}`),
    normalizeOutlet,
  });
}

/**
 * The reply text, or a clear error. content[0].text crashed with "Cannot read
 * properties of undefined (reading 'text')" when a reply came back with no
 * text block (wicked-tour-2021, BRO-4852), hiding the reason.
 */
function responseText(message) {
  const text = finalResponseText(message && message.content).trim();
  if (!text) throw new Error(`empty Claude reply (${describeResponse(message)})`);
  return text;
}

/** Thrown when Claude refuses twice: the caller keeps the stored take. */
class ConsensusRefusedError extends Error {}

/**
 * One consensus request with the refusal policy from
 * scripts/lib/critic-consensus-refusal.js: a refusal (empty reply,
 * stop_reason=refusal) is retried once with ~250-char excerpts and quoted
 * lyrics removed; a second refusal throws ConsensusRefusedError
 * (wicked-tour-2021, BRO-4869).
 * @param {(excerpts: string) => string} buildPrompt
 * @returns {Promise<{text: string, excerptOpts: object, attempt: number}>}
 */
async function requestConsensus(reviews, buildPrompt, temperature, startAttempt = 0) {
  const { outcome, message, excerptOpts, attempt } = await requestWithRefusalRetry({
    create: (params) => anthropic.messages.create(params),
    reviews,
    buildPrompt,
    params: { model: COPY_SONNET, max_tokens: 150, temperature },
    startAttempt,
    onRetry: (msg) => console.warn(`  ⚠️  Claude refused (${describeResponse(msg)}) — retrying once with ${REFUSAL_RETRY_EXCERPT_CHARS}-char excerpts, quoted lyrics removed`),
    pause: () => new Promise(resolve => setTimeout(resolve, 1000)),
  });
  if (outcome === 'keep-old') {
    throw new ConsensusRefusedError(`Claude refused again with ${REFUSAL_RETRY_EXCERPT_CHARS}-char lyric-free excerpts (${describeResponse(message)})`);
  }
  return { text: responseText(message), excerptOpts, attempt };
}

/**
 * Generate consensus using Claude API
 */
async function generateConsensus(showTitle, reviews) {
  const buildPrompt = (reviewSummaries) => `You are writing a "Critics' Take" for the Broadway show "${showTitle}" - a very concise editorial summary capturing the critical reception.

Based on these ${reviews.length} critic reviews, write a brief summary (1-2 SHORT sentences, maximum 280 characters total) that captures the overall critical reception. The summary should:
- Be VERY concise and punchy (like a tweet)
- Maximum 280 characters total - keep it brief!
- Capture the general sentiment (positive, mixed, or negative)
- Mention 1-2 specific praised/criticized elements if space allows
- Be objective and factual, not promotional
- Use present tense
- Not mention specific critic names or outlets
- Get straight to the point - no unnecessary words

Reviews:
${reviewSummaries}

Write only the concise consensus (max 280 chars), nothing else.`;

  const result = await requestConsensus(reviews, buildPrompt, 0.7);
  const consensus = result.text;

  // Validate length and sentence count
  const sentenceCount = (consensus.match(/[.!?]+/g) || []).length;
  if (consensus.length > 300) {
    console.warn(`  ⚠️  Generated ${consensus.length} chars (target: 280 max), but proceeding...`);
  }
  if (sentenceCount > 2) {
    console.warn(`  ⚠️  Generated ${sentenceCount} sentences (target: 1-2), but proceeding...`);
  }

  return result;
}

/**
 * Determine if a show's consensus should be regenerated.
 * Returns { should: boolean, reason: string }
 */
function shouldRegenerate(existing, reviews) {
  if (!existing) return { should: true, reason: 'new show (no existing consensus)' };

  const currentReviewCount = reviews.length;
  const currentFullTextCount = reviews.filter(r => r.hasFullText).length;
  const scoredReviews = reviews.filter(r => r.score != null);
  const currentMeanScore = scoredReviews.length > 0
    ? Math.round(scoredReviews.reduce((a, r) => a + r.score, 0) / scoredReviews.length)
    : null;

  // Trigger 1: New reviews added (existing behavior)
  const reviewCountDiff = currentReviewCount - (existing.reviewCount || 0);
  if (reviewCountDiff >= 3) {
    return { should: true, reason: `${reviewCountDiff} new reviews` };
  }

  // Trigger 2: Full text upgrades (excerpt → full text)
  if (existing.fullTextCount != null) {
    const fullTextGain = currentFullTextCount - existing.fullTextCount;
    if (fullTextGain >= 3) {
      return { should: true, reason: `${fullTextGain} reviews upgraded to full text` };
    }
  }

  // Trigger 3: Reviews removed (wrongProduction flags, etc.)
  if (reviewCountDiff <= -2) {
    return { should: true, reason: `${Math.abs(reviewCountDiff)} reviews removed` };
  }

  // Trigger 4: Mean score drift (rescoring, rave calibration)
  if (existing.meanScore != null && currentMeanScore != null) {
    const scoreDrift = Math.abs(currentMeanScore - existing.meanScore);
    if (scoreDrift >= 8) {
      return { should: true, reason: `mean score shifted ${scoreDrift}pts (${existing.meanScore} → ${currentMeanScore})` };
    }
  }

  // Trigger 5: Bucket breakdown changed (e.g., review rescored from Mixed to Positive)
  if (existing.bucketBreakdown) {
    const currentBuckets = { positive: 0, mixed: 0, negative: 0 };
    for (const r of scoredReviews) {
      if (r.score >= 61) currentBuckets.positive++;
      else if (r.score >= 40) currentBuckets.mixed++;
      else currentBuckets.negative++;
    }
    const prev = existing.bucketBreakdown;
    if (prev.positive !== currentBuckets.positive || prev.mixed !== currentBuckets.mixed || prev.negative !== currentBuckets.negative) {
      return { should: true, reason: `bucket breakdown changed (P:${prev.positive}/M:${prev.mixed}/N:${prev.negative} → P:${currentBuckets.positive}/M:${currentBuckets.mixed}/N:${currentBuckets.negative})` };
    }
  }

  return { should: false };
}

/**
 * Main execution
 */
async function main() {
  console.log('🎭 Generating Critics\' Take for all shows...\n');

  // Load existing data
  const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf-8'));
  const consensusData = fs.existsSync(CONSENSUS_FILE)
    ? JSON.parse(fs.readFileSync(CONSENSUS_FILE, 'utf-8'))
    : { _meta: {}, shows: {} };

  if (!process.argv.includes('--prune-only') && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required (only --prune-only runs without it)');
  }
  const force = process.argv.includes('--force');
  const cleanupOrphans = process.argv.includes('--cleanup-orphans');
  // --prune-only: drop stale + orphaned entries, write, exit before any LLM call.
  const pruneOnly = process.argv.includes('--prune-only');

  // Parse --shows=a,b / --show=a filter: Set of requested ids, or null for a
  // whole scan (single-show mode for opening-night remediation; list mode for
  // the poller's one-dispatch-per-cycle batch, BRO-4595).
  const showFilter = parseShowListArg(process.argv.slice(2));

  // Parse --max-shows=N cap (cost control)
  const maxShowsArg = process.argv.find(a => a.startsWith('--max-shows='));
  const maxShows = maxShowsArg ? parseInt(maxShowsArg.split('=')[1], 10) : 0; // 0 = unlimited

  const filterDesc = describeShowFilter(showFilter);
  if (filterDesc) console.log(`🎯 ${filterDesc}\n`);
  if (showFilter && showFilter.size === 0) {
    // A filter flag with no usable IDs is a no-op: return before the final
    // write so push-core-data has nothing to commit and no deploy is
    // dispatched for a run that changed nothing.
    console.log('Nothing to do — exiting without touching the consensus file.');
    return;
  }
  if (maxShows > 0) console.log(`📊 Max shows cap: ${maxShows}\n`);

  let processedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  // Build show ID set for existence checks
  const showIdSet = new Set(showsData.shows.map(s => s.id));
  if (showFilter) {
    const unknown = [...showFilter].filter(id => !showIdSet.has(id));
    if (unknown.length) {
      console.warn(`⚠️  ${unknown.length} requested show id(s) not in shows.json (skipped): ${unknown.join(', ')}`);
    }
  }
  const showStatusMap = {};
  for (const s of showsData.shows) {
    showStatusMap[s.id] = s.status;
  }

  // Live scored reviews per show, from reviews.json (what the site shows).
  // null = unreadable: fall back to the review-texts count alone (BRO-4852).
  let liveCounts = null;
  let liveOutlets = null;
  try {
    const reviewsJson = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf-8'));
    liveCounts = liveScoredCounts(reviewsJson);
    liveOutlets = liveOutletKeys(reviewsJson);
  } catch { liveCounts = null; liveOutlets = null; }

  if (pruneOnly) {
    const counts = liveCounts;
    if (!counts) {
      console.warn('::warning::consensus prune-only skipped: reviews.json unreadable');
      return;
    }
    const { stale, orphans, capped } = pruneConsensusEntries(consensusData.shows, counts, showIdSet);
    if (capped) {
      console.warn(`::warning::consensus prune skipped: ${stale.length} entries look stale (cap ${MAX_STALE_PRUNE}), reviews.json is probably incomplete`);
      return;
    }
    if (!stale.length && !orphans.length) {
      console.log('Nothing to prune.');
      return;
    }
    console.log(`🗑️  Pruned ${stale.length} stale, ${orphans.length} orphaned consensus entries: ${[...stale, ...orphans].join(', ')}`);
    fs.writeFileSync(CONSENSUS_FILE, JSON.stringify(consensusData, null, 2));
    return;
  }

  // Prune every consensus whose show has too few live reviews, whatever the
  // --show filter: no LLM call, and a blurb outliving its reviews is wrong on
  // the page today (BRO-4852).
  if (liveCounts) {
    const stale = staleConsensusIds(consensusData.shows, liveCounts);
    if (stale.length > MAX_STALE_PRUNE) {
      // A truncated reviews.json would otherwise wipe every Critics' Take.
      console.warn(`::warning::consensus prune skipped: ${stale.length} entries look stale (cap ${MAX_STALE_PRUNE}), reviews.json is probably incomplete`);
      liveCounts = null;
      liveOutlets = null;
    } else if (stale.length) {
      console.log(`🗑️  Removing ${stale.length} consensus entr${stale.length === 1 ? 'y' : 'ies'} with fewer than ${MIN_SCORED_REVIEWS} live reviews: ${stale.join(', ')}`);
      for (const id of stale) delete consensusData.shows[id];
    }
  }

  // Layer 5c: Orphan cleanup — remove consensus for shows not in shows.json
  {
    const orphanIds = Object.keys(consensusData.shows).filter(id => !showIdSet.has(id));
    if (orphanIds.length > 0) {
      if (cleanupOrphans) {
        console.log(`🧹 Removing ${orphanIds.length} orphaned consensus entries:`);
        for (const id of orphanIds) {
          console.log(`  - ${id}`);
          delete consensusData.shows[id];
        }
      } else {
        console.log(`⚠️  Found ${orphanIds.length} orphaned consensus entries (show not in shows.json):`);
        orphanIds.slice(0, 5).forEach(id => console.log(`  - ${id}`));
        if (orphanIds.length > 5) console.log(`  ... and ${orphanIds.length - 5} more`);
        console.log('  Run with --cleanup-orphans to remove them.\n');
      }
    }
  }

  for (let i = 0; i < showsData.shows.length; i++) {
    const show = showsData.shows[i];
    const showId = show.id;
    const showTitle = show.title;

    // --shows/--show filter: skip shows not in the requested set
    if (showFilter && !showFilter.has(showId)) continue;

    // Max shows cap: stop after N generations
    if (maxShows > 0 && processedCount >= maxShows) {
      console.log(`\n⚠️  Reached max-shows cap (${maxShows}). Stopping.`);
      if (showFilter) {
        // Name what the cap dropped so a truncated batch is visible in the run
        // log instead of silently losing shows (BRO-4595).
        // "Not evaluated", not "dropped": some of these would have been
        // skipped anyway (below the review floor, no texts, unchanged).
        const unreached = showsData.shows.slice(i).filter(s => showFilter.has(s.id)).map(s => s.id);
        if (unreached.length) {
          console.warn(`⚠️  ${unreached.length} requested show(s) not evaluated because the cap was reached first: ${unreached.join(', ')}`);
        }
      }
      break;
    }

    console.log(`\n📖 ${showTitle} (${showId})`);

    // Load reviews
    const reviews = loadReviewTexts(showId, liveOutlets);

    // Layer 5a: Input validation — minimum review threshold
    const scoredReviews = reviews.filter(r => r.score != null);
    const eligibleCount = liveCounts ? Math.min(scoredReviews.length, liveCounts.get(showId) || 0) : scoredReviews.length;
    if (!isConsensusEligible(eligibleCount)) {
      console.log(`  ⏭️  Skipped - only ${eligibleCount} scored reviews (need ${MIN_SCORED_REVIEWS}+)`);
      // Delete stale consensus if show dropped below threshold (any stored
      // count: a blurb stored with reviewCount 1 used to be kept forever)
      if (consensusData.shows[showId]) {
        console.log(`  🗑️  Removing stale consensus (reviews dropped below threshold)`);
        delete consensusData.shows[showId];
      }
      skippedCount++;
      continue;
    }

    // Layer 5a: Input validation — previews guard
    if (showStatusMap[showId] === 'previews' && scoredReviews.length === 0) {
      console.log(`  ⏭️  Skipped - previews show with 0 scored reviews`);
      skippedCount++;
      continue;
    }

    if (reviews.length === 0) {
      console.log(`  ⏭️  Skipped - no review texts available`);
      skippedCount++;
      continue;
    }

    // Check if we should regenerate (multi-trigger)
    const existing = consensusData.shows[showId];
    if (existing && !force) {
      const result = shouldRegenerate(existing, reviews);
      if (!result.should) {
        console.log(`  ⏭️  Skipped - no significant changes`);
        skippedCount++;
        continue;
      }
      console.log(`  🔄 Regenerating - ${result.reason}`);
    }

    try {
      // Generate consensus
      console.log(`  🤖 Generating consensus from ${reviews.length} reviews...`);
      const first = await generateConsensus(showTitle, reviews);
      let consensus = first.text;
      // Sentiment retries reuse the excerpt mode that got an answer: if the
      // full excerpts were refused, the corrective prompt starts lyric-free.
      const retryAttempt = first.attempt;

      // Layer 5b: Output validation — LLM refusal detection
      const REFUSAL_PATTERNS = [
        /I apologize/i,
        /I cannot provide/i,
        /I'm unable/i,
        /I can't generate/i,
        /based on these reviews/i,
        /I don't have enough/i,
        /As an AI/i,
      ];
      const isRefusal = REFUSAL_PATTERNS.some(p => p.test(consensus));
      if (isRefusal) {
        console.warn(`  ⚠️  LLM refusal detected — skipping: "${consensus.slice(0, 80)}..."`);
        errorCount++;
        continue;
      }

      // A corrective retry that fails (refused twice, API error, or a refusal
      // phrase in the text) keeps the first take (null) rather than failing
      // the show or replacing a good take.
      const correctiveRetry = async (buildPrompt) => {
        try {
          const text = (await requestConsensus(reviews, buildPrompt, 0.5, retryAttempt)).text;
          if (REFUSAL_PATTERNS.some(p => p.test(text))) {
            console.warn(`  ⚠️  Corrective retry looks like a refusal — keeping the first take: "${text.slice(0, 60)}..."`);
            return null;
          }
          return text;
        } catch (err) {
          console.warn(`  ⚠️  Corrective retry failed — keeping the first take: ${err.message}`);
          return null;
        }
      };

      // Layer 5b: Output validation — sentiment cross-check against review breakdown
      const breakdown = { positive: 0, mixed: 0, negative: 0 };
      for (const r of reviews) {
        if (r.score == null) continue;
        if (r.score >= 61) breakdown.positive++;
        else if (r.score >= 40) breakdown.mixed++;
        else breakdown.negative++;
      }
      const totalScored = breakdown.positive + breakdown.mixed + breakdown.negative;
      const allPositive = totalScored > 0 && breakdown.mixed === 0 && breakdown.negative === 0;
      const NEGATIVE_KEYWORDS = /\b(divided|split|mixed|dismiss|less compelling|not all|polariz)/i;
      const HEDGED_NEGATIVE = /\bthough (some|one|a few|critics?)(\s+critics?)? (find|note|dismiss|say|argue|feel)\w*/i;
      if (allPositive && (NEGATIVE_KEYWORDS.test(consensus) || HEDGED_NEGATIVE.test(consensus))) {
        console.warn(`  ⚠️  Sentiment mismatch: all ${totalScored} reviews are positive but text implies criticism — regenerating...`);
        // Retry once with an explicit instruction about the breakdown
        const retryPrompt = (excerpts) => `You are writing a "Critics' Take" for the Broadway show "${showTitle}".

IMPORTANT: All ${totalScored} reviews are POSITIVE (scores 61-100). Do NOT say critics are "divided", "mixed", or that "some find it less compelling." The consensus is clearly positive.

Based on these ${reviews.length} critic reviews, write a brief summary (1-2 SHORT sentences, maximum 280 characters total) that captures this positive reception. Mention 1-2 specific praised elements if space allows. Be concise, objective, and use present tense.

Reviews:
${excerpts}

Write only the concise consensus (max 280 chars), nothing else.`;
        const retryText = await correctiveRetry(retryPrompt);
        if (retryText == null) {
          // keep the first take
        } else if (!NEGATIVE_KEYWORDS.test(retryText) && !HEDGED_NEGATIVE.test(retryText)) {
          consensus = retryText;
          console.log(`  ✅ Retry succeeded — sentiment now matches breakdown`);
        } else {
          console.warn(`  ⚠️  Retry still has mismatch — using anyway: "${retryText.slice(0, 60)}..."`);
          consensus = retryText;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Layer 5b: Output validation — inverse check: mostly negative/mixed but text says unanimous praise
      const mostlyNegative = totalScored > 0 && (breakdown.negative + breakdown.mixed) >= totalScored * 0.5;
      const POSITIVE_KEYWORDS = /\b(universal acclaim|unanimous|universally praised|all praise|every critic|rave reviews|critics rave)\b/i;
      if (mostlyNegative && POSITIVE_KEYWORDS.test(consensus)) {
        console.warn(`  ⚠️  Inverse sentiment mismatch: ${breakdown.negative}N/${breakdown.mixed}M/${breakdown.positive}P but text implies unanimous praise — regenerating...`);
        const retryPrompt = (excerpts) => `You are writing a "Critics' Take" for the Broadway show "${showTitle}".

IMPORTANT: Reviews are mixed/negative (${breakdown.positive} positive, ${breakdown.mixed} mixed, ${breakdown.negative} negative out of ${totalScored}). Do NOT say "universal acclaim", "unanimous praise", or "critics rave." Reflect the actual divided or negative reception.

Based on these ${reviews.length} critic reviews, write a brief summary (1-2 SHORT sentences, maximum 280 characters total). Be concise, objective, and use present tense.

Reviews:
${excerpts}

Write only the concise consensus (max 280 chars), nothing else.`;
        const retryText = await correctiveRetry(retryPrompt);
        if (retryText != null) {
          consensus = retryText;
          console.log(`  ✅ Inverse retry complete`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Layer 5b: Output validation — length check (> 280 chars = too long)
      let finalText = consensus;
      if (consensus.length > 280) {
        console.warn(`  ⚠️  Generated ${consensus.length} chars (max 280) — truncating at sentence boundary`);
        const truncated = consensus.substring(0, 280);
        const lastSentence = truncated.lastIndexOf('.');
        finalText = lastSentence > 100 ? truncated.substring(0, lastSentence + 1) : truncated;
      }

      // Fingerprint for change detection on future runs; the contamination
      // audit rebuilds the same one from the same inputs (BRO-4869).
      const fingerprint = consensusFingerprint(reviews);

      consensusData.shows[showId] = {
        text: finalText,
        lastUpdated: new Date().toISOString(),
        ...fingerprint,
      };

      console.log(`  ✅ Generated: "${(consensusData.shows[showId].text).slice(0, 80)}..."`);
      processedCount++;

      // Rate limiting - wait 1 second between API calls
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (err) {
      if (err instanceof ConsensusRefusedError) {
        console.warn(`::warning::Critics' Take refused for ${showId}; ${existing ? 'keeping the existing take' : 'no take written'}: ${err.message}`);
      } else {
        console.error(`  ❌ Error: ${err.message}`);
      }
      errorCount++;
    }
  }

  // Update metadata and save
  consensusData._meta = {
    description: "LLM-generated Critics' Take summaries for shows (concise 1-2 sentence summary, max 280 chars)",
    lastGenerated: new Date().toISOString(),
    updatePolicy: "Auto-regenerate on: 3+ new reviews, 3+ full-text upgrades, 2+ reviews removed, or 8+ pt mean score drift",
  };

  fs.writeFileSync(CONSENSUS_FILE, JSON.stringify(consensusData, null, 2));

  console.log(`\n\n✅ Done!`);
  console.log(`   Processed: ${processedCount}`);
  console.log(`   Skipped: ${skippedCount}`);
  console.log(`   Errors: ${errorCount}`);
  if (maxShows > 0) console.log(`   Max shows cap: ${maxShows}`);
  console.log(`\n💾 Saved to: ${path.relative(ROOT, CONSENSUS_FILE)}`);

  if (force) {
    console.log(`\n💡 Used --force flag to regenerate all shows`);
  } else {
    console.log(`\n💡 Use --force to regenerate all shows regardless of triggers`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
