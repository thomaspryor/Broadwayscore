// Scoring Engine - Computes all scores from raw data using config
// Based on user's Google Sheet methodology
//
// REPEATABILITY GUARANTEE:
// - Same input data + same config = same output scores (deterministic)
// - No randomness, no time-based variations in scoring
// - All calculations use explicit, documented formulas

import {
  METHODOLOGY_VERSION,
  METHODOLOGY_DATE,
  COMPONENT_WEIGHTS,
  OUTLET_TIERS,
  TIER_WEIGHTS,
  DEFAULT_TIER,
  DESIGNATION_BUMPS,
  DESIGNATION_FLOORS,
  LETTER_GRADE_MAP,
  BUCKET_SCORE_MAP,
  THUMB_SCORE_MAP,
  AUDIENCE_PLATFORM_WEIGHTS,
  BUZZ_CONFIG,
  CONFIDENCE_THRESHOLDS,
  AUDIENCE_DIVERGENCE_THRESHOLD,
  getCriticLabel,
  SCORE_DISPLAY_YEAR_CUTOFF,
  MIN_HIGH_CONF_REVIEWS_PRE_CUTOFF,
  LOW_CONF_SCORE_SOURCES,
  shouldHideReviews,
} from '@/config/scoring';
import { getRegistryTier, getOutletRegistry } from './outlet-id-mapper';
// The one critic-score formula, shared with the slim-file generator (BRO-4312).
import { scoreReviews } from '../../scripts/lib/compute-critic-score';
import { normalizeShowStatus, effectiveShowStatus } from '../../scripts/lib/effective-status';

/** Per-review detail returned by scripts/lib/compute-critic-score.js scoreReviews(). */
interface SharedScoredReview {
  review: unknown;
  tier: number;
  tierWeight: number;
  reviewScore: number;
  confidenceWeight: number;
  outletShare: number;
  weightedScore: number;
}
import { getMarketDate } from './date-utils';
import { getReviewAgeYear } from './show-date-line';
import { stripInlineMarkdown } from './formatting';

// ===========================================
// TYPES
// ===========================================

export interface ShowImages {
  hero?: string;        // Full-width hero image (1920x1080 or similar)
  thumbnail?: string;   // Square thumbnail (400x400)
  poster?: string;      // Poster image (2:3 ratio)
}

export interface TicketLink {
  platform: string;     // TodayTix, Telecharge, Official, etc.
  url: string;
  priceFrom?: number;   // Starting price in dollars
  isOfficial?: boolean; // True = official box office vendor (lowest fees). See theatre-vendor mapping.
}

export interface CreativeMember {
  name: string;
  role: string;         // Director, Book, Music, Lyrics, Choreographer, etc.
}

// Earlier run of the same artistic production (returning transfer, revival
// of a limited run, etc). Re-includes that run's reviews on the current
// show page — see scripts/lib/wrong-production-autoclear.js findMatchingPriorRun.
export interface PriorRun {
  openingDate: string;
  closingDate?: string;
  venue?: string;
}

