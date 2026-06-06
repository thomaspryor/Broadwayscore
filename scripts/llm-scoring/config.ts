/**
 * Configuration for the LLM-based review scoring system
 *
 * This file contains:
 * - Scoring scale definitions
 * - Few-shot calibration examples (real reviews with known scores)
 * - Prompt templates
 */

import { FewShotExample } from './types';

// ========================================
// SCORING SCALE DEFINITIONS
// ========================================

// V5 Bucket Ranges (simplified, bucket-first approach)
export const BUCKET_RANGES = {
  Rave: { min: 83, max: 100, thumb: 'Up' as const },
  Positive: { min: 70, max: 82, thumb: 'Up' as const },
  Mixed: { min: 55, max: 69, thumb: 'Flat' as const },
  Negative: { min: 35, max: 54, thumb: 'Down' as const },
  Pan: { min: 0, max: 34, thumb: 'Down' as const }
};

/**
 * Get the score range for a bucket
 */
export function bucketToRange(bucket: string): { min: number; max: number } {
  return BUCKET_RANGES[bucket as keyof typeof BUCKET_RANGES] || { min: 55, max: 69 };
}

/**
 * Ensure score is within bucket range
 */
export function clampScoreToBucket(score: number, bucket: string): number {
  const range = bucketToRange(bucket);
  return Math.max(range.min, Math.min(range.max, score));
}

// ========================================
// STAR / LETTER GRADE → BAND PROJECTIONS
// ========================================
// Bands constrain the LLM's output range when a critic provides a star
// rating or letter grade. Distinct from BUCKET_RANGES (display buckets):
// bands are LLM-input constraints, BUCKET_RANGES is downstream score→bucket
// classification. A 5★ band [91,100] is INSIDE the Rave bucket [83,100],
// but a 4★ band [71,90] straddles Positive [70,82] and lower Rave [83,90].
// The asymmetry is intentional: rank preservation across stars beats bucket
// alignment.

export interface ScoreBand {
  fraction: number;
  floor: number;
  ceiling: number;
}

/**
 * Project a star rating onto a score band.
 * Scale-agnostic: handles /4, /5, /10 identically via fraction.
 *
 * Mapping (fraction of max → band):
 *   ≥90% → [91,100]   (5★ on /5, 4/4, 4.5/5)
 *   70-89% → [71,90]  (4★ on /5, 3/4, 3.5/4)
 *   50-69% → [51,70]  (3★ on /5)
 *   30-49% → [31,50]  (2★ on /5)
 *   <30%   → [0,30]   (1★ on /5, F territory)
 *
 * Half-stars land naturally: 3.5/4 = 87.5% → [71,90]; 4.5/5 = 90% → [91,100].
 */
export function starToBand(stars: number, max: number = 5): ScoreBand {
  const fraction = stars / max;
  if (fraction >= 0.9) return { fraction, floor: 91, ceiling: 100 };
  if (fraction >= 0.7) return { fraction, floor: 71, ceiling: 90 };
  if (fraction >= 0.5) return { fraction, floor: 51, ceiling: 70 };
  if (fraction >= 0.3) return { fraction, floor: 31, ceiling: 50 };
  return { fraction, floor: 0, ceiling: 30 };
}

/**
 * Project a letter grade onto a narrow score band.
 * Letter grades have 13 positions (A+ → F) so each gets ~6pt of within-band
 * spread, preserving the granularity the +/- modifier already encodes.
 * F gets a wide band because "merely failed" vs "actively offensive" is real.
 *
 * Returns null on unrecognized input. Case-insensitive; tolerates whitespace.
 */
export function letterGradeToBand(grade: string): { floor: number; ceiling: number } | null {
  if (typeof grade !== 'string') return null;
  const g = grade.trim().toUpperCase();
  switch (g) {
    case 'A+': return { floor: 95, ceiling: 100 };
    case 'A':  return { floor: 89, ceiling: 94 };
    case 'A-': return { floor: 83, ceiling: 88 };
    case 'B+': return { floor: 77, ceiling: 82 };
    case 'B':  return { floor: 71, ceiling: 76 };
    case 'B-': return { floor: 65, ceiling: 70 };
    case 'C+': return { floor: 59, ceiling: 64 };
    case 'C':  return { floor: 53, ceiling: 58 };
    case 'C-': return { floor: 47, ceiling: 52 };
    case 'D+': return { floor: 41, ceiling: 46 };
    case 'D':  return { floor: 35, ceiling: 40 };
    case 'D-': return { floor: 29, ceiling: 34 };
    case 'F':  return { floor: 0,  ceiling: 28 };
    default:   return null;
  }
}

/**
 * Clamp a score into a band [floor, ceiling].
 */
export function clampScoreToBand(score: number, band: { floor: number; ceiling: number }): number {
  return Math.max(band.floor, Math.min(band.ceiling, score));
}

/**
 * @deprecated Use BUCKET_RANGES with SYSTEM_PROMPT_V5 instead.
 * These V3 ranges conflict with V5 bucket definitions.
 */
