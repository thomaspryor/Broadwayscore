#!/usr/bin/env node
/**
 * Rebuild reviews.json from ALL review-texts data
 *
 * IMPORTANT: Reviews WITHOUT a valid score source are EXCLUDED
 * We NEVER use a default score of 50 - that skews results
 *
 * Score priority (in order):
 * P0a. EXPLICIT RATING IN TEXT (★★★★☆, "4 out of 5", letter grades, X/5)
 *      - Most reliable - override LLM scores which had 33% error rate
 * P0b. humanReviewScore (manual override from audit queue, 1-100)
 * P0c. originalScore field (aggregator-provided: "4/5 stars", "B+")
 *      - Parsed before LLM to prevent paywall/garbage text from overriding
 * P1.  llmScore.score (HIGH/MEDIUM confidence, with original fullText only)
 *      - Excerpt-only and garbage-recovered reviews are downgraded to low confidence
 * P2.  Thumb-validated LLM (when low-conf LLM AND thumb agrees with direction)
 *      - LLM already sees thumb data in prompt; thumbs boost confidence, not replace score
 * P3.  llmScore.score (low confidence, needs review, or excerpt-only - when no thumb or mixed signals)
 * P4.  assignedScore (if already set and valid, with known source)
 * P5.  bucket mapping (Rave=90, Positive=82, Mixed=65, Negative=48, Pan=30)
 * P5.5 bwwScore fallback (BWW editorial 1-10 × 10, more granular than thumbs)
 * P6.  dtliThumb or bwwThumb (Up=80, Flat=60, Down=35) - final fallback
 * P7.  SKIP - do not include in reviews.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getOutletDisplayName, normalizeOutlet: normalizeOutletCanonical, normalizeCritic: normalizeCriticCanonical } = require('./lib/review-normalization');
const { decodeHtmlEntities, cleanText } = require('./lib/text-cleaning');
const { classifyContentTier, computeContentFingerprint } = require('./lib/content-quality');
const { classifyIncompleteReason } = require('./lib/incomplete-reason');
const { LETTER_GRADES, BUCKET_SCORES, THUMB_SCORES } = require('./lib/score-extractors');
const { parseStarRating, parseLetterGrade, parseOriginalScore, LETTER_GRADE_OUTLETS } = require('./lib/score-parsers');
const { excerptMentionsWrongShow, isTourReviewExcerpt, isFilmTvReview } = require('./lib/excerpt-validation');

// Load outlet registry for cross-market guard + nonReview recovery
const outletRegistry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'outlet-registry.json'), 'utf8'));
// Load critic registry for nonReview recovery (known critics are more likely real reviews)
const criticRegistry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'critic-registry.json'), 'utf8'));
const knownCriticKeys = new Set(Object.keys(criticRegistry.critics || {}));
const outletRegionMap = {};  // outletId -> region (e.g., 'london')
for (const [id, info] of Object.entries(outletRegistry.outlets)) {
  if (info.region) outletRegionMap[id] = info.region;
  // Also map aliases to the same region
  if (info.aliases && info.region) {
    for (const alias of info.aliases) {
      outletRegionMap[alias] = info.region;
    }
  }
}
// Outlets that genuinely cover BOTH Broadway and West End markets.
// Derived from `isDualMarket: true` in outlet-registry.json — single source of truth.
// Used by the REVERSE guard (London→Broadway), so only truly dual-market outlets belong here.
const DUAL_MARKET_OUTLETS = new Set();
for (const [id, info] of Object.entries(outletRegistry.outlets || {})) {
  if (info.isDualMarket) {
    DUAL_MARKET_OUTLETS.add(id);
    if (info.aliases) {
      for (const alias of info.aliases) DUAL_MARKET_OUTLETS.add(alias.toLowerCase());
    }
  }
}
// Also allow all Tier 1/2 outlets — they legitimately review West End shows
// The cross-market guard targets Tier 3 / untiered regional US outlets (Fayetteville Flyer, etc.)
// Uses outlet-registry.json tiers (not scoring.ts — registry IDs match review-text file IDs)
const TIER_1_2_OUTLET_IDS = new Set();
for (const [id, info] of Object.entries(outletRegistry.outlets)) {
  if (info.tier === 1 || info.tier === 2) {
    TIER_1_2_OUTLET_IDS.add(id);
    if (info.aliases) {
      for (const alias of info.aliases) TIER_1_2_OUTLET_IDS.add(alias.toLowerCase());
    }
  }
}

// Human review queue — flagged items written to data/audit/needs-human-review.json
const humanReviewQueue = [];

function normalizeThumb(thumb) {
  if (thumb === 'Meh' || thumb === 'Flat') return 'Flat';
  return thumb; // 'Up' or 'Down'
}

const MONTH_TO_NUM = { january:'01', february:'02', march:'03', april:'04', may:'05', june:'06', july:'07', august:'08', september:'09', october:'10', november:'11', december:'12' };
function normalizePublishDate(dateStr) {
  if (!dateStr) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  // ISO timestamp: "2018-04-22T20:11:20-04:00"
  const isoTs = dateStr.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoTs) return isoTs[1];
  // "Month Day, Year" or "Month DayOrd, Year"
  const mdy = dateStr.match(/^(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i);
  if (mdy && MONTH_TO_NUM[mdy[1].toLowerCase()]) {
    return `${mdy[3]}-${MONTH_TO_NUM[mdy[1].toLowerCase()]}-${mdy[2].padStart(2, '0')}`;
  }
  // Garbage values
  if (/previous production/i.test(dateStr)) return null;
  // Last resort: JS Date
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function flagForHumanReview(data, reason, detail) {
  humanReviewQueue.push({
    showId: data.showId,
    outletId: data.outletId || data.outlet,
    criticName: data.criticName || null,
    reason,
    detail,
    llmScore: data.llmScore?.score || null,
    llmBucket: data.llmScore?.bucket || null,
    llmConfidence: data.llmScore?.confidence || null,
    dtliThumb: data.dtliThumb || null,
    bwwThumb: data.bwwThumb || null,
    bwwScore: data.bwwScore ?? null,
    flaggedAt: new Date().toISOString()
  });
}

// Score mappings — imported from shared source of truth
const THUMB_TO_SCORE = THUMB_SCORES;
const BUCKET_TO_SCORE = BUCKET_SCORES;

// EXPLICIT RATING EXTRACTION removed — now handled at collection time
// by LLM extraction (scripts/lib/llm-score-extractor.js).
// Rebuild only consumes pre-stored originalScore via parseOriginalScore().

// Paths
const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const reviewsJsonPath = path.join(__dirname, '../data/reviews.json');

// decodeHtmlEntities imported from ./lib/text-cleaning

/**
 * Fix mojibake: UTF-8 bytes misinterpreted as Latin-1/CP1252.
 * Common in scraped text where encoding was mangled.
 */