export interface RawShow {
  id: string;
  title: string;
  slug: string;
  venue: string;
  openingDate: string;
  closingDate: string | null;
  status: string;
  type: string;
  category?: string;  // 'broadway', 'off-broadway', 'west-end', etc — required at data-entry (validate-data.js); a missing value is treated as neither Broadway nor Off-Broadway, see data-core.ts isBroadwayShow()
  genre?: string;     // performance type beyond play/musical: dance/magic/comedy/cabaret/concert/circus (see src/lib/genre.ts)
  runtime: string;
  intermissions: number;
  images?: ShowImages;
  // New fields
  synopsis?: string;
  ageRecommendation?: string;  // e.g., "Ages 12+", "All ages"
  limitedRun?: boolean;        // true for shows with announced closing dates
  previewsStartDate?: string;  // First preview performance (for upcoming shows)
  firstRunStart?: string;      // BRO-4768: first performance of an earlier run of this same production (return engagement)
  ticketLinks?: TicketLink[];
  officialUrl?: string;
  trailerUrl?: string;
  creativeTeam?: CreativeMember[];
  tags?: string[];             // Musical, Comedy, Romance, New, etc.
  theaterAddress?: string;
  // Revival and historical tracking
  isRevival?: boolean;                 // true for revival productions
  originalProductionId?: string | null; // ID of the original production (e.g., "cabaret-1966")
  productionNumber?: number;            // 1 for original, 2 for first revival, etc.
  season?: string;                      // Broadway season (e.g., "2024-2025")
  // Transfer pair: regional tryout or Broadway <-> West End (reciprocal ids; validate-data enforces).
  transferOf?: string | null;           // on the later production: id of its regional tryout or other-market original (BRO-6400)
  transferredTo?: string | null;        // on the earlier production: id of its Broadway / West End transfer
  // Multi-venue regional tryout (e.g. a national pre-Broadway tour with a
  // stop per city). Set on each per-venue leg; points at the aggregate show
  // that rolls up all legs' reviews into one combined score.
  tourParent?: string | null;
  // National tour (category 'tour', BRO-4211): id of the Broadway production it tours.
  tourOf?: string | null;
  // Regional city hub metro slug (BRO-6515), e.g. 'manchester-uk', 'chicago-il'.
  // From data/venue-metros.json via scripts/lib/venue-metro.js; market stays 'regional'.
  city?: string | null;
  // BRO-6518: local-only shows (scripts/lib/local-market.js); must survive computeShowData
  localOnly?: boolean;
  discoverySource?: string;
  provisional?: boolean;
  // Homepage curation overrides (off-Broadway shows surfaced on the Broadway grid).
  // See src/lib/homepage-notability.ts. Editorial escape hatches over the auto rule.
  homepageInclude?: boolean;           // force onto homepage grid (e.g. star-driven previews)
  homepageExclude?: boolean;           // veto from homepage grid
  priorRuns?: PriorRun[];
  // Old ids/slugs this row absorbed when duplicate entries were merged (full
  // ids and year-less slugs). scripts/build-slug-redirects.js turns them into
  // /show/* 301s; data-core.ts getShowBySlug() resolves them for the routes
  // the middleware does not cover (S5-T7).
  aliases?: string[];
}

export interface RawReview {
  showId: string;
  outletId?: string;
  outlet: string;
  criticName?: string;
  url: string;
  publishDate: string;
  // New fields from spreadsheet methodology
  assignedScore?: number;          // Manual 0-100 score
  originalRating?: string;         // e.g., "B+", "3 stars", "4/5"
  bucket?: string;                 // Rave, Positive, Mixed, Negative, Pan
  verdict?: string;                // Critic's verdict (ensemble majority bucket, lowercase); breakdown bar counts by it (BRO-6686)
  thumb?: string;                  // Up, Flat, Down
  designation?: string;            // Critics_Pick, Critics_Choice, etc.
  quote?: string;                  // Direct quote from the review
  summary?: string;                // Third-person summary of the review
  pullQuote?: string;              // Legacy field - use quote/summary instead
  // Scoring confidence metadata (from rebuild)
  scoreSource?: string;        // llmScore, llmScore-lowconf, llmScore-thumb-boosted, originalScore-priority0, human-review, thumb, bwwScore-fallback
  contentTier?: string;        // complete, truncated, excerpt, stub, invalid
  scoreConfidence?: string;    // high, medium, low
  dtliThumb?: string | null;   // DTLI thumb signal
  bwwThumb?: string | null;    // BWW thumb signal
  needsReview?: boolean;       // Score doesn't reflect current signals (needs rescore)
  singleModelEmergency?: boolean; // 1-of-N ensemble models succeeded — unreliable, exclude from compositeScore
}

export interface RawAudience {
  showId: string;
  platform: string;
  platformName: string;
  averageRating: number;
  maxRating: number;
  reviewCount: number;
  url?: string;
  lastUpdated: string;
}

export interface RawBuzzThread {
  showId: string;
  platform: string;
  subreddit?: string;
  title: string;
  url: string;
  upvotes: number;
  commentCount: number;
  sentiment: 'positive' | 'mixed' | 'negative';
  date: string;
  summary?: string;
}