export const SCORE_ANCHORS = {
  RAVE: {
    range: [90, 100],
    description: 'Unqualified enthusiasm. "Masterpiece", "triumph", "unmissable".',
    characteristics: [
      'Uses superlatives without major caveats',
      'Explicit strong recommendation',
      'Praises multiple aspects (performances, direction, writing)',
      'Compares favorably to great works'
    ]
  },
  POSITIVE: {
    range: [75, 89],
    description: 'Clear recommendation with minor reservations at most.',
    characteristics: [
      'Overall enthusiastic but measured',
      'May note small flaws that don\'t diminish experience',
      'Would recommend to most audiences',
      'Praises key elements'
    ]
  },
  MIXED_POSITIVE: {
    range: [60, 74],
    description: 'More good than bad. Qualified recommendation.',
    characteristics: [
      'Acknowledges significant flaws',
      'But finds enough to enjoy',
      '"Worth seeing despite its problems"',
      'Conditional recommendation ("if you like X...")'
    ]
  },
  MIXED: {
    range: [50, 59],
    description: 'Could go either way. "Depends on your taste."',
    characteristics: [
      'Equal parts positive and negative',
      'No clear recommendation either way',
      '"Some will love it, others won\'t"',
      'Ambivalent conclusion'
    ]
  },
  MIXED_NEGATIVE: {
    range: [35, 49],
    description: 'More problems than strengths. Hard to recommend.',
    characteristics: [
      'Negatives outweigh positives',
      'May praise isolated elements',
      'Overall cannot recommend',
      '"Only for die-hard fans"'
    ]
  },
  NEGATIVE: {
    range: [20, 34],
    description: 'Clear pan. Few if any redeeming elements.',
    characteristics: [
      'Predominantly critical',
      'Minimal positive notes',
      'Clear non-recommendation',
      'Disappointed tone'
    ]
  },
  PAN: {
    range: [0, 19],
    description: 'Unqualified rejection. Warns people away.',
    characteristics: [
      'Harsh throughout',
      'No redeeming qualities noted',
      'Active warning to avoid',
      'May question how it was produced'
    ]
  }
};

// ========================================
// FEW-SHOT CALIBRATION EXAMPLES
// ========================================

/**
 * Real reviews with known human-assigned scores
 * Selected to cover the full scoring range and different writing styles
 */
export const FEW_SHOT_EXAMPLES: FewShotExample[] = [
  // RAVE example (score: 95)
  {
    reviewExcerpt: `In 1996, Bug was a warning. In 2026, it's a mirror. This is not a feel-good night at the theater. It's raw, violent, sexy, and deeply American. Carrie Coon delivers a performance that will haunt you. The production design is impeccable, the pacing relentless. An absolute triumph of theatrical storytelling.`,
    score: 95,
    bucket: 'Rave',
    reasoning: 'Unqualified praise with superlatives ("triumph", "impeccable"), strong emotional impact promised, no caveats.'
  },

  // 5-STAR example (score: 87) - measured language but still 5 stars
  {
    reviewExcerpt: `Daniel Aukin's superb production navigates the change without missing a beat. The jam has been preserved. With the greater sense of distance at the Golden Theatre, Stereophonic feels more than ever like watching a wide-screen film. There's nary a false note. The result is richly satisfying multitrack production. (5/5 stars)`,
    score: 87,
    bucket: 'Rave',
    reasoning: '5/5 stars with consistent praise ("superb", "richly satisfying", "nary a false note"). 5 stars with measured but unqualified praise = Rave range (83+).'
  },

  // 4-STAR example (score: 78) - clear recommendation
  {
    reviewExcerpt: `The dancers and singers of the ensemble are first-rate, and Wheeldon gives them a lot to do. As the 1992 incarnation, Frost carries the bulk of the role, and not only nails Jackson's signature sound and moves but also his otherworldly affect. The design is deluxe: dazzling costumes, a smooth set, flashy lighting. Worth seeing for the performances alone. (4/5 stars)`,
    score: 78,
    bucket: 'Positive',
    reasoning: '4/5 stars with clear praise for performances and design. 4 stars = 75-88 range.'
  },

  // NEGATIVE-SETUP-POSITIVE-VERDICT example (score: 78) - instructional
  {
    reviewExcerpt: `When "Suffs" premiered at the Public Theatre two years ago, it was a didactic, dull, overstuffed mess. That it would come back, and on Broadway, wasn't a thrilling prospect. And while it did not magically morph into a great show, Version 2.0 is tighter, more confident, often rousing and downright entertaining. We can only rejoice that the creative team did not back down.`,
    score: 78,
    bucket: 'Positive',
    reasoning: 'The negative opening describes the PREVIOUS production ("two years ago"). The verdict for THIS production is "rousing and downright entertaining", "We can only rejoice". Score the current production, not the old one.'
  },

  // MIXED-POSITIVE example (score: 68)
  {
    reviewExcerpt: `Intelligent, disciplined, and often absorbing—but rarely electrifying. Coon anchors the production with a performance of formidable control and emotional clarity. Yet something feels muted about this revival. The intimate horror that made the play unforgettable Off-Broadway doesn't quite translate to the larger Broadway house.`,
    score: 68,
    bucket: 'Mixed',
    reasoning: 'Praises lead performance and production qualities, but expresses significant disappointment about the impact compared to expectations.'
  },

  // MIXED example (score: 55)
  {
    reviewExcerpt: `Bug was a shot of adrenaline and a delayed-release dose of anxiety when seen Off-Broadway, but much of the effect for me has worn off. The performances are committed, particularly Coon, but the play's paranoid spiral feels more dated than prescient now. Worth seeing for the acting, but temper expectations.`,
    score: 55,
    bucket: 'Mixed',
    reasoning: 'Balanced positive (performances) and negative (dated material), no clear recommendation, suggests conditional interest.'
  },

  // 2-STAR "PRAISE PERFORMER, PAN SHOW" example (score: 40) - Lempicka / NYSR
  {
    reviewExcerpt: `Power-contralto Eden Espinosa strives mightily to keep Lempicka – an overstuffed, formulaic musical – in forward motion, to mixed effect. Amber Iman's shining moment as Rafaela is worth the overall tedium of admission. But the show plugs along like a Bugatti in need of a lube job — Lempicka deserves — deserved — better. (2/5 stars)`,
    score: 40,
    bucket: 'Negative',
    reasoning: '2/5 stars. The critic praises individual performers (Espinosa, Iman) but finds the show itself "overstuffed, formulaic" and tedious. PERFORMER PRAISE DOES NOT REDEEM A PAN — score the overall verdict, not the best element.'
  },

  // MEASURED NEGATIVE example (score: 42) - Back to the Future / NYSR
  {
    reviewExcerpt: `This adaptation is less a musical than a two-and-a-half-hour theme park ride with songs, offering as much sensory overload as an afternoon at Magic Kingdom. The turbo-charged tunes are memorable mostly for the affable banality of their lyrics. Roger Bart's considerable comedic gifts are pretty much relegated to reproducing shtick. A day pass to Six Flags might prove a better bargain. (2/5 stars)`,
    score: 42,
    bucket: 'Negative',
    reasoning: '2/5 stars. Measured but clearly negative: compares show to theme park, calls lyrics "banally affable," suggests cheaper alternatives. Even acknowledging performers, the recommendation is clearly against.'
  },

  // DEVASTATING PAN example (score: 15) - Lempicka / NY Post
  {
    reviewExcerpt: `What "Lempicka" needs more than anything else is turpentine. The ugly splatter that audiences are left to parse is a ridiculous two-and-a-half-hour Eurovision act with stratospheric delusions of grandeur. The book is incoherent, tonally unhinged. Espinosa and Iman have no chemistry — this pair isn't even in the same room. It's hard to believe this muck is directed by the talented Chavkin.`,
    score: 15,
    bucket: 'Pan',
    reasoning: 'Devastating pan. Calls it "ugly splatter," "muck," "incoherent." No redeeming qualities offered. Deep Pan range (10-20).'
  },

  // 1-STAR PAN ANCHOR example (score: 18) - Queen of Versailles / Culture Sauce
  {
    reviewExcerpt: `A tone-deaf celebration of all-American affluenza that can never resolve how we should feel about the vain, misguided woman at its center. The book lifts from the documentary but fails to dramatize any of it. Songs are pleasant but mostly unmemorable. There's a hollowness to this enterprise that's inescapable. This ill-timed trudge of a show seems content to watch her eat cake. (1/5 stars)`,
    score: 18,
    bucket: 'Pan',
    reasoning: '1/5 stars. "Tone-deaf," "hollow," "ill-timed trudge." Even acknowledging the star\'s performance, the verdict is total rejection. 1 star = deep Pan range (10-25).'
  }
];

