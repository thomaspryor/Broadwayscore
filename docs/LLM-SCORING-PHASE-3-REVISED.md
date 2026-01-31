# LLM Scoring Phase 3: Revised Implementation Plan (v2)

**Goal:** Improve scoring accuracy through better prompts, richer context, simplified output, and a three-model ensemble (Claude + OpenAI + Gemini).

**Key insight from critique:** The original plan had issues with rigid scoring, potential thumb bias, and risky batch operations. This version addresses those.

---

## 3.1 Simplified Prompt Output

### Current Output (Too Complex)
```json
{
  "score": 78,
  "confidence": "high",
  "range": { "low": 72, "high": 84 },
  "bucket": "Positive",
  "thumb": "Up",
  "components": {
    "book": 75,
    "music": 82,
    "performances": 85,
    "direction": 78
  },
  "keyPhrases": [
    { "quote": "...", "sentiment": "positive", "strength": 4 },
    { "quote": "...", "sentiment": "negative", "strength": 2 },
    { "quote": "...", "sentiment": "positive", "strength": 5 }
  ],
  "reasoning": "...",
  "flags": {
    "hasExplicitRecommendation": true,
    "focusedOnPerformances": false,
    "comparesToPrevious": true,
    "mixedSignals": false
  }
}
```

### New Output (Simplified)
```json
{
  "bucket": "Positive",
  "score": 79,
  "confidence": "high",
  "verdict": "recommended with minor reservations",
  "keyQuote": "A rousing, entertaining triumph",
  "reasoning": "Despite negative setup about previous production, final verdict is clearly positive."
}
```

### What We Remove
| Field | Why Remove |
|-------|------------|
| `range` | Not used, adds complexity |
| `components` (book/music/performances/direction) | Not used in UI or aggregation |
| `keyPhrases` array (3 items with sentiment/strength) | Simplified to single `keyQuote` |
| `thumb` | Derived from bucket |
| `flags` (4 boolean flags) | Rarely used, adds cognitive load |

### Score Within Bucket (Not Rigid Mapping)

Instead of mapping bucket+position to fixed scores, we ask the LLM for a specific score within the bucket's range:

| Bucket | Score Range | Thumb |
|--------|-------------|-------|
| Rave | 85-100 | Up |
| Positive | 70-84 | Up |
| Mixed | 55-69 | Flat |
| Negative | 35-54 | Down |
| Pan | 0-34 | Down |

The LLM picks the bucket FIRST (easier), then assigns a specific score within that range (constrained problem = more reliable).

---

## 3.2 Richer Input Context

### For All Reviews
```
REVIEW TEXT:
[cleaned text here]

METADATA:
- Outlet: The New York Times (Tier 1)
- Show: Hamilton
- Critic: Ben Brantley
```

### For Truncated/Low-Confidence Text ONLY

Only for truncated texts, we add aggregator context with an explicit caveat:

```
REVIEW TEXT:
[truncated fullText here]

⚠️ TEXT QUALITY WARNING:
This text appears to be TRUNCATED and may be missing the final verdict.

AGGREGATOR CONTEXT (for reference, not gospel):
Human curators at review aggregators classified this review as:
- DTLI: Thumbs Up
- BWW: Thumbs Up

Curator-selected excerpts:
- "A rousing, entertaining triumph that captures the excitement..."

NOTE: Use this context to help identify the likely verdict, but make your own independent assessment. Aggregators can be wrong.
```

### Why This Approach
1. **Avoids bias for complete texts** - We don't show thumbs when we have good fullText
2. **Helps with truncated texts** - Where the verdict is literally missing
3. **Explicit caveat** - Tells LLM to think independently, not just agree

---

## 3.3 Three-Model Ensemble

### Models (Best Available)

| Role | Model | Reasoning |
|------|-------|-----------|
| Claude | `claude-sonnet-4-20250514` | Best for structured output, nuanced judgment |
| OpenAI | `gpt-4o` | Full model, better than mini for complex assessment |
| Gemini | `gemini-1.5-pro` | Most capable Gemini, good at following instructions |

### Ensemble Scoring Logic