export interface ComputedReview {
  showId: string;
  outletId: string;
  outlet: string;
  criticName?: string;
  url: string;
  publishDate: string;
  tier: 1 | 2 | 3 | 4;
  tierWeight: number;
  assignedScore: number;
  bucketScore?: number;
  verdict?: string;
  thumbScore?: number;
  reviewScore: number;      // The computed score used for averaging
  confidenceWeight: number; // Content quality multiplier (1.0 for full text, lower for excerpts)
  weightedScore: number;    // reviewScore × tierWeight × confidenceWeight × outletShare
  outletShare?: number;     // 1/criticCount for this outlet on this show — preserves
                            // one-vote-per-outlet weighting when an outlet publishes
                            // multiple critic reviews
  designation?: string;
  quote?: string;               // Direct quote from the review
  summary?: string;             // Third-person summary of the review
  pullQuote?: string;           // Legacy field
  originalRating?: string;      // Original rating format (e.g., "4/5 stars", "B+", "Positive")
}

export interface ComputedAudience extends RawAudience {
  mappedScore: number;
  weight: number;
}

export interface CriticScoreResult {
  score: number;                // Tier-weighted average (same as weightedScore)
  weightedScore: number;        // Weighted average using tier weights
  reviewCount: number;
  tier1Count: number;
  tier2Count: number;
  tier3Count: number;
  label: string;                // Rave, Positive, Mixed, Negative
  reviews: ComputedReview[];
}

export interface AudienceScoreResult {
  score: number;
  platforms: ComputedAudience[];
  totalReviewCount: number;
  divergenceWarning?: string;
}

export interface BuzzScoreResult {
  score: number;
  volumeScore: number;
  sentimentScore: number;
  volumeNote: string;
  sentimentNote: string;
  threads: RawBuzzThread[];
  stalenessPenalty?: number;
}

export interface ConfidenceResult {
  level: 'high' | 'medium' | 'low';
  reasons: string[];
}

export interface ComputedShow {
  id: string;
  title: string;
  slug: string;
  venue: string;
  openingDate: string;
  closingDate: string | null;
  status: string;
  type: string;
  category?: string;  // 'broadway', 'off-broadway', 'west-end', etc — required at data-entry (validate-data.js); a missing value is treated as neither Broadway nor Off-Broadway, see data-core.ts isBroadwayShow()
  genre?: string;     // performance type beyond play/musical: dance/magic/comedy/cabaret/concert/circus (see src/lib/genre.ts)
  runtime: string;
  intermissions?: number;
  images?: ShowImages;
  // New fields
  synopsis?: string;
  ageRecommendation?: string;
  limitedRun?: boolean;
  previewsStartDate?: string;  // For upcoming shows
  ticketLinks?: TicketLink[];
  officialUrl?: string;
  trailerUrl?: string;
  creativeTeam?: CreativeMember[];
  tags?: string[];
  theaterAddress?: string;
  // Revival and historical tracking
  isRevival?: boolean;
  originalProductionId?: string | null;
  productionNumber?: number;
  season?: string;
  transferOf?: string | null;
  transferredTo?: string | null;
  tourParent?: string | null;
  tourOf?: string | null;
  city?: string | null;    // regional city hub metro slug (BRO-6515)
  // BRO-6518: local-only shows (scripts/lib/local-market.js); must survive computeShowData
  localOnly?: boolean;
  discoverySource?: string;
  provisional?: boolean;
  // Homepage curation overrides (see RawShow above / homepage-notability.ts)
  homepageInclude?: boolean;
  homepageExclude?: boolean;
  // Scores
  criticScore: CriticScoreResult | null;
  audienceScore: AudienceScoreResult | null;
  buzzScore: BuzzScoreResult | null;
  compositeScore: number | null;
  confidence: ConfidenceResult;
  // Review age context for long-running shows
  reviewYearNote: string | null;
  methodologyVersion: string;
  methodologyDate: string;
  computedAt: string;
  // Coverage Verdict (S2/S3, tasks #906/#905) — attached in data-core.ts from
  // data/audit/show-review-gap.json + data/audit/score-public-since.json.
  // Fails open: absent when the audit file/kill switch/no stamp yet.
  cov?: { state: string; liveCount: number; candidateCount: number; computedAt: string | null };
  scorePublicSince?: string | null;
  coverageAcked?: boolean;
  priorRuns?: PriorRun[];
}

/**
 * ComputedShow variant whose criticScore.reviews is narrowed to R instead of the
 * full ComputedReview[]. Lets client-boundary props declare exactly which review
 * fields they serialize — widening back to full reviews becomes a compile error,
 * not a silent regression (card #962, sibling of the #419 Theater Pick<> pattern).
 */