// ========================================
// PROMPT TEMPLATES
// ========================================

// 5.4.0 (2026-04-28): Added "## Structural Review Patterns" section to address
// the praise→critique→wistful-close failure mode. Helen Shaw NYT Lost Boys was
// the canonical case (v5.3.0 ensemble: 68 Mixed; manual override 78 Positive).
// Promoted from candidate after rule-13 A/B passed at n=133: max bucket shift
// 3.8pp, mean drift +0.29pts, Helen Shaw fixture unanimous 78 Positive.
// Audit: data/audit/llm-prompt-ab-2026-04-28T20-03-37-806Z.json
export const PROMPT_VERSION = '5.4.0';

// Gemini calibration offset (adjust if Gemini has systematic bias)
export const GEMINI_CALIBRATION_OFFSET = 0;

/**
 * @deprecated Alias kept so the A/B harness still type-checks. For the next
 * prompt iteration, set this to the new candidate version string and update
 * SYSTEM_PROMPT_V5_STRUCTURAL accordingly.
 */
export const PROMPT_VERSION_CANDIDATE = PROMPT_VERSION;

/**
 * System prompt establishing the scoring framework
 */
export const SYSTEM_PROMPT = `You are an expert theater review analyst for Broadway Scorecard, a review aggregation site. Your task is to analyze review text and assign a score from 0-100 that reflects how strongly the critic recommends seeing the show.

## Scoring Scale (Recommendation Strength)

Score what the critic is RECOMMENDING, not just their emotional reaction:

| Range | Category | Meaning |
|-------|----------|---------|
| 90-100 | Rave | Unqualified enthusiasm. "Must-see", "masterpiece", "triumph" |
| 75-89 | Positive | Clear recommendation, minor reservations at most |
| 60-74 | Mixed-Positive | More good than bad, qualified recommendation |
| 50-59 | Mixed | Could go either way, "depends on your taste" |
| 35-49 | Mixed-Negative | More problems than strengths, hard to recommend |
| 20-34 | Negative | Clear pan, few redeeming elements |
| 0-19 | Pan | Unqualified rejection, warns people away |

## Star Rating Calibration (IMPORTANT)

When a review has an original star rating, use these mappings:
| Stars | Score Range | Notes |
|-------|-------------|-------|
| 5/5 or A/A+ | 85-100 | Even without superlatives, 5 stars = strong positive |
| 4/5 or B+/A- | 75-88 | Clear recommendation |
| 3/5 or B/B- | 55-72 | Mixed but lean positive |
| 2/5 or C/C+ | 35-55 | Mixed-negative |
| 1/5 or D/F | 0-35 | Pan |

## Important Scoring Principles

1. **Professional critics sound measured even when enthusiastic.** A critic saying "a solid, well-crafted production" from the New York Times often means strong recommendation (75-85).

2. **5/5 star reviews should score 85+.** If a critic gave 5 stars, score at least 85 even if the language seems measured. The star rating is the critic's final verdict.

3. **Watch for mixed reviews.** A critic might love the performances but hate the book. Weigh both.

4. **The recommendation signal matters most.** Look for: "worth seeing", "skip it", "don't miss", "for fans only", etc.

5. **Excerpt limitations.** If you only have a partial review, acknowledge lower confidence.

6. **Avoid score compression.** Don't cluster scores in the 60-75 range. Use the full scale based on the critic's actual sentiment.

## Calibration Examples

${FEW_SHOT_EXAMPLES.map((ex, i) => `
### Example ${i + 1}: Score ${ex.score} (${ex.bucket})
Review: "${ex.reviewExcerpt}"
Reasoning: ${ex.reasoning}
`).join('')}
`;

