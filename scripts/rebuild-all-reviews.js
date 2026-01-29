#!/usr/bin/env node
/**
 * Rebuild reviews.json from ALL review-texts data
 *
 * IMPORTANT: Reviews WITHOUT a valid score source are EXCLUDED
 * We NEVER use a default score of 50 - that skews results
 *
 * Score priority:
 * 1. llmScore.score (if confidence != 'low' AND ensembleData.needsReview != true)
 * 2. assignedScore (if already set and valid, with known source)
 * 3. originalScore parsed (stars, letter grades)
 * 4. bucket mapping (Rave=90, Positive=82, Mixed=65, Negative=48, Pan=30)
 * 5. dtliThumb or bwwThumb (Up=80, Flat=60, Down=35)
 * 6. SKIP - do not include in reviews.json
 */

const fs = require('fs');
const path = require('path');

// Score mappings
const THUMB_TO_SCORE = { 'Up': 80, 'Meh': 60, 'Flat': 60, 'Down': 35 };
const BUCKET_TO_SCORE = { 'Rave': 90, 'Positive': 82, 'Mixed': 65, 'Negative': 48, 'Pan': 30 };
const LETTER_TO_SCORE = {
  'A+': 97, 'A': 93, 'A-': 90,
  'B+': 87, 'B': 83, 'B-': 80,
  'C+': 77, 'C': 73, 'C-': 70,
  'D+': 55, 'D': 50, 'D-': 45,
  'F': 30
};

// Paths
const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const reviewsJsonPath = path.join(__dirname, '../data/reviews.json');

/**
 * Decode ALL HTML entities properly
 */
function decodeHtmlEntities(text) {
  if (!text) return text;
  return text
    // Numeric entities
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    // Named entities - common ones
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '...')
    .replace(/&auml;/g, 'ä')
    .replace(/&ouml;/g, 'ö')
    .replace(/&uuml;/g, 'ü')
    .replace(/&apos;/g, "'")
    .replace(/&copy;/g, '©')
    .replace(/&reg;/g, '®')
    .replace(/&trade;/g, '™')
    .replace(/&euro;/g, '€')
    .replace(/&pound;/g, '£');
}

/**
 * Detect if text looks like website navigation/junk rather than review content
 */
function isJunkExcerpt(text) {
  if (!text) return true;

  // Patterns that indicate website chrome/navigation
  const junkPatterns = [
    /^Home\s+(Legit|News|Reviews)/i,                    // "Home Legit Reviews..."
    /^\d{1,2}:\d{2}\s*(AM|PM)\s*(PT|ET|CT)/i,          // "5:30pm PT"
    /Plus Icon.*Latest/i,                               // "Plus Icon Aramide Tinubu Latest"
    /See All\s+[A-Z]/i,                                 // "See All Matthew Murphy"
    /\d+ (day|week|month|hour)s? ago/i,                // "1 day ago"
    /Related Stories/i,                                 // "Related Stories"
    /By [A-Z][a-z]+ [A-Z][a-z]+ Plus Icon/i,           // "By Author Name Plus Icon"
    /TV Review.*TV Review/i,                            // Multiple "TV Review" = sidebar
    /Photo:/i,                                          // Photo credits
    /Matthew Murphy\s+[A-Z]/,                           // Photo credit pattern
    /\bdefineSlot\b|\bsetTargeting\b|\bgoogletag\b/i,  // Ad code
    /blogherads/i,                                      // Ad code
  ];

  for (const pattern of junkPatterns) {
    if (pattern.test(text)) return true;
  }

  // If first 50 chars contain multiple timestamps/dates, likely junk
  const first50 = text.substring(0, 50);
  const datePatterns = first50.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+/gi) || [];
  if (datePatterns.length >= 2) return true;

  return false;
}

/**
 * Clean excerpt text from aggregator sources
 * Fixes: JavaScript/ad code, HTML entities, multi-critic concatenation
 */