function fixMojibake(text) {
  if (!text) return text;
  // Three-byte UTF-8 sequences stored as raw bytes (â + two control chars)
  return text
    // Smart quotes
    .replace(/\u00e2\u0080\u0099/g, '\u2019')   // ' right single quote
    .replace(/\u00e2\u0080\u0098/g, '\u2018')   // ' left single quote
    .replace(/\u00e2\u0080\u009c/g, '\u201c')   // " left double quote
    .replace(/\u00e2\u0080\u009d/g, '\u201d')   // " right double quote
    // Dashes and ellipsis
    .replace(/\u00e2\u0080\u0094/g, '\u2014')   // — em dash
    .replace(/\u00e2\u0080\u0093/g, '\u2013')   // – en dash
    .replace(/\u00e2\u0080\u00a6/g, '\u2026')   // … ellipsis
    // Also handle the text-rendered versions (â€™, â€", etc.)
    .replace(/â€™/g, '\u2019')
    .replace(/â€˜/g, '\u2018')
    .replace(/â€œ/g, '\u201c')
    .replace(/â€\u009d/g, '\u201d')
    .replace(/â€"/g, '\u2014')
    .replace(/â€"/g, '\u2013')
    .replace(/â€¦/g, '\u2026')
    // Two-byte Latin characters
    .replace(/Ã©/g, 'é')
    .replace(/Ã¨/g, 'è')
    .replace(/Ã¯/g, 'ï')
    .replace(/Ã¼/g, 'ü')
    .replace(/Ã¶/g, 'ö')
    .replace(/Ã´/g, 'ô')
    .replace(/Ã®/g, 'î')
    .replace(/Ã¢/g, 'â')
    .replace(/Ã /g, 'à');
}

/**
 * Fix missing periods between concatenated text segments.
 * Common in NYSR (star rating subtitle + review body) and aggregator excerpts.
 */
function fixMissingPeriods(text) {
  if (!text) return text;
  let result = text;

  // After a 4-digit year followed by a capital letter starting a new sentence
  // e.g., "circa 1915 There's" → "circa 1915. There's"
  result = result.replace(/(\d{4})\s+([A-Z][a-z])/g, '$1. $2');

  // After "No Comment" running into "BY AUTHOR" (Chelsea Community News)
  result = result.replace(/No Comment\s*(BY\s)/i, 'No Comment. $1');

  // After photo credit parenthetical running into review text
  // e.g., "(Joan Marcus)Listen" → "(Joan Marcus). Listen"
  result = result.replace(/\)([A-Z][a-z])/g, '). $1');

  // After "Darkness" running into next word (WaPo motto concatenation)
  result = result.replace(/Darkness([A-Z][a-z])/g, 'Darkness. $1');

  return result;
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
    /^NYC Events,?\s+Restaurants/i,                     // Cititour site navigation
    /Cititour\.com\s*Review/i,                          // Cititour site branding
    /^(Facebook|Twitter|Pinterest|Threads)\s+(Twitter|Facebook|Pinterest|X\b)/i,  // Social sharing buttons
    /^Visit the Site/i,                                 // Cititour show info metadata
    /^Tickets from \$/i,                                // Ticket pricing metadata
    /By clicking submit/i,                              // Observer privacy consent
    /<a\s+href=/i,                                      // Raw HTML in text
    /^Home\s*[>|]/i,                                    // Breadcrumb navigation (Mashable)
    /newsletter in your inbox/i,                        // Newsletter signup (Time Out)
    /Get all the top news.*discount/i,                  // Newsletter promo (BWW)
    /Open\/Close Dates/i,                               // Show metadata (Cititour)
    /\bprivacy policy\b/i,                              // Privacy/legal boilerplate
    /^Skip to (content|main)/i,                         // Navigation skip link (TheWrap, ChicagoTribune, BroadwayNews)
    /^Democracy Dies/i,                                 // Washington Post motto
    /^Q:\s/i,                                           // Quiz widget sidebar (The Times UK)
    /^Posted on\s+\w+\s+\d/i,                           // WordPress metadata (Chelsea Community News)
    /^This article was published more than/i,            // WaPo stale article warning
    /^Listen\d+\s*min/i,                                // WaPo audio player metadata
    /rose lovers|Bachelor in Paradise|couples grapple/i, // Wrong show content (reality TV)
    /^(MUSIC|THEATER).*Add Topic/i,                      // USA Today CMS navigation junk
    /^Trump says|^Biden|^Senate\s+(votes|passes)/i,      // AP/news feed content (wrong page)
    /Keep Watching|mins ago\s/i,                          // NBC broadcast crawl / news feed
    /Hear this story/i,                                   // Audio player prompt
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

  let cleaned = fixMissingPeriods(fixMojibake(decodeHtmlEntities(text)));

  // Reject URLs masquerading as excerpts
  if (/^https?:\/\//i.test(cleaned.trim())) return null;

  // --- Layer 1: Systematic excerpt quality gates ---

  // Strip "Average Rating: XX%" and everything after (BWW metadata leak)
  cleaned = cleaned.replace(/Average Rating:.*$/s, '');

  // Strip JSON-LD fragments (BWW page data)
  cleaned = cleaned.replace(/\{\s*"@context".*$/s, '');

  // Strip CRITIC'S PICK prefix (NYT designation leaked into excerpt)
  cleaned = cleaned.replace(/^\*?CRITIC[''\u2019]?S PICK\*?\s*/i, '');

  // Strip embedded critic attribution at start: "Laura Collins-Hughes, New York Times: "
  // Only within first 80 chars and must match "Name Name, Outlet Words: " pattern
  cleaned = cleaned.replace(/^[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-zA-Z'-]+,\s+[A-Z][\w\s&.'-]{2,40}:\s*/, '');

  // Strip leading colon/comma artifacts (from aggregator excerpt extraction)
  // Must run AFTER attribution strip since `: "text"` may remain
  cleaned = cleaned.replace(/^[,\s]*:\s*/, '');

  // Strip control characters (U+0080–U+009F range — invisible C1 control codes)
  cleaned = cleaned.replace(/[\u0080-\u009F]/g, '');

  // Fix remaining mojibake: standalone â before whitespace → em-dash
  cleaned = cleaned.replace(/â\s/g, '\u2014 ');
  // Standalone â at end of text
  cleaned = cleaned.replace(/â$/, '\u2014');

  // --- End Layer 1 ---

  // Strip navigation/boilerplate prefixes
  cleaned = cleaned.replace(/^Skip to (content|main content)\s*/i, '');
  cleaned = cleaned.replace(/^(This article was published more than[^.]*\.\s*)?Democracy Dies in Darkness\s*/i, '');
  cleaned = cleaned.replace(/^Q:\s+[^?]*\?\s*/i, '');
  cleaned = cleaned.replace(/^Posted on\s+\w+\s+\d{1,2},?\s+\d{4}\s*/i, '');
  cleaned = cleaned.replace(/^No Comment\s*(BY\s+)?/i, '');
  cleaned = cleaned.replace(/^Listen\s*\d+\s*min\s*/i, '');
  // Strip WaPo photo captions: "Name as Character in 'Title'. (Photographer)"
  cleaned = cleaned.replace(/^[A-Z][^.]{10,80}\.\s*\([A-Z][a-z]+ [A-Z][a-z]+\)\s*/i, '');
  // Strip "Review by Author NAME —" or "Review by Author"
  cleaned = cleaned.replace(/^Review by\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s*(?:—\s*)?/i, '');

  // Strip "| Photo:" caption artifacts
  cleaned = cleaned.replace(/^[^|]{0,80}\|\s*Photo\s*:\s*[A-Z][a-z]+(?:\s+(?:and\s+)?[A-Z][a-z]+)*(?:\s+[A-Z][a-z]+)*\s+/i, '');

  // Remove JavaScript/ad code patterns
  cleaned = cleaned.replace(/blogherads\.[^;]+;?/gi, '');
  cleaned = cleaned.replace(/\.defineSlot\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.setTargeting\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.addSize\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.exemptFromSleep\(\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.setClsOptimization\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.setSubAdUnitPath\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/googletag\.[^;]+;?/gi, '');
  cleaned = cleaned.replace(/\(adsbygoogle\s*=\s*window\.adsbygoogle\s*\|\|\s*\[\]\)\.push\(\{[^}]*\}\);?\s*/g, '');
  cleaned = cleaned.replace(/\[\s*["']mid-article\d*["'][^\]]*\]/gi, '');
  cleaned = cleaned.replace(/Related Stories\s+[A-Z][^"]*$/gi, '');

  // Remove photo credits mixed into text
  cleaned = cleaned.replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\s+(?=Thirty|The|In|When|After|Before|It|This|That|A|An)/g, '');

  // Stop at next critic attribution (BWW roundups concatenate multiple critics)
  const nextCriticMatch = cleaned.match(/\.\s+[A-Z][a-z]+(?:\s+[A-Z][a-z'-]+)?,\s+[A-Z][^:]+:/);
  if (nextCriticMatch && nextCriticMatch.index > 50) {
    cleaned = cleaned.substring(0, nextCriticMatch.index + 1);
  }

  // Strip Observer privacy consent and similar trailing boilerplate
  cleaned = cleaned.replace(/\s*By clicking submit[^]*$/i, '');
  cleaned = cleaned.replace(/\s*<a\s+href=[^]*$/i, '');
  // Strip LA Times / newspaper copyright footers
  cleaned = cleaned.replace(/\s*Copyright ©[^]*$/i, '');
  // Strip "Visit the Site" show metadata (Cititour)
  cleaned = cleaned.replace(/\s*Visit the Site\S*[^]*$/i, '');

  // Strip trailing "Read more" / "Continue reading" / "Read the full review"
  cleaned = cleaned.replace(/\s*(Read more|Continue reading|Read the full review)\.?\s*$/i, '');

  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Skip if starts mid-word/mid-sentence (unless it's a quote)
  if (/^[a-z]/.test(cleaned) && !cleaned.startsWith('"')) {
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
  if (/defineSlot|setTargeting|blogherads|Plus Icon|adsbygoogle|googletag/i.test(cleaned)) {
    return null;
  }

  return cleaned.length > 30 ? cleaned : null;
}

/**
 * Extract a good opening excerpt from full review text
 */
function extractExcerptFromFullText(fullText, showTitle) {
  if (!fullText || fullText.length < 200) return null;

  let text = fixMissingPeriods(fixMojibake(decodeHtmlEntities(fullText)));

  // Strip control characters (U+0080–U+009F range)
  text = text.replace(/[\u0080-\u009F]/g, '');

  // Strip leading star ratings (★★★★☆, ⭐⭐⭐, etc.)
  text = text.replace(/^[\s★☆⭐✩✪❤]+/, '');

  // Strip NYSR-style star-rating subtitles: cast list + show description tagline before the review body
  // Pattern: "Name, Name, Name, and [Name(s)] [verb] this [description]... circa YEAR."
  // These appear right after star ratings and run into the review text without clear separation
  text = text.replace(/^[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+(?:,\s+[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+){2,}[^.]*\b(?:cast|musical|new|spark|star|exceptional)\b[^.]*\.\s*/i, '');

  // Strip leading metadata/boilerplate lines before the actual review
  // Split on newlines first to skip header junk
  const lines = text.split(/\n+/).map(l => l.trim()).filter(l => l.length > 0);
  let startIdx = 0;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const line = lines[i];
    // Skip: dates, bylines, categories, photo credits, "Theater review", metadata
    if (/^(By|Photo|Posted in|Author:|Date:|Published|Reviews?\s+['''""]|Theater review|Read our review|Category:|Tags:)/i.test(line)) { startIdx = i + 1; continue; }
    if (/^(Broadway|Off-Broadway|Theater Reviews?|Musical|Play)\s*[,|]/i.test(line)) { startIdx = i + 1; continue; }
    // Skip navigation skip links, newspaper mottos, quiz widgets, WaPo boilerplate
    if (/^Skip to (content|main)/i.test(line)) { startIdx = i + 1; continue; }
    if (/^Democracy Dies/i.test(line)) { startIdx = i + 1; continue; }
    if (/^Q:\s/i.test(line)) { startIdx = i + 1; continue; }
    if (/^This article was published more than/i.test(line)) { startIdx = i + 1; continue; }
    if (/^Listen\s*\d+\s*min/i.test(line)) { startIdx = i + 1; continue; }
    if (/^Posted on\s+\w+\s+\d/i.test(line)) { startIdx = i + 1; continue; }
    if (/^No Comment\b/i.test(line)) { startIdx = i + 1; continue; }
    if (/^Review by\s+[A-Z]/i.test(line)) { startIdx = i + 1; continue; }
    if (/^\d{1,2}:\d{2}\s*(AM|PM)/i.test(line)) { startIdx = i + 1; continue; }
    if (/^\w+\s+\d{1,2},\s+\d{4}/.test(line) && line.length < 50) { startIdx = i + 1; continue; }  // "November 20, 2025"
    if (/^(Leave a Comment|Comments?:?\s*\d)/i.test(line)) { startIdx = i + 1; continue; }
    if (line.length < 15) { startIdx = i + 1; continue; }  // Very short header fragments
    // If line contains "Date:" or "Author:" mid-line, it's metadata
    if (/\bDate:\s*\w+\s+\d/i.test(line) || /\bAuthor:\s*[A-Z]/i.test(line)) { startIdx = i + 1; continue; }
    // Skip article subtitles like "'Title' is a ... (Broadway review)" or "(review)"
    if (/\((?:Broadway |theater |play )?review\)/i.test(line)) { startIdx = i + 1; continue; }
    // Skip lines with "\d+ Comments" (WordPress metadata)
    if (/^\d+\s+Comments?\b/i.test(line)) { startIdx = i + 1; continue; }
    // Skip "Share this:" and similar social media prompts
    if (/^Share (this|on|via)/i.test(line)) { startIdx = i + 1; continue; }
    // Skip photo caption lines (Theatrely format: "Name | Photo: Photographer")
    if (/\|\s*Photo\s*:/i.test(line)) { startIdx = i + 1; continue; }
    // Skip URL-only lines
    if (/^https?:\/\//i.test(line) && line.length < 200) { startIdx = i + 1; continue; }
    // Skip site navigation/branding (Cititour, etc.)
    if (/^NYC Events|Cititour\.com|^(Facebook|Twitter)\s+(Twitter|Facebook)/i.test(line)) { startIdx = i + 1; continue; }
    break;
  }
  text = lines.slice(startIdx).join(' ');

  // Strip navigation/boilerplate prefixes that may be on same line as content
  text = text.replace(/^Skip to (content|main content)\s*/i, '');
  text = text.replace(/^(This article was published more than[^.]*\.\s*)?Democracy Dies in Darkness\s*/i, '');
  text = text.replace(/^Q:\s+[^?]*\?\s*/i, '');
  text = text.replace(/^Posted on\s+\w+\s+\d{1,2},?\s+\d{4}\s*/i, '');
  text = text.replace(/^No Comment\s*(BY\s+[A-Z][^|]*\|\s*)?/i, '');
  text = text.replace(/^Listen\s*\d+\s*min\s*/i, '');
  // Strip WaPo photo captions: "Name as Character in 'Title'. (Photographer)" or "Name in 'Title'. (Photographer)"
  text = text.replace(/^[A-Z][^.]{10,80}\.\s*\([A-Z][a-z]+ [A-Z][a-z]+\)\s*/i, '');
  // Strip "Review by Author NAME —" or "Review by Author" followed by location
  text = text.replace(/^Review by\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s*(?:—\s*)?(?:NEW YORK\s*—?\s*)?/i, '');

  // Strip photo caption + credit at start (Theatrely: "Name | Photo: Photographer Review text...")
  text = text.replace(/^[^|]{0,80}\|\s*Photo\s*:\s*[A-Z][a-z]+(?:\s+(?:and\s+)?[A-Z][a-z]+)*(?:\s+[A-Z][a-z]+)*\s+/i, '');
  text = text.replace(/^[^.!?]*\bPhoto\s+(by|credit|courtesy)\b[^.]*\.\s*/i, '');
  // Strip URLs at start of text
  text = text.replace(/^https?:\/\/\S+\s*/i, '');
  // Strip Cititour site navigation preamble
  text = text.replace(/^NYC Events,?\s+Restaurants,?\s+Music,?\s+&\s+Nightlife\s+/i, '');
  text = text.replace(/^(Facebook\s+)?Twitter\s+X\s+Pinterest\s+Threads\s+Snapchat\s+WhatsApp\s+Message\s+Email\s+/i, '');
  text = text.replace(/^Tickets from \$\d+\s+Buy Tickets\s+/i, '');
  text = text.replace(/^Cititour\.com\s+Review\s+/i, '');

  // Strip concatenated page title + metadata blobs (common on One-Minute Critic, CultureSauce, etc.)
  // Pattern: "Reviews 'Title' <headline> <Author> <Date> <number> <Cast> in "Title"." Photo by X. Share this: By Author <actual review>"
  text = text.replace(/^Reviews?\s+[''""'][^''"'""]+[''""'][^.]*\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b[^.]*\.\s*(?:Photo\s+by\b[^.]*\.\s*)?(?:Share\s+this:[^.]*\.\s*)?(?:By\s+[A-Z][a-z]+\s+[A-Z][a-z]+\s+)?/i, '');

  // Strip "Share this:" / "Share on:" social sharing prompts at start of text
  text = text.replace(/^Share\s+(this|on|via)\s*:\s*/i, '');
  // Strip "By Author Name" byline at start (after other stripping)
  text = text.replace(/^By\s+[A-Z][a-z]+\s+[A-Z][a-z]+\s+/i, '');

  // Strip "Things you buy through our links..." affiliate disclaimers
  text = text.replace(/^Things you buy through our links[^.]*\.\s*/i, '');

  // Strip inline ad injection code (adsbygoogle, googletag, etc.)
  text = text.replace(/\(adsbygoogle\s*=\s*window\.adsbygoogle\s*\|\|\s*\[\]\)\.push\(\{[^}]*\}\);?\s*/g, '');
  text = text.replace(/googletag\.cmd\.push\([^)]*\);?\s*/g, '');

  // Split into sentences
  const sentences = text.split(/(?<=[.!?])\s+/);

  // Filter to substantive sentences only (skip bylines, photo credits, metadata, junk)
  const substantive = [];
  for (const sentence of sentences) {
    if (sentence.length < 30) continue;
    if (/^By\s+[A-Z]/i.test(sentence)) continue;
    if (/^Photo:/i.test(sentence)) continue;
    if (/^\d{1,2}:\d{2}/i.test(sentence)) continue;
    if (/\b(Published Date|Leave a Comment|Posted in)\b/i.test(sentence)) continue;
    if (/^Read (more|our review|the full)/i.test(sentence)) continue;
    if (/^[★☆⭐✩✪❤\s]{3,}/.test(sentence)) continue;
    if (/^Reviews?\s+['''""]/i.test(sentence)) continue;
    if (/^Share\s+(this|on|via)\b/i.test(sentence)) continue;
    if (/\bPhoto\s+(by|credit|courtesy)\b/i.test(sentence)) continue;
    if (/\|\s*Photo\s*:/i.test(sentence)) continue;
    if (/\bin\s+[""][^""]+[""]\s*\.\s*$/i.test(sentence) && sentence.length < 120) continue;
    if (/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\s+\d+\s+/i.test(sentence) && sentence.indexOf('Photo') !== -1) continue;
    if (/^Home\s*[>|]/i.test(sentence)) continue;
    if (/By clicking submit/i.test(sentence)) continue;
    if (/newsletter|sign up for|subscribe to|Get all the top news/i.test(sentence)) continue;
    if (/<a\s+href=/i.test(sentence)) continue;
    if (/^Skip to (content|main)/i.test(sentence)) continue;
    if (/Democracy Dies/i.test(sentence)) continue;
    if (/^Q:\s/i.test(sentence)) continue;
    if (/^Posted on\s+\w+\s+\d/i.test(sentence)) continue;
    if (/^No Comment\b/i.test(sentence)) continue;
    if (/^Listen\s*\d+\s*min/i.test(sentence)) continue;
    if (/^This article was published/i.test(sentence)) continue;
    if (/^[A-Z][a-z]+ [A-Z][a-z]+\s+(as|in|and|stars|is)\s/i.test(sentence) && /\([A-Z][a-z]+ [A-Z][a-z]+\)\s*$/.test(sentence)) continue;
    if (/^[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+,\s+[A-Z][a-z]+/.test(sentence) && /\b(cast|musical|new|spark|star)\b/i.test(sentence) && sentence.length < 200) continue;
    // Skip CMS/navigation junk (USA Today, AP, etc.)
    if (/^(MUSIC|THEATER|ARTS|ENTERTAINMENT)\s*[A-Z]/i.test(sentence) && /Add Topic|Keep Watching|mins ago/i.test(sentence)) continue;
    if (/^NEW YORK\s*[-–—]\s*$/i.test(sentence)) continue;  // Orphaned dateline

    substantive.push(sentence);
  }

  // Score sentences for evaluative content — critics put opinions in the middle, not the opening
  const evaluativePatterns = /\b(brilliant|stunning|magnificent|masterful|superb|exquisite|riveting|extraordinary|tremendous|dazzling|remarkable|outstanding|phenomenal|triumphant|glorious|mesmerizing|unforgettable|electrifying|breathtaking|enthralling|captivating|compelling|powerful|moving|touching|stirring|soaring|ambitious|accomplished|impressive|enjoyable|entertaining|delightful|charming|witty|clever|smart|sharp|terrific|wonderful|excellent|great|good|solid|fine|decent|satisfying|adequate|mediocre|uneven|mixed|disappointing|lackluster|overwrought|tedious|plodding|uninspired|dull|bland|lifeless|clumsy|awkward|misguided|tiresome|labored|dreary|flat|overwrought|pretentious|bloated|muddled|incoherent|terrible|awful|abysmal|disastrous|dire|painful|insufferable|excels|succeeds|fails|stumbles|falters|shines|soars|triumphs|delivers|struggles|suffers|manages|achieves|misses|works|doesn't work|falls short|rises above|worth seeing|must.see|not to be missed|skip this|avoid|highly recommended)\b/i;

  // Also detect evaluative structure: "is a [adjective] [noun]", "proves to be", comparative language
  const evaluativeStructure = /\b(is a|is an|proves to be|turns out|makes for|offers a|provides|lacks|needs more|could use|doesn't quite|more than|less than|better than|worse than|the best|the worst|one of the|not enough|too much|too many|too little|though .{5,30} (it|the|this)|but .{5,30} (it|the|this)|despite|unfortunately|thankfully|fortunately|sadly)\b/i;

  // Score each sentence
  const scored = substantive.map((sentence, idx) => {
    let score = 0;

    // Evaluative language match
    const evalMatches = sentence.match(evaluativePatterns);
    if (evalMatches) score += 3;

    // Evaluative structure match
    if (evaluativeStructure.test(sentence)) score += 2;

    // Bonus for sentences that feel like a verdict
    if (/\b(overall|in the end|ultimately|all in all|on balance|the result|the bottom line|what emerges)\b/i.test(sentence)) score += 2;

    // Penalty for pure scene-setting/context (dates, "back in YEAR", "when X first", producer/cast lists)
    if (/^(In|Back in|When)\s+\d{4}/i.test(sentence)) score -= 2;
    if (/^(With|Featuring|Starring|Directed by|Written by|Produced by)\s+[A-Z]/i.test(sentence)) score -= 1;
    if (/^NEW YORK\s*[-–—]/i.test(sentence)) score -= 2;
    // Penalty for pure plot summary language
    if (/^(The story|The plot|The show|The musical|The play)\s+(follows|centers|is about|is set|takes place|begins|opens|starts|revolves)/i.test(sentence)) score -= 1;

    // Slight preference for mid-review sentences (where opinions tend to be)
    if (idx > 0 && idx < 8) score += 0.5;
    // Heavy penalty for very early sentences in long reviews (likely context)
    if (idx === 0 && substantive.length > 5) score -= 1;

    return { sentence, score, idx };
  });

  // Try to build an excerpt from the highest-scored evaluative sentences
  // First, try to find a cluster of 1-3 consecutive evaluative sentences
  let bestExcerpt = '';
  let bestScore = -Infinity;

  for (let i = 0; i < Math.min(scored.length, 15); i++) {
    let excerpt = scored[i].sentence;
    let totalScore = scored[i].score;

    // Try adding the next 1-2 sentences for context
    for (let j = i + 1; j < Math.min(i + 3, scored.length); j++) {
      if (scored[j].idx !== scored[j - 1].idx + 1) break; // Only consecutive
      excerpt += ' ' + scored[j].sentence;
      totalScore += scored[j].score;
      if (excerpt.length >= 250) break;
    }

    if (excerpt.length >= 50 && excerpt.length <= 400 && totalScore > bestScore) {
      bestScore = totalScore;
      bestExcerpt = excerpt;
    }
  }

  // Fallback: if no evaluative sentences found, take the first substantive sentences
  if (bestScore <= 0 || bestExcerpt.length < 50) {
    bestExcerpt = '';
    for (const s of substantive) {
      bestExcerpt += (bestExcerpt ? ' ' : '') + s;
      if (bestExcerpt.length >= 250 || (bestExcerpt.match(/[.!?]/g) || []).length >= 2) break;
    }
  }

  let excerpt = bestExcerpt;
  if (excerpt.length < 50) return null;

  // Strip trailing "Read more." or similar
  excerpt = excerpt.replace(/\s*Read more\.?\s*$/i, '');

  // Reject if excerpt is ad code, URL, HTML attributes, or junk
  if (/defineSlot|setTargeting|blogherads|adsbygoogle|googletag/i.test(excerpt)) return null;
  if (/^https?:\/\//i.test(excerpt)) return null;
  if (/data-\w+="/i.test(excerpt)) return null;  // Raw HTML data attributes

  // Reject if starts mid-word (lowercase with no preceding context)
  if (/^[a-z]/.test(excerpt)) {
    const nextSentence = excerpt.search(/[.!?]\s+[A-Z]/);
    if (nextSentence > 0 && nextSentence < excerpt.length - 50) {
      excerpt = excerpt.substring(nextSentence + 2);
    } else {
      return null;
    }
  }

  // Strip any remaining "| Photo:" artifacts
  excerpt = excerpt.replace(/\|\s*Photo\s*:\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s*/g, '');

  // Truncate if needed
  if (excerpt.length > 350) {
    const truncAt = excerpt.lastIndexOf('.', 350);
    excerpt = truncAt > 100 ? excerpt.substring(0, truncAt + 1) : excerpt.substring(0, 347) + '...';
  }

  return excerpt.length > 50 ? excerpt : null;
}

/**
 * Select the best available excerpt using smart priority
 * Aggregator excerpts are preferred over fullText extraction because critics
 * typically open reviews with context/scene-setting, not evaluative content.
 * Aggregator editors hand-pick evaluative quotes.
 *
 * Priority: llmPullQuote > LLM keyPhrases > showScoreExcerpt > bwwExcerpt >
 *           nycTheatreExcerpt > dtliExcerpt > fullText extract > existing pullQuote
 */
// Cross-show validation: dry-run by default (log but don't suppress)
const CROSS_SHOW_DRY_RUN = process.env.DRY_RUN_CROSS_SHOW !== 'false';

/**
 * Quality gate for LLM-extracted pull quotes. Rejects generic or scene-setting
 * quotes that don't add value over aggregator excerpts.
 */
function isGenericQuote(text) {
  if (!text) return true;
  const lower = text.toLowerCase().trim();

  // Generic praise/criticism that could apply to any show
  const genericPatterns = [
    /^(it('s| is)|this is) (a )?(must[- ]see|worth seeing|not to be missed)\b/,
    /^don'?t miss (it|this)/,
    /^(highly )?recommended\.?$/,
    /^(go )?see (it|this show)/,
    /^a (great|good|wonderful|terrible|bad) show\.?$/,
  ];

  // Scene-setting openers
  const sceneSettingPatterns = [
    /^when the (curtain|lights|house lights|show) /,
    /^at the [a-z]+ the(a|u)tre/,
    /^on a recent (evening|night|afternoon)/,
    /^(walking|stepping) into the /,
    /^the (stage|set) (is|was) (bare|dark|set)/,
  ];

  for (const p of [...genericPatterns, ...sceneSettingPatterns]) {
    if (p.test(lower)) return true;
  }

  // Short quotes whose entire evaluative content is "must-see" or "not to be missed"
  if (lower.length < 100 && /(must[- ]see|not to be missed|highly recommended)\b/.test(lower)) {
    return true;
  }

  return false;
}

/**
 * Trim a quote to the last complete sentence (ending in . ! ? or closing quote).
 * Returns the original if it already ends cleanly or no sentence boundary is found.
 */
function trimToCompleteSentence(text) {
  if (!text) return text;
  const trimmed = text.trim();
  // Already ends with sentence-ending punctuation
  if (/[.!?"\u201D')]\s*$/.test(trimmed)) return trimmed;
  // Find the last sentence-ending punctuation
  const match = trimmed.match(/^(.*[.!?"\u201D'])\s*\S+.*$/s);
  if (match && match[1].length >= 40) return match[1].trim();
  return trimmed;
}

function selectBestExcerpt(data, showTitle) {
  const showId = data.showId;

  /**
   * Validate an excerpt candidate against cross-show and tour guards.
   * Returns the excerpt if valid, null if suppressed.
   */
  function validateExcerpt(excerpt, source) {
    if (!excerpt) return null;

    // Layer 3: Cross-show validation
    const crossCheck = excerptMentionsWrongShow(excerpt, showId, showTitle);
    if (crossCheck.isWrongShow) {
      const msg = `[cross-show] ${showId}: "${source}" mentions "${crossCheck.mentionedTitle}" (${crossCheck.mentionedShowId})`;
      if (CROSS_SHOW_DRY_RUN) {
        // Log only — don't suppress
        if (!stats.crossShowExcerptFlags) stats.crossShowExcerptFlags = [];
        stats.crossShowExcerptFlags.push({ showId, source, mentionedTitle: crossCheck.mentionedTitle, mentionedShowId: crossCheck.mentionedShowId });
        console.log(`  ⚠️  DRY-RUN ${msg}`);
        // Return excerpt anyway in dry-run mode
      } else {
        if (!stats.crossShowExcerptSuppressed) stats.crossShowExcerptSuppressed = [];
        stats.crossShowExcerptSuppressed.push({ showId, source, mentionedTitle: crossCheck.mentionedTitle });
        console.log(`  🚫 SUPPRESSED ${msg}`);
        return null;
      }
    }

    // Layer 4: Tour review detection (only for non-tour-stop shows)
    if (data._showStatus !== 'tour-stop') {
      const tourCheck = isTourReviewExcerpt(excerpt);
      if (tourCheck.isTourReview) {
        if (!stats.tourExcerptFlags) stats.tourExcerptFlags = [];
        stats.tourExcerptFlags.push({ showId, source, signal: tourCheck.signal });
        console.log(`  ⚠️  [tour-excerpt] ${showId}: "${source}" has tour signal: ${tourCheck.signal}`);
        // Tour detection is always log-only for now (excerpt still used)
      }
    }

    return excerpt;
  }

  // 0. Try dedicated LLM pull quote (highest quality — focused extraction prompt)
  //    Quality gate: reject generic/scene-setting, trim mid-sentence cutoffs
  if (data.llmPullQuote && data.llmPullQuote.length > 30) {
    const trimmed = trimToCompleteSentence(data.llmPullQuote);
    const cleaned = cleanExcerpt(trimmed);
    if (cleaned && !isJunkExcerpt(cleaned) && !isGenericQuote(cleaned)) {
      const validated = validateExcerpt(cleaned, 'llmPullQuote');
      if (validated) return validated;
    }
  }

  // 1. Try LLM-extracted key phrases (from scoring pipeline)
  if (data.llmScore?.keyPhrases?.length > 0) {
    // Find a positive or descriptive quote
    for (const phrase of data.llmScore.keyPhrases) {
      if (phrase.quote && phrase.quote.length > 30 && phrase.sentiment !== 'negative') {
        const cleaned = cleanExcerpt(phrase.quote);
        if (cleaned && !isJunkExcerpt(cleaned)) {
          const validated = validateExcerpt(cleaned, 'keyPhrase');
          if (validated) return validated;
        }
      }
    }
    // Fall back to any quote
    for (const phrase of data.llmScore.keyPhrases) {
      if (phrase.quote && phrase.quote.length > 30) {
        const cleaned = cleanExcerpt(phrase.quote);
        if (cleaned && !isJunkExcerpt(cleaned)) {
          const validated = validateExcerpt(cleaned, 'keyPhrase');
          if (validated) return validated;
        }
      }
    }
  }

  // 1b. Try V5 keyQuote (single string from V5 scoring, not yet converted to keyPhrases)
  if (data.llmScore?.keyQuote && data.llmScore.keyQuote.length > 30) {
    const cleaned = cleanExcerpt(data.llmScore.keyQuote);
    if (cleaned && !isJunkExcerpt(cleaned)) {
      const validated = validateExcerpt(cleaned, 'keyQuote');
      if (validated) return validated;
    }
  }

  // 2. Try showScoreExcerpt (usually human-curated, cleaner)
  if (data.showScoreExcerpt) {
    const cleaned = cleanExcerpt(data.showScoreExcerpt);
    if (cleaned && cleaned.length > 40) {
      const validated = validateExcerpt(cleaned, 'showScoreExcerpt');
      if (validated) return validated;
    }
  }

  // 3. Try bwwExcerpt (aggregator-curated, usually evaluative)
  if (data.bwwExcerpt) {
    const cleaned = cleanExcerpt(data.bwwExcerpt);
    if (cleaned && cleaned.length > 40) {
      const validated = validateExcerpt(cleaned, 'bwwExcerpt');
      if (validated) return validated;
    }
  }

  // 4. Try nycTheatreExcerpt (aggregator-curated)
  if (data.nycTheatreExcerpt) {
    const cleaned = cleanExcerpt(data.nycTheatreExcerpt);
    if (cleaned && cleaned.length > 40) {
      const validated = validateExcerpt(cleaned, 'nycTheatreExcerpt');
      if (validated) return validated;
    }
  }

  // 5. Try dtliExcerpt with aggressive cleaning (aggregator-curated)
  if (data.dtliExcerpt) {
    const cleaned = cleanExcerpt(data.dtliExcerpt, true);
    if (cleaned && cleaned.length > 40) {
      const validated = validateExcerpt(cleaned, 'dtliExcerpt');
      if (validated) return validated;
    }
  }

  // 6. Extract from fullText (last automated option — critics often open with
  //    context/scene-setting, so this is lower priority than aggregator excerpts)
  if (data.fullText && data.fullText.length > 300 && data.textStatus !== 'truncated') {
    const extracted = extractExcerptFromFullText(data.fullText, data.showId);
    if (extracted && extracted.length > 50) {
      const validated = validateExcerpt(extracted, 'fullText');
      if (validated) return validated;
    }
  }

  // 7. Try existing pullQuote if nothing else works
  if (data.pullQuote) {
    const cleaned = cleanExcerpt(data.pullQuote);
    if (cleaned && cleaned.length > 40) {
      const validated = validateExcerpt(cleaned, 'pullQuote');
      if (validated) return validated;
    }
  }

  return null;
}

/**
 * Strip wrapping quotation marks from excerpt so frontend can add them consistently.
 * Handles straight quotes, curly quotes, and mixed pairs.
 */
function normalizeQuoteWrapping(text) {
  if (!text) return text;
  let result = text.trim();
  // Strip matching outer quotes (straight, curly, or mixed)
  if ((result.startsWith('"') || result.startsWith('\u201c')) &&
      (result.endsWith('"') || result.endsWith('\u201d'))) {
    result = result.slice(1, -1).trim();
  }
  return result;
}

// Stats tracking
const stats = {
  totalFiles: 0,
  totalReviews: 0,
  skippedNoScore: 0,
  skippedDuplicate: 0,
  scoreSources: {
    'explicit-stars': 0,
    'explicit-outOf': 0,
    'explicit-slash': 0,
    'explicit-letterGrade': 0,
    'human-review': 0,
    'originalScore-priority0': 0,
    llmScore: 0,
    'llmScore-thumb-validated': 0,  // Both thumbs agree with LLM direction
    'llmScore-thumb-boosted': 0,   // Single thumb agrees with LLM direction
    'llmScore-lowconf': 0,
    'llmScore-review': 0,
    assignedScore: 0,
    originalScore: 0,
    bucket: 0,
    'bwwScore-fallback': 0,
    thumb: 0
  },
  // explicitOverrideLlm removed — extraction now at collection time
  thumbValidatedLlm: 0,    // Count how many times thumb validated low-conf LLM direction
  unscoredWithText: [],     // Reviews with text but no LLM score (should be scored!)
  byShow: {}
};

const skippedReviews = [];

// parseStarRating, parseLetterGrade, parseOriginalScore — imported from scripts/lib/score-parsers.js

function getBestScore(data) {
  // Skip if explicitly marked as TO_BE_CALCULATED
  if (data.scoreStatus === 'TO_BE_CALCULATED') {
    return null;
  }

  // Priority 0: Human-reviewed score (manual override from audit queue)
  // These are set after reviewing flagged reviews where LLM and thumbs disagree.
  // Highest priority — a deliberate human decision always wins.
  if (data.humanReviewScore && data.humanReviewScore >= 1 && data.humanReviewScore <= 100) {
    return { score: data.humanReviewScore, source: 'human-review' };
  }

  // Priority 0.5: Parse originalScore field (aggregator-provided, outlet-verified)
  // Ratings like "4/5 stars", "B+", "★★★★☆" come from the aggregator or scraper
  // and are more reliable than regex extraction from fullText, which can match
  // garbage sidebar content or unrelated embedded articles.
  //
  // EXCEPTION: For West End shows, ShowScore originalScores are downgraded to P1 level
  // because ShowScore WE ratings haven't been validated and are known to inflate
  // (e.g., reporting 5/5 when actual review was 4/5). LLM scores take priority.
  const isShowScoreSource = data.source === 'show-score' || data.source === 'show-score-playwright' || data.source === 'showscore-roundup';
  const isWestEnd = data._showCategory === 'west-end';
  const downgradeShowScore = isShowScoreSource && isWestEnd;

  if (data.originalScore && !downgradeShowScore) {
    // Skip low-confidence originalScores — these are often misreads from page templates
    // (e.g., "1/5" from a star icon in a sidebar, "D" from a page element)
    if (data.scoreConfidence === 'low' || data.scoreSource === 'star-icon') {
      stats.skippedLowConfidenceOriginal = (stats.skippedLowConfidenceOriginal || 0) + 1;
      // Fall through to LLM scoring instead
    } else {
      const parsed = parseOriginalScore(data.originalScore, data.outletId);
      if (parsed !== null) {
        // Direction guard: flag for human review if originalScore wildly conflicts with LLM.
        // Still USES the originalScore (explicit data has priority), but surfaces the conflict.
        const llm = data.llmScore && data.llmScore.score;
        const llmConf = data.llmScore && data.llmScore.confidence;
        if (llm && llmConf !== 'low' && Math.abs(parsed - llm) > 25) {
          const parsedBucket = parsed >= 70 ? 'positive' : parsed <= 40 ? 'negative' : 'mixed';
          const llmBucket = llm >= 70 ? 'positive' : llm <= 40 ? 'negative' : 'mixed';
          if (parsedBucket !== llmBucket) {
            flagForHumanReview(data, 'originalScore-llm-conflict',
              `originalScore "${data.originalScore}" (=${parsed}, bucket=${parsedBucket}) vs LLM ${llm} (bucket=${llmBucket}, conf=${llmConf})`);
          }
        }
        return { score: parsed, source: 'originalScore-priority0' };
      }
    }
  }

  // Priority 1 (formerly 0b): Explicit rating extraction from fullText
  // REMOVED — now handled at collection time by LLM extraction.
  // Reviews with explicit ratings will have originalScore pre-populated,
  // caught by Priority 0.5 above.

  // Priority 2: LLM score (HIGH/MEDIUM confidence only)
  if (data.llmScore && data.llmScore.score) {
    const confidence = data.llmScore.confidence;
    const needsReview = data.ensembleData?.needsReview;

    // Downgrade confidence when scoring from excerpt-only text
    // Audit showed ~50% error rate on excerpt-only high/medium confidence scores
    // Also downgrade when fullText was recovered from garbage — the LLM scored the excerpt, not the recovered text
    // Also downgrade when contentVerification flagged the article as wrong — the text is from a different article
    const cvWrongArticle = data.contentVerification && data.contentVerification.wrongArticle === true;
    const hasOriginalFullText = data.fullText && data.fullText.trim().length > 100 && !data.fullTextRecoveredFrom && !cvWrongArticle;
    const effectiveConfidence = (!hasOriginalFullText && confidence !== 'low') ? 'low' : confidence;

    // High/medium confidence: use directly
    if (effectiveConfidence !== 'low' && !needsReview) {
      // ENSEMBLE QUALITY GATE: Block single-model scores without ensemble validation
      const hasEnsemble = !!data.ensembleData;
      if (!hasEnsemble) {
        if (!hasOriginalFullText) {
          // BLOCK: excerpt-only + single-model = highest error rate, fall through
          stats.blockedSingleModelExcerpt = (stats.blockedSingleModelExcerpt || 0) + 1;
        } else {
          // fullText + single-model: include but tag source differently
          stats.warnSingleModelFullText = (stats.warnSingleModelFullText || 0) + 1;
          return { score: data.llmScore.score, source: 'llmScore-single-model' };
        }
      } else {
        // Has ensemble — proceed with existing validation
        // Flag if BOTH thumbs agree with each other but disagree with LLM direction
        const llmThumb = data.llmScore.score >= 70 ? 'Up' : data.llmScore.score >= 55 ? 'Flat' : 'Down';
        const dtli = data.dtliThumb ? normalizeThumb(data.dtliThumb) : null;
        const bww = data.bwwThumb ? normalizeThumb(data.bwwThumb) : null;
        if (dtli && bww && dtli === bww && dtli !== llmThumb) {
          flagForHumanReview(data, 'both-thumbs-disagree-with-llm',
            `LLM=${data.llmScore.score} (${llmThumb}), both thumbs=${data.dtliThumb}`);
        }
        // Track bwwScore-LLM divergence as stat counter (not human-review flag — too noisy)
        if (data.bwwScore != null) {
          const bwwNorm = data.bwwScore * 10;
          if (Math.abs(bwwNorm - data.llmScore.score) > 30) {
            stats.bwwScoreLlmConflicts = (stats.bwwScoreLlmConflicts || 0) + 1;
          }
        }
        // Borderline rave detection: ensemble score 78-82 with high confidence
        // Calibration data shows 50% of true raves are misclassified, with 62% scoring 78-82.
        // Flag these for human review so they can be manually promoted if warranted.
        if (data.llmScore.score >= 78 && data.llmScore.score <= 82 && data.llmScore.confidence !== 'low') {
          stats.borderlineRaves = (stats.borderlineRaves || 0) + 1;
          // Only flag when we have corroborating evidence of rave-level reception
          const dtliUp = data.dtliThumb && normalizeThumb(data.dtliThumb) === 'Up';
          const bwwUp = data.bwwThumb && normalizeThumb(data.bwwThumb) === 'Up';
          const bwwHigh = data.bwwScore != null && data.bwwScore >= 8;
          const corroboratingSignals = (dtliUp ? 1 : 0) + (bwwUp ? 1 : 0) + (bwwHigh ? 1 : 0);
          if (corroboratingSignals >= 2) {
            flagForHumanReview(data, 'borderline-rave',
              `LLM=${data.llmScore.score} (high conf), thumbs/bwwScore suggest rave. Calibration shows 62% of true raves score 78-82.`);
            stats.borderlineRavesFlagged = (stats.borderlineRavesFlagged || 0) + 1;
          }
        }
        return { score: data.llmScore.score, source: 'llmScore' };
      }
    }
  }

  // Priority 3: Thumb-validated confidence upgrade for low-confidence LLM scores
  // Instead of overriding the LLM's nuanced score with a blunt thumb value (Up=80, Down=35),
  // use thumbs to VALIDATE the LLM score. The LLM already sees thumb data in its prompt
  // (input-builder.ts passes "Aggregator verdicts: DTLI: Up, BWW: Up"), so its score already
  // incorporates that signal. Thumbs boost confidence; they don't replace the score.
  const hasLowConfLlm = data.llmScore?.score &&
    (data.llmScore.confidence === 'low' || data.ensembleData?.needsReview ||
     !(data.fullText && data.fullText.trim().length > 100 && !data.fullTextRecoveredFrom));

  if (hasLowConfLlm) {
    const dtliThumbNorm = data.dtliThumb ? normalizeThumb(data.dtliThumb) : null;
    const bwwThumbNorm = data.bwwThumb ? normalizeThumb(data.bwwThumb) : null;
    const llmScore = data.llmScore.score;
    const llmBucket = scoreToBucket(llmScore);

    const thumbDirection = (thumb) => {
      if (thumb === 'Up') return 'positive';
      if (thumb === 'Down') return 'negative';
      return 'neutral'; // Flat/Meh
    };
    const bucketDirection = (bucket) => {
      if (bucket === 'Rave' || bucket === 'Positive') return 'positive';
      if (bucket === 'Negative' || bucket === 'Pan') return 'negative';
      return 'neutral'; // Mixed
    };

    const dtliIsMeh = dtliThumbNorm === 'Flat';
    const bwwIsMeh = bwwThumbNorm === 'Flat';
    const llmDir = bucketDirection(llmBucket);

    // Convert bwwScore (1-10) to thumb-equivalent direction
    const bwwScoreDir = data.bwwScore != null
      ? (data.bwwScore >= 7 ? 'positive' : data.bwwScore <= 3 ? 'negative' : 'neutral')
      : null;

    // Track when bwwThumb and bwwScore disagree directionally (data quality signal)
    if (bwwThumbNorm && bwwScoreDir && bwwScoreDir !== 'neutral') {
      const thumbDir = thumbDirection(bwwThumbNorm);
      if (thumbDir !== 'neutral' && thumbDir !== bwwScoreDir) {
        stats.bwwInternalConflicts = (stats.bwwInternalConflicts || 0) + 1;
      }
    }

    // Check how many non-Meh thumbs agree with LLM direction
    const thumbDirs = [];
    if (dtliThumbNorm && !dtliIsMeh) thumbDirs.push(thumbDirection(dtliThumbNorm));
    if (bwwThumbNorm && !bwwIsMeh) thumbDirs.push(thumbDirection(bwwThumbNorm));
    // bwwScore as additional directional signal (only when bwwThumb absent to avoid double-counting)
    if (bwwScoreDir && bwwScoreDir !== 'neutral' && !bwwThumbNorm) thumbDirs.push(bwwScoreDir);
    const agreeing = thumbDirs.filter(d => d === llmDir).length;
    const disagreeing = thumbDirs.filter(d => d !== llmDir && d !== 'neutral').length;

    if (agreeing > 0 && disagreeing === 0) {
      // Thumbs validate LLM direction → upgrade to medium confidence, keep LLM's nuanced score
      stats.thumbValidatedLlm = (stats.thumbValidatedLlm || 0) + 1;
      return { score: llmScore, source: agreeing >= 2 ? 'llmScore-thumb-validated' : 'llmScore-thumb-boosted' };
    }

    if (disagreeing > 0 && agreeing === 0) {
      // Thumbs disagree with LLM direction → flag for review but still use LLM score
      // Both thumbs disagreeing is stronger signal
      if (disagreeing >= 2) {
        flagForHumanReview(data, 'both-thumbs-disagree-with-llm',
          `LLM=${llmScore} (${llmBucket}), thumbs=${dtliThumbNorm || '-'}/${bwwThumbNorm || '-'}`);
      }
      // Use LLM score but keep as low confidence (thumbs couldn't validate it)
    }

    // Meh thumbs or mixed signals: don't change confidence, fall through to P4
  }

  // Priority 4: LLM score fallback (low confidence, needs review, or excerpt-only - when no thumb available)
  if (data.llmScore && data.llmScore.score) {
    const confidence = data.llmScore.confidence;
    const needsReview = data.ensembleData?.needsReview;
    const isExcerptOnly = !(data.fullText && data.fullText.trim().length > 100 && !data.fullTextRecoveredFrom);
    const hasEnsemble = !!data.ensembleData;

    // ENSEMBLE QUALITY GATE: Block single-model excerpt-only scores entirely
    if (!hasEnsemble && isExcerptOnly) {
      stats.blockedSingleModelExcerpt = (stats.blockedSingleModelExcerpt || 0) + 1;
      // Fall through to assignedScore/bucket/thumb fallbacks
    } else if (confidence === 'low' || isExcerptOnly) {
      return { score: data.llmScore.score, source: hasEnsemble ? 'llmScore-lowconf' : 'llmScore-lowconf-single-model' };
    } else if (needsReview) {
      return { score: data.llmScore.score, source: 'llmScore-review' };
    }
  }

  // P4: Existing assignedScore (if valid AND has a known source)
  if (data.assignedScore && data.assignedScore >= 1 && data.assignedScore <= 100) {
    // Check if this has a legitimate source
    const validSources = ['llmScore', 'originalScore', 'bucket', 'thumb',
                          'llmScore-thumb-validated', 'llmScore-thumb-boosted',
                          'extracted-grade', 'extracted-rating', 'extracted-unicode-stars',
                          'extracted-thumbs', 'extracted-strong-positive', 'extracted-strong-negative',
                          'sentiment-rave', 'sentiment-strong-positive', 'sentiment-positive', 'sentiment-mixed-positive',
                          'sentiment-mixed', 'sentiment-mixed-negative', 'sentiment-negative',
                          'sentiment-strong-negative', 'sentiment-pan', 'manual', 'manual-excerpt'];

    if (data.scoreSource && validSources.some(s => data.scoreSource.includes(s))) {
      return { score: data.assignedScore, source: 'assignedScore' };
    }

    // Also accept if there's evidence of how it was scored (thumb data, etc.)
    if (data.dtliThumb || data.bwwThumb || data.originalScore || data.bucket) {
      return { score: data.assignedScore, source: 'assignedScore' };
    }
  }

  // P4b: Downgraded ShowScore originalScore fallback (WE shows only)
  // ShowScore star ratings for WE are used as fallback when no LLM/explicit score exists
  if (downgradeShowScore && data.originalScore) {
    const parsed = parseOriginalScore(data.originalScore, data.outletId);
    if (parsed !== null) {
      stats.showScoreDowngradedFallback = (stats.showScoreDowngradedFallback || 0) + 1;
      return { score: parsed, source: 'originalScore-showscore-downgraded' };
    }
  }

  // P5: Bucket mapping
  if (data.bucket && BUCKET_TO_SCORE[data.bucket]) {
    return { score: BUCKET_TO_SCORE[data.bucket], source: 'bucket' };
  }

  // P5.5: bwwScore fallback (more granular than thumb mapping)
  if (data.bwwScore != null && data.bwwScore >= 1 && data.bwwScore <= 10) {
    return { score: data.bwwScore * 10, source: 'bwwScore-fallback' };
  }

  // P6: Thumb mappings (dtli first, then bww)
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
  if (score >= 83) return 'Rave';
  if (score >= 70) return 'Positive';
  if (score >= 55) return 'Mixed';
  if (score >= 35) return 'Negative';
  return 'Pan';
}

function scoreToThumb(score) {
  if (score >= 70) return 'Up';
  if (score >= 55) return 'Flat';
  return 'Down';
}

// Main execution
console.log('=== REBUILDING ALL REVIEWS ===\n');
console.log('NOTE: Reviews without valid scores are EXCLUDED (no default of 50)\n');

// Load show dates and status for production-date guard
const showsData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
const showDateMap = {};
const showClosingDateMap = {};
const showStatusMap = {};
const showTitleMap = {};
const showCategoryMap = {};  // showId -> category (e.g., 'west-end', 'broadway')
const showCreativeTeamIndex = {};  // showId -> Set of lowercase creative team names
for (const s of showsData.shows) {
  const earliest = s.previewsStartDate || s.openingDate;
  if (earliest) showDateMap[s.id] = new Date(earliest);
  if (s.closingDate && s.status === 'closed') showClosingDateMap[s.id] = new Date(s.closingDate);
  showStatusMap[s.id] = s.status;
  showTitleMap[s.id] = s.title;
  showCategoryMap[s.id] = s.category || 'broadway';
  showCreativeTeamIndex[s.id] = new Set();
  if (s.creativeTeam) {
    for (const m of s.creativeTeam) {
      if (m.name) showCreativeTeamIndex[s.id].add(m.name.toLowerCase().trim());
    }
  }
}

// Build URL-year cross-production guard for multi-production shows
// Pattern: review URL contains a year clearly closer to a sibling production = wrong directory
const multiProdYearGuard = {};
{
  const titleGroups = {};
  for (const s of showsData.shows) {
    const normTitle = s.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!titleGroups[normTitle]) titleGroups[normTitle] = [];
    titleGroups[normTitle].push(s);
  }
  for (const [, prods] of Object.entries(titleGroups)) {
    if (prods.length < 2) continue;
    for (const show of prods) {
      const showYear = show.openingDate ? parseInt(show.openingDate.slice(0, 4))
        : show.previewsStartDate ? parseInt(show.previewsStartDate.slice(0, 4)) : null;
      if (!showYear) continue;
      // Compare to siblings in the same market. Broadway and off-broadway are treated
      // as the same NYC market (e.g., Kinky Boots 2013 broadway vs 2026 off-broadway).
      // West End is a separate market — never cross-compare with Broadway/OB.
      const showCat = show.category || 'broadway';
      const nycMarket = showCat === 'broadway' || showCat === 'off-broadway';
      const siblings = prods.filter(p => {
        if (p.id === show.id) return false;
        const pCat = p.category || 'broadway';
        if (nycMarket) return pCat === 'broadway' || pCat === 'off-broadway';
        return pCat === showCat;
      }).map(p => ({
        id: p.id,
        year: p.openingDate ? parseInt(p.openingDate.slice(0, 4)) : null
      })).filter(p => p.year);
      if (siblings.length > 0) {
        multiProdYearGuard[show.id] = { showYear, siblings };
      }
    }
  }
  const guardedCount = Object.keys(multiProdYearGuard).length;
  if (guardedCount > 0) {
    console.log(`URL-year cross-production guard active for ${guardedCount} multi-production shows`);
  }
}

// Build director cross-check lookup for multi-production shows
// Pattern: reviews in OLDER production dirs mentioning NEWER production's director = wrong production
const multiProdDirectorGuard = {};
{
  const titleGroups = {};
  for (const s of showsData.shows) {
    const base = s.title.replace(/\s*\(.*?\)/g, '').replace(/:\s.*$/, '').trim().toLowerCase();
    if (!titleGroups[base]) titleGroups[base] = [];
    titleGroups[base].push(s);
  }
  for (const [, prods] of Object.entries(titleGroups)) {
    if (prods.length < 2) continue;
    prods.sort((a, b) => {
      const da = a.openingDate ? new Date(a.openingDate).getTime() : Infinity;
      const db = b.openingDate ? new Date(b.openingDate).getTime() : Infinity;
      return da - db;
    });
    for (let i = 0; i < prods.length; i++) {
      const thisShow = prods[i];
      const thisDirectors = (thisShow.creativeTeam || [])
        .filter(ct => /director/i.test(ct.role))
        .map(ct => ct.name.toLowerCase());
      // Collect directors from NEWER productions in the SAME market only
      const newerDirs = new Map();
      for (let j = i + 1; j < prods.length; j++) {
        // Don't cross-compare different markets (Broadway vs West End vs Off-Broadway)
        if (prods[j].category !== thisShow.category) continue;
        for (const ct of (prods[j].creativeTeam || [])) {
          if (/director/i.test(ct.role)) {
            const name = ct.name.toLowerCase();
            // Skip if this person also directed the current production
            if (!thisDirectors.includes(name)) {
              newerDirs.set(name, prods[j].id);
            }
          }
        }
      }
      if (newerDirs.size > 0) {
        multiProdDirectorGuard[thisShow.id] = newerDirs;
      }
    }
  }
  const guardedShows = Object.keys(multiProdDirectorGuard).length;
  if (guardedShows > 0) {
    console.log(`Director cross-check guard active for ${guardedShows} multi-production shows\n`);
  }
}

// Get all show directories
const showDirs = fs.readdirSync(reviewTextsDir)
  .filter(f => {
    const fullPath = path.join(reviewTextsDir, f);
    // Skip symlinks to avoid processing the same directory twice
    if (fs.lstatSync(fullPath).isSymbolicLink()) return false;
    return fs.statSync(fullPath).isDirectory();
  });

console.log(`Found ${showDirs.length} show directories\n`);

const allReviews = [];

// Load failed-fetches map for incompleteReason classification
const failedFetchesPath = path.join(reviewTextsDir, 'failed-fetches.json');
let failedFetchMap = new Map();
try {
  const ff = JSON.parse(fs.readFileSync(failedFetchesPath, 'utf8'));
  for (const entry of ff) {
    if (entry.reviewId) failedFetchMap.set(entry.reviewId, entry);
  }
  console.log(`Loaded ${failedFetchMap.size} failed-fetch entries for incompleteReason classification`);
} catch (e) {
  console.log(`Warning: Could not load failed-fetches.json: ${e.message}`);
}

// Cross-show URL dedup: detect when the same review URL exists in multiple show directories.
// When a URL appears in two shows, the show whose opening year is closest to the review's
// publish date (or URL year) gets priority. The other is flagged wrongProduction.
const crossShowUrlIndex = new Map();
{
  function normalizeUrlForDedup(url) {
    if (!url) return null;
    return url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();
  }
  for (const sid of showDirs) {
    const sDir = path.join(reviewTextsDir, sid);
    const showYear = showDateMap[sid] ? showDateMap[sid].getFullYear() : null;
    for (const f of fs.readdirSync(sDir).filter(x => x.endsWith('.json'))) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(sDir, f), 'utf8'));
        if (d.wrongProduction || d.wrongShow) continue;
        const norm = normalizeUrlForDedup(d.url);
        if (!norm) continue;
        const existing = crossShowUrlIndex.get(norm);
        if (existing && existing.showId !== sid) {
          if (!existing.conflicts) existing.conflicts = [];
          existing.conflicts.push({ showId: sid, file: f, showYear });
        } else if (!existing) {
          crossShowUrlIndex.set(norm, { showId: sid, file: f, showYear, conflicts: [] });
        }
      } catch { /* skip unreadable files */ }
    }
  }
  let conflictCount = 0;
  for (const [, entry] of crossShowUrlIndex) {
    if (entry.conflicts.length > 0) conflictCount++;
  }
  if (conflictCount > 0) {
    console.log(`Cross-show URL dedup: found ${conflictCount} URLs shared across multiple shows`);
  }
}

// Cross-show fullText fingerprint map: detect when the same scraped text appears under different shows
// Key: SHA-256 hash of full cleaned text (avoids false positives from shared boilerplate prefixes)
const crossShowFingerprints = new Map();

showDirs.forEach(showId => {
  // Skip Broadway shows in previews — they haven't opened yet, all reviews are wrong-production
  // Off-Broadway and West End shows commonly get reviewed during previews, so don't skip them
  const showCat = showCategoryMap[showId] || 'broadway';
  if (showStatusMap[showId] === 'previews' && showCat === 'broadway') {
    stats.skippedPreviewsShows = (stats.skippedPreviewsShows || 0) + 1;
    return;
  }

  const showDir = path.join(reviewTextsDir, showId);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'))
    // Sort: prefer files with real critic names over "unknown"/"unnamed" for URL dedup tiebreaking
    .sort((a, b) => {
      const aUnknown = /unknown|unnamed/i.test(a) ? 1 : 0;
      const bUnknown = /unknown|unnamed/i.test(b) ? 1 : 0;
      return aUnknown - bUnknown || a.localeCompare(b);
    });

  stats.byShow[showId] = { files: files.length, reviews: 0, skipped: 0 };
  stats.totalFiles += files.length;

  // Track seen outlet+critic combinations to avoid duplicates
  const seenKeys = new Set();
  // Track seen URLs per outlet to avoid same-URL duplicates with different critic names
  const seenUrlsByOutlet = new Map();
  // Track seen URLs globally (cross-outlet) to catch same URL filed under different outlets
  const seenUrlsGlobal = new Map();
  // Track content fingerprints per outlet to catch same text under different critic names
  const seenFingerprintsByOutlet = new Map();

  files.forEach(file => {
    try {
      const filePath = path.join(showDir, file);
      const rawContent = fs.readFileSync(filePath, 'utf8');

      // Guard: detect git merge conflict markers (silent data corruption)
      if (/^<{7}\s|^={7}$|^>{7}\s/m.test(rawContent)) {
        console.error(`  [CORRUPTED] ${showId}/${file}: contains git merge conflict markers — SKIPPING`);
        stats.skippedCorrupted = (stats.skippedCorrupted || 0) + 1;
        if (!stats.corruptedFiles) stats.corruptedFiles = [];
        stats.corruptedFiles.push(`${showId}/${file}`);
        return;
      }

      const data = JSON.parse(rawContent);

      // Recover review text from garbageFullText when fullText is missing
      // Some reviews were flagged as garbage only due to trailing junk (newsletters, copyright)
      // but contain valid review text that can be cleaned and promoted
      // NEVER recover from 404/error pages — they contain content from other reviews
      // (e.g., NYSR 404 pages include star ratings for unrelated reviews)
      const isErrorPage = data.garbageReason &&
        (/^Error\/404/i.test(data.garbageReason) || /page not found/i.test(data.garbageReason));
      if (!data.fullText && data.garbageFullText && data.garbageFullText.length > 200 && !isErrorPage) {
        const cleaned = cleanText(data.garbageFullText);
        if (cleaned && cleaned.length > 200) {
          data.fullText = cleaned;
          data.fullTextRecoveredFrom = 'garbageFullText';
          stats.recoveredFromGarbage = (stats.recoveredFromGarbage || 0) + 1;
        }
      }

      // Reclassify contentTier as safety net (in case collect-review-texts missed it)
      // Also write back to source file if tier changed (prevents stale classifications)
      {
        const tierResult = classifyContentTier(data);
        const oldTier = data.contentTier;
        data.contentTier = tierResult.contentTier;
        if (oldTier && oldTier !== tierResult.contentTier) {
          try {
            const sourceData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            sourceData.contentTier = tierResult.contentTier;
            sourceData.contentTierReason = tierResult.tierReason;
            sourceData.wordCount = tierResult.wordCount;
            fs.writeFileSync(filePath, JSON.stringify(sourceData, null, 2) + '\n');
            stats.reclassifiedTiers = (stats.reclassifiedTiers || 0) + 1;
          } catch (writeErr) {
            // Non-fatal: source file write failure doesn't block rebuild
          }
        }
      }

      // Classify incompleteReason
      {
        const reviewId = `${showId}/${file}`;
        const reasonResult = classifyIncompleteReason(data, failedFetchMap.get(reviewId));
        const oldReason = data.incompleteReason;
        if (reasonResult) {
          data.incompleteReason = reasonResult.incompleteReason;
          data.incompleteDetail = reasonResult.incompleteDetail;
        } else {
          delete data.incompleteReason;
          delete data.incompleteDetail;
        }
        if (oldReason !== data.incompleteReason) {
          try {
            const sourceData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (reasonResult) {
              sourceData.incompleteReason = reasonResult.incompleteReason;
              sourceData.incompleteDetail = reasonResult.incompleteDetail;
            } else {
              delete sourceData.incompleteReason;
              delete sourceData.incompleteDetail;
            }
            fs.writeFileSync(filePath, JSON.stringify(sourceData, null, 2) + '\n');
          } catch (writeErr) { /* Non-fatal */ }
        }
      }

      // Skip files flagged as duplicates by cleanup-review-sources.js
      // But only if the referenced file exists and is NOT also flagged as a duplicate
      // (prevents circular chains where all copies get excluded)
      if (data.duplicateOf) {
        const refPath = path.join(showDir, data.duplicateOf);
        let refAlsoDupe = false;
        try {
          const refData = JSON.parse(fs.readFileSync(refPath, 'utf8'));
          refAlsoDupe = !!refData.duplicateOf || !!refData.duplicateTextOf;
        } catch {
          refAlsoDupe = true; // Reference file missing — stale flag
        }
        if (!refAlsoDupe) {
          stats.skippedDuplicateOf = (stats.skippedDuplicateOf || 0) + 1;
          return;
        }
        // Circular or stale — let this file through, fingerprint dedup will handle actual duplicates
        stats.circularDuplicateRecovered = (stats.circularDuplicateRecovered || 0) + 1;
      }

      // Skip files flagged as duplicate text of another review (same content, different critic)
      // Set by collect-review-texts.js content fingerprinting
      // But only if the referenced file exists and is NOT also flagged — prevents circular exclusion
      if (data.duplicateTextOf) {
        const refPath = path.join(showDir, data.duplicateTextOf);
        let refAlsoDupe = false;
        let staleFlag = false;
        try {
          const refData = JSON.parse(fs.readFileSync(refPath, 'utf8'));
          refAlsoDupe = !!refData.duplicateTextOf || !!refData.duplicateOf;
          // Verify fingerprints still match — flag may be stale after text re-fetch
          if (!refAlsoDupe && data.fullText && refData.fullText) {
            const thisFp = computeContentFingerprint(data.fullText);
            const refFp = computeContentFingerprint(refData.fullText);
            if (thisFp && refFp && thisFp !== refFp) {
              staleFlag = true;
            }
          }
        } catch {
          refAlsoDupe = true; // Reference file missing — stale flag
        }
        if (staleFlag) {
          // Texts no longer match — flag is stale, let this file through
          stats.staleDuplicateTextCleared = (stats.staleDuplicateTextCleared || 0) + 1;
        } else if (!refAlsoDupe) {
          stats.skippedDuplicateText = (stats.skippedDuplicateText || 0) + 1;
          return;
        } else {
          // Circular or stale — let this file through, fingerprint dedup will handle actual duplicates
          stats.circularDuplicateRecovered = (stats.circularDuplicateRecovered || 0) + 1;
        }
      }

      // Auto-clear wrongProduction on WE/OB files set by the URL-year standalone guard
      // These are false positives — WE/OB shows transfer from other venues, so URL years mismatch legitimately
      if (data.wrongProduction === true && data.wrongProductionNote
          && data.wrongProductionNote.includes('URL contains year')
          && (showCat === 'west-end' || showCat === 'off-broadway')) {
        data.wrongProduction = false;
        data.wrongProductionAutoCleared = `rebuild: WE/OB exempt from URL-year guard (was: ${data.wrongProductionNote})`;
        data.wrongProductionAutoClearedAt = new Date().toISOString().split('T')[0];
        delete data.wrongProductionNote;
        stats.wrongProdWEOBAutoCleared = (stats.wrongProdWEOBAutoCleared || 0) + 1;
        try { fs.writeFileSync(path.join(showDir, file), JSON.stringify(data, null, 2) + '\n'); } catch (e) {}
        // Fall through — don't skip
      }

      // Skip wrong-production reviews (e.g., off-Broadway reviews filed under Broadway show)
      if (data.wrongProduction === true) {
        stats.skippedWrongProduction = (stats.skippedWrongProduction || 0) + 1;
        return;
      }

      // Wrong-show recovery for files without documented reason
      // Files WITH wrongShowReason have evidence — keep excluded.
      // Files WITHOUT reason predate reason-recording. Recovery requires double signal:
      //   aggregator excerpt (show matched by aggregator's editorial process) +
      //   assignedScore (P0-level score from aggregator star ratings, not LLM)
      if (data.wrongShow === true) {
        if (data.wrongShowReason) {
          // Documented evidence — keep excluded
          stats.skippedWrongShow = (stats.skippedWrongShow || 0) + 1;
          return;
        }
        const hasExcerpt = !!(data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt);
        if (hasExcerpt && data.assignedScore) {
          // Double signal: aggregator matched show + aggregator-derived score
          delete data.wrongShow;
          data.wrongShowAutoRecovered = `rebuild: has aggregator excerpt + assignedScore ${data.assignedScore} (no wrongShowReason recorded)`;
          data.wrongShowAutoRecoveredAt = new Date().toISOString().split('T')[0];
          stats.wrongShowAutoRecovered = (stats.wrongShowAutoRecovered || 0) + 1;
          try { fs.writeFileSync(path.join(showDir, file), JSON.stringify(data, null, 2) + '\n'); } catch (e) {}
          // Fall through — don't skip
        } else if (hasExcerpt && !data.assignedScore) {
          // Single signal — not strong enough, log for manual review
          if (!stats.wrongShowNeedsReview) stats.wrongShowNeedsReview = [];
          stats.wrongShowNeedsReview.push({ showId, file, hasLlmScore: !!data.llmScore });
          stats.skippedWrongShow = (stats.skippedWrongShow || 0) + 1;
          return;
        } else {
          // No excerpts, no recovery signal — keep excluded
          stats.skippedWrongShow = (stats.skippedWrongShow || 0) + 1;
          return;
        }
      }

      // Skip fabricated entries (URLs fabricated by web-search LLM, confirmed dead via HTTP check)
      if (data.fabricatedEntry === true) {
        stats.skippedFabricated = (stats.skippedFabricated || 0) + 1;
        return;
      }

      // Cross-show URL dedup: if this URL also exists in another show's directory,
      // flag the copy that's farther from its show's opening year as wrongProduction.
      // Catches aggregator contamination (e.g., ShowScore listing 2013 Broadway reviews
      // on a 2026 Off-Broadway page with the same title).
      if (data.url && !data.wrongProduction) {
        const norm = data.url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();
        const entry = crossShowUrlIndex.get(norm);
        if (entry && entry.conflicts.length > 0) {
          const allCopies = [{ showId: entry.showId, showYear: entry.showYear },
            ...entry.conflicts.map(c => ({ showId: c.showId, showYear: c.showYear }))];
          const myYear = showDateMap[showId] ? showDateMap[showId].getFullYear() : null;
          let reviewYear = null;
          if (data.publishDate) {
            const m = data.publishDate.match(/\b((?:19|20)\d\d)\b/);
            if (m) reviewYear = parseInt(m[1]);
          }
          if (!reviewYear && data.url) {
            const m = data.url.match(/(?:[\/\-_.])((?:19|20)\d\d)(?:[\/\-_.]|$)/);
            if (m) reviewYear = parseInt(m[1]);
          }
          if (reviewYear && myYear) {
            const myDist = Math.abs(myYear - reviewYear);
            for (const other of allCopies) {
              if (other.showId === showId || !other.showYear) continue;
              if (Math.abs(other.showYear - reviewYear) < myDist) {
                console.log(`  [CROSS-SHOW URL] ${showId}/${file}: URL year ${reviewYear} closer to ${other.showId} (${other.showYear}) than ${showId} (${myYear})`);
                stats.skippedCrossShowUrl = (stats.skippedCrossShowUrl || 0) + 1;
                data.wrongProduction = true;
                data.wrongProductionNote = `Same URL exists in ${other.showId} which is closer to review year ${reviewYear}`;
                fs.writeFileSync(path.join(showDir, file), JSON.stringify(data, null, 2) + '\n');
                return;
              }
            }
          }
        }
      }

      // Cross-market guard: skip reviews where outlet market doesn't match show market
      // e.g., US-only outlets (Fayetteville Flyer) should not score West End shows
      const showCategory = showCategoryMap[showId] || 'broadway';
      const rawOutlet = (data.outletId || data.outlet || '').toLowerCase();
      const canonicalOutlet = normalizeOutletCanonical(rawOutlet);
      if (showCategory === 'west-end'
          && !DUAL_MARKET_OUTLETS.has(canonicalOutlet) && !DUAL_MARKET_OUTLETS.has(rawOutlet)
          && !TIER_1_2_OUTLET_IDS.has(canonicalOutlet) && !TIER_1_2_OUTLET_IDS.has(rawOutlet)) {
        // Only block Tier 3 / untiered outlets without London region
        // Tier 1/2 outlets (NYT, WashPost, AP, etc.) legitimately review WE shows
        const outletRegion = outletRegionMap[canonicalOutlet] || outletRegionMap[rawOutlet];
        if (outletRegion !== 'london') {
          stats.skippedCrossMarket = (stats.skippedCrossMarket || 0) + 1;
          if (!stats.crossMarketDetails) stats.crossMarketDetails = [];
          stats.crossMarketDetails.push({ showId, outlet: rawOutlet, file });
          return;
        }
      }

      // Reverse cross-market guard: London outlets should not score Broadway/off-Broadway
      // Unlike the forward guard, we DON'T exempt Tier 1/2 here — a London Tier 1 outlet like
      // Evening Standard never covers Broadway. Only explicitly dual-market outlets (Guardian, FT, Variety)
      // are allowed to cross markets. Tier 1/2 exemption was designed for US outlets reviewing WE.
      if ((showCategory === 'broadway' || showCategory === 'off-broadway')
          && !DUAL_MARKET_OUTLETS.has(canonicalOutlet) && !DUAL_MARKET_OUTLETS.has(rawOutlet)) {
        const outletRegion = outletRegionMap[canonicalOutlet] || outletRegionMap[rawOutlet];
        // URL-domain fallback: if outlet has no region in registry, check if the URL is a .co.uk domain
        let urlIsUK = false;
        if (!outletRegion && data.url) {
          try {
            const hostname = new URL(data.url).hostname || '';
            urlIsUK = hostname.endsWith('.co.uk') || hostname.endsWith('.org.uk');
          } catch (e) { /* ignore malformed URLs */ }
        }
        if (outletRegion === 'london' || urlIsUK) {
          stats.skippedCrossMarket = (stats.skippedCrossMarket || 0) + 1;
          if (!stats.crossMarketDetails) stats.crossMarketDetails = [];
          stats.crossMarketDetails.push({ showId, outlet: rawOutlet, file, direction: 'london→broadway', urlFallback: urlIsUK });
          return;
        }
      }

      // Skip pre-opening reviews (published before show opened — wrong production)
      // Broadway: 14-day grace period (preview coverage).
      // Off-Broadway/West End: 5-year (1825-day) grace period — they commonly transfer from
      // fringe/regional theaters, but a 13-year gap (e.g., 2013→2026) is clearly wrong.
      // Reviews with allowEarlyDate: true bypass all date checks.
      if (data.publishDate && showDateMap[showId] && !data.allowEarlyDate) {
        const pubDate = new Date(data.publishDate);
        const openDate = showDateMap[showId];
        const daysBefore = Math.ceil((openDate - pubDate) / (1000 * 60 * 60 * 24));
        const isFlexCategory = showCategory === 'off-broadway' || showCategory === 'west-end';
        const threshold = isFlexCategory ? 1825 : 14;
        if (daysBefore > threshold) {
          console.log(`  [PRE-OPENING] ${showId}/${file}: published ${daysBefore} days before opening (${data.publishDate} vs ${openDate.toISOString().split('T')[0]})`);
          stats.skippedPreOpening = (stats.skippedPreOpening || 0) + 1;
          // Also flag the source file for future reference
          if (!data.wrongProduction) {
            data.wrongProduction = true;
            data.wrongProductionNote = `Review published ${daysBefore} days before show opened — likely reviewing a different production`;
            fs.writeFileSync(path.join(showDir, file), JSON.stringify(data, null, 2) + '\n');
          }
          return;
        }
      }

      // Signal-based auto-recovery for nonReview false positives
      // Many files flagged isNonReview/nonReviewFlag/nonReviewContent are actually real reviews
      // that the LLM classifier misidentified. Use multiple independent signals to recover.
      // Flag precedence: if also wrongShow, don't recover (wrongShow is more restrictive)
      if ((data.isNonReview === true || data.nonReviewFlag === true || data.nonReviewContent === true)
          && !data.wrongShow) {
        let recoverySignals = 0;
        const signalReasons = [];

        // +3: LLM ensemble scored with high or medium confidence
        const conf = (data.llmScore?.confidence || '').toLowerCase();
        if (conf === 'high' || conf === 'medium') {
          recoverySignals += 3;
          signalReasons.push(`ensemble ${conf} confidence`);
        }

        // +2: T1/T2 outlet (major outlets rarely publish non-reviews in review slots)
        const outId = (data.outletId || data.outlet || '').toLowerCase();
        const outInfo = outletRegistry.outlets[outId];
        if (outInfo && (outInfo.tier === 1 || outInfo.tier === 2)) {
          recoverySignals += 2;
          signalReasons.push(`T${outInfo.tier} outlet`);
        }

        // +2: URL contains /review/ (strong structural signal)
        if (data.url && /\/review[s]?\//i.test(data.url)) {
          recoverySignals += 2;
          signalReasons.push('URL contains /review/');
        }

        // +2: has assignedScore or originalScore (aggregator-derived, validates review identity)
        if (data.assignedScore || data.originalScore) {
          recoverySignals += 2;
          signalReasons.push('has assignedScore');
        }

        // +1: known critic in registry
        const criticKey = (data.criticName || '').toLowerCase().replace(/\s+/g, '-');
        if (criticKey && knownCriticKeys.has(criticKey)) {
          recoverySignals += 1;
          signalReasons.push('known critic');
        }

        // -1: type that's usually genuinely not a review
        const nrType = (data.nonReviewType || '').toLowerCase();
        if (['interview', 'obituary', 'profile'].includes(nrType)) {
          recoverySignals -= 1;
          signalReasons.push(`${nrType} type penalty`);
        }

        if (recoverySignals >= 4) {
          // Recover: clear nonReview flags
          delete data.isNonReview;
          delete data.nonReviewFlag;
          delete data.nonReviewContent;
          data.nonReviewAutoRecovered = `rebuild: signal score ${recoverySignals} (${signalReasons.join(', ')})`;
          data.nonReviewAutoRecoveredAt = new Date().toISOString().split('T')[0];
          stats.nonReviewAutoRecovered = (stats.nonReviewAutoRecovered || 0) + 1;
          try { fs.writeFileSync(path.join(showDir, file), JSON.stringify(data, null, 2) + '\n'); } catch (e) {}
          // Fall through — don't skip
        } else {
          stats.skippedNonReview = (stats.skippedNonReview || 0) + 1;
          return;
        }
      } else if (data.isNonReview === true || data.nonReviewFlag === true || data.nonReviewContent === true) {
        // Has wrongShow — skip without recovery attempt (flag precedence)
        stats.skippedNonReview = (stats.skippedNonReview || 0) + 1;
        return;
      }

      // Skip syndicated duplicates (same critic, different outlet, same review text)
      // Flagged by scripts/detect-syndicated-duplicates.js
      if (data.isSyndicatedDuplicate === true) {
        stats.skippedSyndicated = (stats.skippedSyndicated || 0) + 1;
        return;
      }

      // Skip cross-outlet duplicates (different critic, same text across outlets)
      // Flagged by scripts/detect-cross-outlet-duplicates.js
      if (data.crossOutletDuplicate === true) {
        stats.skippedCrossOutletDupe = (stats.skippedCrossOutletDupe || 0) + 1;
        return;
      }

      // Garbage review guard: skip reviews where critic name matches a creative team member
      // of the SAME show (indicates scraped cast/crew info, not a real review)
      const criticLower = (data.criticName || '').toLowerCase().trim();
      if (criticLower && showCreativeTeamIndex[showId]?.has(criticLower)) {
        console.log(`  [CREATIVE-AS-CRITIC] ${showId}/${file}: critic "${data.criticName}" is a creative team member`);
        stats.skippedGarbage = (stats.skippedGarbage || 0) + 1;
        return;
      }

      // Garbage outlet guard: skip reviews with sentence-fragment outlet names
      const outlet = (data.outlet || '').trim();
      if (
        outlet.length > 50 ||
        /^(is |has |the show |a |an |in her |in his |but |with |and |does |proves |keeps |left |enjoying |are )/i.test(outlet) ||
        (/^[a-z]+-[a-z]+-[a-z]+-[a-z]+-[a-z]+/.test(data.outletId || '') && !data.url)
      ) {
        console.log(`  [GARBAGE-OUTLET] ${showId}/${file}: outlet "${outlet.substring(0, 60)}" is suspicious`);
        stats.skippedGarbage = (stats.skippedGarbage || 0) + 1;
        return;
      }

      // Blocklisted outlet IDs: scraping artifacts that are never valid outlets
      const BLOCKED_OUTLET_IDS = new Set(['advertisement', 'sponsored', 'promoted', 'ad', 'promo']);
      const rawOutletId = (data.outletId || '').toLowerCase();
      if (BLOCKED_OUTLET_IDS.has(rawOutletId)) {
        console.log(`  [BLOCKED-OUTLET] ${showId}/${file}: outletId "${rawOutletId}" is a scraping artifact`);
        stats.skippedGarbage = (stats.skippedGarbage || 0) + 1;
        return;
      }

      // Date-based wrong-production guard: skip reviews published >30 days before previews/opening
      // Broadway reviews are embargoed until opening night; anything earlier is likely wrong-production
      // Reviews with allowEarlyDate: true bypass this (e.g., out-of-town tryouts, transfers)
      // WE shows are exempt: many are long-running transfers with reviews from the original run
      if (data.publishDate && showDateMap[showId] && !data.allowEarlyDate && showCategory !== 'west-end') {
        const pubDate = new Date(data.publishDate);
        if (!isNaN(pubDate.getTime())) {
          const showDate = showDateMap[showId];
          const daysBefore = (showDate - pubDate) / (1000 * 60 * 60 * 24);
          if (daysBefore > 30) {
            console.log(`  [DATE GUARD] ${showId}/${file}: published ${data.publishDate}, show opens ${showDateMap[showId].toISOString().split('T')[0]} (${Math.round(daysBefore)}d before)`);
            if (!stats.suspectedWrongProduction) stats.suspectedWrongProduction = [];
            stats.suspectedWrongProduction.push({
              showId, file, outlet: data.outletId || data.outlet,
              critic: data.criticName, publishDate: data.publishDate,
              daysBefore: Math.round(daysBefore), score: data.assignedScore
            });
            stats.skippedDateMismatch = (stats.skippedDateMismatch || 0) + 1;
            return;
          }
        }
      }

      // Post-closing date guard: skip reviews published >6 months after show closed
      // These are likely from revivals, off-Broadway productions, or tours
      // Reviews with allowLateDate: true bypass this (e.g., retrospective pieces)
      // Uses URL-extracted dates (reliable) + publishDate only when it's a proper ISO/dated format
      // Skips unreliable bulk-import dates like "April 22, 2014" that don't correlate with actual review dates
      if (showClosingDateMap[showId] && !data.allowLateDate) {
        let effectiveDate = null;
        let dateSource = null;
        // Prefer URL date (most reliable — can't be a metadata artifact)
        if (data.url) {
          const m = data.url.match(/\/(\d{4})[/-](\d{2})[/-](\d{2})/);
          if (m) {
            const ud = new Date(`${m[1]}-${m[2]}-${m[3]}`);
            if (!isNaN(ud.getTime())) { effectiveDate = ud; dateSource = 'url'; }
          }
        }
        // Fall back to publishDate only if it looks like a real date (ISO format with time, or matches URL)
        if (!effectiveDate && data.publishDate) {
          const pd = new Date(data.publishDate);
          if (!isNaN(pd.getTime())) {
            // Only trust publishDate if it contains a timestamp (T or time component) — bulk imports are plain dates
            const hasTimestamp = /T\d|:\d/.test(data.publishDate);
            if (hasTimestamp) { effectiveDate = pd; dateSource = 'publishDate'; }
          }
        }
        if (effectiveDate) {
          const closingDate = showClosingDateMap[showId];
          const monthsAfter = (effectiveDate - closingDate) / (1000 * 60 * 60 * 24 * 30);
          if (monthsAfter > 6) {
            console.log(`  [LATE DATE GUARD] ${showId}/${file}: ${dateSource}=${effectiveDate.toISOString().split('T')[0]}, show closed ${closingDate.toISOString().split('T')[0]} (${Math.round(monthsAfter)} months after)`);
            if (!stats.suspectedLateReviews) stats.suspectedLateReviews = [];
            stats.suspectedLateReviews.push({
              showId, file, outlet: data.outletId || data.outlet,
              critic: data.criticName, effectiveDate: effectiveDate.toISOString().split('T')[0],
              closingDate: closingDate.toISOString().split('T')[0],
              monthsAfter: Math.round(monthsAfter), score: data.assignedScore,
              dateSource,
            });
            stats.skippedLateDateMismatch = (stats.skippedLateDateMismatch || 0) + 1;
            return;
          }
        }
      }

      // URL-year cross-production guard for multi-production shows
      // If a review's URL or publish date contains a year clearly closer to a sibling production,
      // skip it (likely filed in the wrong directory by aggregator scrapers)
      if (multiProdYearGuard[showId]) {
        const guard = multiProdYearGuard[showId];
        let detectedYear = null;
        let yearSource = null;
        // Check publish date first (more reliable)
        if (data.publishDate) {
          const m = data.publishDate.match(/(20\d\d|19\d\d)/);
          if (m) { detectedYear = parseInt(m[0]); yearSource = 'publishDate'; }
        }
        // Fall back to URL year
        if (!detectedYear && data.url) {
          const m = data.url.match(/\/(20\d\d|19\d\d)\//);
          if (m) { detectedYear = parseInt(m[1]); yearSource = 'urlYear'; }
        }
        if (detectedYear) {
          const distToThis = Math.abs(detectedYear - guard.showYear);
          if (distToThis > 1) {
            for (const sib of guard.siblings) {
              const distToSib = Math.abs(detectedYear - sib.year);
              if (distToSib < distToThis) {
                console.log(`  [URL-YEAR GUARD] ${showId}/${file}: ${yearSource}=${detectedYear}, show=${guard.showYear}, closer to ${sib.id} (${sib.year})`);
                stats.skippedUrlYearMismatch = (stats.skippedUrlYearMismatch || 0) + 1;
                return;
              }
            }
          }
        }
      }

      // Standalone URL-year guard for dateless reviews (systematic cross-production prevention)
      // Aggregator sources (serp-discovery, bww-roundup, dtli, playbill-verdict) match by title only.
      // When they scrape reviews for "Heathers" or "The Other Place", they may pull reviews from
      // prior productions (2014, 2013, etc.) and file them under the new show directory.
      // These reviews typically have NO publishDate. The URL often contains the actual review year.
      // If URL year is >2 years from show opening, flag as wrongProduction.
      // This guard is independent of multiProdYearGuard (doesn't require sibling productions in DB).
      // WE/OB exempt: they commonly transfer from fringe/regional, so URL years mismatch legitimately
      if (!data.publishDate && data.url && showDateMap[showId] && !data.wrongProduction
          && showCat !== 'west-end' && showCat !== 'off-broadway') {
        const showYear = showDateMap[showId].getFullYear();
        // Extract years from URL bounded by path separators, hyphens, underscores, dots, or string end
        const yearMatches = data.url.match(/(?:[\/\-_.])((?:19|20)\d\d)(?:[\/\-_.]|$)/g);
        if (yearMatches) {
          const urlYears = yearMatches
            .map(m => parseInt(m.match(/\d{4}/)[0]))
            .filter(y => y >= 1950 && y <= 2030);
          if (urlYears.length > 0) {
            const closestYear = urlYears.reduce((best, y) =>
              Math.abs(y - showYear) < Math.abs(best - showYear) ? y : best);
            if (Math.abs(closestYear - showYear) > 2) {
              console.log(`  [URL-YEAR STANDALONE] ${showId}/${file}: URL year ${closestYear}, show year ${showYear} — likely wrong production`);
              stats.skippedUrlYearStandalone = (stats.skippedUrlYearStandalone || 0) + 1;
              data.wrongProduction = true;
              data.wrongProductionNote = `URL contains year ${closestYear} but show opens in ${showYear} — likely review of different production`;
              fs.writeFileSync(path.join(showDir, file), JSON.stringify(data, null, 2) + '\n');
              return;
            }
          }
        }
      }

      // Director cross-check for multi-production shows
      // If a review in an OLDER production's directory mentions a NEWER production's director,
      // it's almost certainly filed under the wrong show (validated pattern, zero false positives)
      if (multiProdDirectorGuard[showId]) {
        const text = (data.fullText || data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || '').toLowerCase();
        if (text.length >= 30) {
          for (const [dirName, newerId] of multiProdDirectorGuard[showId]) {
            if (text.includes(dirName)) {
              console.log(`  [DIRECTOR GUARD] ${showId}/${file}: mentions director "${dirName}" from newer production ${newerId}`);
              stats.skippedDirectorMismatch = (stats.skippedDirectorMismatch || 0) + 1;
              return;
            }
          }
        }
      }

      // Skip misattributed reviews (LLM-hallucinated critic/outlet combos)
      if (data.wrongAttribution === true) {
        stats.skippedWrongAttribution = (stats.skippedWrongAttribution || 0) + 1;
        return;
      }

      // Skip reviews with explicit rejection reason (garbage text, OCR junk, etc.)
      // Auto-clear stale not_a_review/garbage_text rejections when fullText is present and passes quality gate
      if (data.rejectionReason) {
        const clearableRejections = ['not_a_review', 'garbage_text'];
        if (clearableRejections.includes(data.rejectionReason) && data.fullText && data.fullText.length > 300) {
          // Re-validate content quality — length alone doesn't prove it's not boilerplate
          const recomputedTierResult = classifyContentTier(data);
          const recomputedTier = recomputedTierResult.contentTier || recomputedTierResult;
          if (recomputedTier === 'complete' || recomputedTier === 'truncated' || recomputedTier === 'excerpt') {
            const savedReason = data.rejectionReason;
            delete data.rejectionReason;
            delete data.rejectedAt;
            delete data.rejectedBy;
            delete data.rejectionReasoning;
            delete data.promptVersion;
            // Clear stale contentTier set by the rejection
            if ((savedReason === 'not_a_review' && data.contentTier === 'invalid') ||
                (savedReason === 'garbage_text' && data.contentTier === 'needs-rescrape')) {
              data.contentTier = recomputedTier;
            }
            data.rejectionAutoCleared = `rebuild: had ${recomputedTier} fullText (${data.fullText.length} chars) with stale ${savedReason} rejection`;
            data.rejectionAutoClearedAt = new Date().toISOString().split('T')[0];
            stats.rejectionAutoCleared = (stats.rejectionAutoCleared || 0) + 1;
            try { fs.writeFileSync(path.join(showDir, file), JSON.stringify(data, null, 2) + '\n'); } catch (e) {}
            // Fall through — don't skip, let scoring pick up the file
          } else {
            stats.skippedRejectionReason = (stats.skippedRejectionReason || 0) + 1;
            return;
          }
        } else {
          stats.skippedRejectionReason = (stats.skippedRejectionReason || 0) + 1;
          return;
        }
      }

      // Skip roundup articles (multi-show reviews that aren't about this specific show)
      if (data.isRoundupArticle === true) {
        stats.skippedRoundup = (stats.skippedRoundup || 0) + 1;
        return;
      }

      // Skip reviews rejected by LLM ensemble Step 0 (wrong_show, wrong_production, not_a_review, garbage)
      if (data.rejectedBy && Array.isArray(data.rejectedBy) && data.rejectedBy.length >= 2) {
        stats.skippedLlmRejected = (stats.skippedLlmRejected || 0) + 1;
        return;
      }

      // Skip reviews where LLM reasoning indicates wrong content (error pages, press releases, etc.)
      const reasoning = data.llmScore?.reasoning || '';
      if (reasoning && /\b(error page|error message|website error|search result|not a review|press release|announcement rather than|reality TV|Bachelor in Paradise)\b/i.test(reasoning)) {
        stats.skippedWrongContent = (stats.skippedWrongContent || 0) + 1;
        return;
      }

      // Skip reviews where show title was never mentioned AND there are no aggregator excerpts
      // Reviews with valid excerpts from DTLI/BWW/ShowScore are likely legitimate even without title match
      if (data.showNotMentioned === true) {
        // Safety net: if fullText exists and mentions the show, clear the stale flag
        // This catches cases where collect-review-texts.js fetched good content but didn't clear the flag
        if (data.fullText && data.fullText.length > 300) {
          const showTitle = (data.showId || '').replace(/-\d{4}$/, '').replace(/-/g, ' ').toLowerCase();
          const shortTitle = showTitle.replace(/^the /, '').replace(/ musical$/, '');
          const textLower = data.fullText.substring(0, 5000).toLowerCase();
          if (textLower.includes(showTitle) || (shortTitle.length >= 5 && textLower.includes(shortTitle))) {
            data.showNotMentioned = false;
            delete data._showNotMentionedDiscoveryAttempted;
            stats.showNotMentionedAutoCleared = (stats.showNotMentionedAutoCleared || 0) + 1;
            // Write fix back to source file
            try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n'); } catch (e) {}
          }
        }

        if (data.showNotMentioned === true) {
          const hasExcerpt = data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt;
          if (!hasExcerpt) {
            stats.skippedShowNotMentioned = (stats.skippedShowNotMentioned || 0) + 1;
            return;
          }
          stats.showNotMentionedWithExcerpts = (stats.showNotMentionedWithExcerpts || 0) + 1;
        }
      }

      // Cross-show duplicate text detection: skip if this fullText was already seen under a different show
      // Uses SHA-256 hash of full cleaned text to avoid false positives from shared boilerplate prefixes
      if (data.fullText && data.fullText.length > 200) {
        const cleanedForFp = (cleanText(data.fullText) || '').toLowerCase().replace(/\s+/g, '');
        if (cleanedForFp.length > 200) {
          const fp = crypto.createHash('sha256').update(cleanedForFp).digest('hex').substring(0, 16);
          const existing = crossShowFingerprints.get(fp);
          if (existing && existing.showId !== showId) {
            stats.skippedCrossShowDupe = (stats.skippedCrossShowDupe || 0) + 1;
            if (!stats.crossShowDupeDetails) stats.crossShowDupeDetails = [];
            stats.crossShowDupeDetails.push(`${showId}/${file} duplicates ${existing.showId}/${existing.file}`);
            return;
          }
          if (!existing) {
            crossShowFingerprints.set(fp, { showId, file });
          }
        }
      }

      // Create deduplication key — use canonical normalization to catch merged outlets
      const outletKey = normalizeOutletCanonical(data.outletId || data.outlet);
      const criticKey = normalizeCriticCanonical(data.criticName || 'unknown');
      const dedupKey = `${outletKey}|${criticKey}`;

      // Skip exact duplicates (keep first occurrence)
      if (seenKeys.has(dedupKey)) {
        stats.skippedDuplicate++;
        return;
      }

      // Unknown-critic dedup: if incoming critic is "unknown"/"unnamed" and a named critic
      // already exists at this outlet, skip the unknown entry. This prevents BWW roundup entries
      // (which have null critic → "unknown") from coexisting with named critic entries at the
      // same outlet, which would give that outlet double weight in composite scores.
      // Files are sorted so named critics come before "unknown" — named critic wins.
      if (/^(unknown|unnamed)$/.test(criticKey)) {
        let namedCriticExists = false;
        for (const existingKey of seenKeys) {
          const [existingOutlet, existingCritic] = existingKey.split('|');
          if (existingOutlet === outletKey && !/^(unknown|unnamed)$/.test(existingCritic)) {
            namedCriticExists = true;
            break;
          }
        }
        if (namedCriticExists) {
          stats.skippedUnknownCriticDedup = (stats.skippedUnknownCriticDedup || 0) + 1;
          return;
        }
      }

      // First-name prefix dedup: "jesse" at "nytimes" matches "jessegreen" at "nytimes"
      // This catches files like nytimes--jesse.json vs nytimes--jesse-green.json
      let prefixDuplicate = false;
      for (const existingKey of seenKeys) {
        const [existingOutlet, existingCritic] = existingKey.split('|');
        if (existingOutlet !== outletKey) continue;
        if (criticKey.length >= 3 && existingCritic.startsWith(criticKey)) {
          // Incoming is shorter name (e.g., "jesse"), existing is full name — skip incoming
          prefixDuplicate = true;
          break;
        }
        if (existingCritic.length >= 3 && criticKey.startsWith(existingCritic)) {
          // Incoming is full name (e.g., "jessegreen"), existing is shorter — keep incoming, but don't remove existing
          // The existing shorter-name entry is already in the output; this is a rare edge case.
          // For now, skip the incoming to avoid duplicates. The file-level dedup in gather-reviews.js
          // is the primary defense; this is a safety net.
          prefixDuplicate = true;
          break;
        }
      }
      if (prefixDuplicate) {
        stats.skippedDuplicate++;
        return;
      }

      seenKeys.add(dedupKey);

      // URL dedup: same URL at same outlet under different critic names
      if (data.url) {
        // Normalize URL: lowercase hostname, strip trailing slash and fragment
        // Preserve query params (some outlets use them as article IDs)
        let normalizedUrl;
        try {
          const parsed = new URL(data.url);
          parsed.hash = '';
          normalizedUrl = parsed.toString().replace(/\/$/, '');
        } catch {
          normalizedUrl = data.url.toLowerCase().replace(/#.*$/, '').replace(/\/$/, '');
        }
        // Use canonical outletId for URL dedup
        const urlOutletKey = normalizeOutletCanonical(data.outletId || data.outlet);
        const urlDedupKey = `${urlOutletKey}|${normalizedUrl}`;
        if (seenUrlsByOutlet.has(urlDedupKey)) {
          // Files are sorted so real critic names come before "unknown" — first wins
          stats.skippedDuplicateUrl = (stats.skippedDuplicateUrl || 0) + 1;
          return;
        }
        seenUrlsByOutlet.set(urlDedupKey, file);

        // Cross-outlet URL dedup: same URL filed under different outlets (e.g., unknown + nytimes)
        // Files are sorted so real outlet names come before "unknown" — first wins
        if (seenUrlsGlobal.has(normalizedUrl)) {
          stats.skippedCrossOutletDuplicateUrl = (stats.skippedCrossOutletDuplicateUrl || 0) + 1;
          return;
        }
        seenUrlsGlobal.set(normalizedUrl, file);
      }

      // Content fingerprint dedup: same review text at same outlet under different critic names
      // Belt-and-suspenders: catches duplicates even if duplicateTextOf flag was never set
      if (data.fullText && data.fullText.length >= 100) {
        const fingerprint = computeContentFingerprint(data.fullText);
        if (fingerprint) {
          const outletKey2 = normalizeOutletCanonical(data.outletId || data.outlet);
          const fpKey = `${outletKey2}|${fingerprint}`;
          if (seenFingerprintsByOutlet.has(fpKey)) {
            console.log(`  [FINGERPRINT DEDUP] ${showId}/${file}: same text as ${seenFingerprintsByOutlet.get(fpKey)} at ${outletKey2}`);
            stats.skippedFingerprintDedup = (stats.skippedFingerprintDedup || 0) + 1;
            return;
          }
          seenFingerprintsByOutlet.set(fpKey, file);
        }
      }

      // CONTAMINATION SAFETY NET: Check fullText for tour/film signals on reviews
      // that haven't been through the LLM ensemble's Step 0 rejection check.
      // Only checks reviews with text fetched after our 2026-02-13 corpus audit
      // to avoid flooding the queue with legitimate reviews that mention tours/films.
      // The LLM ensemble already catches these for reviews it scores (v5.2+ Step 0).
      // This catches reviews that bypass the LLM (excerpt-only, pre-v5.2, unscored).
      const CONTAMINATION_AUDIT_CUTOFF = process.env.CONTAMINATION_AUDIT_CUTOFF || '2026-02-13T00:00:00Z';
      if (data.fullText && data.textFetchedAt && data.textFetchedAt > CONTAMINATION_AUDIT_CUTOFF && !data.rejectedBy) {
        const introText = data.fullText.slice(0, 600);

        // Tour detection (skip tour-stop shows where touring is expected)
        if (showStatusMap[showId] !== 'tour-stop') {
          const tourCheck = isTourReviewExcerpt(introText);
          if (tourCheck.isTourReview) {
            flagForHumanReview(data, 'possible-tour-fulltext',
              `Tour signal in fullText intro: ${tourCheck.signal}`);
          }
        }

        // Film/TV detection (2+ film/streaming keywords, 0 theater keywords)
        const filmCheck = isFilmTvReview(introText);
        if (filmCheck.isFilmTv) {
          flagForHumanReview(data, 'possible-film-tv-fulltext',
            `Film/TV signals in fullText intro: ${filmCheck.signals.join(', ')}`);
        }
      }

      // EXCERPT CROSS-VALIDATION: If fullText is COMPLETE and long, check that
      // aggregator excerpts share distinctive words with this review. Mismatched
      // excerpts (from wrong critic) happen when aggregators show one excerpt per
      // outlet but we have multiple critics at the same outlet (e.g., 2 NYT reviews).
      // REPORT ONLY — too many false positives from truncated fullTexts to auto-null.
      if (data.fullText && data.fullText.length >= 800 &&
          data.contentTier === 'complete' && data.textStatus === 'complete') {
        const ftWords = new Set(data.fullText.toLowerCase().match(/\b[a-z]{5,}\b/g) || []);
        const excerptFields = ['dtliExcerpt', 'showScoreExcerpt'];
        for (const field of excerptFields) {
          if (data[field] && data[field].length >= 50) {
            const exWords = (data[field].toLowerCase().match(/\b[a-z]{5,}\b/g) || []);
            if (exWords.length < 5) continue;
            const matchCount = exWords.filter(w => ftWords.has(w)).length;
            const matchRate = matchCount / exWords.length;
            // If <20% of distinctive excerpt words appear in fullText,
            // the excerpt is likely from a different critic's review
            if (matchRate < 0.20) {
              stats.excerptMismatches = (stats.excerptMismatches || 0) + 1;
              if (!stats.excerptMismatchDetails) stats.excerptMismatchDetails = [];
              stats.excerptMismatchDetails.push({
                path: `${showId}/${file}`,
                field,
                matchRate: Math.round(matchRate * 100) + '%',
                excerptSnippet: data[field].substring(0, 80)
              });
            }
          }
        }
      }

      // CHECK: Flag reviews that SHOULD have LLM scores but don't
      // These have scorable text but were never run through LLM scoring
      const scorableText = data.fullText || data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt || '';
      const hasScorableText = scorableText.length >= 100;
      const hasLlmScore = data.llmScore && data.llmScore.score;

      if (hasScorableText && !hasLlmScore) {
        stats.unscoredWithText.push({
          path: showId + '/' + file,
          textLength: scorableText.length,
          hasThumb: !!(data.dtliThumb || data.bwwThumb)
        });
      }

      // Inject show category for market-aware scoring decisions
      data._showCategory = showCategoryMap[showId] || 'broadway';

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

      let { score, source } = scoreResult;

      // DEFENSE-IN-DEPTH: reject scores outside 0-100
      // Catches parsing bugs (e.g., 600/900 scores from unclamped star ratings)
      if (!Number.isFinite(score) || score < 0 || score > 100) {
        console.error(`  [SCORE OUT OF RANGE] ${showId}/${file}: score=${score} source=${source} — SKIPPING`);
        stats.outOfRangeScores = (stats.outOfRangeScores || 0) + 1;
        stats.skippedNoScore++;
        return;
      }

      stats.scoreSources[source]++;

      // Warn if file's showId disagrees with directory (data integrity issue)
      if (data.showId && data.showId !== showId) {
        console.log(`  [SHOW-ID MISMATCH] ${showId}/${file}: file claims showId=${data.showId} — using directory showId`);
        stats.showIdMismatches = (stats.showIdMismatches || 0) + 1;
      }

      // Build review object — normalize outletId to canonical form
      // ALWAYS use directory showId — file's showId field is unreliable (can be stale from cross-production flagging)
      const canonicalOutletId = normalizeOutletCanonical(data.outletId || data.outlet);
      const review = {
        showId,
        outletId: canonicalOutletId,
        outlet: getOutletDisplayName(canonicalOutletId) || data.outlet || data.outletId || 'Unknown',
        assignedScore: score,
        scoreSource: source,
        bucket: scoreToBucket(score),
        thumb: scoreToThumb(score),
        criticName: data.criticName || null,
        url: data.url || null,
        publishDate: normalizePublishDate(data.publishDate),
        originalRating: data.originalScore || null,
        pullQuote: (() => {
          data._showStatus = showStatusMap[showId];
          const raw = selectBestExcerpt(data, showTitleMap[showId]);
          if (raw && isJunkExcerpt(raw)) return null;
          return normalizeQuoteWrapping(raw);
        })(),
        dtliThumb: data.dtliThumb || null,
        bwwThumb: data.bwwThumb || null,
        contentTier: data.contentTier || 'none',
        // Ensemble scoring metadata (for confidence analysis + auditing)
        ...(data.ensembleData ? {
          scoreDelta: data.ensembleData.scoreDelta || 0,
          modelAgreement: data.ensembleData.modelAgreement || null,
          needsReview: data.ensembleData.needsReview || false,
        } : {}),
        ...(data.llmScore ? {
          scoreConfidence: data.llmScore.confidence || null,
        } : {})
      };

      // Sanitize display fields: decode HTML entities in critic name, outlet, pullQuote
      if (review.criticName) review.criticName = decodeHtmlEntities(review.criticName);
      if (review.outlet) review.outlet = decodeHtmlEntities(review.outlet);
      if (review.pullQuote) review.pullQuote = decodeHtmlEntities(review.pullQuote);

      // Add designation if present, or auto-detect from text/archive
      if (data.designation) {
        review.designation = data.designation;
      } else if (review.outletId === 'nytimes' || (data.outletId || '').startsWith('nytimes')) {
        // Auto-detect NYT Critics' Pick from review text or archived HTML
        const text = data.fullText || data.bwwExcerpt || data.dtliExcerpt || data.showScoreExcerpt || '';
        const textHasPick = /CRITIC['\u2019]?S PICK/i.test(text);
        let archiveHasPick = false;
        if (!textHasPick && data.archivePath) {
          try {
            const archiveHtml = fs.readFileSync(path.join(__dirname, '..', data.archivePath), 'utf8');
            archiveHasPick = /critic[''\u2019]?s[''\u2019]?\s*pick/i.test(archiveHtml) || /criticsPick/i.test(archiveHtml);
          } catch (e) { /* archive not available */ }
        }
        if (textHasPick || archiveHasPick) {
          review.designation = 'Critics_Pick';
          // Persist back to source file so it's not re-detected every rebuild
          data.designation = 'Critics_Pick';
          try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); } catch (e) { /* read-only in CI */ }
        }
      }

      allReviews.push(review);
      stats.byShow[showId].reviews++;
      stats.totalReviews++;

    } catch (e) {
      if (e instanceof SyntaxError) {
        console.error(`  [CORRUPTED] ${showId}/${file}: invalid JSON — ${e.message}`);
        stats.skippedCorrupted = (stats.skippedCorrupted || 0) + 1;
        if (!stats.corruptedFiles) stats.corruptedFiles = [];
        stats.corruptedFiles.push(`${showId}/${file}`);
      } else {
        console.error(`  Error processing ${file}: ${e.message}`);
      }
    }
  });
});

// Sort reviews by showId, then outlet
allReviews.sort((a, b) => {
  if (a.showId !== b.showId) return a.showId.localeCompare(b.showId);
  return (a.outlet || '').localeCompare(b.outlet || '');
});

// ========================================
// 3B: SCORE-DRIFT GUARD
// ========================================
// Compare new scores against current reviews.json to detect silent cascading changes.
const DRIFT_THRESHOLD = 20; // Max reviews that can shift >10 points before warning
const DRIFT_POINT_THRESHOLD = 10; // Score difference to count as "drift"

let driftReport = null;
if (fs.existsSync(reviewsJsonPath)) {
  try {
    const currentData = JSON.parse(fs.readFileSync(reviewsJsonPath, 'utf8'));
    const currentReviews = currentData.reviews || [];

    // Build lookup: showId+outlet+critic → score
    const currentScoreMap = new Map();
    for (const r of currentReviews) {
      const key = `${r.showId}|${(r.outlet || '').toLowerCase()}|${(r.criticName || '').toLowerCase()}`;
      currentScoreMap.set(key, r.assignedScore);
    }

    // Find drifted reviews
    const driftedReviews = [];
    for (const r of allReviews) {
      const key = `${r.showId}|${(r.outlet || '').toLowerCase()}|${(r.criticName || '').toLowerCase()}`;
      const oldScore = currentScoreMap.get(key);
      if (oldScore !== undefined) {
        const delta = Math.abs(r.assignedScore - oldScore);
        if (delta > DRIFT_POINT_THRESHOLD) {
          driftedReviews.push({
            showId: r.showId,
            outlet: r.outlet,
            critic: r.criticName,
            oldScore,
            newScore: r.assignedScore,
            delta
          });
        }
      }
    }

    if (driftedReviews.length > 0) {
      driftReport = {
        timestamp: new Date().toISOString(),
        totalDrifted: driftedReviews.length,
        threshold: DRIFT_THRESHOLD,
        reviews: driftedReviews.sort((a, b) => b.delta - a.delta)
      };

      // Write drift report
      const auditDir = path.join(__dirname, '../data/audit');
      if (!fs.existsSync(auditDir)) {
        fs.mkdirSync(auditDir, { recursive: true });
      }
      fs.writeFileSync(
        path.join(auditDir, 'rebuild-score-drift.json'),
        JSON.stringify(driftReport, null, 2) + '\n'
      );

      console.log(`\n⚠️  SCORE DRIFT: ${driftedReviews.length} reviews shifted by >${DRIFT_POINT_THRESHOLD} points`);
      driftedReviews.slice(0, 10).forEach(d => {
        console.log(`  ${d.showId}: ${d.outlet} (${d.critic}) ${d.oldScore}→${d.newScore} (Δ${d.delta})`);
      });
      if (driftedReviews.length > 10) {
        console.log(`  ...and ${driftedReviews.length - 10} more`);
      }

      // In CI: fail if drift exceeds threshold (unless ALLOW_DRIFT=true)
      if (driftedReviews.length > DRIFT_THRESHOLD && process.env.CI && !process.env.ALLOW_DRIFT) {
        console.error(`\n❌ DRIFT GUARD: ${driftedReviews.length} reviews drifted (threshold: ${DRIFT_THRESHOLD})`);
        console.error('Set ALLOW_DRIFT=true to override, or review data/audit/rebuild-score-drift.json');
        process.exit(1);
      }
    }

    // ========================================
    // 3B-ii: PER-SHOW REVIEW COUNT REGRESSION GATE
    // ========================================
    // If any show loses >2 scored reviews in a rebuild, something is wrong.
    // In CI: abort to prevent data corruption from reaching production.
    const REGRESSION_DROP_THRESHOLD = 2; // max reviews a single show can lose
    const REGRESSION_MAX_SHOWS = 5;      // max shows that can regress before hard abort

    const oldCountByShow = new Map();
    for (const r of currentReviews) {
      oldCountByShow.set(r.showId, (oldCountByShow.get(r.showId) || 0) + 1);
    }
    const newCountByShow = new Map();
    for (const r of allReviews) {
      newCountByShow.set(r.showId, (newCountByShow.get(r.showId) || 0) + 1);
    }

    const regressions = [];
    for (const [showId, oldCount] of oldCountByShow) {
      const newCount = newCountByShow.get(showId) || 0;
      const dropped = oldCount - newCount;
      if (dropped > REGRESSION_DROP_THRESHOLD) {
        regressions.push({ showId, oldCount, newCount, dropped });
      }
    }

    if (regressions.length > 0) {
      regressions.sort((a, b) => b.dropped - a.dropped);

      const auditDir = path.join(__dirname, '../data/audit');
      if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
      fs.writeFileSync(
        path.join(auditDir, 'rebuild-regression.json'),
        JSON.stringify({ timestamp: new Date().toISOString(), regressions }, null, 2) + '\n'
      );

      console.log(`\n⚠️  REVIEW COUNT REGRESSION: ${regressions.length} show(s) lost >${REGRESSION_DROP_THRESHOLD} reviews`);
      regressions.slice(0, 10).forEach(r => {
        console.log(`  ${r.showId}: ${r.oldCount}→${r.newCount} (lost ${r.dropped})`);
      });
      if (regressions.length > 10) {
        console.log(`  ...and ${regressions.length - 10} more`);
      }

      if (regressions.length >= REGRESSION_MAX_SHOWS && process.env.CI && !process.env.ALLOW_REGRESSION) {
        console.error(`\n❌ REGRESSION GUARD: ${regressions.length} shows lost reviews (threshold: ${REGRESSION_MAX_SHOWS} shows)`);
        console.error('This likely indicates data corruption. Review data/audit/rebuild-regression.json');
        console.error('Set ALLOW_REGRESSION=true to override.');
        process.exit(1);
      }
    }
    // ========================================
    // 3B-iii: PER-SHOW AGGREGATE SCORE DRIFT GUARD
    // ========================================
    // Detects when a show's average review score shifts >5 points without new reviews.
    // Catches tier weight changes, outlet remapping, duplicate detection shifts, and
    // parsing bugs that affect composites but not individual review scores.
    const SHOW_DRIFT_THRESHOLD = 5;     // points of mean score shift to flag
    const SHOW_DRIFT_MAX_FLAGGED = 10;  // abort CI if this many shows drift

    // Compute per-show mean score for old and new
    const oldScoresByShow = new Map(); // showId → [scores]
    for (const r of currentReviews) {
      if (r.assignedScore == null) continue;
      if (!oldScoresByShow.has(r.showId)) oldScoresByShow.set(r.showId, []);
      oldScoresByShow.get(r.showId).push(r.assignedScore);
    }
    const newScoresByShow = new Map();
    for (const r of allReviews) {
      if (r.assignedScore == null) continue;
      if (!newScoresByShow.has(r.showId)) newScoresByShow.set(r.showId, []);
      newScoresByShow.get(r.showId).push(r.assignedScore);
    }

    const showDrifts = [];
    for (const [showId, oldScores] of oldScoresByShow) {
      const newScores = newScoresByShow.get(showId);
      if (!newScores || newScores.length === 0) continue;

      // Only flag shows where review count stayed the same or decreased
      // (new reviews naturally shift averages — that's expected)
      if (newScores.length > oldScores.length) continue;

      const oldMean = oldScores.reduce((a, b) => a + b, 0) / oldScores.length;
      const newMean = newScores.reduce((a, b) => a + b, 0) / newScores.length;
      const delta = Math.abs(newMean - oldMean);

      if (delta > SHOW_DRIFT_THRESHOLD) {
        showDrifts.push({
          showId,
          oldMean: Math.round(oldMean * 10) / 10,
          newMean: Math.round(newMean * 10) / 10,
          delta: Math.round(delta * 10) / 10,
          oldCount: oldScores.length,
          newCount: newScores.length
        });
      }
    }

    if (showDrifts.length > 0) {
      showDrifts.sort((a, b) => b.delta - a.delta);

      const auditDir = path.join(__dirname, '../data/audit');
      if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
      fs.writeFileSync(
        path.join(auditDir, 'rebuild-show-drift.json'),
        JSON.stringify({ timestamp: new Date().toISOString(), threshold: SHOW_DRIFT_THRESHOLD, shows: showDrifts }, null, 2) + '\n'
      );

      console.log(`\n⚠️  SHOW SCORE DRIFT: ${showDrifts.length} show(s) shifted >${SHOW_DRIFT_THRESHOLD}pts without new reviews`);
      showDrifts.slice(0, 10).forEach(d => {
        console.log(`  ${d.showId}: ${d.oldMean}→${d.newMean} (Δ${d.delta}, ${d.oldCount}→${d.newCount} reviews)`);
      });
      if (showDrifts.length > 10) {
        console.log(`  ...and ${showDrifts.length - 10} more`);
      }

      if (showDrifts.length >= SHOW_DRIFT_MAX_FLAGGED && process.env.CI && !process.env.ALLOW_DRIFT) {
        console.error(`\n❌ SHOW DRIFT GUARD: ${showDrifts.length} shows drifted (threshold: ${SHOW_DRIFT_MAX_FLAGGED})`);
        console.error('This likely indicates a scoring logic or tier mapping change.');
        console.error('Review data/audit/rebuild-show-drift.json');
        console.error('Set ALLOW_DRIFT=true to override.');
        process.exit(1);
      }
    }
  } catch (e) {
    // Can't read current file, skip drift/regression check (first build)
  }
}

// ========================================
// 3C: CONSISTENCY AUDIT
// ========================================
// Detect rating conversion bugs, designation mismatches, and score clustering.
const consistencyIssues = [];

for (const r of allReviews) {
  // Check 1: Original rating vs assigned score mismatch
  // Skip when scoreSource is llmScore — means the originalRating was intentionally skipped
  // (e.g., star-icon from TimeOut listing pages, low-confidence scraped ratings)
  if (r.originalRating && typeof r.originalRating === 'string' && r.scoreSource !== 'llmScore') {
    const parsed = parseOriginalScore(r.originalRating, r.outletId);
    if (parsed !== null && Math.abs(r.assignedScore - parsed) > 20) {
      consistencyIssues.push({
        type: 'rating-score-mismatch',
        severity: 'high',
        showId: r.showId,
        outlet: r.outletId,
        critic: r.criticName,
        detail: `originalRating "${r.originalRating}" (=${parsed}) vs score ${r.assignedScore} (source: ${r.scoreSource})`
      });
    }
  }

  // Check 2: Positive designation with very low score
  const positiveDesignations = ['Critics_Pick', 'Critics_Choice'];
  if (positiveDesignations.includes(r.designation) && r.assignedScore < 55) {
    consistencyIssues.push({
      type: 'designation-score-mismatch',
      severity: 'medium',
      showId: r.showId,
      outlet: r.outletId,
      critic: r.criticName,
      detail: `${r.designation} but score=${r.assignedScore} (source: ${r.scoreSource})`
    });
  }
}

// Check 3: humanReviewScore overriding explicit originalScore in opposite direction
for (const r of allReviews) {
  if (r.originalRating && r.scoreSource === 'human-review') {
    const parsed = parseOriginalScore(r.originalRating, r.outletId);
    if (parsed !== null) {
      const diff = Math.abs(r.assignedScore - parsed);
      if (diff > 20) {
        const parsedBucket = parsed >= 70 ? 'positive' : parsed <= 40 ? 'negative' : 'mixed';
        const scoreBucket = r.assignedScore >= 70 ? 'positive' : r.assignedScore <= 40 ? 'negative' : 'mixed';
        if (parsedBucket !== scoreBucket) {
          consistencyIssues.push({
            type: 'human-override-vs-explicit-grade',
            severity: 'high',
            showId: r.showId,
            outlet: r.outletId,
            critic: r.criticName,
            detail: `humanReviewScore ${r.assignedScore} (${scoreBucket}) overrides explicit "${r.originalRating}" (=${parsed}, ${parsedBucket})`
          });
        }
      }
    }
  }
}

// Check 4: Score clustering per show (many identical LLM scores)
// Note: Moderate clustering (35-50%) at scores like 80, 82, 60 is EXPECTED behavior.
// When 4 LLM models independently agree on "Positive" bucket, their scores naturally
// average to 81-83, which rounds to 82. Similarly, "Mixed" converges to 60.
// Only flag extreme cases (50%+ at one score with 8+ reviews).
const showGroups = {};
for (const r of allReviews) {
  if (!showGroups[r.showId]) showGroups[r.showId] = [];
  showGroups[r.showId].push(r);
}
for (const [showId, revs] of Object.entries(showGroups)) {
  if (revs.length < 10) continue;
  const scoreCounts = {};
  for (const r of revs) {
    scoreCounts[r.assignedScore] = (scoreCounts[r.assignedScore] || 0) + 1;
  }
  for (const [score, count] of Object.entries(scoreCounts)) {
    const pct = (count / revs.length) * 100;
    if (count >= 8 && pct >= 50) {
      consistencyIssues.push({
        type: 'score-clustering',
        severity: 'low',
        showId,
        detail: `${count}/${revs.length} reviews (${pct.toFixed(0)}%) scored exactly ${score}`
      });
    }
  }
}

if (consistencyIssues.length > 0) {
  const auditDir = path.join(__dirname, '../data/audit');
  if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'rebuild-consistency.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), issues: consistencyIssues }, null, 2) + '\n'
  );

  const byType = {};
  consistencyIssues.forEach(i => { byType[i.type] = (byType[i.type] || 0) + 1; });

  console.log(`\n⚠️  CONSISTENCY AUDIT: ${consistencyIssues.length} issues detected`);
  for (const [type, count] of Object.entries(byType)) {
    console.log(`  ${type}: ${count}`);
  }
  const highSeverity = consistencyIssues.filter(i => i.severity === 'high');
  if (highSeverity.length > 0) {
    console.log('\n  HIGH SEVERITY issues:');
    for (const i of highSeverity.slice(0, 10)) {
      console.log(`    ${i.showId} / ${i.outlet}: ${i.detail}`);
    }
  }
  console.log(`  Full report: data/audit/rebuild-consistency.json`);
}

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
      skippedDuplicateUrl: stats.skippedDuplicateUrl || 0,
      skippedCrossOutletDuplicateUrl: stats.skippedCrossOutletDuplicateUrl || 0,
      skippedDuplicateText: stats.skippedDuplicateText || 0,
      skippedFingerprintDedup: stats.skippedFingerprintDedup || 0,
      skippedUnknownCriticDedup: stats.skippedUnknownCriticDedup || 0,
      skippedWrongProduction: stats.skippedWrongProduction || 0,
      skippedFabricated: stats.skippedFabricated || 0,
      skippedCrossShowUrl: stats.skippedCrossShowUrl || 0,
      skippedCrossMarket: stats.skippedCrossMarket || 0,
      skippedUrlYearStandalone: stats.skippedUrlYearStandalone || 0,
      showScoreDowngradedFallback: stats.showScoreDowngradedFallback || 0,
      recoveredFromGarbage: stats.recoveredFromGarbage || 0,
      outOfRangeScoresRejected: stats.outOfRangeScores || 0,
      scoreSources: stats.scoreSources
    }
  },
  reviews: allReviews
};

// ========================================
// 3D: VALIDATION GATE (hard-fail before write)
// ========================================
// Catches data integrity violations that should NEVER reach production.
// Unlike drift/regression guards (CI-only, threshold-based), these are
// absolute invariants that abort locally AND in CI.
{
  const errors = [];

  // 1. Score range: every review must have assignedScore in 0-100
  const outOfRange = allReviews.filter(r =>
    r.assignedScore == null || r.assignedScore < 0 || r.assignedScore > 100 ||
    !Number.isFinite(r.assignedScore)
  );
  if (outOfRange.length > 0) {
    errors.push(`${outOfRange.length} review(s) have assignedScore outside 0-100:`);
    outOfRange.slice(0, 10).forEach(r => {
      errors.push(`  ${r.showId}/${r.outletId} (${r.criticName}): ${r.assignedScore} [source: ${r.scoreSource}]`);
    });
  }

  // 2. Required fields: every review must have showId, outletId, scoreSource
  const missingFields = allReviews.filter(r => !r.showId || !r.outletId || !r.scoreSource);
  if (missingFields.length > 0) {
    errors.push(`${missingFields.length} review(s) missing required fields (showId, outletId, scoreSource):`);
    missingFields.slice(0, 5).forEach(r => {
      const missing = [!r.showId && 'showId', !r.outletId && 'outletId', !r.scoreSource && 'scoreSource'].filter(Boolean);
      errors.push(`  ${r.showId || '?'}/${r.outletId || '?'}: missing ${missing.join(', ')}`);
    });
  }

  // 3. Total review count: shouldn't drop >15% vs previous file
  if (fs.existsSync(reviewsJsonPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(reviewsJsonPath, 'utf8'));
      const prevCount = (prev.reviews || []).length;
      if (prevCount > 0) {
        const dropPct = ((prevCount - allReviews.length) / prevCount) * 100;
        if (dropPct > 15) {
          errors.push(`Total review count dropped ${dropPct.toFixed(1)}%: ${prevCount} → ${allReviews.length}`);
        }
      }
    } catch (e) { /* can't read previous — skip */ }
  }

  // 4. Score distribution: mean should be 40-90 (catches systematic bias)
  if (allReviews.length > 100) {
    const mean = allReviews.reduce((sum, r) => sum + r.assignedScore, 0) / allReviews.length;
    if (mean < 40 || mean > 90) {
      errors.push(`Mean score ${mean.toFixed(1)} is outside sane range [40-90] — likely systematic scoring bug`);
    }
  }

  // 5. Zero reviews = something is very wrong
  if (allReviews.length === 0) {
    errors.push('Zero reviews produced — rebuild generated empty output');
  }

  if (errors.length > 0) {
    console.error('\n❌ VALIDATION GATE FAILED — reviews.json NOT written');
    errors.forEach(e => console.error(`  ${e}`));
    console.error('\nFix the underlying data issue. Set SKIP_VALIDATION_GATE=true to override (NOT recommended).');
    if (!process.env.SKIP_VALIDATION_GATE) {
      process.exit(1);
    }
    console.warn('⚠️  SKIP_VALIDATION_GATE=true — writing despite validation failures');
  } else {
    console.log('\n✅ VALIDATION GATE: all checks passed');
  }
}

// Write output
fs.writeFileSync(reviewsJsonPath, JSON.stringify(output, null, 2));

// ========================================
// 4: POST-REBUILD EXCERPT AUDIT (Layer 2)
// ========================================
{
  const excerptAuditIssues = [];
  let pullQuoteCount = 0;

  for (const review of allReviews) {
    const pq = review.pullQuote;
    if (pq) pullQuoteCount++;
    if (!pq) continue;

    // Leading colon or comma
    if (/^[,:\s]*[,:]/.test(pq)) {
      excerptAuditIssues.push({ type: 'leading-artifact', showId: review.showId, outlet: review.outlet, preview: pq.substring(0, 60) });
    }
    // Metadata fragments
    if (/Average Rating/i.test(pq) || /"@context"/i.test(pq)) {
      excerptAuditIssues.push({ type: 'metadata-leak', showId: review.showId, outlet: review.outlet, preview: pq.substring(0, 60) });
    }
    // Control characters (U+0080–U+009F)
    if (/[\u0080-\u009F]/.test(pq)) {
      excerptAuditIssues.push({ type: 'control-chars', showId: review.showId, outlet: review.outlet, preview: pq.substring(0, 60) });
    }
    // Very short (likely truncated)
    if (pq.length < 20) {
      excerptAuditIssues.push({ type: 'too-short', showId: review.showId, outlet: review.outlet, preview: pq });
    }
    // Mojibake remnants
    if (/â[€\u0080]/.test(pq) || /Ã[©¨¶¼®´]/.test(pq)) {
      excerptAuditIssues.push({ type: 'mojibake', showId: review.showId, outlet: review.outlet, preview: pq.substring(0, 60) });
    }
  }

  // Count regression check: compare with previous reviews.json
  let previousPullQuoteCount = null;
  if (fs.existsSync(reviewsJsonPath + '.bak')) {
    try {
      const prev = JSON.parse(fs.readFileSync(reviewsJsonPath + '.bak', 'utf8'));
      previousPullQuoteCount = (prev.reviews || []).filter(r => r.pullQuote).length;
    } catch (e) { /* ignore */ }
  }

  if (excerptAuditIssues.length > 0) {
    console.log(`\n⚠️  EXCERPT AUDIT: ${excerptAuditIssues.length} pullQuote issues detected`);
    const byType = {};
    excerptAuditIssues.forEach(i => { byType[i.type] = (byType[i.type] || 0) + 1; });
    for (const [type, count] of Object.entries(byType)) {
      console.log(`  ${type}: ${count}`);
    }
    // Show first 5
    excerptAuditIssues.slice(0, 5).forEach(i => {
      console.log(`    ${i.showId}/${i.outlet}: ${i.preview}`);
    });
  } else {
    console.log(`\n✅ EXCERPT AUDIT: 0 pullQuote issues (${pullQuoteCount} total pullQuotes)`);
  }

  // Count regression warning
  if (previousPullQuoteCount !== null) {
    const dropPct = ((previousPullQuoteCount - pullQuoteCount) / previousPullQuoteCount * 100);
    if (dropPct > 5) {
      console.log(`\n🚨 EXCERPT COUNT REGRESSION: ${previousPullQuoteCount} → ${pullQuoteCount} (${dropPct.toFixed(1)}% drop)`);
      console.log('   This may indicate a false-positive epidemic in excerpt validation.');
    } else if (dropPct > 1) {
      console.log(`\n⚠️  Excerpt count change: ${previousPullQuoteCount} → ${pullQuoteCount} (${dropPct.toFixed(1)}% drop)`);
    }
  }

  // Cross-show and tour validation summary
  if (stats.crossShowExcerptFlags && stats.crossShowExcerptFlags.length > 0) {
    console.log(`\n📋 CROSS-SHOW FLAGS (dry-run): ${stats.crossShowExcerptFlags.length} excerpts mention other shows`);
    stats.crossShowExcerptFlags.slice(0, 10).forEach(f => {
      console.log(`  ${f.showId}: ${f.source} → "${f.mentionedTitle}"`);
    });
    if (stats.crossShowExcerptFlags.length > 10) {
      console.log(`  ... and ${stats.crossShowExcerptFlags.length - 10} more`);
    }
  }
  if (stats.crossShowExcerptSuppressed && stats.crossShowExcerptSuppressed.length > 0) {
    console.log(`\n🚫 CROSS-SHOW SUPPRESSED: ${stats.crossShowExcerptSuppressed.length} excerpts blocked`);
  }
  if (stats.tourExcerptFlags && stats.tourExcerptFlags.length > 0) {
    console.log(`\n🎭 TOUR EXCERPT FLAGS: ${stats.tourExcerptFlags.length} excerpts have tour signals`);
    stats.tourExcerptFlags.slice(0, 5).forEach(f => {
      console.log(`  ${f.showId}: ${f.source} — ${f.signal}`);
    });
  }
}

// Print summary
console.log('\n=== SUMMARY ===\n');
// LOUD WARNING for corrupted files — these represent silent data loss
if (stats.skippedCorrupted > 0) {
  console.error(`\n${'!'.repeat(60)}`);
  console.error(`!! CORRUPTED FILES FOUND: ${stats.skippedCorrupted} files skipped due to corruption`);
  console.error(`!! These files have merge conflicts or invalid JSON — reviews are LOST`);
  stats.corruptedFiles.forEach(f => console.error(`!!   ${f}`));
  console.error(`${'!'.repeat(60)}\n`);
}

console.log(`Total files processed: ${stats.totalFiles}`);
console.log(`Total reviews INCLUDED: ${stats.totalReviews}`);
console.log(`  Skipped (no valid score): ${stats.skippedNoScore}`);
console.log(`  Skipped (duplicate): ${stats.skippedDuplicate}`);
console.log(`  Skipped (duplicate URL): ${stats.skippedDuplicateUrl || 0}`);
console.log(`  Skipped (cross-outlet duplicate URL): ${stats.skippedCrossOutletDuplicateUrl || 0}`);
console.log(`  Skipped (corrupted/invalid JSON): ${stats.skippedCorrupted || 0}`);
console.log(`  Skipped (wrong production): ${stats.skippedWrongProduction || 0}`);
console.log(`  Skipped (fabricated entry): ${stats.skippedFabricated || 0}`);
console.log(`  Skipped (cross-show URL dedup): ${stats.skippedCrossShowUrl || 0}`);
console.log(`  Skipped (cross-market outlet): ${stats.skippedCrossMarket || 0}`);
if (stats.showScoreDowngradedFallback > 0) {
  console.log(`  ShowScore downgraded to fallback (WE): ${stats.showScoreDowngradedFallback}`);
}
if (stats.crossMarketDetails && stats.crossMarketDetails.length > 0) {
  console.log(`  Cross-market details (first 10):`);
  stats.crossMarketDetails.slice(0, 10).forEach(d => console.log(`    ${d.showId} | ${d.outlet} | ${d.file}`));
  if (stats.crossMarketDetails.length > 10) console.log(`    ... and ${stats.crossMarketDetails.length - 10} more`);
}
console.log(`  Skipped (non-review): ${stats.skippedNonReview || 0}`);
console.log(`  Skipped (syndicated duplicate): ${stats.skippedSyndicated || 0}`);
console.log(`  Skipped (cross-outlet duplicate): ${stats.skippedCrossOutletDupe || 0}`);
console.log(`  Skipped (previews shows): ${stats.skippedPreviewsShows || 0}`);
console.log(`  Skipped (date mismatch >30d): ${stats.skippedDateMismatch || 0}`);
console.log(`  Skipped (director cross-check): ${stats.skippedDirectorMismatch || 0}`);
console.log(`  Skipped (URL-year cross-production): ${stats.skippedUrlYearMismatch || 0}`);
console.log(`  Skipped (URL-year standalone): ${stats.skippedUrlYearStandalone || 0}`);
console.log(`  Skipped (wrong content/reasoning): ${stats.skippedWrongContent || 0}`);
console.log(`  Skipped (rejection reason): ${stats.skippedRejectionReason || 0}`);
console.log(`  Skipped (roundup article): ${stats.skippedRoundup || 0}`);
console.log(`  Skipped (duplicate text flag): ${stats.skippedDuplicateText || 0}`);
if (stats.circularDuplicateRecovered > 0) {
  console.log(`  Recovered (circular/stale duplicate flags): ${stats.circularDuplicateRecovered}`);
}
if (stats.staleDuplicateTextCleared > 0) {
  console.log(`  Recovered (stale duplicateTextOf — text changed): ${stats.staleDuplicateTextCleared}`);
}
console.log(`  Skipped (unknown critic dedup): ${stats.skippedUnknownCriticDedup || 0}`);
console.log(`  Skipped (fingerprint dedup): ${stats.skippedFingerprintDedup || 0}`);
console.log(`  Skipped (cross-show duplicate text): ${stats.skippedCrossShowDupe || 0}`);
if (stats.crossShowDupeDetails && stats.crossShowDupeDetails.length > 0) {
  stats.crossShowDupeDetails.forEach(d => console.log(`    - ${d}`));
}
console.log(`  Skipped (show not mentioned, no excerpts): ${stats.skippedShowNotMentioned || 0}`);
if (stats.showIdMismatches > 0) {
  console.log(`  ⚠️  showId mismatches (file vs directory): ${stats.showIdMismatches}`);
}
if (stats.showNotMentionedAutoCleared > 0) {
  console.log(`  Auto-cleared stale showNotMentioned (fullText valid): ${stats.showNotMentionedAutoCleared}`);
}
if (stats.showNotMentionedWithExcerpts > 0) {
  console.log(`  Show not mentioned but has excerpts (allowed): ${stats.showNotMentionedWithExcerpts}`);
}
if (stats.wrongProdWEOBAutoCleared > 0) {
  console.log(`  Auto-cleared wrongProduction (WE/OB URL-year exempt): ${stats.wrongProdWEOBAutoCleared}`);
}
if (stats.rejectionAutoCleared > 0) {
  console.log(`  Auto-cleared stale rejections (content-quality gate): ${stats.rejectionAutoCleared}`);
}
if (stats.nonReviewAutoRecovered > 0) {
  console.log(`  Auto-recovered nonReview false positives (signal-based): ${stats.nonReviewAutoRecovered}`);
}
if (stats.wrongShowAutoRecovered > 0) {
  console.log(`  Auto-recovered wrongShow (excerpt+assignedScore, no reason): ${stats.wrongShowAutoRecovered}`);
}
if (stats.wrongShowNeedsReview && stats.wrongShowNeedsReview.length > 0) {
  console.log(`  wrongShow needs manual review (excerpt but no assignedScore): ${stats.wrongShowNeedsReview.length}`);
}
if (stats.recoveredFromGarbage > 0) {
  console.log(`  Recovered from garbageFullText: ${stats.recoveredFromGarbage}`);
}
if (stats.skippedLowConfidenceOriginal > 0) {
  console.log(`  Skipped low-confidence originalScores: ${stats.skippedLowConfidenceOriginal}`);
}
if (stats.excerptMismatches > 0) {
  console.log(`  Excerpt-fullText mismatches (report only): ${stats.excerptMismatches}`);
  if (stats.excerptMismatchDetails) {
    for (const d of stats.excerptMismatchDetails.slice(0, 10)) {
      console.log(`    ${d.path}: ${d.field} (${d.matchRate} word overlap)`);
    }
    if (stats.excerptMismatchDetails.length > 10) {
      console.log(`    ...and ${stats.excerptMismatchDetails.length - 10} more`);
    }
  }
}

// Explicit rating summary
const explicitCount = (stats.scoreSources['explicit-stars'] || 0) +
                      (stats.scoreSources['explicit-outOf'] || 0) +
                      (stats.scoreSources['explicit-slash'] || 0) +
                      (stats.scoreSources['explicit-letterGrade'] || 0);
if (explicitCount > 0) {
  console.log(`\nExplicit ratings extracted from text: ${explicitCount}`);
}

// Thumb validation summary
if (stats.thumbValidatedLlm > 0) {
  console.log(`\nThumb-validated LLM scores (confidence upgraded): ${stats.thumbValidatedLlm}`);
  console.log(`  (Aggregator thumbs agreed with LLM direction, boosting confidence)`);
}
if (stats.borderlineRaves > 0) {
  console.log(`\nBorderline raves (score 78-82, high conf): ${stats.borderlineRaves}`);
  console.log(`  Flagged for human review (2+ corroborating signals): ${stats.borderlineRavesFlagged || 0}`);
}
if (stats.bwwScoreLlmConflicts > 0) {
  console.log(`  BWW score-LLM conflicts (>30pt divergence): ${stats.bwwScoreLlmConflicts}`);
}
if (stats.bwwInternalConflicts > 0) {
  console.log(`  BWW thumb/score internal conflicts: ${stats.bwwInternalConflicts}`);
}

// Ensemble quality gate report
const blockedExcerpt = stats.blockedSingleModelExcerpt || 0;
const warnedFullText = stats.warnSingleModelFullText || 0;
if (blockedExcerpt + warnedFullText > 0) {
  console.log(`\nENSEMBLE QUALITY GATE:`);
  console.log(`  Blocked (excerpt-only, no ensemble): ${blockedExcerpt}`);
  console.log(`  Warned (fullText, no ensemble): ${warnedFullText}`);
  if (blockedExcerpt > 0) {
    console.log(`  → Run ensemble scoring to fix blocked reviews`);
  }
}

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

// WARNING: Reviews that should have LLM scores but don't
if (stats.unscoredWithText.length > 0) {
  console.log(`\n⚠️  WARNING: ${stats.unscoredWithText.length} REVIEWS NEED LLM SCORING`);
  console.log('These have scorable text (100+ chars) but no LLM score.');
  console.log('Run: gh workflow run "LLM Ensemble Score Reviews" to score them.\n');

  // Group by show
  const byShow = {};
  stats.unscoredWithText.forEach(r => {
    const show = r.path.split('/')[0];
    byShow[show] = (byShow[show] || 0) + 1;
  });

  console.log('By show:');
  Object.entries(byShow).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([show, count]) => {
    console.log(`  ${show}: ${count}`);
  });
  if (Object.keys(byShow).length > 10) {
    console.log(`  ... and ${Object.keys(byShow).length - 10} more shows`);
  }
}

// Write human review queue (always write, even if empty, to clear stale data)
{
  const auditDir = path.join(__dirname, '../data/audit');
  if (!fs.existsSync(auditDir)) {
    fs.mkdirSync(auditDir, { recursive: true });
  }

  const auditPath = path.join(auditDir, 'needs-human-review.json');
  const auditOutput = {
    _meta: {
      generatedAt: new Date().toISOString(),
      totalFlagged: humanReviewQueue.length,
      reasons: {}
    },
    reviews: humanReviewQueue
  };

  // Count by reason
  humanReviewQueue.forEach(r => {
    auditOutput._meta.reasons[r.reason] = (auditOutput._meta.reasons[r.reason] || 0) + 1;
  });

  fs.writeFileSync(auditPath, JSON.stringify(auditOutput, null, 2) + '\n');
  if (humanReviewQueue.length > 0) {
    console.log(`\nHUMAN REVIEW QUEUE: ${humanReviewQueue.length} reviews flagged`);
    Object.entries(auditOutput._meta.reasons).forEach(([reason, count]) => {
      console.log(`  ${reason}: ${count}`);
    });
    console.log(`  Written to: ${auditPath}`);
  } else {
    console.log(`\nHUMAN REVIEW QUEUE: 0 reviews flagged (all clear)`);
  }
}

// Report auto-detected wrong production reviews
if (stats.suspectedWrongProduction && stats.suspectedWrongProduction.length > 0) {
  console.log(`\nAUTO-EXCLUDED ${stats.suspectedWrongProduction.length} review(s) published >60 days before show previews:`);
  for (const r of stats.suspectedWrongProduction) {
    console.log(`  ${r.showId}: ${r.outlet}/${r.critic} (${r.daysBefore} days before, score=${r.score})`);
  }
  console.log('  These are likely from off-Broadway, West End, or TV productions.');
  console.log('  To include a review despite early date, add "allowEarlyDate": true to the review file.');
}

// Report auto-detected post-closing reviews
if (stats.suspectedLateReviews && stats.suspectedLateReviews.length > 0) {
  console.log(`\nAUTO-EXCLUDED ${stats.suspectedLateReviews.length} review(s) published >6 months after show closed:`);
  for (const r of stats.suspectedLateReviews) {
    console.log(`  ${r.showId}: ${r.outlet}/${r.critic} (${r.monthsAfter} months after closing, score=${r.score})`);
  }
  console.log('  These are likely from revivals, off-Broadway, tours, or TV adaptations.');
  console.log('  To include a review despite late date, add "allowLateDate": true to the review file.');
}

// ========================================
// AUTO-REGISTER NEW OUTLETS
// ========================================
{
  // Collect all unique outletIds from just-built reviews
  const reviewOutletIds = new Set(allReviews.map(r => r.outletId).filter(Boolean));
  const registryIds = new Set();
  for (const [id, info] of Object.entries(outletRegistry.outlets)) {
    registryIds.add(id.toLowerCase());
    if (info.aliases) {
      for (const alias of info.aliases) registryIds.add(alias.toLowerCase());
    }
  }
  if (outletRegistry._aliasIndex) {
    for (const alias of Object.keys(outletRegistry._aliasIndex)) {
      registryIds.add(alias.toLowerCase());
    }
  }

  const newOutlets = [];
  for (const outletId of reviewOutletIds) {
    if (!registryIds.has(outletId.toLowerCase())) {
      newOutlets.push(outletId);
    }
  }

  if (newOutlets.length > 0) {
    // Auto-add missing outlets with tier 3
    for (const outletId of newOutlets) {
      const displayName = outletId
        .split('-')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      outletRegistry.outlets[outletId] = {
        displayName,
        tier: 3,
        aliases: [outletId],
        domain: null
      };
    }
    if (outletRegistry._meta) {
      outletRegistry._meta.lastUpdated = new Date().toISOString().split('T')[0];
    }
    const registryPath = path.join(__dirname, '..', 'data', 'outlet-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify(outletRegistry, null, 2));
    console.log(`\n✅ AUTO-REGISTERED ${newOutlets.length} new outlet(s) in outlet-registry.json (Tier 3):`);
    for (const id of newOutlets.sort()) {
      console.log(`  + ${id}`);
    }
    console.log('  Review tiers manually if needed.');
  }
}

console.log('\n=== DONE ===');
console.log(`\nReviews saved to: ${reviewsJsonPath}`);