```typescript
interface ModelScore {
  model: string;
  bucket: Bucket;
  score: number;
  confidence: 'high' | 'medium' | 'low';
}

function ensembleScore(results: ModelScore[]): EnsembleResult {
  // Filter out failed models
  const valid = results.filter(r => r.score !== null);

  if (valid.length === 0) {
    return { success: false, error: 'All models failed' };
  }

  if (valid.length === 1) {
    // Single model fallback
    return {
      score: valid[0].score,
      bucket: valid[0].bucket,
      confidence: 'low',
      source: 'single-model-fallback',
      warning: `Only ${valid[0].model} succeeded`
    };
  }

  if (valid.length === 2) {
    // Two-model fallback
    return twoModelEnsemble(valid);
  }

  // Full three-model ensemble
  return threeModelEnsemble(valid);
}

function threeModelEnsemble(results: ModelScore[]): EnsembleResult {
  const buckets = results.map(r => r.bucket);
  const scores = results.map(r => r.score);

  // Count bucket agreement
  const bucketCounts = countOccurrences(buckets);
  const majorityBucket = getMajorityBucket(bucketCounts);

  // Case 1: All 3 agree on bucket
  if (bucketCounts[majorityBucket] === 3) {
    const scoreSpread = Math.max(...scores) - Math.min(...scores);

    if (scoreSpread <= 8) {
      // Tight agreement - use mean
      return {
        score: Math.round(mean(scores)),
        bucket: majorityBucket,
        confidence: 'high',
        source: 'ensemble-unanimous',
        agreement: '3/3 models agree (tight)'
      };
    } else {
      // Same bucket but scores spread - use median
      return {
        score: median(scores),
        bucket: majorityBucket,
        confidence: 'high',
        source: 'ensemble-unanimous',
        agreement: '3/3 models agree (spread)',
        note: `Score spread: ${scoreSpread} pts, using median`
      };
    }
  }

  // Case 2: 2/3 agree on bucket
  if (bucketCounts[majorityBucket] === 2) {
    const agreeingResults = results.filter(r => r.bucket === majorityBucket);
    const outlier = results.find(r => r.bucket !== majorityBucket);

    const agreeingScores = agreeingResults.map(r => r.score);
    const scoreSpread = Math.abs(agreeingScores[0] - agreeingScores[1]);

    return {
      score: scoreSpread <= 8 ? Math.round(mean(agreeingScores)) : median(agreeingScores),
      bucket: majorityBucket,
      confidence: 'medium',
      source: 'ensemble-majority',
      agreement: `2/3 models agree`,
      outlier: {
        model: outlier.model,
        bucket: outlier.bucket,
        score: outlier.score
      }
    };
  }

  // Case 3: All 3 disagree on bucket - flag for review
  return {
    score: median(scores),
    bucket: scoreToBucket(median(scores)),
    confidence: 'low',
    source: 'ensemble-no-consensus',
    needsReview: true,
    reviewReason: `Models disagree: ${results.map(r => `${r.model}=${r.bucket}`).join(', ')}`,
    allResults: results
  };
}
```

### Graceful Degradation

| Models Available | Behavior |
|-----------------|----------|
| 3/3 | Full ensemble with majority voting |
| 2/3 | Two-model ensemble (average if agree, flag if not) |
| 1/3 | Single model with `confidence: 'low'` |
| 0/3 | Fail, mark review as `needsRescore: true` |

---

## 3.4 Revised System Prompt

```
You are a Broadway theater critic review scorer. Your task is to determine how strongly a critic recommends seeing a show based on their review text.

## Step 1: Choose the Bucket

Classify the review into ONE of these buckets:

| Bucket | Description | Examples |
|--------|-------------|----------|
| **Rave** | Enthusiastic, must-see recommendation | "masterpiece", "unmissable", "triumph", "essential viewing" |
| **Positive** | Recommends seeing it, with or without reservations | "worth seeing", "entertaining", "enjoyable", "recommended" |
| **Mixed** | Neither recommends nor discourages | "has its moments", "uneven", "hit or miss", "for fans only" |
| **Negative** | Does not recommend | "disappointing", "falls short", "skip the ticket price" |
| **Pan** | Strongly negative | "avoid", "waste of time", "terrible", "a disaster" |

## Step 2: Assign a Score Within the Bucket

After choosing the bucket, assign a specific score within its range:

| Bucket | Score Range |
|--------|-------------|
| Rave | 85-100 |
| Positive | 70-84 |
| Mixed | 55-69 |
| Negative | 35-54 |
| Pan | 0-34 |

Use the full range. A barely-positive review should be 70-72. A very strong positive should be 82-84.

## Critical Instructions

1. **VERDICT OVER SETUP**: Many reviews open with negative context (previous productions, source material issues, hype concerns) before delivering a positive verdict. ALWAYS score based on the FINAL RECOMMENDATION, not the opening setup.

2. **CURRENT PRODUCTION ONLY**: If the review compares to previous productions or revivals, score only the assessment of THIS production.

3. **TRUNCATED TEXT**: If warned that text is truncated, be cautious about low scores - the positive verdict may have been cut off. Weight any provided aggregator excerpts as additional evidence.

4. **EXPLICIT RECOMMENDATIONS**: Phrases like "must-see", "skip it", "don't miss", "not worth it" should heavily influence the bucket choice.

## Output Format

Respond with ONLY this JSON (no markdown code fences, no explanation outside the JSON):

{
  "bucket": "Positive",
  "score": 79,
  "confidence": "high",
  "verdict": "recommended with reservations",
  "keyQuote": "The most indicative phrase from the review",
  "reasoning": "1-2 sentences explaining your classification"
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
```