export type ComputedShowWithReviews<R> = Omit<ComputedShow, 'criticScore'> & {
  criticScore: (Omit<CriticScoreResult, 'reviews'> & { reviews: R[] }) | null;
};

// ===========================================
// HELPER: GET OUTLET CONFIG
// ===========================================

export function getOutletConfig(outletId?: string, outletName?: string, showCategory?: string) {
  // Per-region tier resolver: when showCategory is provided and the entry has
  // `tiers: { nyc, london }`, return the regional tier. Otherwise return the
  // legacy single `tier` field. (v5 — 2026-04-29)
  const resolveTier = (entry: { tier: 1 | 2 | 3 | 4; tiers?: { nyc?: 1 | 2 | 3 | 4; london?: 1 | 2 | 3 | 4 } }): 1 | 2 | 3 | 4 => {
    if (showCategory && entry.tiers) {
      const region = (showCategory === 'west-end' || showCategory === 'off-west-end') ? 'london' : 'nyc';
      const regionalTier = entry.tiers[region];
      if (regionalTier != null) return regionalTier;
    }
    return entry.tier;
  };

  // Direct lookup — OUTLET_TIERS keys are lowercase registry IDs
  if (outletId) {
    const normalized = outletId.toLowerCase().trim();
    if (OUTLET_TIERS[normalized]) {
      const entry = OUTLET_TIERS[normalized];
      return { ...entry, tier: resolveTier(entry), id: outletId };
    }
  }

  // Fallback to name lookup (rare, legacy)
  if (outletName) {
    for (const [id, config] of Object.entries(OUTLET_TIERS)) {
      if (config.name.toLowerCase() === outletName.toLowerCase()) {
        return { ...config, tier: resolveTier(config), id };
      }
    }
  }

  // Fallback to outlet-registry.json tier (covers ~775 outlets not in OUTLET_TIERS)
  if (outletId) {
    const registryTier = getRegistryTier(outletId, showCategory);
    if (registryTier) {
      return {
        tier: registryTier as 1 | 2 | 3 | 4,
        name: outletName || outletId,
        scoreFormat: 'text_bucket',
        id: outletId,
      };
    }
  }

  // Default tier 3
  return {
    tier: DEFAULT_TIER as 1 | 2 | 3 | 4,
    name: outletName || 'Unknown',
    scoreFormat: 'text_bucket',
    id: outletId || 'UNKNOWN',
  };
}

// ===========================================
// CRITIC SCORE CALCULATION
// ===========================================

export function computeCriticScore(reviews: RawReview[], showCategory?: string, showType?: string): CriticScoreResult | null {
  // The formula lives ONLY in scripts/lib/compute-critic-score.js, the same
  // module that writes the slim files' `cs` (BRO-4312). This used to be a
  // second, hand-mirrored copy; on the same inputs both agreed on all 1,500
  // scored shows, but it differed latently (an unscored review counted as
  // originalRating-or-50 here and was skipped there; an outletName-only tier
  // fallback existed only here). Delegating removes the second pipeline, so
  // every page that reads criticScore.score shows the canonical number.
  // Opera flat-weighting, critic-level dedup, per-outlet share, designation
  // floors/bumps and confidence weights are all applied inside scoreReviews.
  // A review without assignedScore is neither scored nor listed in
  // criticScore.reviews (the slim `rv` list drops it too); 0 such rows today.
  const result = scoreReviews(reviews, getOutletRegistry(), showCategory, showType);
  if (!result) return null;

  const computedReviews: ComputedReview[] = result.reviews.map((r: SharedScoredReview) => {
    const review = r.review as RawReview;
    return {
      showId: review.showId,
      // Display id only (tier comes from the shared scorer above).
      outletId: getOutletConfig(review.outletId, review.outlet, showCategory).id,
      outlet: review.outlet,
      criticName: review.criticName,
      url: review.url,
      publishDate: review.publishDate,
      tier: r.tier as 1 | 2 | 3 | 4,
      tierWeight: r.tierWeight,
      assignedScore: review.assignedScore as number,
      bucketScore: review.bucket ? BUCKET_SCORE_MAP[review.bucket] : undefined,
      verdict: review.verdict,
      thumbScore: review.thumb ? THUMB_SCORE_MAP[review.thumb] : undefined,
      reviewScore: r.reviewScore,
      confidenceWeight: r.confidenceWeight,
      weightedScore: r.weightedScore,
      designation: review.designation,
      quote: review.quote,
      summary: review.summary,
      pullQuote: review.pullQuote,
      originalRating: review.originalRating,
      outletShare: r.outletShare,
    };
  });

  return {
    score: result.s,
    weightedScore: result.s,
    reviewCount: result.rc,
    tier1Count: result.t1,
    tier2Count: result.t2,
    tier3Count: result.t3,
    label: getCriticLabel(Math.round(result.s)),
    reviews: computedReviews.sort((a, b) => b.reviewScore - a.reviewScore),
  };
}