// ========================================
// V5 SIMPLIFIED PROMPT (Bucket-First Approach)
// ========================================

export const SYSTEM_PROMPT_V5 = `You are a theater critic review scorer for Broadway and West End shows. Your task is to determine how strongly a critic recommends seeing a show based on their review text.

## Step 0: Is This Text Scoreable?

Before scoring, check if this text is actually a scoreable review of the target show. If ANY of the following apply, DO NOT score — return a rejection instead:

| Rejection Reason | Description |
|-----------------|-------------|
| wrong_show | Text is about a completely different show or topic |
| wrong_production | Reviews a different production than the one specified in the Show context. **Check the venue and market carefully**: if the context says "at Lyric Theatre (West End)" but the review discusses a production at the National Theatre, a Broadway theatre, or any other venue, reject as wrong_production. Same show title at the wrong venue/market = wrong production. Also reject touring, regional, transfer, or preview/workshop productions at other venues. |
| not_a_review | Press release, plot summary with no evaluation, cast listing, or promotional content |
| garbage_text | Navigation menus, error pages, ad copy, login prompts, or other non-article content |

The following are NOT rejections — score them, but with reduced confidence:

| Situation | How to Handle |
|-----------|--------------|
| **Multi-show roundup** | Score the portion about the target show. Set confidence to "low" if less than ~150 words about it. |
| **Truncated text** | Score what's available. Set confidence to "low" if the verdict/conclusion appears cut off. |
| **Excerpt only** | Score the excerpt. Set confidence to "low". |

If rejecting, respond with ONLY this JSON:
{
  "scoreable": false,
  "rejection": "wrong_show",
  "reasoning": "Brief explanation of why this is not scoreable"
}

If scoreable, proceed to Step 1.

## Step 1: Choose the Bucket

Classify the review into ONE of these buckets:

| Bucket | Description | Examples |
|--------|-------------|----------|
| **Rave** | Strong recommendation with no significant reservations. Does NOT require superlatives — consistent praise throughout is enough. | "superb", "first-rate", "a must-see", "masterpiece", "I loved it", "don't miss this" |
| **Positive** | Recommends seeing it, BUT with reservations, caveats, or mixed elements | "worth seeing", "entertaining despite flaws", "enjoyable", "recommended with caveats" |
| **Mixed** | Neither recommends nor discourages | "has its moments", "uneven", "hit or miss", "for fans only" |
| **Negative** | Does not recommend | "disappointing", "falls short", "skip the ticket price" |
| **Pan** | Strongly negative | "avoid", "waste of time", "terrible", "a disaster" |

## Step 2: Assign a Score Within the Bucket

After choosing the bucket, assign a specific score within its range:

| Bucket | Score Range |
|--------|-------------|
| Rave | 83-100 |
| Positive | 70-82 |
| Mixed | 55-69 |
| Negative | 35-54 |
| Pan | 0-34 |

Use the full range. A barely-positive review should be 70-72. A very strong positive should be 80-82.

## The Positive/Rave Boundary (IMPORTANT)

The most common scoring error is putting Raves in Positive. Ask yourself:

**Does this review have significant reservations or caveats?**
- YES → Positive (70-82). The reviewer liked it but flagged real problems.
- NO → Rave (83+). Consistent praise without significant caveats = Rave, even if the language is measured or professional rather than effusive.

Professional critics often write in a measured tone even when highly enthusiastic. "A superb production" or "richly satisfying" from a respected critic is a Rave — they don't need to say "masterpiece" for it to qualify. If the review praises performances, direction, and writing with no meaningful caveats, it's a Rave.

## Score Distribution
Do NOT default to the midpoint of a bucket.
- **Rave** 83-87: Consistent praise, professional tone, no reservations. 88-95: Superlative language, "must-see." 96-100: Once-in-a-generation.
- **Positive** 78-82: Strong praise but with at least one real caveat. 74-77: Solid recommendation, notable reservations. 70-73: Barely positive, heavily qualified.
- Spread scores across the full bucket range based on recommendation strength.

## Critical Instructions

1. **VERDICT OVER SETUP**: Many reviews open with negative context (previous productions, source material issues, hype concerns) before delivering a positive verdict. ALWAYS score based on the FINAL RECOMMENDATION, not the opening setup.

2. **CURRENT PRODUCTION ONLY**: If the review compares to previous productions or revivals, score only the assessment of THIS production.

3. **TRUNCATED TEXT**: If warned that text is truncated, be cautious about low scores - the positive verdict may have been cut off. Weight any provided aggregator excerpts as additional evidence.

4. **EXPLICIT RECOMMENDATIONS**: Phrases like "must-see", "skip it", "don't miss", "not worth it" should heavily influence the bucket choice.

5. **BIOGRAPHICAL CONTEXT IS NOT CRITICISM**: Reviews often open with context about the show's subject (a person's life, historical events, source material controversies). This background describes the SUBJECT, not the SHOW. A reviewer describing abuse allegations or historical inaccuracies is providing context, not criticizing the production. Score based on what the critic says about the SHOW (performances, direction, staging, writing), not the subject matter.

6. **EVALUATIVE TEXT IS NOT PLOT SUMMARY**: When a critic describes performances ("delivers a powerful turn"), staging choices ("the set crackles with energy"), or production quality ("the direction keeps things moving"), this IS evaluative content even if it reads descriptively. Do not dismiss such passages as "plot summary" or "cast listing."

## Structural Review Patterns (IMPORTANT)

When a review structurally praises a show heavily and then reserves criticism for one specific section (e.g. one act, one performance, one creative element), weight the praise:critique ratio by content volume, not section count. A review that spends 70% on praise and 30% on Act-2 critique is a qualified rave (Positive, ~78), not Mixed (~68). Wistful or melancholy closing tone does NOT downgrade an otherwise-positive review — a critic who closes with "even these keen delights pall in the second act" after pages of admiring description is still recommending the show. Score the volume of praise, not the location of the critique. When this pattern applies and praise volume clearly exceeds critique volume, use the upper Positive range (75-82), not the bucket boundary (70-72).

## Negative Review Patterns

**PERFORMER PRAISE DOES NOT REDEEM A PAN.** A critic saying "despite a game cast giving their all" or "the lead delivers a committed performance" while panning the book, direction, and overall experience is writing a NEGATIVE review. Score the overall verdict, not the best individual element.

**USE THE FULL PAN RANGE (0-34).** Reviews that question why a show exists, warn audiences away, or find no redeeming qualities should score 10-20. Reserve 25-34 for pans that acknowledge isolated bright spots.

## Output Format

Respond with ONLY this JSON (no markdown code fences, no explanation outside the JSON):

{
  "scoreable": true,
  "bucket": "Positive",
  "score": 79,
  "confidence": "high",
  "verdict": "recommended with reservations",
  "keyQuote": "One COMPLETE SENTENCE (40-150 chars) where the critic directly evaluates the show — an opinion, not plot summary or context. Prefer mid-review verdicts over opening scene-setting.",
  "reasoning": "1-2 sentences explaining your classification",
  "publishDate": "YYYY-MM-DD or null — the date this review was published, extracted from bylines, datelines, or headers in the text. Return null if not found. Do NOT guess or use the show's opening date."
}

## Verdict Examples
Good verdict formats:
- "enthusiastically recommended"
- "worth seeing despite flaws"
- "mixed but has moments"
- "disappointing, skip it"
- "a must-see masterpiece"

## Confidence Levels
- **high**: Clear verdict language, unambiguous tone
- **medium**: Some ambiguity but overall direction is clear
- **low**: Genuinely mixed signals, or truncated text with unclear verdict

## Calibration Examples

${FEW_SHOT_EXAMPLES.map((ex, i) => `### Example ${i + 1}: Score ${ex.score} (${ex.bucket})
Review: "${ex.reviewExcerpt}"
Reasoning: ${ex.reasoning}
`).join('\n')}
### Example: Not Scoreable
Text: "The page you are looking for no longer exists. Perhaps you can return back to the homepage..."
Response: { "scoreable": false, "rejection": "garbage_text", "reasoning": "This is a 404 error page, not a review." }
`;