---

## 3.5 Gemini Adapter

Gemini may have different response formats. Build an adapter layer:

```typescript
// scripts/llm-scoring/gemini-scorer.ts
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SimplifiedLLMResult, ScoringContext } from './types';

export class GeminiScorer {
  private client: GoogleGenerativeAI;
  private model = 'gemini-1.5-pro';

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async scoreReview(text: string, context: ScoringContext): Promise<SimplifiedLLMResult> {
    const model = this.client.getGenerativeModel({
      model: this.model,
      generationConfig: {
        temperature: 0.3,  // Lower = more consistent
        topP: 0.8,
        maxOutputTokens: 500
      }
    });

    const prompt = buildPrompt(text, context);

    try {
      const result = await model.generateContent(prompt);
      const response = result.response.text();

      return this.parseResponse(response);
    } catch (error) {
      // Graceful failure
      return {
        success: false,
        error: `Gemini error: ${error.message}`
      };
    }
  }

  private parseResponse(response: string): SimplifiedLLMResult {
    // Gemini sometimes wraps JSON in markdown
    let cleaned = response.trim();

    // Remove markdown code fences if present
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    try {
      const parsed = JSON.parse(cleaned);
      return this.validateAndNormalize(parsed);
    } catch (e) {
      // Try to extract score/bucket even from malformed response
      return this.extractFromMalformed(response);
    }
  }

  private validateAndNormalize(parsed: any): SimplifiedLLMResult {
    // Ensure bucket is valid
    const validBuckets = ['Rave', 'Positive', 'Mixed', 'Negative', 'Pan'];
    if (!validBuckets.includes(parsed.bucket)) {
      // Try to map common variations
      const bucketMap: Record<string, string> = {
        'RAVE': 'Rave', 'POSITIVE': 'Positive', 'MIXED': 'Mixed',
        'NEGATIVE': 'Negative', 'PAN': 'Pan',
        'positive': 'Positive', 'negative': 'Negative'
      };
      parsed.bucket = bucketMap[parsed.bucket] || 'Mixed';
    }

    // Ensure score is in bucket range
    const ranges: Record<string, [number, number]> = {
      'Rave': [85, 100], 'Positive': [70, 84], 'Mixed': [55, 69],
      'Negative': [35, 54], 'Pan': [0, 34]
    };
    const [min, max] = ranges[parsed.bucket];
    parsed.score = Math.max(min, Math.min(max, parsed.score));

    return {
      success: true,
      bucket: parsed.bucket,
      score: parsed.score,
      confidence: parsed.confidence || 'medium',
      verdict: parsed.verdict || '',
      keyQuote: parsed.keyQuote || '',
      reasoning: parsed.reasoning || ''
    };
  }
}
```

### Pre-flight Test

Before scaling, test Gemini with 10 diverse reviews:

```typescript
async function testGeminiIntegration() {
  const testReviews = [
    // 2 clear Raves, 2 clear Positives, 2 Mixed, 2 Negative, 2 Pan
  ];

  const gemini = new GeminiScorer(process.env.GEMINI_API_KEY);

  for (const review of testReviews) {
    const result = await gemini.scoreReview(review.text, review.context);
    console.log(`Expected: ${review.expectedBucket}, Got: ${result.bucket}`);

    if (result.bucket !== review.expectedBucket) {
      console.warn('MISMATCH - investigate before scaling');
    }
  }
}
```