// ===========================================
// AUDIENCE SCORE CALCULATION
// ===========================================

export function computeAudienceScore(audienceData: RawAudience[]): AudienceScoreResult | null {
  if (audienceData.length === 0) return null;

  const computedPlatforms: ComputedAudience[] = audienceData.map(platform => {
    const mappedScore = Math.round((platform.averageRating / platform.maxRating) * 100);
    const weight = AUDIENCE_PLATFORM_WEIGHTS[platform.platform] ?? AUDIENCE_PLATFORM_WEIGHTS['other'];

    return {
      ...platform,
      mappedScore,
      weight,
    };
  });

  let weightedSum = 0;
  let totalWeight = 0;
  let totalReviewCount = 0;

  for (const platform of computedPlatforms) {
    weightedSum += platform.mappedScore * platform.weight;
    totalWeight += platform.weight;
    totalReviewCount += platform.reviewCount || 0;
  }

  const score = Math.round(weightedSum / totalWeight);

  let divergenceWarning: string | undefined;
  if (computedPlatforms.length >= 2) {
    const scores = computedPlatforms.map(p => p.mappedScore);
    const maxDiff = Math.max(...scores) - Math.min(...scores);
    if (maxDiff > AUDIENCE_DIVERGENCE_THRESHOLD) {
      divergenceWarning = `Platform scores vary by ${maxDiff} points.`;
    }
  }

  return {
    score,
    platforms: computedPlatforms,
    totalReviewCount,
    divergenceWarning,
  };
}

// ===========================================
// BUZZ SCORE CALCULATION
// ===========================================

export function computeBuzzScore(threads: RawBuzzThread[]): BuzzScoreResult | null {
  if (threads.length === 0) return null;

  const { baselineThreads, volumeMaxScore, sentimentMaxScore, sentimentValues, stalenessThresholdDays, stalenessPenalty: penaltyAmount } = BUZZ_CONFIG;

  const totalEngagement = threads.reduce((sum, t) => sum + t.upvotes + t.commentCount, 0);
  const volumeRatio = Math.min(2, threads.length / baselineThreads);
  const engagementBonus = Math.min(10, Math.log10(totalEngagement + 1) * 3);
  const volumeScore = Math.round(Math.min(volumeMaxScore, (volumeRatio * 20) + engagementBonus));

  let sentimentSum = 0;
  let sentimentWeight = 0;

  for (const thread of threads) {
    const engagement = thread.upvotes + thread.commentCount;
    const weight = Math.log10(engagement + 10);
    sentimentSum += sentimentValues[thread.sentiment] * weight;
    sentimentWeight += weight;
  }

  const sentimentScore = Math.round(sentimentWeight > 0 ? sentimentSum / sentimentWeight : 25);

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - stalenessThresholdDays);
  const recentThreads = threads.filter(t => new Date(t.date) >= cutoffDate);
  const stalenessPenalty = recentThreads.length < threads.length / 2 ? penaltyAmount : 0;

  const totalScore = Math.max(0, volumeScore + sentimentScore - stalenessPenalty);

  const volumeNote = volumeScore >= 35 ? 'High activity level' : volumeScore >= 20 ? 'Moderate activity level' : 'Limited recent activity';
  const sentimentNote = sentimentScore >= 35 ? 'Predominantly positive sentiment' : sentimentScore >= 20 ? 'Mixed sentiment' : 'Predominantly negative sentiment';

  return {
    score: totalScore,
    volumeScore,
    sentimentScore,
    volumeNote,
    sentimentNote,
    threads: threads.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    stalenessPenalty: stalenessPenalty > 0 ? stalenessPenalty : undefined,
  };
}