/**
 * @deprecated The structural-review block is now inlined in SYSTEM_PROMPT_V5
 * (v5.4.0, 2026-04-28). This alias kept so the A/B harness still type-checks
 * and can be reused for the next prompt iteration. For future A/B runs,
 * define a new candidate constant and update test-prompt-structural-ab.ts.
 */
export const SYSTEM_PROMPT_V5_STRUCTURAL = SYSTEM_PROMPT_V5;

// Opening line is intentionally market-neutral — the market label ("Broadway",
// "West End", "Off-Broadway", "Off-West End") is emitted by input-builder.ts
// inside {context} on the "Show: X at Y (Market)" line. Earlier versions said
// "Score this Broadway review." which primed the LLM toward Broadway even for
// WE shows and collided with the wrong_production check in SYSTEM_PROMPT_V5.
// Fixed 2026-04-23 (Notion 34b637c5-416f-81ad-8afb-e39b9de9e926).
export const SCORING_PROMPT_V5 = `Score this theater review.

{context}

## Review Text
"{reviewText}"

Respond with ONLY the JSON object.`;

/**
 * Build the V5 prompt for a review
 */
export function buildPromptV5(reviewText: string, context: string = ''): string {
  return SCORING_PROMPT_V5
    .replace('{reviewText}', reviewText)
    .replace('{context}', context);
}

// ========================================
// V6 PROMPT — STAR-ANCHORED BANDS + FULL-RANGE DECOMPRESSION
// ========================================
// V6 fixes two empirical biases in V5:
//   1. Top-end compression: V5 FEW_SHOT_EXAMPLES anchors 5/5 at 87, no
//      example >95. Phase A measurement (1,030 paired observations,
//      2026-04-11) showed 5/5 critic ratings → LLM mean 88.7 (gap -11.3).
//      Only 60 of 12,335 LLM scores ever reach 95+, max observed 98.
//   2. Star-rated reviews collapse to a flat number (5★=100, 4★=80) via
//      starsToNumeric and never see the LLM at all (V5 bypasses LLM when
//      a high-reliability star exists).
//
// V6 design:
//   - Anchored mode (band passed): "Critic awarded N/M (X%). Score MUST be
//     in [floor, ceiling]. Use the FULL band — top for rapturous, floor
//     for barely qualifying."
//   - Unanchored mode (no band): rebuilt rubric. Few-shots include 100,
//     95, 91 raves to kill the empirical 89-cap.
//
// NOT YET EXPORTED FROM index.ts. PROMPT_VERSION still '5.4.0'. Phase 2b
// flips PROMPT_VERSION to '6.0.0' and switches index.ts to buildPromptV6.

// Two extra few-shot examples that V5 lacks: a 100-score rave and a 91
// floor-of-rave. These are designed to teach the model the FULL band.
// Excerpts are composite — written to mirror real critic prose at these
// score levels — and will be replaced with corpus-sourced excerpts during
// Sprint 2 sample review if the user wants real-source examples.
const FEW_SHOT_EXAMPLES_V6_HIGH_END: FewShotExample[] = [
  // 100 — once-in-a-generation rave anchor
  {
    score: 100,
    bucket: 'Rave',
    reviewExcerpt: "There are nights in the theater you can feel are happening — the entire room leaning forward together — and this is one of them. Every choice on stage lands; every performance has been rehearsed into a kind of inevitability. I cannot remember the last time I left a Broadway house this exhilarated. See it now, see it twice, and tell everyone you know.",
    reasoning: "Pure superlative throughout, explicit double-recommendation, no caveats anywhere. The critic uses 'cannot remember the last time' framing — that's career-best language. 96+ requires this kind of unqualified, generational claim.",
  },
  // 91 — floor of the Rave bucket: clear rave but not a career-best
  {
    score: 91,
    bucket: 'Rave',
    reviewExcerpt: "It's a strong, intelligent production with a fine cast and a director who clearly knows what she wants. The book is sharp, the songs land, and there are no sustained low patches. I left smiling and would happily go again — though I won't pretend it cracked the top tier of the season.",
    reasoning: "Consistent praise without significant caveats = Rave. But the closing 'won't pretend it cracked the top tier' explicitly puts it at the floor of the Rave bucket, not the top.",
  },
];

