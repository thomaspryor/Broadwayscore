#!/usr/bin/env node
/**
 * Rebuild reviews.json for a specific show using review-texts data
 * Uses DTLI/BWW thumbs and LLM scores to get accurate scores
 */

const fs = require('fs');
const path = require('path');

const SHOWS_TO_FIX = ['queen-versailles-2025', 'stereophonic-2024'];

const THUMB_TO_SCORE = { 'Up': 78, 'Meh': 55, 'Flat': 55, 'Down': 35 };
const STAR_TO_SCORE = { 5: 92, 4: 82, 3: 63, 2: 45, 1: 25, 0: 10 };
const LETTER_TO_SCORE = {
  'A+': 97, 'A': 93, 'A-': 89,
  'B+': 85, 'B': 80, 'B-': 74,
  'C+': 67, 'C': 60, 'C-': 53,
  'D+': 45, 'D': 36, 'D-': 28,
  'F': 15
};

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
 */
function cleanExcerpt(text, aggressive = false) {
  if (!text) return null;

  let cleaned = decodeHtmlEntities(text);

  // Remove JavaScript/ad code
  cleaned = cleaned.replace(/blogherads\.[^;]+;?/gi, '');
  cleaned = cleaned.replace(/\.defineSlot\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.setTargeting\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.addSize\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/googletag\.[^;]+;?/gi, '');
  cleaned = cleaned.replace(/Related Stories\s+[A-Z][^"]*$/gi, '');

  // Remove photo credits mixed into text
  cleaned = cleaned.replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\s+(?=Thirty|The|In|When|After|Before|It|This|That|A|An)/g, '');

  // Stop at next critic attribution
  const nextCritic = cleaned.match(/\.\s+[A-Z][a-z]+(?:\s+[A-Z][a-z'-]+)?,\s+[A-Z][^:]+:/);
  if (nextCritic && nextCritic.index > 50) {
    cleaned = cleaned.substring(0, nextCritic.index + 1);
  }

  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Skip if starts mid-sentence (unless it's a quote)
  if (/^[a-z]/.test(cleaned) && !cleaned.startsWith('"') && cleaned.length < 100) {
    return null;
  }

  // Skip junk excerpts
  if (isJunkExcerpt(cleaned)) {
    return null;
  }

  // Truncate to 350 chars at sentence boundary
  if (cleaned.length > 350) {
    const truncAt = cleaned.lastIndexOf('.', 350);
    cleaned = truncAt > 100 ? cleaned.substring(0, truncAt + 1) : cleaned.substring(0, 347) + '...';
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

  return null;
}

// Load reviews.json
const reviewsPath = path.join(__dirname, '../data/reviews.json');
const data = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
let reviews = data.reviews;

function normalizeOutlet(outlet) {
  return (outlet || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getScoreFromRating(rating) {
  if (!rating) return null;
  const r = rating.toString();

  const starMatch = r.match(/^(\d(?:\.\d)?)\s*(?:\/\s*5|stars?)/i);
  if (starMatch) {
    return STAR_TO_SCORE[Math.round(parseFloat(starMatch[1]))];
  }

  const letterMatch = r.match(/^([A-D][+-]?|F)$/i);
  if (letterMatch) {
    return LETTER_TO_SCORE[letterMatch[1].toUpperCase()];
  }

  return null;
}

function getBestScore(textData) {
  // Priority: LLM > originalScore > dtliThumb > bwwThumb > current

  if (textData.llmScore && textData.llmScore.score) {
    return { score: textData.llmScore.score, source: 'LLM' };
  }

  if (textData.originalScore) {
    const score = getScoreFromRating(textData.originalScore);
    if (score) return { score, source: `originalScore=${textData.originalScore}` };
  }

  if (textData.dtliThumb) {
    return { score: THUMB_TO_SCORE[textData.dtliThumb] || 55, source: `dtliThumb=${textData.dtliThumb}` };
  }

  if (textData.bwwThumb) {
    return { score: THUMB_TO_SCORE[textData.bwwThumb] || 55, source: `bwwThumb=${textData.bwwThumb}` };
  }

  return null;
}

function scoreToBucket(score) {
  if (score >= 85) return 'Rave';
  if (score >= 70) return 'Positive';
  if (score >= 50) return 'Mixed';
  if (score >= 35) return 'Negative';
  return 'Pan';
}

function scoreToThumb(score) {
  if (score >= 70) return 'Up';
  if (score >= 50) return 'Flat';
  return 'Down';
}

let totalFixes = 0;

SHOWS_TO_FIX.forEach(showId => {
  console.log(`\n=== REBUILDING ${showId.toUpperCase()} ===\n`);

  const showDir = path.join(__dirname, '../data/review-texts', showId);
  if (!fs.existsSync(showDir)) {
    console.log('  Show directory not found, skipping');
    return;
  }

  // Build map of review-texts data
  const textDataMap = new Map();
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  files.forEach(file => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      const outletKey = normalizeOutlet(data.outlet || data.outletId);
      const criticKey = normalizeOutlet(data.criticName || '');

      // Store by outlet + critic for deduplication
      const key = `${outletKey}|${criticKey}`;

      const bestScore = getBestScore(data);
      if (bestScore) {
        // Only keep if better data than what we have
        if (!textDataMap.has(key) || (data.llmScore && !textDataMap.get(key).llmScore)) {
          textDataMap.set(key, { ...data, ...bestScore });
        }
      }
    } catch (e) {
      // skip
    }
  });

  // Remove existing reviews for this show
  const otherReviews = reviews.filter(r => r.showId !== showId);
  const existingCount = reviews.length - otherReviews.length;

  // Create new reviews from text data
  const newReviews = [];
  const seenOutlets = new Set();

  textDataMap.forEach((data, key) => {
    const outletNorm = normalizeOutlet(data.outlet || data.outletId);

    // Skip if we already have this outlet (to avoid duplicates)
    if (seenOutlets.has(outletNorm)) {
      return;
    }
    seenOutlets.add(outletNorm);

    const score = data.score;
    const review = {
      showId: showId,
      outletId: data.outletId || outletNorm,
      outlet: data.outlet || data.outletId,
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

    newReviews.push(review);
    console.log(`  ${review.outlet}: ${score} (${data.source})`);
  });

  // Add new reviews
  reviews = [...otherReviews, ...newReviews];

  console.log(`\n  Replaced ${existingCount} reviews with ${newReviews.length} reviews`);
  totalFixes += newReviews.length;

  // Calculate new average
  const avg = newReviews.reduce((sum, r) => sum + r.assignedScore, 0) / newReviews.length;
  console.log(`  New average: ${avg.toFixed(1)}`);
});

// Save
data.reviews = reviews;
data._meta.lastUpdated = new Date().toISOString().split('T')[0];
data._meta.notes = 'Rebuilt from review-texts with thumb/LLM data';
fs.writeFileSync(reviewsPath, JSON.stringify(data, null, 2));

console.log(`\n=== SUMMARY ===`);
console.log(`Total reviews rebuilt: ${totalFixes}`);

// Final validation
console.log('\n=== FINAL VALIDATION ===\n');

function getShowAverage(showId) {
  const showReviews = reviews.filter(r => r.showId === showId && r.assignedScore != null);
  if (showReviews.length === 0) return null;
  const avg = showReviews.reduce((sum, r) => sum + r.assignedScore, 0) / showReviews.length;
  return { avg: avg.toFixed(1), count: showReviews.length };
}

const qov = getShowAverage('queen-versailles-2025');
console.log(`Queen of Versailles: ${qov?.avg} (${qov?.count} reviews) - TARGET: 45-55`);
console.log(`  Status: ${qov && parseFloat(qov.avg) >= 45 && parseFloat(qov.avg) <= 55 ? '✓ PASS' : '✗ FAIL'}`);

const stereo = getShowAverage('stereophonic-2024');
console.log(`Stereophonic: ${stereo?.avg} (${stereo?.count} reviews) - TARGET: 85-95`);
console.log(`  Status: ${stereo && parseFloat(stereo.avg) >= 85 && parseFloat(stereo.avg) <= 95 ? '✓ PASS' : '✗ FAIL'}`);
