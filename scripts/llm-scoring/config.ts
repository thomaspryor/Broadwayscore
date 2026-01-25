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
    bucket: 'Positive',
    reasoning: '5/5 stars with consistent praise ("superb", "richly satisfying", "nary a false note"). Even without extreme superlatives, 5 stars = 85+ range.'
  },

  // 4-STAR example (score: 78) - clear recommendation
  {
    reviewExcerpt: `The dancers and singers of the ensemble are first-rate, and Wheeldon gives them a lot to do. As the 1992 incarnation, Frost carries the bulk of the role, and not only nails Jackson's signature sound and moves but also his otherworldly affect. The design is deluxe: dazzling costumes, a smooth set, flashy lighting. Worth seeing for the performances alone. (4/5 stars)`,
    score: 78,
    bucket: 'Positive',
    reasoning: '4/5 stars with clear praise for performances and design. 4 stars = 75-88 range.'
  },

  // POSITIVE example (score: 82)
  {
    reviewExcerpt: `June Squibb brings a lovable feistiness to the role of Marjorie, while Danny Burstein delivers another remarkable performance. The play raises fascinating questions about memory and identity in the age of AI. Some scenes drag slightly in the second half, but the ensemble work elevates the material throughout.`,
    score: 82,
    bucket: 'Positive',
    reasoning: 'Clear praise for performances and themes, minor caveat about pacing, overall positive recommendation.'
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

  // 2-STAR example (score: 45) - negative despite some praise
  {
    reviewExcerpt: `A monumentally silly show. Elder viewers reared on the comparatively subtle writing of Charles Busch are likely to find Escola's slapdash artistry crude, but there's no denying he snags laughs. I blush to admit that Escola is an artist new to me and their charm eludes me so far. The script may be flimsy. (2/5 stars)`,
    score: 45,
    bucket: 'Negative',
    reasoning: '2/5 stars despite acknowledging some laughs. Personal criticism ("charm eludes me", "flimsy script") signals negative. 2 stars = 35-55 range.'
  },

  // MIXED-NEGATIVE example (score: 42)
  {
    reviewExcerpt: `Despite a game cast giving their all, the production never finds its footing. The second act drags interminably, the songs are forgettable, and the direction seems uncertain whether to play it campy or sincere. A few bright moments, particularly in the Act One finale, aren't enough to save the evening.`,
    score: 42,
    bucket: 'Negative',
    reasoning: 'Predominantly negative with structural and creative criticisms, only isolated praise, cannot recommend.'
  },

  // NEGATIVE example (score: 30)
  {
    reviewExcerpt: `What should be a thrilling evening of theater is instead a tedious slog through underwritten characters and predictable plot beats. The performers seem stranded by the material, forced to emote wildly to compensate for the script's emptiness. By intermission, half the audience had checked out. I understand why.`,
    score: 30,
    bucket: 'Pan',
    reasoning: 'Harshly critical of script, direction, and overall experience. Notes audience disengagement. Clear pan.'
  }
];

// ========================================
// PROMPT TEMPLATES
// ========================================

export const PROMPT_VERSION = '3.0.0';

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

/**
 * Main scoring prompt template
 * {reviewText} will be replaced with the actual review
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
7. **keyPhrases**: 2-3 quotes from the review that most indicate sentiment
   - Each with: quote, sentiment ("positive" | "negative" | "neutral"), strength (1-5)
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
  if (score >= 90) return 'Rave';
  if (score >= 75) return 'Positive';
  if (score >= 50) return 'Mixed';
  if (score >= 35) return 'Negative';
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
 * Calculate tier from outlet configuration
 */
export function getOutletTier(outletId: string): 1 | 2 | 3 {
  const tier1 = ['NYT', 'VARIETY', 'THR', 'VULT', 'WASHPOST', 'WSJ', 'GUARDIAN', 'TIMEOUTNY', 'BWAYNEWS', 'LATIMES', 'AP'];
  const tier2 = ['NYP', 'CHTRIB', 'USATODAY', 'NYDN', 'EW', 'INDIEWIRE', 'DEADLINE', 'OBSERVER', 'TDB', 'SLANT', 'NYTHTR', 'NYTG', 'NYSR', 'TMAN', 'THLY', 'BWAYJOURNAL', 'STAGEBUDDY', 'WRAP'];

  const normalizedId = outletId.toUpperCase();
  if (tier1.includes(normalizedId)) return 1;
  if (tier2.includes(normalizedId)) return 2;
  return 3;
}