export const FEW_SHOT_EXAMPLES_V6: FewShotExample[] = [
  ...FEW_SHOT_EXAMPLES_V6_HIGH_END,
  ...FEW_SHOT_EXAMPLES,
];

// Anchored-mode block: emitted when the caller passes a band. Replaces
// the V5 "Star Rating Calibration" + "Score Distribution" sections with
// a hard-constrained band instruction.
//
// v6.1 (2026-05-16): empirical finding — V6.0 anchored mode never used the
// floor (e.g. 5★ band [91,100] always landed 95-100, even for measured prose
// like Stuart King's Harold Fry review). The LLM defaulted high. v6.1 adds
// (a) explicit prose-marker calibration table, (b) a low-band few-shot for
// 5★ specifically, (c) stronger instruction to NOT default high.
function buildAnchoredBandBlock(band: ScoreBand, starsRaw?: string): string {
  // `fraction` can be a sentinel < 0 when the band comes from a non-stars
  // source (letter grade), or NaN/Infinity if a caller fails validation.
  // Only emit the percentage when it's a real fraction in [0, 1.5].
  const hasUsablePct = Number.isFinite(band.fraction) && band.fraction >= 0 && band.fraction <= 1.5;
  const pctText = hasUsablePct ? `${Math.round(band.fraction * 100)}%` : null;
  const bandWidth = band.ceiling - band.floor;
  const ratingLine = starsRaw
    ? `## Original Rating\nThe critic awarded **${starsRaw}**${pctText ? ` (${pctText} of max)` : ''}.`
    : pctText
    ? `## Original Rating\nThe critic's rating maps to ${pctText} of max.`
    : `## Original Rating\nThe critic's rating maps to band [${band.floor}, ${band.ceiling}].`;

  // Compute calibration anchor points within the band so the table is
  // mathematically consistent (top quartile, upper-mid, lower-mid, floor).
  const q4 = band.ceiling;                                  // top
  const q3 = Math.round(band.floor + bandWidth * 0.66);     // upper-mid
  const q2 = Math.round(band.floor + bandWidth * 0.33);     // lower-mid
  const q1 = band.floor;                                    // floor

  // Floor-of-band few-shot anchored to the SPECIFIC band the LLM is in.
  // For wider bands (e.g. 4★ at [71,90]) we still want a "barely qualifying"
  // example at the floor. The example below is generic enough to apply.
  const floorFewShot = `### Within-Band Calibration Example
A critic awards their top rating and writes prose like:
"It's a strong, intelligent production with a fine cast. The book is sharp,
the songs land, and there are no sustained low patches. I left smiling and
would happily go again — though I won't pretend it cracked the top tier of
the season."

This is a FLOOR-OF-BAND review. The critic awarded the rating, so it stays
in band — but the prose is measured, the closing line explicitly qualifies,
and no superlatives appear. Score: **${q1}** (floor of band).

Now consider the same critic's same top rating with prose like:
"There are nights in the theater you can feel are happening. Every choice
on stage lands; every performance has been rehearsed into a kind of
inevitability. See it now, see it twice, and tell everyone you know."

This is a CEILING-OF-BAND review. Career-best framing, "see it twice",
unqualified superlatives. Score: **${q4}** (ceiling of band).
`;

  return `${ratingLine}

## Anchored Score Band (HARD CONSTRAINT)

Your score MUST be an integer in **[${band.floor}, ${band.ceiling}]**. Do not output a score outside this range. The critic's rating sets the band — your job is to pick the position WITHIN it that best matches the prose.

**The default is NOT the top of the band.** A common failure mode is to read the star rating and reach for the ceiling. The critic already encoded their verdict in the star — your job is to extract the PROSE WARMTH and translate it to a within-band position. If the prose is measured, the score should be measured. If the prose is rapturous, the score should be rapturous.

## Prose-to-band calibration

| Score in band | Prose signature |
|---------------|----------------|
| **${q4}** (ceiling) | Career-best language. Sustained superlatives. Explicit "must-see" / "see it twice" / "tell everyone". No qualifications. |
| **${q3}** (upper-mid) | Strong consistent praise. Standard rave language ("superb", "first-rate"). One or two minor qualifications at most. |
| **${q2}** (lower-mid) | Clear positive verdict but tonally measured. Reads like a respected critic in a workmanlike mode. No reach for superlatives. |
| **${q1}** (floor) | Critic awarded the rating, but the prose is qualified, biographical-context-heavy, or contains explicit reservations the critic chose not to demote. Pleasant but not effusive. "Worth seeing" energy rather than "must-see". |

If the prose contains words like "unassuming," "ordinary," "easy," "gentle," "humdrum," "modest," "pleasant," or extensive biographical/source-material context with limited evaluative praise of the production itself — that points to the **lower half of the band** even if the star rating is the critic's maximum.

If the prose is dominated by superlatives, unqualified recommendation, explicit "must-see" framing, or comparison to career-best work — that points to the **upper half of the band**.

${floorFewShot}

`;
}