---

## 3.6 Version Tracking

Every scored review stores the prompt version:

```typescript
llmMetadata: {
  promptVersion: '5.0.0',  // INCREMENT for this release
  scoredAt: '2026-01-31T...',
  models: ['claude-sonnet-4', 'gpt-4o', 'gemini-1.5-pro'],
  ensembleSource: 'ensemble-unanimous',
  // For rollback capability:
  previousScore: 78,
  previousVersion: '4.0.0'
}
```

If v5 causes problems, we can restore v4 scores without re-running LLMs.

---

## 3.7 Calibration Plan (200 Reviews)

### Dataset Composition

| Bucket | Count | Source |
|--------|-------|--------|
| Rave | 40 | Reviews where both DTLI and BWW thumbs = Up, excerpt contains "must-see"/"masterpiece" |
| Positive | 40 | Reviews where thumbs = Up, no superlatives |
| Mixed | 40 | Reviews where thumbs disagree OR thumb = Meh/Flat |
| Negative | 40 | Reviews where thumbs = Down, no strong language |
| Pan | 40 | Reviews where thumbs = Down, excerpt contains "avoid"/"terrible" |

### Stratification
Within each bucket:
- 50% Tier 1 outlets
- 30% Tier 2 outlets
- 20% Tier 3 outlets

### Calibration Metrics

| Metric | Definition | Target |
|--------|------------|--------|
| 3-model bucket agreement | All 3 models same bucket | ≥60% |
| 2-model bucket agreement | At least 2/3 same bucket | ≥90% |
| Bucket accuracy vs human | Our bucket matches expected | ≥85% |
| Score spread (same bucket) | Max-min when models agree | ≤10 pts avg |
| Severe outlier rate | One model ≥2 buckets different | ≤5% |

### Gemini-Specific Calibration

After initial run, analyze:
1. **Systematic bias**: Is Gemini consistently harsher or more lenient?
2. **Bucket confusion**: Does Gemini confuse specific buckets (e.g., Mixed vs Negative)?
3. **Outlier rate**: How often is Gemini the outlier vs Claude/OpenAI?

If Gemini has systematic bias >5 points, apply calibration offset:
```typescript
const GEMINI_CALIBRATION_OFFSET = -3; // If Gemini scores 3pts high on average
geminiScore = rawGeminiScore + GEMINI_CALIBRATION_OFFSET;
```

---

## 3.8 Batched Rescore with Validation Gates

Instead of rescoring all 2,000 reviews at once, use validated batches:

### Batch Strategy

```
Batch 1: 200 reviews (calibration set)
  → Run all 3 models
  → Validate metrics meet targets
  → If FAIL: Stop, investigate, fix
  → If PASS: Continue

Batch 2-5: 200 reviews each (800 total)
  → Run all 3 models
  → After each batch: Quick validation
    - 3-model agreement still ≥60%?
    - No systematic drift detected?
  → If metrics degrade: Stop, investigate

Batch 6-10: 200 reviews each (1000 total)
  → Continue with spot checks

Final validation:
  → Compare old vs new scores
  → Review all cases where score changed by >20 points
  → Review all needsReview flags
```

### Validation Checks Per Batch

```typescript
function validateBatch(results: ScoredReview[]): ValidationResult {
  const checks = {
    agreementRate: calc3ModelAgreement(results),
    avgScoreSpread: calcAvgScoreSpread(results),
    needsReviewCount: results.filter(r => r.needsReview).length,
    failureRate: results.filter(r => !r.success).length / results.length
  };

  const passed =
    checks.agreementRate >= 0.55 &&  // Allow 5% below target during batches
    checks.avgScoreSpread <= 12 &&
    checks.needsReviewCount <= 30 &&  // Max 15% flagged
    checks.failureRate <= 0.05;

  return { passed, checks };
}
```

---

## 3.9 Implementation Steps

### Step 1: Update Types
```typescript
// types.ts
interface SimplifiedLLMResult {
  bucket: 'Rave' | 'Positive' | 'Mixed' | 'Negative' | 'Pan';
  score: number;  // Within bucket range
  confidence: 'high' | 'medium' | 'low';
  verdict: string;
  keyQuote: string;
  reasoning: string;
}

interface EnsembleResult {
  score: number;
  bucket: string;
  confidence: 'high' | 'medium' | 'low';
  source: 'ensemble-unanimous' | 'ensemble-majority' | 'ensemble-no-consensus' | 'single-model-fallback';
  agreement?: string;
  needsReview?: boolean;
  reviewReason?: string;
  modelResults: {
    claude?: { bucket: string; score: number };
    openai?: { bucket: string; score: number };
    gemini?: { bucket: string; score: number };
  };
}
```