// ===========================================
// OVERALL COMPOSITE SCORE
// ===========================================

export function computeCompositeScore(
  criticScore: number | null,
  audienceScore: number | null,
  buzzScore: number | null
): number | null {
  const scores: { value: number; weight: number }[] = [];

  if (criticScore !== null) {
    scores.push({ value: criticScore, weight: COMPONENT_WEIGHTS.critic });
  }
  if (audienceScore !== null) {
    scores.push({ value: audienceScore, weight: COMPONENT_WEIGHTS.audience });
  }
  if (buzzScore !== null) {
    scores.push({ value: buzzScore, weight: COMPONENT_WEIGHTS.buzz });
  }

  if (scores.length === 0) return null;

  const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0);
  const normalizedScores = scores.map(s => ({
    value: s.value,
    weight: s.weight / totalWeight,
  }));

  // Keep 2 decimal places for tiebreaking in sort order
  const raw = normalizedScores.reduce((sum, s) => sum + s.value * s.weight, 0);
  return Math.round(raw * 100) / 100;
}

// ===========================================
// CONFIDENCE ASSESSMENT
// ===========================================

export function assessConfidence(
  criticScore: CriticScoreResult | null,
  audienceScore: AudienceScoreResult | null,
  showStatus: string
): ConfidenceResult {
  const reasons: string[] = [];

  if (!criticScore) {
    return { level: 'low', reasons: ['No critic reviews'] };
  }

  const reviewCount = criticScore.reviewCount;

  if (reviewCount >= CONFIDENCE_THRESHOLDS.high) {
    if (criticScore.tier1Count >= 2) {
      return { level: 'high', reasons: [`${reviewCount} reviews including ${criticScore.tier1Count} Tier 1`] };
    }
    reasons.push(`${reviewCount} reviews but only ${criticScore.tier1Count} Tier 1`);
    return { level: 'high', reasons };
  }

  if (reviewCount >= CONFIDENCE_THRESHOLDS.medium) {
    reasons.push(`${reviewCount} reviews (${CONFIDENCE_THRESHOLDS.high}+ preferred)`);
    return { level: 'medium', reasons };
  }

  reasons.push(`Only ${reviewCount} reviews`);
  return { level: 'low', reasons };
}

// ===========================================
// MAIN: COMPUTE ALL SHOW DATA
// ===========================================