// Unanchored-mode block: emitted when no band is passed. Rebuilt rubric
// that explicitly authorizes 95-100 scores for the strongest raves, with
// the V6 high-end few-shots showing what those look like.
const UNANCHORED_FULL_RANGE_BLOCK = `## Score Distribution (USE THE FULL RANGE)

Do NOT cluster scores in the 80-87 zone. The 0-100 range is real — use it.

- **Rave 96-100** Once-in-a-season / once-in-a-career level. Career-best praise from the critic, sustained superlatives, explicit "must-see" / "go now" / "tell everyone" framing. No reservations anywhere. **Use 100 for the most rapturous reviews — do not cap at 95.**
- **Rave 91-95** Strong rave with no caveats. "Superb," "first-rate," "one of the year's best." Clear and consistent praise.
- **Rave 83-90** Floor of Rave. Consistent praise but tonally measured. Critic clearly recommends without reservations but doesn't reach for superlatives.
- **Positive 78-82** Strong recommendation with at least one real caveat.
- **Positive 74-77** Solid recommendation, notable reservations.
- **Positive 70-73** Barely positive, heavily qualified.
- **Mixed 55-69** Genuinely on the fence.
- **Negative 35-54** Cannot recommend.
- **Pan 0-34** Avoid. Use 0-15 for the most damning pans — do not cluster at 25-30.

`;

const SYSTEM_PROMPT_V6_BASE = `You are a theater critic review scorer for Broadway and West End shows. Your task is to determine how strongly a critic recommends seeing a show based on their review text.

## Step 0: Is This Text Scoreable?

Before scoring, check if this text is actually a scoreable review of the target show. If ANY of the following apply, DO NOT score — return a rejection instead:

| Rejection Reason | Description |
|-----------------|-------------|
| wrong_show | Text is about a completely different show or topic |
| wrong_production | Reviews a different production than the one specified in the Show context. **Check the venue and market carefully**: same show title at the wrong venue/market = wrong production. Also reject touring, regional, transfer, or preview/workshop productions at other venues. |
| not_a_review | Press release, plot summary with no evaluation, cast listing, or promotional content |
| garbage_text | Navigation menus, error pages, ad copy, login prompts, or other non-article content |

The following are NOT rejections — score them, but with reduced confidence:

| Situation | How to Handle |
|-----------|--------------|
| **Multi-show roundup** | Score the portion about the target show. Set confidence to "low" if less than ~150 words about it. |
| **Truncated text** | Score what's available. Set confidence to "low" if the verdict/conclusion appears cut off. |
| **Excerpt only** | Score the excerpt. Set confidence to "low". |

If rejecting, respond with ONLY this JSON:
{
  "scoreable": false,
  "rejection": "wrong_show",
  "reasoning": "Brief explanation of why this is not scoreable"
}

If scoreable, proceed to Step 1.

## Step 1: Choose the Bucket

Classify the review into ONE of these buckets:

| Bucket | Description |
|--------|-------------|
| **Rave** | Strong recommendation with no significant reservations. Does NOT require superlatives — consistent praise is enough. |
| **Positive** | Recommends seeing it, BUT with reservations, caveats, or mixed elements |
| **Mixed** | Neither recommends nor discourages |
| **Negative** | Does not recommend |
| **Pan** | Strongly negative |

## Critical Instructions

1. **VERDICT OVER SETUP**: Many reviews open with negative context before delivering a positive verdict. Score the FINAL RECOMMENDATION.
2. **CURRENT PRODUCTION ONLY**: If the review compares to previous productions, score only THIS production.
3. **EXPLICIT RECOMMENDATIONS**: "must-see", "skip it", "don't miss", "not worth it" should heavily influence the bucket.
4. **BIOGRAPHICAL CONTEXT IS NOT CRITICISM**: Background about the SUBJECT is not criticism of the SHOW.
5. **EVALUATIVE TEXT IS NOT PLOT SUMMARY**: Performance/staging descriptions count as evaluation.

## Structural Review Patterns

When a review structurally praises a show heavily and then reserves criticism for one specific section, weight by content volume. A review that spends 70% on praise and 30% on Act-2 critique is a qualified rave (upper Positive ~78), not Mixed. Wistful closing tone does NOT downgrade an otherwise-positive review.

## Negative Review Patterns

**PERFORMER PRAISE DOES NOT REDEEM A PAN.** "A game cast giving their all" while panning the book/direction is NEGATIVE.

**USE THE FULL PAN RANGE.** Reviews that warn audiences away should score 10-20.

`;

const SYSTEM_PROMPT_V6_OUTPUT = `## Output Format

Respond with ONLY this JSON (no markdown code fences, no explanation outside the JSON):

{
  "scoreable": true,
  "bucket": "Positive",
  "score": 79,
  "confidence": "high",
  "verdict": "recommended with reservations",
  "keyQuote": "One COMPLETE SENTENCE (40-150 chars) where the critic directly evaluates the show — an opinion, not plot summary or context.",
  "reasoning": "1-2 sentences explaining your classification",
  "publishDate": "YYYY-MM-DD or null"
}

## Confidence Levels
- **high**: Clear verdict language, unambiguous tone
- **medium**: Some ambiguity but overall direction is clear
- **low**: Genuinely mixed signals, or truncated text with unclear verdict
`;

/**
 * Build the V6 system prompt.
 *
 * @param band - if provided, emits anchored-mode prompt with hard constraint
 *               on the score range. If omitted, emits unanchored-mode prompt
 *               with full-range rubric and high-end few-shots.
 * @param starsRaw - optional raw rating string (e.g. "5/5", "3.5/4", "A-")
 *                   to surface to the LLM in anchored mode for context.
 */