### Step 2: Implement Gemini Scorer
- New file: `scripts/llm-scoring/gemini-scorer.ts`
- Add adapter layer with response normalization
- Add GEMINI_API_KEY to GitHub secrets

### Step 3: Update Prompt Config
- New system prompt with bucket-first approach
- Score-within-range instruction
- Verdict examples

### Step 4: Build Input Context Builder
- `scripts/llm-scoring/input-builder.ts`
- Add text quality context for truncated texts
- Add aggregator thumbs/excerpts (truncated only)

### Step 5: Update Ensemble Logic
- 3-model voting with graceful degradation
- Median for spread cases
- Proper fallback chain

### Step 6: Pre-flight Testing
- Test Gemini with 10 diverse reviews
- Verify response parsing works
- Check for systematic issues

### Step 7: Calibration Run
- 200 reviews across all buckets
- Measure all metrics
- Tune Gemini offset if needed

### Step 8: Batched Rescore
- 200 reviews per batch
- Validation gates between batches
- Stop on metric degradation

---

## 3.10 Files to Create/Modify

### Create
| File | Purpose |
|------|---------|
| `scripts/llm-scoring/gemini-scorer.ts` | Gemini API integration with adapter |
| `scripts/llm-scoring/input-builder.ts` | Build rich context for prompts |
| `scripts/llm-scoring/ensemble.ts` | 3-model ensemble logic |
| `scripts/calibrate-ensemble.ts` | Calibration runner |
| `scripts/batch-rescore.ts` | Batched rescore with validation |
| `data/calibration/calibration-set-200.json` | Calibration dataset |

### Modify
| File | Changes |
|------|---------|
| `scripts/llm-scoring/types.ts` | Simplified result type, ensemble types |
| `scripts/llm-scoring/config.ts` | New prompt, bump PROMPT_VERSION to 5.0.0 |
| `scripts/llm-scoring/scorer.ts` | Use new prompt/output format |
| `scripts/llm-scoring/index.ts` | Integrate 3-model ensemble |
| `.github/workflows/llm-ensemble-score.yml` | Add GEMINI_API_KEY, batch support |

---

## 3.11 Rollout Plan

```
Week 1: Implementation
  Day 1-2: Update types, config, new prompt
  Day 3-4: Implement Gemini scorer with adapter
  Day 5: Build input context builder
  Day 6-7: Update ensemble logic for 3 models

Week 2: Testing & Calibration
  Day 1: Pre-flight test Gemini (10 reviews)
  Day 2-3: Build calibration set (200 reviews)
  Day 4-5: Run calibration, analyze results
  Day 6-7: Tune Gemini offset if needed, re-validate

Week 3: Batched Rescore
  Day 1: Batch 1 (200) + full validation
  Day 2-3: Batches 2-5 (800) with spot checks
  Day 4-5: Batches 6-10 (1000)
  Day 6-7: Review flagged items, fix issues

Week 4: Validation & Deployment
  Day 1-2: Compare old vs new scores
  Day 3-4: Manual review of big changes (>20 pts)
  Day 5: Update thumb override logic (Phase 4)
  Day 6-7: Deploy, monitor
```

---

## 3.12 Success Criteria

| Metric | Current | Target |
|--------|---------|--------|
| Thumb match rate | 69% | ≥85% |
| 3-model consensus | N/A | ≥60% |
| 2-model consensus | ~85% | ≥92% |
| Reviews flagged for review | 0 | ≤100 (5%) |
| Severe bucket errors | ~8% | ≤3% |
| Average score spread (agreeing models) | N/A | ≤8 pts |

---

## 3.13 Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Gemini returns different format | Adapter layer with normalization |
| Gemini has systematic bias | Calibration offset after 200-review test |
| One model goes down mid-rescore | Graceful fallback to 2-model |
| Batch introduces systematic error | Validation gates, stop on degradation |
| New prompt causes regression | Version tracking, can restore old scores |
| Thumb context biases LLM | Only show for truncated texts, with caveat |
| 200 reviews not enough for calibration | Stratify by bucket AND tier, monitor during batches |