function cleanExcerpt(text, aggressive = false) {
  if (!text) return null;

  let cleaned = decodeHtmlEntities(text);

  // Remove JavaScript/ad code patterns
  cleaned = cleaned.replace(/blogherads\.[^;]+;?/gi, '');
  cleaned = cleaned.replace(/\.defineSlot\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.setTargeting\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.addSize\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.exemptFromSleep\(\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.setClsOptimization\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.setSubAdUnitPath\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/googletag\.[^;]+;?/gi, '');
  cleaned = cleaned.replace(/\[\s*["']mid-article\d*["'][^\]]*\]/gi, '');
  cleaned = cleaned.replace(/Related Stories\s+[A-Z][^"]*$/gi, '');

  // Remove photo credits mixed into text
  cleaned = cleaned.replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\s+(?=Thirty|The|In|When|After|Before|It|This|That|A|An)/g, '');

  // Stop at next critic attribution (BWW roundups concatenate multiple critics)
  const nextCriticMatch = cleaned.match(/\.\s+[A-Z][a-z]+(?:\s+[A-Z][a-z'-]+)?,\s+[A-Z][^:]+:/);
  if (nextCriticMatch && nextCriticMatch.index > 50) {
    cleaned = cleaned.substring(0, nextCriticMatch.index + 1);
  }

  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Skip if starts mid-sentence (unless it's a quote)
  if (/^[a-z]/.test(cleaned) && !cleaned.startsWith('"') && cleaned.length < 100) {
    // Try to find the first complete sentence
    const sentenceStart = cleaned.search(/[.!?]\s+[A-Z]/);
    if (sentenceStart > 0 && sentenceStart < cleaned.length - 50) {
      cleaned = cleaned.substring(sentenceStart + 2);
    } else {
      return null;
    }
  }

  // Skip junk excerpts
  if (isJunkExcerpt(cleaned)) {
    return null;
  }

  // Truncate to 350 chars at sentence boundary
  if (cleaned.length > 350) {
    const truncateAt = cleaned.lastIndexOf('.', 350);
    cleaned = truncateAt > 100 ? cleaned.substring(0, truncateAt + 1) : cleaned.substring(0, 347) + '...';
  }

  // Final junk check
  if (/defineSlot|setTargeting|blogherads|Plus Icon/i.test(cleaned)) {
    return null;
  }

  return cleaned.length > 30 ? cleaned : null;
}

/**
 * Extract a good opening excerpt from full review text
 */
function extractExcerptFromFullText(fullText, showTitle) {
  if (!fullText || fullText.length < 200) return null;

  let text = decodeHtmlEntities(fullText);

  // Split into paragraphs/sentences
  const sentences = text.split(/(?<=[.!?])\s+/);

  // Find the first substantive sentence (skip bylines, photo credits)
  let excerpt = '';
  for (const sentence of sentences) {
    // Skip short fragments, bylines, photo credits
    if (sentence.length < 30) continue;
    if (/^By\s+[A-Z]/i.test(sentence)) continue;
    if (/^Photo:/i.test(sentence)) continue;
    if (/^\d{1,2}:\d{2}/i.test(sentence)) continue;

    excerpt += (excerpt ? ' ' : '') + sentence;

    // Stop after 2-3 good sentences or ~300 chars
    if (excerpt.length >= 250 || (excerpt.match(/[.!?]/g) || []).length >= 2) {
      break;
    }
  }

  if (excerpt.length < 50) return null;

  // Truncate if needed
  if (excerpt.length > 350) {
    const truncAt = excerpt.lastIndexOf('.', 350);
    excerpt = truncAt > 100 ? excerpt.substring(0, truncAt + 1) : excerpt.substring(0, 347) + '...';
  }

  return excerpt;
}

/**
 * Select the best available excerpt using smart priority
 * Priority: LLM keyPhrases > showScoreExcerpt > fullText extract > bwwExcerpt > dtliExcerpt
 */
function selectBestExcerpt(data) {
  // 1. Try LLM-extracted key phrases first (already curated quotes!)
  if (data.llmScore?.keyPhrases?.length > 0) {
    // Find a positive or descriptive quote
    for (const phrase of data.llmScore.keyPhrases) {
      if (phrase.quote && phrase.quote.length > 30 && phrase.sentiment !== 'negative') {
        const cleaned = cleanExcerpt(phrase.quote);
        if (cleaned && !isJunkExcerpt(cleaned)) {
          return cleaned;
        }
      }
    }
    // Fall back to any quote
    for (const phrase of data.llmScore.keyPhrases) {
      if (phrase.quote && phrase.quote.length > 30) {
        const cleaned = cleanExcerpt(phrase.quote);
        if (cleaned && !isJunkExcerpt(cleaned)) {
          return cleaned;
        }
      }
    }
  }

  // 2. Try showScoreExcerpt (usually human-curated, cleaner)
  if (data.showScoreExcerpt) {
    const cleaned = cleanExcerpt(data.showScoreExcerpt);
    if (cleaned && cleaned.length > 40) {
      return cleaned;
    }
  }

  // 3. Try extracting from fullText
  if (data.fullText && data.fullText.length > 300) {
    const extracted = extractExcerptFromFullText(data.fullText, data.showId);
    if (extracted && extracted.length > 50) {
      return extracted;
    }
  }

  // 4. Try bwwExcerpt (usually cleaner than DTLI)
  if (data.bwwExcerpt) {
    const cleaned = cleanExcerpt(data.bwwExcerpt);
    if (cleaned && cleaned.length > 40) {
      return cleaned;
    }
  }

  // 5. Last resort: dtliExcerpt with aggressive cleaning
  if (data.dtliExcerpt) {
    const cleaned = cleanExcerpt(data.dtliExcerpt, true);
    if (cleaned && cleaned.length > 40) {
      return cleaned;
    }
  }

  // 6. Try existing pullQuote if nothing else works
  if (data.pullQuote) {
    const cleaned = cleanExcerpt(data.pullQuote);
    if (cleaned && cleaned.length > 40) {
      return cleaned;
    }
  }

  return null;
}

// Stats tracking
const stats = {
  totalFiles: 0,
  totalReviews: 0,
  skippedNoScore: 0,
  skippedDuplicate: 0,
  scoreSources: {
    llmScore: 0,
    'llmScore-lowconf': 0,
    'llmScore-review': 0,
    assignedScore: 0,
    originalScore: 0,
    bucket: 0,
    thumb: 0
  },
  byShow: {}
};

const skippedReviews = [];

function parseStarRating(rating) {
  if (!rating) return null;
  const r = rating.toString();

  const starMatch = r.match(/^(\d(?:\.\d)?)\s*(?:\/\s*(\d)|out\s+of\s+(\d)|stars?)/i);
  if (starMatch) {
    const stars = parseFloat(starMatch[1]);
    const maxStars = parseInt(starMatch[2] || starMatch[3] || '5');
    return Math.round((stars / maxStars) * 100);
  }

  const starSymbols = (r.match(/★/g) || []).length;
  const emptyStars = (r.match(/☆/g) || []).length;
  if (starSymbols > 0) {
    const total = starSymbols + emptyStars || 5;
    return Math.round((starSymbols / total) * 100);
  }

  return null;
}

function parseLetterGrade(rating) {
  if (!rating) return null;
  const r = rating.toString().trim().toUpperCase();

  const letterMatch = r.match(/^([A-D][+-]?|F)$/i);
  if (letterMatch) {
    return LETTER_TO_SCORE[letterMatch[1].toUpperCase()] || null;
  }

  return null;
}

function parseOriginalScore(rating) {
  if (!rating) return null;

  const starScore = parseStarRating(rating);
  if (starScore !== null) return starScore;

  const letterScore = parseLetterGrade(rating);
  if (letterScore !== null) return letterScore;

  const numMatch = rating.toString().match(/^(\d+)\s*(?:\/\s*100)?$/);
  if (numMatch) {
    const num = parseInt(numMatch[1]);
    if (num >= 0 && num <= 100) return num;
  }

  return null;
}

function getBestScore(data) {
  // Skip if explicitly marked as TO_BE_CALCULATED
  if (data.scoreStatus === 'TO_BE_CALCULATED') {
    return null;
  }

  // Priority 1: LLM score (accept all LLM scores, even low confidence)
  // Rationale: A low-confidence LLM score is still better than no score
  if (data.llmScore && data.llmScore.score) {
    const confidence = data.llmScore.confidence;
    const needsReview = data.ensembleData?.needsReview;

    // High/medium confidence: use directly
    if (confidence !== 'low' && !needsReview) {
      return { score: data.llmScore.score, source: 'llmScore' };
    }
    // Low confidence or needs review: still use, but mark source
    if (confidence === 'low') {
      return { score: data.llmScore.score, source: 'llmScore-lowconf' };
    }
    if (needsReview) {
      return { score: data.llmScore.score, source: 'llmScore-review' };
    }
  }

  // Priority 2: Existing assignedScore (if valid AND has a known source)
  // We accept sentiment-based scores from our fix script
  if (data.assignedScore && data.assignedScore >= 1 && data.assignedScore <= 100) {
    // Check if this has a legitimate source
    const validSources = ['llmScore', 'originalScore', 'bucket', 'thumb', 'extracted-grade',
                          'sentiment-strong-positive', 'sentiment-positive', 'sentiment-mixed-positive',
                          'sentiment-mixed', 'sentiment-mixed-negative', 'sentiment-negative',
                          'sentiment-strong-negative', 'manual'];

    if (data.scoreSource && validSources.some(s => data.scoreSource.includes(s))) {
      return { score: data.assignedScore, source: 'assignedScore' };
    }

    // Also accept if there's evidence of how it was scored (thumb data, etc.)
    if (data.dtliThumb || data.bwwThumb || data.originalScore || data.bucket) {
      return { score: data.assignedScore, source: 'assignedScore' };
    }
  }

  // Priority 3: Parse original score
  if (data.originalScore) {
    const parsed = parseOriginalScore(data.originalScore);
    if (parsed !== null) {
      return { score: parsed, source: 'originalScore' };
    }
  }

  // Priority 4: Bucket mapping
  if (data.bucket && BUCKET_TO_SCORE[data.bucket]) {
    return { score: BUCKET_TO_SCORE[data.bucket], source: 'bucket' };
  }

  // Priority 5: Thumb mappings (dtli first, then bww)
  if (data.dtliThumb && THUMB_TO_SCORE[data.dtliThumb]) {
    return { score: THUMB_TO_SCORE[data.dtliThumb], source: 'thumb' };
  }
  if (data.bwwThumb && THUMB_TO_SCORE[data.bwwThumb]) {
    return { score: THUMB_TO_SCORE[data.bwwThumb], source: 'thumb' };
  }
  if (data.thumb && THUMB_TO_SCORE[data.thumb]) {
    return { score: THUMB_TO_SCORE[data.thumb], source: 'thumb' };
  }

  // NO DEFAULT - return null to skip this review
  return null;
}

function scoreToBucket(score) {
  if (score >= 85) return 'Rave';
  if (score >= 70) return 'Positive';
  if (score >= 55) return 'Mixed';
  if (score >= 40) return 'Negative';
  return 'Pan';
}

function scoreToThumb(score) {
  if (score >= 70) return 'Up';
  if (score >= 55) return 'Flat';
  return 'Down';
}

function normalizeOutletId(outlet) {
  if (!outlet) return 'unknown';
  return outlet.toString().toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 20);
}

// Main execution
console.log('=== REBUILDING ALL REVIEWS ===\n');
console.log('NOTE: Reviews without valid scores are EXCLUDED (no default of 50)\n');

// Get all show directories
const showDirs = fs.readdirSync(reviewTextsDir)
  .filter(f => {
    const fullPath = path.join(reviewTextsDir, f);
    return fs.statSync(fullPath).isDirectory();
  });

console.log(`Found ${showDirs.length} show directories\n`);

const allReviews = [];

showDirs.forEach(showId => {
  const showDir = path.join(reviewTextsDir, showId);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  stats.byShow[showId] = { files: files.length, reviews: 0, skipped: 0 };
  stats.totalFiles += files.length;

  // Track seen outlet+critic combinations to avoid duplicates
  const seenKeys = new Set();

  files.forEach(file => {
    try {
      const filePath = path.join(showDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Skip wrong-production reviews (e.g., off-Broadway reviews filed under Broadway show)
      if (data.wrongProduction === true) {
        stats.skippedWrongProduction = (stats.skippedWrongProduction || 0) + 1;
        return;
      }

      // Skip wrong-show reviews (review content is for a different show)
      if (data.wrongShow === true) {
        stats.skippedWrongShow = (stats.skippedWrongShow || 0) + 1;
        return;
      }

      // Create deduplication key
      const outletKey = normalizeOutletId(data.outlet || data.outletId);
      const criticKey = normalizeOutletId(data.criticName || '');
      const dedupKey = `${outletKey}|${criticKey}`;

      // Skip duplicates (keep first occurrence)
      if (seenKeys.has(dedupKey)) {
        stats.skippedDuplicate++;
        return;
      }
      seenKeys.add(dedupKey);

      // Get best score - returns null if no valid score
      const scoreResult = getBestScore(data);

      if (scoreResult === null) {
        // Skip this review - no valid score
        stats.skippedNoScore++;
        stats.byShow[showId].skipped++;
        skippedReviews.push({
          showId,
          file,
          outlet: data.outlet,
          critic: data.criticName
        });
        return;
      }

      const { score, source } = scoreResult;
      stats.scoreSources[source]++;

      // Build review object
      const review = {
        showId: data.showId || showId,
        outletId: data.outletId || outletKey.toUpperCase(),
        outlet: data.outlet || data.outletId || 'Unknown',
        assignedScore: score,
        bucket: scoreToBucket(score),
        thumb: scoreToThumb(score),
        criticName: data.criticName || null,
        url: data.url || null,
        publishDate: data.publishDate || null,
        originalRating: data.originalScore || null,
        pullQuote: selectBestExcerpt(data),
        dtliThumb: data.dtliThumb || null,
        bwwThumb: data.bwwThumb || null
      };

      // Add designation if present
      if (data.designation) {
        review.designation = data.designation;
      }

      allReviews.push(review);
      stats.byShow[showId].reviews++;
      stats.totalReviews++;

    } catch (e) {
      console.error(`  Error processing ${file}: ${e.message}`);
    }
  });
});

// Sort reviews by showId, then outlet
allReviews.sort((a, b) => {
  if (a.showId !== b.showId) return a.showId.localeCompare(b.showId);
  return (a.outlet || '').localeCompare(b.outlet || '');
});

// Build output
const output = {
  _meta: {
    description: "Critic reviews - raw input data",
    lastUpdated: new Date().toISOString().split('T')[0],
    notes: "Rebuilt from review-texts. Reviews without valid scores are EXCLUDED.",
    stats: {
      totalReviews: stats.totalReviews,
      skippedNoScore: stats.skippedNoScore,
      skippedDuplicate: stats.skippedDuplicate,
      skippedWrongProduction: stats.skippedWrongProduction || 0,
      scoreSources: stats.scoreSources
    }
  },
  reviews: allReviews
};

// Write output
fs.writeFileSync(reviewsJsonPath, JSON.stringify(output, null, 2));

// Print summary
console.log('\n=== SUMMARY ===\n');
console.log(`Total files processed: ${stats.totalFiles}`);
console.log(`Total reviews INCLUDED: ${stats.totalReviews}`);
console.log(`  Skipped (no valid score): ${stats.skippedNoScore}`);
console.log(`  Skipped (duplicate): ${stats.skippedDuplicate}`);
console.log(`  Skipped (wrong production): ${stats.skippedWrongProduction || 0}`);

console.log('\nScore sources:');
Object.entries(stats.scoreSources).forEach(([source, count]) => {
  if (count > 0) {
    console.log(`  ${source}: ${count} (${(count/stats.totalReviews*100).toFixed(1)}%)`);
  }
});

// Show per-show counts
console.log('\n=== REVIEWS PER SHOW ===\n');
const showCounts = Object.entries(stats.byShow)
  .map(([show, data]) => ({ show, ...data }))
  .sort((a, b) => b.reviews - a.reviews);

showCounts.forEach(({ show, files, reviews, skipped }) => {
  const skipNote = skipped > 0 ? ` (${skipped} skipped - no score)` : '';
  console.log(`  ${show}: ${reviews} reviews${skipNote}`);
});

if (skippedReviews.length > 0) {
  console.log(`\n=== SKIPPED REVIEWS (${skippedReviews.length}) ===`);
  console.log('These need scoring before they can be included:');

  // Group by show
  const byShow = {};
  skippedReviews.forEach(r => {
    byShow[r.showId] = byShow[r.showId] || [];
    byShow[r.showId].push(r);
  });

  Object.entries(byShow).forEach(([show, reviews]) => {
    console.log(`\n  ${show}:`);
    reviews.slice(0, 5).forEach(r => {
      console.log(`    - ${r.outlet} (${r.critic || 'unknown'})`);
    });
    if (reviews.length > 5) {
      console.log(`    ... and ${reviews.length - 5} more`);
    }
  });
}

console.log('\n=== DONE ===');
console.log(`\nReviews saved to: ${reviewsJsonPath}`);