export function buildSystemPromptV6(band?: ScoreBand, starsRaw?: string): string {
  const middle = band
    ? buildAnchoredBandBlock(band, starsRaw)
    : UNANCHORED_FULL_RANGE_BLOCK;

  const examples = FEW_SHOT_EXAMPLES_V6.map(
    (ex, i) => `### Example ${i + 1}: Score ${ex.score} (${ex.bucket})
Review: "${ex.reviewExcerpt}"
Reasoning: ${ex.reasoning}
`
  ).join('\n');

  return `${SYSTEM_PROMPT_V6_BASE}${middle}${SYSTEM_PROMPT_V6_OUTPUT}
## Calibration Examples

${examples}
### Example: Not Scoreable
Text: "The page you are looking for no longer exists..."
Response: { "scoreable": false, "rejection": "garbage_text", "reasoning": "404 page, not a review." }
`;
}

// ========================================
// COMPARATIVE WITHIN-BAND SCORING
// ========================================
// buildAnchoredBandBlock (above) positions a SINGLE review within its star
// band. In isolation, genuine strong raves all snap to the q3≈97 anchor, so a
// show's four 5★ raves show 97/97/97/97 even when the prose warmth differs.
// The comparative pass re-scores a show's same-band reviews TOGETHER so the
// models rank them by relative warmth (validated 2026-06-05: GPT-4o + Gemini
// both spread War Horse's four 5★ reviews 92-99 and agreed on the ordering).
// The pure prompt/parser/combine live in scripts/lib/comparative-band.js so
// they're require()-testable with no API key; re-exported here per the
// scoring-config convention that all prompt builders are reachable from config.
// eslint-disable-next-line @typescript-eslint/no-var-requires
export const {
  buildComparativeBandPrompt,
  parseComparativeResponse,
  combineComparative,
  orderingAgreement,
} = require('../lib/comparative-band');

/**
 * Build the V6 user-message prompt for a review.
 * Same shape as buildPromptV5 — context + reviewText.
 */
export function buildPromptV6(reviewText: string, context: string = ''): string {
  return SCORING_PROMPT_V5
    .replace('{reviewText}', reviewText)
    .replace('{context}', context);
}

// ========================================
// V3 LEGACY PROMPT (kept for compatibility)
// ========================================

/**
 * Main scoring prompt template
 * {reviewText} will be replaced with the actual review
 * @deprecated Use buildPromptV5 for v5+ scoring
 */
export const SCORING_PROMPT_TEMPLATE = `Analyze this Broadway review and provide a comprehensive scoring.

## Review Text
"{reviewText}"

## Your Task

Analyze this review and respond with a JSON object containing:

1. **score** (0-100): Overall recommendation strength
2. **confidence** ("high" | "medium" | "low"): How confident you are in this score
3. **range** ({low, high}): Reasonable score range given uncertainty
4. **bucket** ("Rave" | "Positive" | "Mixed" | "Negative" | "Pan"): Category
5. **thumb** ("Up" | "Flat" | "Down"): Simple recommendation
6. **components**: Breakdown scores (null if not mentioned)
   - book (0-100 or null): Script/story quality
   - music (0-100 or null): Songs/music quality (musicals only)
   - performances (0-100 or null): Acting quality
   - direction (0-100 or null): Direction/design/production
7. **keyPhrases**: 2-3 COMPLETE SENTENCES from the review where the critic directly evaluates the show's quality. These will be displayed as the public-facing review excerpt.
   - Pick sentences with clear opinion/judgment (e.g., "This is a stunning achievement" or "The show stumbles in its second act"), NOT plot summary, historical context, or production credits
   - Each quote should be 40-150 characters, be a full grammatical sentence (not a fragment), and make sense without surrounding context
   - Prefer sentences from the middle or end of the review where critics typically state their verdict, not opening scene-setting paragraphs
   - Each with: quote (exact text from review), sentiment ("positive" | "negative" | "neutral"), strength (1-5)
8. **reasoning**: One sentence explaining your score
9. **flags**: Boolean flags
   - hasExplicitRecommendation: Does critic explicitly say "see it" or "skip it"?
   - focusedOnPerformances: Is this mainly about the actors, not the show?
   - comparesToPrevious: Does it compare to earlier productions?
   - mixedSignals: Are there conflicting positive/negative signals?

Respond ONLY with the JSON object, no other text.`;

// ========================================
// UTILITY FUNCTIONS
// ========================================

/**
 * Build the full prompt for a review
 */
export function buildPrompt(reviewText: string): string {
  return SCORING_PROMPT_TEMPLATE.replace('{reviewText}', reviewText);
}

/**
 * Convert score to bucket
 */
export function scoreToBucket(score: number): 'Rave' | 'Positive' | 'Mixed' | 'Negative' | 'Pan' {
  if (score >= BUCKET_RANGES.Rave.min) return 'Rave';       // 83
  if (score >= BUCKET_RANGES.Positive.min) return 'Positive'; // 70
  if (score >= BUCKET_RANGES.Mixed.min) return 'Mixed';       // 55
  if (score >= BUCKET_RANGES.Negative.min) return 'Negative'; // 35
  return 'Pan';
}

/**
 * Convert score to thumb
 */
export function scoreToThumb(score: number): 'Up' | 'Flat' | 'Down' {
  if (score >= 70) return 'Up';
  if (score >= 50) return 'Flat';
  return 'Down';
}

/**
 * Calculate tier from outlet configuration.
 * Reads from outlet-registry.json (single source of truth).
 *
 * Returns the full canonical tier set (1-4 as of v5). Previously narrowed to
 * 1|2|3 and collapsed T4→T3, which silently contaminated T3 calibration stats.
 */
export function getOutletTier(outletId: string): 1 | 2 | 3 | 4 {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getTier, VALID_TIERS, DEFAULT_TIER } = require('../lib/outlet-tiers');
  const tier = getTier(outletId);
  return (VALID_TIERS as number[]).includes(tier)
    ? (tier as 1 | 2 | 3 | 4)
    : (DEFAULT_TIER as 1 | 2 | 3 | 4);
}