export function computeShowData(
  show: RawShow,
  showReviews: RawReview[],
  audienceData: RawAudience[],
  buzzThreads: RawBuzzThread[]
): ComputedShow {
  // Caller is expected to pass reviews already pre-filtered to this show
  // (data-core.ts uses a Map<showId, Reviews[]> index). The inner filter was
  // removed as a no-op once all callers were updated (only data-core.ts:getAllShows).

  // Pre-2005 closed shows: hide reviews entirely (unreliable data from bulk import)
  // Announced shows: never surface a composite score — any reviews present belong
  // to a prior production and would mislead ("upcoming show with 82 score").
  const hideReviews = shouldHideReviews(show) || show.status === 'announced';
  // Include singleModelEmergency reviews in the composite (2026-05-16).
  //
  // Background: when ensemble scoring runs and 2 of 3 models fail (commonly
  // Gemini outage), the surviving model's score is still saved with
  // ensembleData.singleModelEmergency=true. Previously this flag excluded the
  // review from /opera, /off-broadway, /broadway, /west-end list pages — but
  // generate-mobile-show-details.js (which writes /data/shows/*.json) does
  // NOT exclude them. The asymmetry caused stale-looking market pages (e.g.
  // /opera showed Eugene Onegin at 51/2 reviews while the per-show JSON had
  // 60/3 — the missing review was a singleModelEmergency Parterre score).
  //
  // The Phase 4 daily cron in llm-ensemble-score.yml already retries these
  // automatically (singleModelEmergencyRetryCount<1 → re-score; if 2+ models
  // succeed the flag clears; if not, retryCount=1 prevents further retries).
  // So including these in the composite means: low-confidence scores show up
  // briefly until the cron picks them up, instead of disappearing entirely.
  // Notion 362637c5-416f-81ff-ad1f-c5b4b85e62ef tracks the parity question.
  let criticScore = hideReviews ? null : computeCriticScore(showReviews, show.category, (show as { type?: string }).type);

  // V1: composite score = critic score (audience/buzz coming later)
  // Keep 2 decimal places for tiebreaking in sort order (e.g., 87.96 vs 87.12)
  const compositeScore = criticScore?.weightedScore
    ? Math.round(criticScore.weightedScore * 100) / 100
    : null;

  // Build-time status correction: safety net for stale data from concurrent pushes.
  // The source script (update-show-status.js) runs daily, but race conditions between
  // CI runs and local sessions can overwrite status changes.
  // Use market-local date: opening dates are calendar dates in the show's timezone
  // (ET for Broadway/OB, London for WE/OWE). UTC comparison causes off-by-one when
  // builds run after midnight UTC but before midnight local (e.g., Titanique 2026-04-12
  // appeared "open" at 9pm ET April 11 because UTC was already April 12).
  // The rule lives in scripts/lib/effective-status.js, which the app feed uses too.
  const today = getMarketDate(show.category);
  const normalizedStatus = normalizeShowStatus(show, today);

  const confidence = assessConfidence(criticScore, null, normalizedStatus);

  // List-card caveat when most of an open show's reviews are 10+ years old.
  // Same rule as the show page hero (getReviewAgeYear), from the scored reviews'
  // own publish years rather than openingDate.
  const reviewAgeYear = getReviewAgeYear({ status: normalizedStatus }, criticScore?.reviews);
  const reviewYearNote = reviewAgeYear === null ? null : `Most reviews from ${reviewAgeYear}`;

  return {
    id: show.id,
    title: show.title,
    slug: show.slug,
    venue: show.venue,
    openingDate: show.openingDate,
    closingDate: show.closingDate,
    status: effectiveShowStatus(show, today),
    type: show.type,
    category: show.category,
    genre: show.genre,
    runtime: show.runtime,
    intermissions: show.intermissions,
    images: show.images,
    // Pass through new fields
    synopsis: stripInlineMarkdown(show.synopsis),
    ageRecommendation: show.ageRecommendation,
    limitedRun: show.limitedRun,
    previewsStartDate: show.previewsStartDate,
    ticketLinks: show.ticketLinks,
    officialUrl: show.officialUrl,
    trailerUrl: show.trailerUrl,
    creativeTeam: show.creativeTeam,
    tags: show.tags,
    theaterAddress: show.theaterAddress,
    // Revival and historical tracking
    isRevival: show.isRevival || (show.type as string) === 'revival' || (show.tags?.includes('revival') ?? false),
    originalProductionId: show.originalProductionId,
    productionNumber: show.productionNumber,
    season: show.season,
    transferOf: show.transferOf,
    transferredTo: show.transferredTo,
    tourParent: show.tourParent,
    tourOf: show.tourOf,
    city: show.city ?? null,
    localOnly: show.localOnly,
    discoverySource: show.discoverySource,
    provisional: show.provisional,
    homepageInclude: show.homepageInclude,
    homepageExclude: show.homepageExclude,
    priorRuns: show.priorRuns,
    // Scores
    criticScore,
    audienceScore: null,
    buzzScore: null,
    compositeScore,
    confidence,
    reviewYearNote,
    methodologyVersion: METHODOLOGY_VERSION,
    methodologyDate: METHODOLOGY_DATE,
    computedAt: new Date().toISOString(),
  };
}

// ===========================================
// EXPORT CONFIG FOR METHODOLOGY PAGE
// ===========================================

export function getMethodologyConfig() {
  return {
    version: METHODOLOGY_VERSION,
    date: METHODOLOGY_DATE,
    componentWeights: COMPONENT_WEIGHTS,
    tierWeights: TIER_WEIGHTS,
    outletTiers: OUTLET_TIERS,
    letterGradeMap: LETTER_GRADE_MAP,
    bucketScoreMap: BUCKET_SCORE_MAP,
    thumbScoreMap: THUMB_SCORE_MAP,
    designationBumps: DESIGNATION_BUMPS,
    designationFloors: DESIGNATION_FLOORS,
    audiencePlatformWeights: AUDIENCE_PLATFORM_WEIGHTS,
    buzzConfig: BUZZ_CONFIG,
    confidenceThresholds: CONFIDENCE_THRESHOLDS,
    divergenceThreshold: AUDIENCE_DIVERGENCE_THRESHOLD,
  };
}
