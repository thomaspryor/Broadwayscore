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
 *      WARNING: assignedScore is an OUTPUT of rebuild, not an INPUT.
 *      Setting it manually in source files has no effect — rebuild recalculates it.
 *      To override a score, set humanReviewScore (P0b) instead.
 * P5.  bucket mapping (Rave=90, Positive=82, Mixed=65, Negative=48, Pan=30)
 * P5.5 bwwScore fallback (BWW editorial 1-10 × 10, more granular than thumbs)
 * P6.  dtliThumb or bwwThumb (Up=80, Flat=60, Down=35) - final fallback
 * P7.  SKIP - do not include in reviews.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getOutletDisplayName, normalizeOutlet: normalizeOutletCanonical, normalizeCritic: normalizeCriticCanonical, generateReviewFilename, isJunkOutlet, loadCriticRegistry, AGGREGATOR_SCORE_SOURCES } = require('./lib/review-normalization');
const { decodeHtmlEntities, cleanText } = require('./lib/text-cleaning');
const { classifyContentTier, computeContentFingerprint } = require('./lib/content-quality');
const { shouldDeferCvWrongShow } = require('./lib/content-verifier');
const { classifyIncompleteReason } = require('./lib/incomplete-reason');
const { LETTER_GRADES, BUCKET_SCORES, THUMB_SCORES } = require('./lib/score-extractors');
const { parseStarRating, parseLetterGrade, parseOriginalScore, LETTER_GRADE_OUTLETS } = require('./lib/score-parsers');
const { excerptMentionsWrongShow, isTourReviewExcerpt, isFilmTvReview } = require('./lib/excerpt-validation');
const { shouldRejectAsReservation, isInternalNote, hasCopyrightChrome, stripLeadingChrome } = require('./lib/pull-quote-guards');
const { emitStage } = require('./lib/stage-latency');
const { isRoundupUrl, isLikelyStaleRoundupFlag, isLikelyStaleSuspectedMisattribution, getCriticRegistry, isVenueMismatch, shouldSkipWrongProductionAudit, shouldSkipRoundupAudit, buildShowKeywordSet, findShowKeywordInText, checkLlmVerificationAgainstKeywords, pickRerouteTarget, buildMultiProdYearGuard, isIncludableForRebuild, hasStrongDifferentShowSignal, hasHighConfidenceLlmScore, canonicalizeUrlForDedup, areSameCriticFuzzy, isStaleCvPromotedWrongProduction, applyVenueClassificationCarveout, isReviewWithinOwnProductionWindow } = require('./lib/review-guards');
const { canonicalizeCritic } = require('./lib/critic-canonicalization');
const { shouldFillDefaultCritic } = require('./lib/critic-fill-rules');
const { normalizeThumb, normalizePublishDate, fixMojibake, fixMissingPeriods, isJunkExcerpt, isGenericQuote, trimToCompleteSentence, normalizeQuoteWrapping, cleanExcerpt, isContentVerificationActive, getBestScore: _getBestScoreCore, scoreToBucket, scoreToThumb, extractDateFromUrl } = require('./lib/rebuild-helpers');
const { isLondonMarket, isUkOutletUrl } = require('./lib/venue-classification');
const { isLongRunningProduction } = require('./lib/long-runner-registry');
const { isBlockedReviewUrl } = require('./lib/domain-filters');
const { cascadeClearDuplicateRefs } = require('./lib/cascade-clear-duplicate-refs');
const { parseDate } = require('./lib/date-utils');
const {
  shouldAutoClearWrongProduction,
  shouldAutoClearWrongShow,
  isWithinPriorRun,
  shouldAutoClearWrongProductionPriorRun,
  shouldAutoClearDatelessRevival,
} = require('./lib/wrong-production-autoclear');
const { evaluateDatelessRevivalGuard, earliestShowDate } = require('./lib/date-guard');
const { safeWriteReview } = require('./lib/review-write-guard');
const { KNOWN_SYNDICATION_PAIRS } = require('./lib/syndication-pairs');
const { logExclusion: _sharedLogExclusion } = require('./lib/exclusion-logger');
const { isRebuildPaused, readRebuildPause, REBUILD_PAUSE_PATH } = require('./lib/rebuild-pause');
const { listShowDirs } = require('./lib/list-show-dirs');

// Authoritative NYT Critic's Pick set — union of two sources:
//   1. data/nyt-critics-picks.json — scraped from nytimes.com/spotlight/theater-critics-picks
//      (covers ~100 most recent picks, back to ~April 2024)
//   2. data/designations.json → nyt_critics_pick — human-verified historical picks
//      (Hamilton, Hadestown, Lion King, etc. that fell off the spotlight window)
// A review is designated only if its URL is in this set. Both are URL-keyed; we
// look up the designations.json entries by finding the show's NYT review URL.
function canonicalPickUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(u);
    // Strip query strings and trailing slashes so ?searchResultPosition=1,
    // ?ref=theater, #:~:text=... etc. don't hide matches.
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    return u;
  }
}
const NYT_CRITICS_PICK_URLS = (() => {
  const set = new Set();
  try {
    const picksData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'nyt-critics-picks.json'), 'utf8'));
    for (const u of (picksData.urls || [])) set.add(canonicalPickUrl(u));
  } catch (e) {
    console.warn('[nyt-critics-picks] Could not load data/nyt-critics-picks.json:', e.message);
  }
  try {
    const designations = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'designations.json'), 'utf8'));
    const manualPicks = designations.nyt_critics_pick || {};
    for (const [showId, entry] of Object.entries(manualPicks)) {
      // Only trust entries explicitly marked as Critics_Pick — some entries
      // track non-picks (e.g. "Critic's Notebook" pieces with designation: null).
      if (entry?.designation !== 'Critics_Pick') continue;
      const showDir = path.join(__dirname, '..', 'data', 'review-texts', showId);
      if (!fs.existsSync(showDir)) continue;
      // Match the specific critic recorded in designations.json — avoids
      // picking up misfiled old NYT reviews in the same show directory
      // (e.g. mamma-mia-2025 also has the 2001 Brantley review on file).
      const criticSlug = (entry.critic || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      for (const f of fs.readdirSync(showDir)) {
        if (!f.startsWith('nytimes--')) continue;
        // If we know the critic, require the filename to match. Files are
        // generated as `nytimes--<slug>.json`; allow partial match to tolerate
        // slight slug variants (last-name-only, hyphenation).
        if (criticSlug && !f.toLowerCase().includes(criticSlug)) {
          // Fall back to last-name match
          const lastName = criticSlug.split('-').pop();
          if (lastName && !f.toLowerCase().includes(lastName)) continue;
        }
        try {
          const r = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
          // Skip misfiled reviews known to be wrong production.
          if (r.wrongProduction === true || r.contentVerification?.wrongProduction === true) continue;
          if (r.url) set.add(canonicalPickUrl(r.url));
        } catch { /* skip unreadable */ }
      }
    }
  } catch (e) {
    console.warn('[nyt-critics-picks] Could not load data/designations.json:', e.message);
  }
  return set;
})();

// Load outlet registry for cross-market guard
const outletRegistry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'outlet-registry.json'), 'utf8'));
const outletRegionMap = {};  // outletId -> region (e.g., 'london')
for (const [id, info] of Object.entries(outletRegistry.outlets)) {
  // Use explicit region, or infer from market (west-end → london)
  const region = info.region || (info.market === 'west-end' || info.market === 'off-west-end' ? 'london' : null);
  if (region) outletRegionMap[id] = region;
  // Also map aliases to the same region
  if (info.aliases && region) {
    for (const alias of info.aliases) {
      outletRegionMap[alias] = region;
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

// Load critic registry for resolving "unknown" outlet reviews
const criticRegistry = loadCriticRegistry();

// Human review queue — flagged items written to data/audit/needs-human-review.json
const humanReviewQueue = [];

// Exclusion logging: routes through shared lib (scripts/lib/exclusion-logger.js).
// Exclusions always write to data/audit/exclusions-YYYY-MM-DD.jsonl and emit a
// [EXCLUSION] line on stdout for CI grep. REBUILD_VERBOSE no longer required.
function logExclusion(statKey, showId, file, data, extra) {
  _sharedLogExclusion({
    script: 'rebuild-all-reviews',
    showId: showId || 'unknown',
    file: file || '-',
    reason: statKey,
    details: {
      url: (data && data.url) || undefined,
      outletId: (data && (data.outletId || data.outlet)) || undefined,
      criticName: (data && (data.criticName || data.critic)) || undefined,
      publishDate: (data && data.publishDate) || undefined,
      ...(extra || {}),
    },
  });
}

// normalizeThumb, normalizePublishDate — imported from ./lib/rebuild-helpers

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

// EXPLICIT RATING EXTRACTION removed — now handled at collection time
// by LLM extraction (scripts/lib/llm-score-extractor.js).
// Rebuild only consumes pre-stored originalScore via parseOriginalScore().

// Paths
const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const reviewsJsonPath = path.join(__dirname, '../data/reviews.json');

// decodeHtmlEntities imported from ./lib/text-cleaning

// fixMojibake, fixMissingPeriods — imported from ./lib/rebuild-helpers

// isJunkExcerpt — imported from ./lib/rebuild-helpers

// cleanExcerpt — imported from ./lib/rebuild-helpers

/**
 * Extract a good opening excerpt from full review text
 */
function extractExcerptFromFullText(fullText, showTitle) {
  if (!fullText || fullText.length < 200) return null;

  // Pre-process: strip leading page-chrome lines (Review:/By/Photo/Credit/
  // venue/date/just-name) BEFORE the existing line-by-line strip and sentence
  // scoring. The existing strip didn't handle "Review: <Title>" prefixes or
  // standalone venue lines ("Palace Theatre"), so chrome leaked into the
  // fallback "first substantive sentences" path. Lost Boys 2026-04-26 Exeunt.
  // stripLeadingChrome bails (returns null) if it would skip >70% of text;
  // in that case keep the original.
  const chromeStripped = stripLeadingChrome(fullText, { maxLen: fullText.length });
  let text = fixMissingPeriods(fixMojibake(decodeHtmlEntities(chromeStripped || fullText)));

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
    // Affiliate / reader-funding disclaimers (Evening Standard etc.) that lead many pages
    if (/affiliate commission|purchase through links|journalism is supported by|supported by our readers|we may earn a/i.test(sentence)) continue;
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
 *           nycTheatreExcerpt > stagedoorExcerpt > dtliExcerpt > fullText extract > existing pullQuote
 */
// Cross-show validation: dry-run by default (log but don't suppress)
const CROSS_SHOW_DRY_RUN = process.env.DRY_RUN_CROSS_SHOW !== 'false';

// isGenericQuote, trimToCompleteSentence — imported from ./lib/rebuild-helpers

function selectBestExcerpt(data, showTitle) {
  const showId = data.showId;

  // Bug #10: Manually-set pullQuote always wins — human editors set this
  // deliberately and it must not be overridden by LLM or aggregator sources.
  // Only apply the internal-note and copyright-chrome guards (not cross-show /
  // tour / hedge guards, which are meant for automated pipeline candidates).
  if (data.pullQuote && typeof data.pullQuote === 'string' && data.pullQuote.trim()) {
    const cleaned = cleanExcerpt(data.pullQuote);
    if (cleaned && cleaned.length > 20) {
      if (!isInternalNote(cleaned) && !hasCopyrightChrome(cleaned)) {
        return cleaned;
      }
    }
  }

  /**
   * Validate an excerpt candidate against cross-show and tour guards.
   * Returns the excerpt if valid, null if suppressed.
   */
  function validateExcerpt(excerpt, source) {
    if (!excerpt) return null;

    // Layer 0: Fragment guard. Fallback sources (LLM keyPhrases, aggregator
    // excerpts) can surface mid-sentence fragments that the dedicated
    // llmPullQuote path would have trimmed. Trim a trailing partial sentence,
    // then reject anything that still starts lowercase — a lowercase start means
    // a mid-sentence fragment ("disappointing: poorly directed, oddly paced")
    // that reads as a broken pull quote on the site. Dropping it lets a cleaner
    // source (fullText extraction) win instead. 2026-06-12: ~20 displayed quotes
    // were lowercase-start fragments from the keyPhrase fallback.
    // Skip any leading wrapping quote/paren/whitespace before the fragment check:
    // cleanExcerpt leaves the wrapping quote on (normalizeQuoteWrapping strips it
    // downstream), so a Show Score excerpt like '"disappointing: poorly directed…'
    // or '"a mysterious and deeply moving dance-musical"' would slip past a bare
    // /^[a-z]/ test. (Re-applied 2026-06-15 after a parallel-session merge reverted it.)
    excerpt = trimToCompleteSentence(excerpt);
    if (/^[\s"'“‘«(\[]*[a-z]/.test(excerpt)) return null;

    // Layer 1: Internal-note guard — reject editorial notes that leaked into excerpt fields.
    if (isInternalNote(excerpt)) {
      if (!stats.internalNoteExcerptsRejected) stats.internalNoteExcerptsRejected = [];
      stats.internalNoteExcerptsRejected.push({ showId, source, excerpt: excerpt.slice(0, 80) });
      console.log(`  🚫 [internal-note] ${showId}: "${source}" rejected as internal note`);
      return null;
    }

    // Layer 2: Copyright-chrome guard — reject scraping artifacts.
    if (hasCopyrightChrome(excerpt)) {
      if (!stats.copyrightChromeRejected) stats.copyrightChromeRejected = [];
      stats.copyrightChromeRejected.push({ showId, source, excerpt: excerpt.slice(0, 80) });
      console.log(`  🚫 [copyright-chrome] ${showId}: "${source}" rejected for copyright/subscribe text`);
      return null;
    }

    // Layer 2b: Off-topic guard is disabled in the automated pipeline.
    // isOffTopicExcerpt() has a ~20% false-positive rate on llmPullQuote: legitimate
    // theater criticism often uses metaphorical language ("It has remembered the ladies")
    // without standard theater vocabulary. The guard is kept in pull-quote-guards.js
    // for targeted use (e.g., validating human-set pullQuotes in audits), but applying
    // it here would silently downgrade 1-in-5 valid LLM excerpts to lower-quality sources.

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

    // Layer 5: Hedge-opener guard (Pattern Card #3)
    // Aggregator excerpts on positive reviews often quote a middle-paragraph caveat
    // ("But the book still needs work") rather than the critic's actual verdict.
    // shouldRejectAsReservation returns false when score is null (safe for aggregator-only reviews).
    const reviewScore = data.llmScore?.score ?? null;
    if (shouldRejectAsReservation(excerpt, reviewScore)) {
      if (!stats.hedgeExcerptSuppressed) stats.hedgeExcerptSuppressed = [];
      stats.hedgeExcerptSuppressed.push({ showId, source, excerpt: excerpt.slice(0, 80) });
      console.log(`  🛡️  [hedge-guard] ${showId}: "${source}" rejected as reservation (score ${reviewScore})`);
      return null;
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

  // 4b. Try stagedoorExcerpt (aggregator-curated, UK critics)
  if (data.stagedoorExcerpt) {
    const cleaned = cleanExcerpt(data.stagedoorExcerpt);
    if (cleaned && cleaned.length > 20) {
      const validated = validateExcerpt(cleaned, 'stagedoorExcerpt');
      if (validated) return validated;
    }
  }

  // 5. Try dtliExcerpt with aggressive cleaning (aggregator-curated)
  if (data.dtliExcerpt) {
    const cleaned = cleanExcerpt(data.dtliExcerpt);
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

  // 7. Chrome-skip raw fullText fallback. Defense-in-depth: when the
  //    evaluative-sentence extractor returns null (too few substantive
  //    sentences, all rejected, etc.), still try to surface SOMETHING from
  //    fullText rather than nothing — but skip the leading page chrome first
  //    so we don't return "Review: <Title> at the Palace Theatre Palace
  //    Theatre ⋄ ...". See pull-quote-guards.stripLeadingChrome.
  //    Operates on raw fullText (not the truncated-status version) and bails
  //    when the heuristic would skip >70% of text.
  if (data.fullText && data.fullText.length > 300 && data.textStatus !== 'truncated') {
    const stripped = stripLeadingChrome(data.fullText, { maxLen: 600 });
    if (stripped && stripped.length > 50) {
      const cleaned = cleanExcerpt(stripped);
      if (cleaned && cleaned.length > 50 && !isJunkExcerpt(cleaned)) {
        const validated = validateExcerpt(cleaned, 'fullText-chrome-skip');
        if (validated) return validated;
      }
    }
  }

  return null;
}

// normalizeQuoteWrapping — imported from ./lib/rebuild-helpers

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

// getBestScore — core logic imported from ./lib/rebuild-helpers as _getBestScoreCore.
// This wrapper passes module-level stats/flagForHumanReview and adds extra stat tracking.
function getBestScore(data) {
  const result = _getBestScoreCore(data, { stats, flagForHumanReview });

  // Extra stat tracking (not part of core scoring logic):
  // Borderline rave detection, bwwScore-LLM divergence, thumb-LLM disagreement at P1
  if (result && result.source === 'llmScore' && data.llmScore) {
    // Flag if BOTH thumbs agree with each other but disagree with LLM direction
    const llmThumb = data.llmScore.score >= 70 ? 'Up' : data.llmScore.score >= 55 ? 'Flat' : 'Down';
    const dtli = data.dtliThumb ? normalizeThumb(data.dtliThumb) : null;
    const bww = data.bwwThumb ? normalizeThumb(data.bwwThumb) : null;
    if (dtli && bww && dtli === bww && dtli !== llmThumb) {
      flagForHumanReview(data, 'both-thumbs-disagree-with-llm',
        `LLM=${data.llmScore.score} (${llmThumb}), both thumbs=${data.dtliThumb}`);
    }
    // bwwScore-LLM divergence stat
    if (data.bwwScore != null) {
      const bwwNorm = data.bwwScore * 10;
      if (Math.abs(bwwNorm - data.llmScore.score) > 30) {
        stats.bwwScoreLlmConflicts = (stats.bwwScoreLlmConflicts || 0) + 1;
      }
    }
    // Borderline rave detection
    if (data.llmScore.score >= 78 && data.llmScore.score <= 82 && data.llmScore.confidence !== 'low') {
      stats.borderlineRaves = (stats.borderlineRaves || 0) + 1;
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
  }

  // bwwInternalConflicts stat (thumb vs score direction mismatch)
  if (data.bwwThumb && data.bwwScore != null) {
    const bwwThumbNorm = normalizeThumb(data.bwwThumb);
    const bwwScoreDir = data.bwwScore >= 7 ? 'positive' : data.bwwScore <= 3 ? 'negative' : 'neutral';
    if (bwwScoreDir !== 'neutral') {
      const thumbDir = bwwThumbNorm === 'Up' ? 'positive' : bwwThumbNorm === 'Down' ? 'negative' : 'neutral';
      if (thumbDir !== 'neutral' && thumbDir !== bwwScoreDir) {
        stats.bwwInternalConflicts = (stats.bwwInternalConflicts || 0) + 1;
      }
    }
  }

  return result;
}

// scoreToBucket, scoreToThumb — imported from ./lib/rebuild-helpers

// Main execution
console.log('=== REBUILDING ALL REVIEWS ===\n');
console.log('NOTE: Reviews without valid scores are EXCLUDED (no default of 50)\n');

// Rebuild-pause guard (Schmigadoon 2026 Bug #12).
// If a manual opening-night edit has set a tombstone, exit cleanly BEFORE any
// reads or writes. This prevents a concurrent rebuild from overwriting a
// hand-edited reviews.json during the 10am broadcast window.
// Bypass with --ignore-pause if the tombstone is stale and you know what
// you're doing. Tombstone format + write-side CLI: scripts/pause-rebuild.js.
if (!process.argv.includes('--ignore-pause') && isRebuildPaused()) {
  const entry = readRebuildPause();
  console.log('⏸  REBUILD PAUSED by opening-night manual-edit tombstone');
  console.log(`   File:      ${REBUILD_PAUSE_PATH}`);
  console.log(`   Reason:    ${entry.reason || '(none given)'}`);
  console.log(`   Paused by: ${entry.pausedBy || '(unknown)'}`);
  console.log(`   Paused at: ${entry.pausedAt || '(unknown)'}`);
  console.log(`   Until:     ${entry.until.toISOString()}`);
  console.log('');
  console.log('   Clear:   node scripts/pause-rebuild.js --clear');
  console.log('   Bypass:  node scripts/rebuild-all-reviews.js --ignore-pause');
  console.log('');
  console.log('Exiting cleanly (exit 0) so CI does not alert — pause is intentional.');
  process.exit(0);
}

// Load show dates and status for production-date guard
const showsData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
const showDateMap = {};
const showOpeningDateMap = {};  // showId -> opening date only (NOT previewsStartDate) — for publishDate fallback
const showClosingDateMap = {};
const showStatusMap = {};
const showTitleMap = {};
const showCategoryMap = {};  // showId -> category (e.g., 'west-end', 'broadway')
const showLongRunWE = new Set();  // WE shows with openingDate before 2015 — skip pre-opening guard
const showCreativeTeamIndex = {};  // showId -> Set of lowercase creative team names
const skipCrossShowDupeIds = new Set(showsData.shows.filter(s => s._skipCrossShowDupe).map(s => s.id));
const showById = {};
for (const s of showsData.shows) {
  showById[s.id] = s;
}
for (const s of showsData.shows) {
  // MIN of preview/previews/opening (see earliestShowDate) so an out-of-order
  // stale date can't push the date-guard window later than opening and mis-flag
  // a genuine review filed around opening (Three Houses inverted-date bug).
  const earliest = earliestShowDate(s);
  if (earliest) showDateMap[s.id] = new Date(earliest);
  if (s.openingDate) showOpeningDateMap[s.id] = new Date(s.openingDate);
  if (s.closingDate && s.status === 'closed') showClosingDateMap[s.id] = new Date(s.closingDate);
  showStatusMap[s.id] = s.status;
  showTitleMap[s.id] = s.title;
  showCategoryMap[s.id] = s.category || 'broadway';
  // Long-run WE shows: decades of valid reviews → 90-day pre-opening guard
  // shouldn't apply and CV shouldn't flag wide publishDate ranges. The
  // classifier lives in scripts/lib/long-runner-registry.js so content-verifier
  // can reuse it. See WE long-runner CV hardening card (issue #3).
  if (isLongRunningProduction(s)) {
    showLongRunWE.add(s.id);
  }
  showCreativeTeamIndex[s.id] = new Set();
  if (s.creativeTeam) {
    for (const m of s.creativeTeam) {
      if (m.name) showCreativeTeamIndex[s.id].add(m.name.toLowerCase().trim());
    }
  }
}

// Build URL-year cross-production guard for multi-production shows
// Pattern: review URL contains a year clearly closer to a sibling production = wrong directory
const multiProdYearGuard = buildMultiProdYearGuard(showsData.shows);
{
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

// Multi-production (revival) title index for the dateless-revival guard.
// A show id is "multi-production" when its base title (same normalization as
// the director cross-check guard above) has ≥2 productions in shows.json — the
// regime where a prior production's reviews can be mis-linked to this dir. The
// dateless-revival guard (pre-opening pass below) uses this to decide whether a
// review LACKING any usable date should be held as suspect contamination.
const multiProductionTitleIds = new Set();
{
  const baseTitle = (t) => String(t || '').replace(/\s*\(.*?\)/g, '').replace(/:\s.*$/, '').trim().toLowerCase();
  const titleGroups = {};
  for (const s of showsData.shows) {
    const base = baseTitle(s.title);
    if (!base) continue;
    (titleGroups[base] = titleGroups[base] || []).push(s.id);
  }
  for (const ids of Object.values(titleGroups)) {
    if (ids.length >= 2) ids.forEach(id => multiProductionTitleIds.add(id));
  }
}

// Get all show directories (filter out orphan dirs that don't match any show in shows.json)
const validShowIds = new Set(showsData.shows.map(s => s.id));
const showDirs = listShowDirs(reviewTextsDir)
  .filter(f => {
    const fullPath = path.join(reviewTextsDir, f);
    // Skip symlinks to avoid processing the same directory twice
    if (fs.lstatSync(fullPath).isSymbolicLink()) return false;
    if (!fs.statSync(fullPath).isDirectory()) return false;
    // Skip orphaned review directories (show was renamed/merged/deleted)
    if (!validShowIds.has(f)) {
      console.warn(`  Skipping orphaned review directory: ${f}`);
      logExclusion("skippedOrphanDirs", f, "-", null, { reason: "show dir not in shows.json" });
      stats.skippedOrphanDirs = (stats.skippedOrphanDirs || 0) + 1;
      return false;
    }
    return true;
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
//
// Delegates to canonicalizeUrlForDedup (scripts/lib/review-guards.js) so the tracking-param
// registry stays in one place — any outlet-specific tracking params added there
// (?triedRedirect, ?gaa_at, etc.) are stripped here too. Locally strips the
// scheme + www. prefix for the cross-show Map key shape callers already expect.
function normalizeUrlForDedup(url) {
    if (!url) return null;
    const canon = canonicalizeUrlForDedup(url);
    if (!canon) return null;
    return canon.replace(/^https?:\/\//, '').replace(/^www\./, '');
}
const crossShowUrlIndex = new Map();
{
  for (const sid of showDirs) {
    if (skipCrossShowDupeIds.has(sid)) continue; // _skipCrossShowDupe: test shows excluded from index
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

// OB→Broadway transfer guard: when an OB show transfers to Broadway, flag OB review files
// that share URLs with the Broadway directory. The critic typically updates the same URL
// for the Broadway run, so the OB copy is superseded. Without this, the OB file claims
// the URL in the crossShowUrlIndex and blocks the Broadway version.
{
  let transferFlagged = 0;
  // Build title→shows map for transfer detection
  const showsByTitle = new Map();
  const showsData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
  for (const s of showsData.shows) {
    const normTitle = s.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!showsByTitle.has(normTitle)) showsByTitle.set(normTitle, []);
    showsByTitle.get(normTitle).push(s);
  }

  for (const [, group] of showsByTitle) {
    if (group.length < 2) continue;
    const obShows = group.filter(s => s.category === 'off-broadway');
    const bwShows = group.filter(s => !s.category || s.category === 'broadway');
    if (obShows.length === 0 || bwShows.length === 0) continue;

    for (const bw of bwShows) {
      // Only flag if Broadway show has opened (status !== 'previews')
      if (bw.status === 'previews') continue;
      const bwDir = path.join(reviewTextsDir, bw.id);
      if (!fs.existsSync(bwDir)) continue;

      // Collect Broadway URLs
      const bwUrls = new Set();
      for (const f of fs.readdirSync(bwDir).filter(x => x.endsWith('.json') && x !== 'failed-fetches.json')) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(bwDir, f), 'utf8'));
          if (d.url) bwUrls.add(normalizeUrlForDedup(d.url));
        } catch {}
      }

      // Flag matching OB files
      for (const ob of obShows) {
        const obDir = path.join(reviewTextsDir, ob.id);
        if (!fs.existsSync(obDir)) continue;
        for (const f of fs.readdirSync(obDir).filter(x => x.endsWith('.json') && x !== 'failed-fetches.json')) {
          try {
            const fp = path.join(obDir, f);
            const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
            if (d.wrongProduction || d.wrongProductionManualClear) continue;
            if (!d.url) continue;
            if (shouldSkipWrongProductionAudit(d)) continue; // [GUARD:OB-BW-TRANSFER]
            const norm = normalizeUrlForDedup(d.url);
            if (norm && bwUrls.has(norm)) {
              d.wrongProduction = true;
              d.wrongProductionReason = 'ob-broadway-transfer';
              d.wrongProductionNote = `OB review superseded by Broadway transfer ${bw.id} (shared URL)`;
              safeWriteReview(fp, d);
              transferFlagged++;
            }
          } catch {}
        }
      }
    }
  }
  if (transferFlagged > 0) {
    console.log(`OB→Broadway transfer guard: flagged ${transferFlagged} OB reviews with shared URLs`);
  }
}

// Pre-opening guard pass: flag reviews published 90+ days before a show's earliest date
// as wrongProduction. Runs on ALL shows regardless of status — a 2019 review filed under
// a 2026 remount is wrong whether the show is in previews, open, or closed.
//
// Production-continuity exemption (Phase 1, 2026-04-29): when a show declares a
// priorRuns[] window and the review's publishDate falls inside it, the review
// is legitimate coverage of an earlier run of THIS production (workshop →
// mainstage transfer, return engagement). Skip the flag — and auto-clear any
// stale flag on the same file from a prior rebuild run.
{
  let preOpenFlagged = 0;
  let priorRunSkipped = 0;
  let priorRunAutoCleared = 0;
  let datelessRevivalFlagged = 0;
  let datelessRevivalAutoCleared = 0;
  for (const sid of showDirs) {
    const showEarliest = showDateMap[sid];
    if (!showEarliest) continue;
    // Long-run WE shows (opened before 2015) — skip pre-opening guard.
    // A 2004 Stage review of Phantom is perfectly valid for a show running since 1986.
    if (showLongRunWE.has(sid)) continue;
    const showRecord = showById[sid];
    const sDir = path.join(reviewTextsDir, sid);
    for (const f of fs.readdirSync(sDir).filter(x => x.endsWith('.json'))) {
      try {
        const fp = path.join(sDir, f);
        const d = JSON.parse(fs.readFileSync(fp, 'utf8'));

        // Resolve a usable review date once (parsed publishDate, else a precise
        // date in the URL). extractDateFromUrl handles /YYYY/MM/DD/, Guardian
        // /YYYY/mon/DD/, compact YYYYMMDD and YYYY-MM-DD — a superset of the old
        // contiguous-only match, so date-bearing URLs like
        // theguardian.com/stage/2017/nov/12/ now resolve and the dated guards
        // below can flag them even post-opening. We require a FULL YYYY-MM-DD
        // (never the bare year or a month-only YYYY-MM): a year defaults to
        // July 1st and a month to the 1st, and that imprecision tripped the
        // 90-day window on genuine reviews near a month boundary (74 FPs in the
        // Class B audit 2026-04-12; a month-only blogspot date mis-flagged a
        // real Bright Star review 2026-06-17).
        // Shared by the dateless-revival auto-clear/guard and the dated
        // pre-opening guard further down.
        let reviewDate = parseDate(d.publishDate);
        if (!reviewDate && d.url) {
          const urlDate = extractDateFromUrl(d.url);
          if (urlDate && urlDate.date && /^\d{4}-\d{2}-\d{2}$/.test(urlDate.date)) {
            const parsed = parseDate(urlDate.date);
            if (parsed && !isNaN(parsed.getTime())) reviewDate = parsed;
          }
        }

        // Dateless-revival auto-clear: our HOLD (set below) is provisional —
        // strip it the moment the review gains a usable date (the dated guard
        // then re-decides) or a human overrides. Runs before the wrongProduction
        // short-circuit so a held file can recover.
        if (shouldAutoClearDatelessRevival(d, { hasUsableDate: !!reviewDate })) {
          const wasNote = d.wrongProductionNote || d.wrongProductionReason || '(no marker)';
          d.wrongProduction = false;
          d.wrongProductionAutoCleared = `rebuild: dateless-revival hold released (was: ${wasNote})`;
          d.wrongProductionAutoClearedAt = new Date().toISOString().split('T')[0];
          delete d.wrongProductionNote;
          if (d.wrongProductionReason === 'dateless-revival') delete d.wrongProductionReason;
          safeWriteReview(fp, d, { force: true });
          datelessRevivalAutoCleared++;
          // Fall through — file may still need the dated pre-opening guard.
        }

        // Production-continuity auto-clear: strip stale Pre-opening/Date guard
        // flags on files whose publishDate now falls inside a priorRuns window.
        // Respects manual reasons + high-confidence CV (mirrors URL-year auto-clear).
        // Also strips the auto-set wrongProductionReason values written by date
        // setters (e.g. collect-review-texts.js anticipatory gate's
        // "anticipatory_pre_opening_post"); ALL operator-set reasons are protected.
        if (shouldAutoClearWrongProductionPriorRun(d, showRecord)) {
          const wasNote = d.wrongProductionNote || d.wrongProductionReason || '(no marker)';
          d.wrongProduction = false;
          d.wrongProductionAutoCleared = `rebuild: priorRuns covers publishDate (was: ${wasNote})`;
          d.wrongProductionAutoClearedAt = new Date().toISOString().split('T')[0];
          delete d.wrongProductionNote;
          // Strip auto-set wrongProductionReason values (anticipatory ingest gate
          // exact match + CV-promoted prefixes). Operator-set reasons are
          // protected — shouldAutoClearWrongProductionPriorRun would have already
          // refused to clear if reason was operator-set.
          const reason = d.wrongProductionReason || '';
          if (reason === 'anticipatory_pre_opening_post') {
            delete d.wrongProductionReason;
            delete d.wrongProductionDetail;
            delete d.wrongProductionDetectedAt;
            delete d.wrongProductionDetectedBy;
            delete d.anticipatoryGateOutletCategory;
            delete d.anticipatoryGateDaysBeforeOpening;
          } else if (reason.startsWith('CV-promoted:') || reason.startsWith('CV-low-but-strong-signal:')) {
            delete d.wrongProductionReason;
          }
          safeWriteReview(fp, d, { force: true });
          priorRunAutoCleared++;
          // Fall through — don't skip, file may still need other guards
        }

        if (d.wrongProduction || d.wrongShow) continue;
        // routedFromShowId: already rerouted — publish date reflects the original show's era
        if (d.routedFromShowId) continue;
        // allowEarlyDate bypasses all date-based flagging
        if (d.allowEarlyDate) continue;
        // Respect manual clears UNLESS publishDate is >365 days before the show's
        // earliest date — a prior-production review is wrong regardless of manual override.
        // Threshold raised from 180→365 and requires publishDate specifically (no URL fallback)
        // because the 180-day threshold combined with URL-extracted dates caused false overrides.
        if (d.wrongProductionManualClear) {
          let mcReviewDate = parseDate(d.publishDate);
          if (!mcReviewDate || (showEarliest - mcReviewDate) <= 365 * 86400000) continue;
          // Extreme date mismatch (>1 year with reliable publishDate) — override manual clear
        }
        // (reviewDate resolved above, shared with the dateless-revival auto-clear.
        // YYYY-only URL fallback intentionally omitted: a year alone defaults to
        // July 1st — too imprecise for a 90-day guard, caused 74 false positives
        // in the Class B audit 2026-04-12. Only YYYYMMDD is specific enough.)
        if (reviewDate && (showEarliest - reviewDate) > 90 * 86400000 && !d.wrongProductionCleared && d.humanReviewedWrongProduction !== false && !shouldSkipWrongProductionAudit(d)) {
          // Production-continuity skip: review falls inside a declared priorRuns window
          if (showRecord && isWithinPriorRun(reviewDate, showRecord.priorRuns)) {
            priorRunSkipped++;
            continue;
          }
          console.log(`  [PRE-OPENING] ${sid}/${f}: review ${reviewDate.toISOString().split('T')[0]} is 90+ days before show ${showEarliest.toISOString().split('T')[0]}`);
          d.wrongProduction = true;
          d.wrongProductionNote = `Pre-opening guard: review dated ${reviewDate.toISOString().split('T')[0]} is 90+ days before show starts ${showEarliest.toISOString().split('T')[0]}`;
          safeWriteReview(fp, d);
          preOpenFlagged++;
        } else if (!reviewDate && !d.wrongProductionCleared && d.humanReviewedWrongProduction !== false && !shouldSkipWrongProductionAudit(d)) {
          // Dateless-revival guard: a review with NO usable date escapes every
          // dated guard above and defaults to includable. On a multi-production
          // (revival) title that has NOT yet opened, that is necessarily a
          // mis-linked prior-production review — critics have not filed for the
          // current production yet (CV cannot rescue — it false-confirms same-
          // title prior productions; see feedback_llm_verifier_hallucinates).
          // HOLD it as wrongProduction; the flag persists past the open flip and
          // the auto-clear above releases it the moment a usable date or human
          // override arrives.
          const verdict = evaluateDatelessRevivalGuard({
            hasUsableDate: false,
            isMultiProductionTitle: multiProductionTitleIds.has(sid),
            show: showRecord,
          });
          if (verdict.flag) {
            console.log(`  [DATELESS-REVIVAL] ${sid}/${f}: no usable date on not-yet-opened multi-production title`);
            d.wrongProduction = true;
            d.wrongProductionReason = 'dateless-revival';
            d.wrongProductionNote = `Dateless revival guard: no publishDate on multi-production title that has not yet opened — unverified production (show starts ${showEarliest.toISOString().split('T')[0]})`;
            safeWriteReview(fp, d);
            datelessRevivalFlagged++;
          }
        }
      } catch { /* skip unreadable */ }
    }
  }
  if (preOpenFlagged > 0) {
    console.log(`Pre-opening guard: flagged ${preOpenFlagged} reviews as wrongProduction\n`);
  }
  if (datelessRevivalFlagged > 0) {
    console.log(`Dateless-revival guard: held ${datelessRevivalFlagged} dateless reviews on recent revival titles\n`);
  }
  if (datelessRevivalAutoCleared > 0) {
    console.log(`Dateless-revival guard: auto-cleared ${datelessRevivalAutoCleared} reviews (date/override arrived)\n`);
  }
  if (priorRunAutoCleared > 0) {
    console.log(`Pre-opening guard: auto-cleared ${priorRunAutoCleared} reviews via priorRuns window\n`);
  }
  if (priorRunSkipped > 0) {
    console.log(`Pre-opening guard: skipped ${priorRunSkipped} reviews via priorRuns window\n`);
  }
  stats.preOpeningFlagged = preOpenFlagged;
  stats.priorRunAutoCleared = priorRunAutoCleared;
  stats.priorRunSkipped = priorRunSkipped;
  stats.datelessRevivalFlagged = datelessRevivalFlagged;
  stats.datelessRevivalAutoCleared = datelessRevivalAutoCleared;
}

// Stale --unknown filename cleanup: when a file is named --unknown but its critic was enriched,
// rename it to match the enriched critic name. If a named file already exists, merge unique fields
// from the --unknown file into it and delete the stale --unknown file. This prevents duplicate
// entries in validate-review-texts.js (which keys on JSON criticName, not filename).
{
  let renamedCount = 0, mergedCount = 0, errorCount = 0;
  for (const sid of showDirs) {
    const sDir = path.join(reviewTextsDir, sid);
    const unknownFiles = fs.readdirSync(sDir).filter(f => f.endsWith('.json') && f.includes('--unknown'));
    for (const f of unknownFiles) {
      try {
        const filePath = path.join(sDir, f);
        const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const critic = (d.criticName || '').trim();
        if (!critic || critic.toLowerCase() === 'unknown' || critic.toLowerCase() === 'unnamed') continue;
        // Critic was enriched — filename is stale
        const outletId = normalizeOutletCanonical(d.outletId || d.outlet);
        const expectedFilename = generateReviewFilename(outletId, critic);
        if (expectedFilename === f) continue; // Already correct (shouldn't happen but guard)
        const expectedPath = path.join(sDir, expectedFilename);
        if (fs.existsSync(expectedPath)) {
          // Named file exists — merge unique fields from --unknown, then delete it
          const existingData = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
          let merged = false;
          for (const [key, val] of Object.entries(d)) {
            if (val != null && !existingData[key]) {
              existingData[key] = val;
              merged = true;
            }
          }
          if (merged) {
            safeWriteReview(expectedPath, existingData);
          }
          // Clear any sibling files that point at this file via duplicateOf —
          // otherwise the audit-duplicate-of-url-mismatch CI gate flags them
          // as sibling-missing and Data Validation fails until --fix runs.
          cascadeClearDuplicateRefs(sDir, f);
          fs.unlinkSync(filePath);
          mergedCount++;
        } else {
          // No named file — just rename
          fs.renameSync(filePath, expectedPath);
          renamedCount++;
        }
      } catch (e) {
        errorCount++;
        console.warn(`  [stale-unknown] Error processing ${sid}/${f}: ${e.message}`);
      }
    }
  }
  if (renamedCount > 0 || mergedCount > 0) {
    console.log(`Stale --unknown cleanup: ${renamedCount} renamed, ${mergedCount} merged+deleted${errorCount ? `, ${errorCount} errors` : ''}`);
  }
  stats.staleUnknownRenamed = renamedCount;
  stats.staleUnknownMerged = mergedCount;
}

// Stale outlet-mismatch cleanup: when a file's outlet prefix doesn't match the outletId in JSON
// (e.g., timeout--critic.json but outletId is "timeout-london" due to URL-based resolution),
// rename or merge into the correctly-named file.
// Uses fresh readdirSync per directory (not cached from Pass 1) to see renamed files correctly.
{
  let renamedCount = 0, mergedCount = 0, errorCount = 0;
  for (const sid of showDirs) {
    const sDir = path.join(reviewTextsDir, sid);
    for (const f of fs.readdirSync(sDir).filter(x => x.endsWith('.json'))) {
      try {
        const filePath = path.join(sDir, f);
        if (!fs.existsSync(filePath)) continue; // File may have been renamed by Pass 1
        const fileOutlet = f.split('--')[0];
        const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const jsonOutlet = normalizeOutletCanonical(d.outletId || d.outlet);
        if (!jsonOutlet || !fileOutlet || jsonOutlet === fileOutlet) continue;
        const expectedFilename = generateReviewFilename(jsonOutlet, d.criticName || 'Unknown');
        if (expectedFilename === f) continue;
        const expectedPath = path.join(sDir, expectedFilename);
        if (fs.existsSync(expectedPath)) {
          // Named file exists — merge unique fields, delete stale
          const existingData = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
          let merged = false;
          for (const [key, val] of Object.entries(d)) {
            if (val != null && !existingData[key]) {
              existingData[key] = val;
              merged = true;
            }
          }
          if (merged) {
            safeWriteReview(expectedPath, existingData);
          }
          // Cascade-clear duplicateOf siblings before unlinking (see Pass 1).
          cascadeClearDuplicateRefs(sDir, f);
          fs.unlinkSync(filePath);
          mergedCount++;
        } else {
          // No correctly-named file — just rename
          fs.renameSync(filePath, expectedPath);
          renamedCount++;
        }
      } catch (e) {
        errorCount++;
        console.warn(`  [outlet-mismatch] Error processing ${sid}/${f}: ${e.message}`);
      }
    }
  }
  if (renamedCount > 0 || mergedCount > 0) {
    console.log(`Stale outlet-mismatch cleanup: ${renamedCount} renamed, ${mergedCount} merged+deleted${errorCount ? `, ${errorCount} errors` : ''}`);
  }
  stats.staleOutletRenamed = renamedCount;
  stats.staleOutletMerged = mergedCount;
}

// URL-domain mismatch guard: detect reviews where URL domain doesn't match outlet's registered domain.
// Audit-only — logs mismatches but does NOT write wrongUrl to files. The wrongUrl flag should be
// applied by a dedicated script (e.g., audit-wrong-urls.js) after human review, not during rebuild.
// This prevents rebuild from permanently flagging files based on incomplete domain alias coverage.
{
  const { OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES } = require('./lib/url-discovery');
  const { domainMatchesExpected } = require('./lib/scraper');
  const EXEMPT_URL_DOMAINS = new Set(['newspapers.com']);
  const EXEMPT_OUTLET_IDS = new Set(['ap', 'reuters', 'upi']);
  let domainMismatchDetected = 0;
  for (const sid of showDirs) {
    const sDir = path.join(reviewTextsDir, sid);
    for (const f of fs.readdirSync(sDir).filter(x => x.endsWith('.json') && x !== 'failed-fetches.json')) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(sDir, f), 'utf8'));
        if (d.wrongUrl || d.wrongShow || d.wrongProduction || d.duplicateOf) continue;
        if (!d.url || !d.outletId) continue;
        const outletId = (d.outletId || '').toLowerCase();
        if (EXEMPT_OUTLET_IDS.has(outletId)) continue;
        const expectedDomain = OUTLET_DOMAINS[outletId];
        if (!expectedDomain) continue;
        let urlDomain;
        try {
          urlDomain = new URL(d.url).hostname.replace(/^www\./, '');
        } catch { continue; }
        if (EXEMPT_URL_DOMAINS.has(urlDomain)) continue;
        if (urlDomain.endsWith('.blogspot.com') && urlDomain.includes(outletId.replace(/-/g, ''))) continue;
        if (domainMatchesExpected(expectedDomain.replace(/^www\./, ''), urlDomain)) continue;
        domainMismatchDetected++;
      } catch { /* skip unreadable */ }
    }
  }
  if (domainMismatchDetected > 0) {
    console.log(`URL-domain audit: ${domainMismatchDetected} reviews have mismatched URL domains (audit-only, not flagged)\n`);
  }
  stats.domainMismatchDetected = domainMismatchDetected;
}

// KNOWN_SYNDICATION_PAIRS imported from ./lib/syndication-pairs (Pattern Card #6)

// === PRE-PASS: Promote contentVerification flags to top-level on ALL files ===
// This runs before the main loop so flags are set even on upcoming/duplicate files
// that the main loop skips. The reason string prevents the auto-clear from overriding.
{
  let cvPromoted = 0;
  for (const sid of showDirs) {
    const sDir = path.join(reviewTextsDir, sid);
    const sCat = showCategoryMap[sid] || 'broadway';
    let files;
    try { files = fs.readdirSync(sDir).filter(x => x.endsWith('.json') && x !== 'failed-fetches.json'); } catch { continue; }
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(sDir, f), 'utf8'));
        const cv = d.contentVerification;
        if (!cv) continue;
        // Schmigadoon 2026-04-21 bypass: CV rows with confidence='low' AND explicit
        // "completely different show" markers are treated as eligible for promotion.
        // The temporal override downgraded them, but the CV.issues evidence is definitive.
        const cvLowButStrong = cv.confidence === 'low'
          && cv.wrongProduction === true
          && hasStrongDifferentShowSignal(cv.issues, cv.reasoning);
        if (cv.confidence !== 'high' && cv.confidence !== 'medium' && !cvLowButStrong) continue;
        // Staleness check
        let stale = false;
        if (d.textFetchedAt && cv.verifiedAt) {
          if (new Date(d.textFetchedAt).getTime() > new Date(cv.verifiedAt).getTime()) stale = true;
        }
        if (!stale && cv.contentHash && d.fullText) {
          const h = crypto.createHash('md5').update(d.fullText.substring(0, 2500)).digest('hex');
          if (cv.contentHash !== h) stale = true;
        }
        // EXCEPTION: never skip staleness for high-confidence wrongArticle findings.
        // Hash mismatch means the text was re-fetched, but if the LLM said with high
        // confidence "this is the wrong show", that judgment is almost always still valid
        // (we re-fetch the same URL, which yields the same wrong page). Found in WE
        // pre-Reddit-launch audit (2026-04-10): Matilda was rendering a TimeOut
        // Paddington review at 100, Harry Potter rendering a David Lan play, etc.
        const trustWrongArticleDespiteStale = cv.wrongArticle === true && cv.confidence === 'high';
        if (stale && !trustWrongArticleDespiteStale) continue;
        let promoted = false;
        // Balusters CLASS 1 generalization (2026-04-22): CV.wrongProduction is advisory
        // when (a) the ensemble scored this file with confidence AND (b) CV itself is
        // medium-confidence (not high) AND (c) this is NOT the cvLowButStrong path
        // (strong "different show" markers in issues/reasoning still promote).
        // High-conf CV continues to promote — that's the hard venue/tour/prior-production
        // signal. Medium-conf CV vs confident ensemble = ensemble wins.
        const ppEnsembleSaysReview = hasHighConfidenceLlmScore(d);
        const ppCvWpAdvisory = ppEnsembleSaysReview && cv.confidence !== 'high' && !cvLowButStrong;
        // Production-continuity gate (Phase 1): operator-declared priorRuns trumps
        // CV's wrongProduction (CV identifies a different venue/run, which is
        // exactly what priorRuns IS for). Skip promotion — operator-trust over CV.
        const ppInPriorRun = isWithinPriorRun(d.publishDate, showById[sid]?.priorRuns);
        // Festival-venue carve-out (R&J Delacorte 2026-06-15): a stale CV row whose
        // wrongProduction is purely a "Delacorte/Shakespeare-in-the-Park is not an
        // Off-Broadway venue" objection must not be promoted. New CV writes already
        // clear it at verify time; this protects rows verified before the fix.
        // Gated (ship-check P0, 2026-06-16): only suppress (a) when the review is
        // in THIS show's own run window — never on reasoning text alone — and (b)
        // when it is NOT the cvLowButStrong path, so the Schmigadoon EBT "different
        // show" strong-signal promotion is preserved.
        const ppVenueCarveout = !cvLowButStrong
          && applyVenueClassificationCarveout(cv, showById[sid]).clearedWrongProduction
          && isReviewWithinOwnProductionWindow(showById[sid], d.publishDate);
        if (cv.wrongProduction === true && d.wrongProduction !== true
            && !shouldSkipWrongProductionAudit(d) && !d.allowEarlyDate && !d.allowCrossMarket
            && !ppCvWpAdvisory && !ppInPriorRun && !ppVenueCarveout) {
          // [GUARD:CV-PRE-PASS] DoaS Apr 9-10 #10: was the source of the bug.
          d.wrongProduction = true;
          const promotionPath = cvLowButStrong ? 'CV-low-but-strong-signal' : 'CV-promoted';
          d.wrongProductionReason = d.wrongProductionReason || `${promotionPath}: ${(cv.reasoning || '').substring(0, 200)}`;
          promoted = true;
          if (cvLowButStrong) {
            stats.cvLowStrongSignalPromoted = (stats.cvLowStrongSignalPromoted || 0) + 1;
          }
        } else if (cv.wrongProduction === true && ppVenueCarveout) {
          stats.cvWrongProductionVenueCarveout = (stats.cvWrongProductionVenueCarveout || 0) + 1;
        } else if (cv.wrongProduction === true && ppInPriorRun) {
          stats.cvWrongProductionPriorRunSuppressed = (stats.cvWrongProductionPriorRunSuppressed || 0) + 1;
        } else if (cv.wrongProduction === true && ppCvWpAdvisory) {
          stats.cvWrongProductionAdvisory = (stats.cvWrongProductionAdvisory || 0) + 1;
        }
        const wpConf = cv.confidence || 'medium';
        const skipLondon = isLondonMarket(sCat) && isUkOutletUrl(d.url) && wpConf !== 'high';
        // Balusters postmortem CLASS 1: If the ensemble scored this with confidence, CV.wrongArticle
        // is advisory, not blocking. Don't promote to wrongShow.
        const ensembleSaysReview = hasHighConfidenceLlmScore(d);
        if (cv.wrongArticle === true && !ensembleSaysReview && d.wrongShow !== true && !skipLondon && !d.allowEarlyDate && !d.allowCrossMarket) {
          // CV outlet-style override (S3-T5): defer wrongShow for known long-biographical
          // outlets when the text is substantive + opinionated. The CV pass false-positives
          // on Vulture/NY Sun/NYSR/NYT long-biographical leads. flaggedForReview surfaces
          // these to humanReview rather than auto-promoting.
          if (shouldDeferCvWrongShow(d)) {
            d.flaggedForReview = true;
            d.flagReason = 'cv-promotion-deferred';
            stats.cvPromotionDeferred = (stats.cvPromotionDeferred || 0) + 1;
            try { safeWriteReview(path.join(sDir, f), d); } catch {}
          } else {
            d.wrongShow = true;
            d.wrongShowReason = d.wrongShowReason || `CV-promoted: ${(cv.reasoning || '').substring(0, 200)}`;
            promoted = true;
          }
        } else if (cv.wrongArticle === true && ensembleSaysReview) {
          stats.cvWrongArticleAdvisory = (stats.cvWrongArticleAdvisory || 0) + 1;
        }
        if (cv.isFilmTv === true && !ensembleSaysReview && d.wrongShow !== true && !skipLondon && !d.allowEarlyDate && !d.allowCrossMarket) {
          if (shouldDeferCvWrongShow(d)) {
            d.flaggedForReview = true;
            d.flagReason = 'cv-promotion-deferred';
            stats.cvPromotionDeferred = (stats.cvPromotionDeferred || 0) + 1;
            try { safeWriteReview(path.join(sDir, f), d); } catch {}
          } else {
            d.wrongShow = true;
            d.wrongShowReason = d.wrongShowReason || `CV-promoted (film/TV): ${(cv.reasoning || '').substring(0, 200)}`;
            promoted = true;
          }
        }
        if (promoted) {
          d.contentVerificationPromoted = `rebuild: promoted from contentVerification (${cv.verifiedBy}, ${cv.confidence})`;
          try { safeWriteReview(path.join(sDir, f), d); } catch {}
          cvPromoted++;
        }
      } catch { /* skip malformed */ }
    }
  }
  if (cvPromoted > 0) console.log(`  CV pre-pass: promoted ${cvPromoted} contentVerification flags`);
}

showDirs.forEach(showId => {
  // Skip Broadway shows in previews — they haven't opened yet, all reviews are wrong-production
  // Off-Broadway and West End shows commonly get reviewed during previews, so don't skip them
  const showCat = showCategoryMap[showId] || 'broadway';
  if (showStatusMap[showId] === 'previews' && showCat === 'broadway') {
    logExclusion("skippedPreviewsShows", showId, "-", null, { reason: "Broadway show in previews — not yet opened" });
    stats.skippedPreviewsShows = (stats.skippedPreviewsShows || 0) + 1;
    return;
  }

  // Skip shows in "upcoming" status across all markets — no valid reviews can exist yet
  // BUT: still promote contentVerification flags on upcoming shows so flags are ready when show opens
  if (showStatusMap[showId] === 'upcoming') {
    const upcomingDir = path.join(reviewTextsDir, showId);
    try {
      const upcomingFiles = fs.readdirSync(upcomingDir).filter(f => f.endsWith('.json'));
      for (const uf of upcomingFiles) {
        try {
          const ud = JSON.parse(fs.readFileSync(path.join(upcomingDir, uf), 'utf8'));
          const ucv = ud.contentVerification;
          if (!ucv || (ucv.confidence !== 'high' && ucv.confidence !== 'medium')) continue;
          let promoted = false;
          // Balusters CLASS 1: ensemble-scored reviews defeat CV's wrongArticle/wrongProduction
          // when CV is medium-confidence (high-conf CV still wins).
          const uEnsembleSaysReview = hasHighConfidenceLlmScore(ud);
          const uCvWpAdvisory = uEnsembleSaysReview && ucv.confidence !== 'high';
          // Production-continuity gate (Phase 1): when the operator has declared
          // a priorRun window covering this review's publishDate, CV's wrongProduction
          // is a known false positive (CV identifies an earlier production at a
          // different venue, which is exactly what priorRuns IS for). Skip
          // promotion — operator-trust over CV.
          const uInPriorRun = isWithinPriorRun(ud.publishDate, showById[showId]?.priorRuns);
          if (ucv.wrongProduction === true && ud.wrongProduction !== true && !shouldSkipWrongProductionAudit(ud) && !ud.allowEarlyDate && !ud.allowCrossMarket && !uCvWpAdvisory && !uInPriorRun) {
            // [GUARD:CV-PRE-PASS-UPCOMING]
            ud.wrongProduction = true;
            ud.wrongProductionReason = `CV-promoted: ${(ucv.reasoning || '').substring(0, 200)}`;
            promoted = true;
          } else if (ucv.wrongProduction === true && uInPriorRun) {
            stats.cvWrongProductionPriorRunSuppressed = (stats.cvWrongProductionPriorRunSuppressed || 0) + 1;
          } else if (ucv.wrongProduction === true && uCvWpAdvisory) {
            stats.cvWrongProductionAdvisory = (stats.cvWrongProductionAdvisory || 0) + 1;
          }
          if (ucv.wrongArticle === true && !uEnsembleSaysReview && ud.wrongShow !== true && !ud.allowEarlyDate && !ud.allowCrossMarket) {
            // CV outlet-style override (S3-T5 followup): defer wrongShow for known long-biographical
            // outlets even on upcoming-show path. Long-biographical previews share the same
            // FP class as opening-day reviews (e.g., NY Sun biographical lead on an upcoming show).
            if (shouldDeferCvWrongShow(ud)) {
              ud.flaggedForReview = true;
              ud.flagReason = 'cv-promotion-deferred';
              stats.cvPromotionDeferred = (stats.cvPromotionDeferred || 0) + 1;
              try { safeWriteReview(path.join(upcomingDir, uf), ud); } catch (e) {}
            } else {
              ud.wrongShow = true;
              ud.wrongShowReason = `CV-promoted: ${(ucv.reasoning || '').substring(0, 200)}`;
              promoted = true;
            }
          } else if (ucv.wrongArticle === true && uEnsembleSaysReview) {
            stats.cvWrongArticleAdvisory = (stats.cvWrongArticleAdvisory || 0) + 1;
          }
          if (promoted) {
            ud.contentVerificationPromoted = `rebuild: promoted from contentVerification (${ucv.verifiedBy}, ${ucv.confidence})`;
            stats.contentVerificationPromoted = (stats.contentVerificationPromoted || 0) + 1;
            try { safeWriteReview(path.join(upcomingDir, uf), ud); } catch (e) {}
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* no dir */ }
    logExclusion("skippedUpcomingShows", showId, "-", null, { reason: "Show in 'upcoming' status — no valid reviews yet", status: showStatusMap[showId] });
    stats.skippedUpcomingShows = (stats.skippedUpcomingShows || 0) + 1;
    return;
  }

  const showDir = path.join(reviewTextsDir, showId);
  const allJsonFiles = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  // Pre-read sort metadata once per file (avoids O(N log N) repeated reads in comparator)
  const sortMeta = new Map();
  for (const f of allJsonFiles) {
    const meta = { isDupe: 0, isVerified: 1, hasEnsemble: 1, isOutletAsCritic: 0 };
    try {
      const d = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
      meta.isDupe = (d.isDuplicate || d.duplicateOf || d.duplicateTextOf) ? 1 : 0;
      meta.isVerified = d.contentVerification?.isValid ? 0 : 1;
      meta.hasEnsemble = d.ensembleData ? 0 : 1;
      // Detect outlet-as-critic files (e.g., nydailynews--new-york-daily-news.json)
      // so they sort AFTER real-critic files, ensuring the existing outlet-as-critic
      // dedup mechanism (line ~1873) fires correctly
      if (d.criticName) {
        const rawCritic = d.criticName.toLowerCase().trim();
        const rawOutletId = (d.outletId || '').toLowerCase().trim();
        const rawOutlet = (d.outlet || '').toLowerCase().trim();
        const displayName = (getOutletDisplayName(normalizeOutletCanonical(d.outletId || d.outlet)) || '').toLowerCase().trim();
        if (rawCritic === rawOutletId || rawCritic === rawOutlet || rawCritic === displayName ||
            rawCritic === displayName.replace(/^the\s+/, '')) {
          meta.isOutletAsCritic = 1;
        }
      }
    } catch { /* defaults are conservative */ }
    sortMeta.set(f, meta);
  }

  // Sort: prefer higher-quality files first for dedup tiebreaking (first-seen wins)
  // Priority: non-duplicate > non-unknown > non-outlet-as-critic > verified > ensemble-scored > alphabetical
  const files = allJsonFiles.sort((a, b) => {
    const aUnknown = /unknown|unnamed/i.test(a) ? 1 : 0;
    const bUnknown = /unknown|unnamed/i.test(b) ? 1 : 0;
    if (aUnknown !== bUnknown) return aUnknown - bUnknown;
    const am = sortMeta.get(a), bm = sortMeta.get(b);
    if (am.isDupe !== bm.isDupe) return am.isDupe - bm.isDupe;
    // Deprioritize outlet-as-critic files so real critics are processed first
    if (am.isOutletAsCritic !== bm.isOutletAsCritic) return am.isOutletAsCritic - bm.isOutletAsCritic;
    if (am.isVerified !== bm.isVerified) return am.isVerified - bm.isVerified;
    if (am.hasEnsemble !== bm.hasEnsemble) return am.hasEnsemble - bm.hasEnsemble;
    return a.localeCompare(b);
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
  // Track content fingerprints globally (cross-outlet) to catch same article under different outlet variations
  const seenFingerprintsGlobal = new Map();

  files.forEach(file => {
    try {
      const filePath = path.join(showDir, file);
      const rawContent = fs.readFileSync(filePath, 'utf8');

      // Guard: detect git merge conflict markers (silent data corruption)
      if (/^<{7}\s|^={7}$|^>{7}\s/m.test(rawContent)) {
        console.error(`  [CORRUPTED] ${showId}/${file}: contains git merge conflict markers — SKIPPING`);
        logExclusion("skippedCorrupted", showId, file, null, { reason: "git merge conflict markers in file" });
        stats.skippedCorrupted = (stats.skippedCorrupted || 0) + 1;
        if (!stats.corruptedFiles) stats.corruptedFiles = [];
        stats.corruptedFiles.push(`${showId}/${file}`);
        return;
      }

      const data = JSON.parse(rawContent);

      // Auto-migrate aggregator-sourced originalScore → aggregatorStars.
      // Defense-in-depth for the aggregator-score guard: no matter which extractor
      // wrote originalScore with a scoreSource in AGGREGATOR_SCORE_SOURCES (show-score-stars,
      // lbo-star-rating, theatre-reviews-star-rating, etc.), move the value to aggregatorStars
      // and clear originalScore. Show Score / LBO / TR are aggregators — their "stars" are
      // their own interpretation and must not be treated as the outlet's published rating.
      //
      // MUST run BEFORE every skip check (wrongProduction, duplicateOf, isNotReview, etc.)
      // because contaminated files are usually flagged with one of those, which would skip
      // the migration via early return otherwise. Pure data normalization — runs on every
      // file regardless of whether it contributes to the final score.
      // See memory/feedback_aggregator_score_guard.md.
      if (data.originalScore && data.scoreSource && AGGREGATOR_SCORE_SOURCES.has(data.scoreSource)) {
        if (!data.aggregatorStars) {
          data.aggregatorStars = data.originalScore;
        }
        data.originalScore = null;
        if (data.originalScoreNormalized != null) {
          data.originalScoreNormalized = null;
        }
        if (data.originalScoreSource && AGGREGATOR_SCORE_SOURCES.has(data.originalScoreSource)) {
          data.originalScoreSource = null;
        }
        try {
          safeWriteReview(filePath, data, { force: true });
          stats.migratedAggregatorScore = (stats.migratedAggregatorScore || 0) + 1;
        } catch (e) {
          console.warn('  Failed to write back aggregator-score migration:', file, e.message);
        }
      }

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

      // Clear stale ensembleData: if llmMetadata.model is not an ensemble model,
      // the ensembleData is from a prior scoring pass and no longer matches the current score.
      // This prevents stale ensemble metadata from affecting scoring priority decisions.
      if (data.ensembleData && data.llmMetadata?.model && !data.llmMetadata.model.startsWith('ensemble:')) {
        delete data.ensembleData;
        stats.staleEnsembleCleared = (stats.staleEnsembleCleared || 0) + 1;
      }

      // Reclassify contentTier as safety net (in case collect-review-texts missed it)
      // Also write back to source file if tier changed (prevents stale classifications)
      {
        const tierResult = classifyContentTier(data);
        const oldTier = data.contentTier;
        data.contentTier = tierResult.contentTier;
        // Propagate truncationSignals so classifyIncompleteReason (called next) can
        // use them for routing (e.g., nyt_bot_stub → bot_blocked not paywall).
        if (tierResult.truncationSignals) data.truncationSignals = tierResult.truncationSignals;
        if (!oldTier || oldTier !== tierResult.contentTier) {
          try {
            const sourceData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            sourceData.contentTier = tierResult.contentTier;
            sourceData.contentTierReason = tierResult.tierReason;
            sourceData.wordCount = tierResult.wordCount;
            safeWriteReview(filePath, sourceData, { force: true });
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
            safeWriteReview(filePath, sourceData, { force: true });
          } catch (writeErr) { /* Non-fatal */ }
        }
      }

      // Skip files flagged as duplicates by cleanup-review-sources.js
      // But only if the referenced file exists and is NOT also flagged as a duplicate
      // AND the reference wouldn't be excluded by other guards (prevents both files being dropped)
      if (data.duplicateOf) {
        // Sentinel values like "known-outlet-copy-exists" indicate a confirmed duplicate
        // even without a specific reference file — always skip these
        if (!data.duplicateOf.endsWith('.json')) {
          logExclusion("skippedDuplicateOf", showId, file, data);
          stats.skippedDuplicateOf = (stats.skippedDuplicateOf || 0) + 1;
          return;
        }
        const refPath = path.join(showDir, data.duplicateOf);
        let refAlsoDupe = false;
        let refExcluded = false;
        let isCircular = false;
        let circularSameText = false;
        try {
          const refData = JSON.parse(fs.readFileSync(refPath, 'utf8'));
          refAlsoDupe = !!refData.duplicateOf || !!refData.duplicateTextOf;
          isCircular = refData.duplicateOf === file || refData.duplicateTextOf === file;
          // Only tiebreak on TRUE duplicates — same content fingerprint.
          // Named-critic pairs with DIFFERENT text are legitimate separate reviews;
          // duplicateOf was wrongly set on them. Preserve them (pre-fix behavior).
          if (isCircular && data.fullText && refData.fullText) {
            const a = computeContentFingerprint(data.fullText);
            const b = computeContentFingerprint(refData.fullText);
            circularSameText = !!(a && b && a === b);
          }
          // Check if reference would be excluded by later guards
          refExcluded = !isIncludableForRebuild(refData, showById[showId]);
          if (!refExcluded && refData.publishDate && showDateMap[showId] && !refData.allowEarlyDate) {
            const refPubDate = new Date(refData.publishDate);
            const openDate = showDateMap[showId];
            const daysBefore = Math.ceil((openDate - refPubDate) / (1000 * 60 * 60 * 24));
            const isFlexCat = showCat === 'off-broadway' || isLondonMarket(showCat);
            const threshold = isFlexCat ? 90 : 14;
            // Production-continuity exemption: refData falls inside a declared priorRuns window
            const inPriorRun = isWithinPriorRun(refPubDate, showById[showId]?.priorRuns);
            if (daysBefore > threshold && !inPriorRun) refExcluded = true;
          }
          if (refExcluded) stats.dupeRefExcludedRecovered = (stats.dupeRefExcludedRecovered || 0) + 1;
        } catch {
          refAlsoDupe = true; // Reference file missing — stale flag
        }
        if (!refAlsoDupe && !refExcluded) {
          logExclusion("skippedDuplicateOf", showId, file, data);
          stats.skippedDuplicateOf = (stats.skippedDuplicateOf || 0) + 1;
          return;
        }
        // Circular tiebreaker: when A.duplicateOf=B AND B.duplicateOf=A AND texts match,
        // both files would be double-counted. Exclude the lexicographically-greater filename;
        // the other side keeps itself. Only applied when content fingerprints match —
        // otherwise duplicateOf is wrongly set and we keep both to avoid regressing real reviews.
        if (isCircular && circularSameText && !refExcluded && file > data.duplicateOf) {
          logExclusion("skippedCircularDuplicateTiebreak", showId, file, data);
          stats.skippedCircularDuplicateTiebreak = (stats.skippedCircularDuplicateTiebreak || 0) + 1;
          return;
        }
        // Circular (kept side, different-text, stale, or ref excluded) — let through
        stats.circularDuplicateRecovered = (stats.circularDuplicateRecovered || 0) + 1;
      }

      // Skip files flagged as duplicate text of another review (same content, different critic)
      // Set by collect-review-texts.js content fingerprinting
      // But only if the referenced file exists, is NOT also flagged, AND wouldn't be excluded
      // by other guards. Otherwise both the original and the "duplicate" get silently dropped.
      if (data.duplicateTextOf) {
        const refPath = path.join(showDir, data.duplicateTextOf);
        let refAlsoDupe = false;
        let refWouldBeExcluded = false;
        let staleFlag = false;
        let isCircular = false;
        let circularSameText = false;
        try {
          const refData = JSON.parse(fs.readFileSync(refPath, 'utf8'));
          refAlsoDupe = !!refData.duplicateTextOf || !!refData.duplicateOf;
          isCircular = refData.duplicateTextOf === file || refData.duplicateOf === file;
          if (isCircular && data.fullText && refData.fullText) {
            const a = computeContentFingerprint(data.fullText);
            const b = computeContentFingerprint(refData.fullText);
            circularSameText = !!(a && b && a === b);
          }
          // Check if reference would be excluded by later guards
          refWouldBeExcluded = !isIncludableForRebuild(refData, showById[showId]);
          if (!refWouldBeExcluded && refData.publishDate && showDateMap[showId] && !refData.allowEarlyDate) {
            const refPubDate = new Date(refData.publishDate);
            const openDate = showDateMap[showId];
            const daysBefore = Math.ceil((openDate - refPubDate) / (1000 * 60 * 60 * 24));
            const isFlexCat = showCat === 'off-broadway' || isLondonMarket(showCat);
            const threshold = isFlexCat ? 90 : 14;
            // Production-continuity exemption: refData falls inside a declared priorRuns window
            const inPriorRun = isWithinPriorRun(refPubDate, showById[showId]?.priorRuns);
            if (daysBefore > threshold && !inPriorRun) refWouldBeExcluded = true;
          }
          if (refWouldBeExcluded) stats.dupeRefExcludedRecovered = (stats.dupeRefExcludedRecovered || 0) + 1;
          // Verify fingerprints still match — flag may be stale after text re-fetch or deletion
          if (!data.fullText) {
            // fullText was deleted (e.g., wrong attribution) — duplicateTextOf is stale
            staleFlag = true;
          } else if (!refAlsoDupe && !refWouldBeExcluded && data.fullText && refData.fullText) {
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
        } else if (!refAlsoDupe && !refWouldBeExcluded) {
          logExclusion("skippedDuplicateText", showId, file, data);
          stats.skippedDuplicateText = (stats.skippedDuplicateText || 0) + 1;
          return;
        } else if (isCircular && circularSameText && !refWouldBeExcluded && file > data.duplicateTextOf) {
          // Circular tiebreaker — only when texts truly match (avoid dropping legitimate separate critics)
          logExclusion("skippedCircularDuplicateTiebreak", showId, file, data);
          stats.skippedCircularDuplicateTiebreak = (stats.skippedCircularDuplicateTiebreak || 0) + 1;
          return;
        } else {
          // Circular (kept side), stale, or ref excluded — let through
          stats.circularDuplicateRecovered = (stats.circularDuplicateRecovered || 0) + 1;
        }
      }

      // Auto-clear wrongProduction on WE/OB files set by the URL-year standalone guard
      // These are false positives — WE/OB shows transfer from other venues, so URL years mismatch legitimately
      // Note: uses showCat (outer scope, line 1334) because showCategory is declared later in this callback
      // GUARD: Respect manual reasons, high-confidence CV wrongProduction, and CV wrongArticle
      // (same guards as the UK-URL auto-clear path below — cousin bug fixed 2026-04-15)
      if (data.wrongProduction === true && data.wrongProductionNote && data.wrongProductionNote.includes('URL contains year')
          && (isLondonMarket(showCat) || showCat === 'off-broadway')) {
        const wpCvConfirmedWrong = data.contentVerification?.wrongProduction === true
          && data.contentVerification?.confidence === 'high';
        const wpCvConfirmedWrongArticle = data.contentVerification?.wrongArticle === true
          && data.contentVerification?.confidence === 'high';
        const wpHasManualReason = !!data.wrongProductionReason;
        if (!wpCvConfirmedWrong && !wpCvConfirmedWrongArticle && !wpHasManualReason) {
          data.wrongProduction = false;
          data.wrongProductionAutoCleared = `rebuild: WE/OB exempt from URL-year guard (was: ${data.wrongProductionNote})`;
          data.wrongProductionAutoClearedAt = new Date().toISOString().split('T')[0];
          delete data.wrongProductionNote;
          stats.wrongProdWEOBAutoCleared = (stats.wrongProdWEOBAutoCleared || 0) + 1;
          try { safeWriteReview(path.join(showDir, file), data, { force: true }); } catch (e) {}
          // Fall through — don't skip
        }
      }

      // Promote contentVerification flags to top-level if not already set
      // (contentVerification may be set by a different pipeline than the one that creates the file)
      // IMPORTANT: Skip promotion if contentVerification is stale — i.e., the fullText was
      // fetched AFTER verification ran. The verification was done on old/bad content.
      //
      // Schmigadoon 2026-04-21 bypass: CV rows with confidence='low' AND explicit
      // "completely different show" markers in issues/reasoning (e.g., EBT-as-Schmigadoon)
      // are also promoted. The temporal override downgraded them to 'low' but the
      // evidence is definitive, not a subtle LLM FP. hasStrongDifferentShowSignal
      // identifies those rows.
      const cvLowButStrong = data.contentVerification
        && data.contentVerification.confidence === 'low'
        && data.contentVerification.wrongProduction === true
        && hasStrongDifferentShowSignal(data.contentVerification.issues, data.contentVerification.reasoning);
      if (data.contentVerification && (data.contentVerification.confidence === 'high' || data.contentVerification.confidence === 'medium' || cvLowButStrong)) {
        const cv = data.contentVerification;

        // Staleness check: if text was fetched after verification, skip promotion
        let cvIsStale = false;
        if (data.textFetchedAt && cv.verifiedAt) {
          const fetchedAt = new Date(data.textFetchedAt).getTime();
          const verifiedAt = new Date(cv.verifiedAt).getTime();
          if (fetchedAt > verifiedAt) {
            cvIsStale = true;
            stats.staleContentVerificationSkippedPromotion = (stats.staleContentVerificationSkippedPromotion || 0) + 1;
          }
        }

        // Staleness guard 2: if verification was done on different content than current fullText,
        // skip promotion. The verifier may have re-scraped the URL and gotten a different page.
        if (!cvIsStale && cv.contentHash && data.fullText) {
          const currentHash = crypto.createHash('md5').update(data.fullText.substring(0, 2500)).digest('hex');
          if (cv.contentHash !== currentHash) {
            cvIsStale = true;
            stats.contentHashMismatchSkippedPromotion = (stats.contentHashMismatchSkippedPromotion || 0) + 1;
          }
        }

        // EXCEPTION (mirrors pre-pass): high-confidence wrongArticle is trusted even on
        // stale CV. The hash mismatched but the LLM was right that this URL points to a
        // different show — re-fetching the same URL almost always gives the same wrong page.
        const trustWrongArticleDespiteStale = cv.wrongArticle === true && cv.confidence === 'high';
        if (cvIsStale && trustWrongArticleDespiteStale) {
          cvIsStale = false;
        }

        let promoted = false;
        if (!cvIsStale) {
          // Only promote wrongProduction if:
          // 1. Not already flagged, no override/manual clear
          // 2. LLM confidence is high or medium (skip low — likely temporal proximity override)
          //    EXCEPTION: low confidence + strong "different show" markers in issues/reasoning
          //    still promote — that's definitive evidence, not a subtle FP near opening.
          const wpConfidence = cv.confidence || 'medium';
          const isHighMediumConfidence = wpConfidence === 'high' || wpConfidence === 'medium';
          const promotionEligibleConfidence = isHighMediumConfidence || cvLowButStrong;
          // Balusters CLASS 1 generalization (2026-04-22): ensemble-confident file + medium-conf
          // CV → advisory for BOTH wrongArticle and wrongProduction. High-conf CV still
          // promotes. cvLowButStrong still promotes for wrongProduction.
          const ensembleSaysReview = hasHighConfidenceLlmScore(data);
          const cvWpAdvisory = ensembleSaysReview && wpConfidence !== 'high' && !cvLowButStrong;
          // Production-continuity gate (Phase 1): when the operator has declared
          // a priorRun window covering this review's publishDate, CV's
          // wrongProduction is a known false positive (CV identifies an earlier
          // production at a different venue, which is exactly what priorRuns IS
          // for). Skip promotion — operator-trust over CV.
          const cvInPriorRun = isWithinPriorRun(data.publishDate, showById[showId]?.priorRuns);
          if (cv.wrongProduction === true && data.wrongProduction !== true
              && !shouldSkipWrongProductionAudit(data)
              && promotionEligibleConfidence && !data.allowEarlyDate && !data.allowCrossMarket
              && !cvWpAdvisory && !cvInPriorRun) {
            // [GUARD:CV-MAIN-LOOP]
            data.wrongProduction = true;
            const promotionPath = cvLowButStrong ? 'CV-low-but-strong-signal' : 'CV-promoted';
            data.wrongProductionReason = `${promotionPath}: ${(cv.reasoning || '').substring(0, 200)}`;
            promoted = true;
            if (cvLowButStrong) {
              stats.cvLowStrongSignalPromoted = (stats.cvLowStrongSignalPromoted || 0) + 1;
            }
          } else if (cv.wrongProduction === true && cvInPriorRun) {
            stats.cvWrongProductionPriorRunSuppressed = (stats.cvWrongProductionPriorRunSuppressed || 0) + 1;
          } else if (cv.wrongProduction === true && cvWpAdvisory) {
            stats.cvWrongProductionAdvisory = (stats.cvWrongProductionAdvisory || 0) + 1;
          }
          // Skip London/UK auto-promotion UNLESS LLM confidence is high (high-confidence
          // wrongArticle means the fetched text is genuinely for a different show/venue)
          const skipWsForLondon = isLondonMarket(showCat) && isUkOutletUrl(data.url) && wpConfidence !== 'high';
          if (cv.wrongArticle === true && !ensembleSaysReview && data.wrongShow !== true && !skipWsForLondon && !data.allowEarlyDate && !data.allowCrossMarket) {
            // CV outlet-style override (S3-T5): defer wrongShow for known long-biographical
            // outlets when the text is substantive + opinionated. The CV pass false-positives
            // on Vulture/NY Sun/NYSR/NYT long-biographical leads. flaggedForReview surfaces
            // these to humanReview rather than auto-promoting.
            if (shouldDeferCvWrongShow(data)) {
              data.flaggedForReview = true;
              data.flagReason = 'cv-promotion-deferred';
              stats.cvPromotionDeferred = (stats.cvPromotionDeferred || 0) + 1;
              try { safeWriteReview(path.join(showDir, file), data); } catch (e) {}
            } else {
              data.wrongShow = true;
              data.wrongShowReason = `CV-promoted: ${(cv.reasoning || '').substring(0, 200)}`;
              promoted = true;
            }
          } else if (cv.wrongArticle === true && ensembleSaysReview) {
            stats.cvWrongArticleAdvisory = (stats.cvWrongArticleAdvisory || 0) + 1;
          }
          if (cv.isFilmTv === true && !ensembleSaysReview && data.wrongShow !== true && !skipWsForLondon && !data.allowEarlyDate && !data.allowCrossMarket) {
            if (shouldDeferCvWrongShow(data)) {
              data.flaggedForReview = true;
              data.flagReason = 'cv-promotion-deferred';
              stats.cvPromotionDeferred = (stats.cvPromotionDeferred || 0) + 1;
              try { safeWriteReview(path.join(showDir, file), data); } catch (e) {}
            } else {
              data.wrongShow = true;
              data.wrongShowReason = `CV-promoted (film/TV): ${(cv.reasoning || '').substring(0, 200)}`;
              promoted = true;
            }
          }
          if (promoted) {
            data.contentVerificationPromoted = `rebuild: promoted from contentVerification (${cv.verifiedBy}, ${cv.confidence})`;
            stats.contentVerificationPromoted = (stats.contentVerificationPromoted || 0) + 1;
            try { safeWriteReview(path.join(showDir, file), data); } catch (e) {}
          }
        }

        // Fallback: if cv is stale but wrongShowReason explicitly describes a wrong article,
        // promote wrongShow anyway. The wrongShowReason was set by the collector LLM and
        // describes the actual content mismatch — staleness of the verification timestamp
        // doesn't invalidate the finding if the text is still wrong.
        if (cvIsStale && data.wrongShow !== true && data.wrongShowReason
            && /wrong|different|not a review|not the|Minerva|Chichester/i.test(data.wrongShowReason)) {
          // CV outlet-style override (S3-T5 followup): defer for long-biographical
          // outlets even on the stale-CV fallback path. The wrongShowReason itself
          // is a CV-derived signal, so the same FP class applies.
          if (shouldDeferCvWrongShow(data)) {
            data.flaggedForReview = true;
            data.flagReason = 'cv-promotion-deferred';
            stats.cvPromotionDeferred = (stats.cvPromotionDeferred || 0) + 1;
            try { safeWriteReview(path.join(showDir, file), data); } catch (e) {}
          } else {
            data.wrongShow = true;
            data.contentVerificationPromoted = `rebuild: promoted via wrongShowReason fallback (stale cv)`;
            stats.contentVerificationPromoted = (stats.contentVerificationPromoted || 0) + 1;
            try { safeWriteReview(path.join(showDir, file), data); } catch (e) {}
          }
        }

        // Self-heal one-directional CV promotion: an earlier pass set
        // wrongProduction=true from contentVerification, but the CURRENT
        // (non-stale, high/medium-confidence) CV record says wrongProduction=false.
        // Provenance-gated to CV-sourced flags only, so date/ensemble/tour flags
        // are untouched. Root cause of the R&J Shakespeare-in-the-Park NYSR drop
        // (2026-06-15) — see isStaleCvPromotedWrongProduction in review-guards.js.
        if (isStaleCvPromotedWrongProduction(data, cvIsStale)) {
          data.wrongProduction = false;
          // Deliberately NOT setting wrongProductionManualClear — that is a
          // human-override-equivalent that bypasses future wrong-production
          // audits, so a rare bad self-heal would become permanently protected
          // (codex review 2026-06-15). A plain self-heal marker keeps the file
          // SELF-CORRECTING: if a later high-confidence CV pass legitimately
          // flips wrongProduction back to true, promotion re-fires normally.
          data.wrongProductionSelfHealed = true;
          data.wrongProductionSelfHealReason = `current CV (${cv.verifiedBy || 'cv'}, ${cv.confidence}) says wrongProduction=false + confident ensemble score — cleared stale CV-promoted flag`;
          stats.cvStaleWrongProductionSelfHealed = (stats.cvStaleWrongProductionSelfHealed || 0) + 1;
          try { safeWriteReview(path.join(showDir, file), data); } catch (e) {}
        }
      }

      // Skip wrong-production reviews (e.g., off-Broadway reviews filed under Broadway show)
      // OVERRIDE: If wrongProduction was set by cross-market guard ("US outlet reviewing London show")
      // but the URL is actually a UK domain, clear it — the guard was wrong.
      // Also clears stale flags (no note, "US-only" script) on UK/dual-market outlets with London URLs.
      // BUT: Never auto-clear if the review date is >90 days before the show's earliest date —
      // that's a genuine wrong-production, not a cross-market false positive.
      if (data.wrongProduction === true && !data.wrongProductionOverride && isLondonMarket(showCat) && data.url) {
        const wpNote = data.wrongProductionNote || '';
        // Only auto-clear cross-market, US-only, or stale no-note flags — NOT legitimate
        // "Same URL exists", "Pre-opening guard", or "days before show opened" flags
        const isStructuralFlag = wpNote.includes('Same URL exists') || wpNote.includes('Pre-opening guard')
          || wpNote.includes('days before show opened') || wpNote.includes('URL contains year');
        // Date-aware guard: if review is >90 days before the show's earliest date, it's genuinely
        // from a prior production — do NOT auto-clear regardless of URL domain
        let isDateMismatch = false;
        if (data.publishDate && showDateMap[showId]) {
          const reviewDate = parseDate(data.publishDate);
          if (reviewDate && (showDateMap[showId] - reviewDate) > 90 * 86400000) {
            isDateMismatch = true;
          }
        }
        if (!isStructuralFlag && !isDateMismatch) {
          // Compute outlet early for wrongProduction override check
          const earlyRawOutlet = (data.outletId || data.outlet || '').toLowerCase();
          const earlyCanonicalOutlet = normalizeOutletCanonical(earlyRawOutlet);
          const outletIsDualOrUk = DUAL_MARKET_OUTLETS.has(earlyCanonicalOutlet)
            || outletRegionMap[earlyCanonicalOutlet] === 'london' || outletRegionMap[earlyRawOutlet] === 'london';
          try {
            const hostname = new URL(data.url).hostname || '';
            // Use venue-classification's isUkOutletUrl for consistency (handles US outlet exclusions)
            const { isUkOutletUrl: _isUkUrl } = require('./lib/venue-classification');
            const isUkUrl = _isUkUrl(data.url);
            if (isUkUrl || outletIsDualOrUk) {
              // UK/dual-market outlet + London URL → clear false positive
              // BUT: Do NOT auto-clear if contentVerification explicitly confirmed wrongProduction
              // (e.g., touring/outdoor production reviewed by UK outlet) or if manual reason is set.
              // ALSO: Do NOT auto-clear if cv flagged wrongArticle (review is about a completely
              // different show) — that's the bug found in WE pre-Reddit-launch audit (2026-04-10).
              // Matilda was rendering a TimeOut Paddington review at 100/100, etc.
              const cvConfirmedWrong = data.contentVerification?.wrongProduction === true
                && data.contentVerification?.confidence === 'high';
              const cvConfirmedWrongArticle = data.contentVerification?.wrongArticle === true
                && data.contentVerification?.confidence === 'high';
              const hasManualReason = !!data.wrongProductionReason;
              if (isUkUrl && !cvConfirmedWrong && !cvConfirmedWrongArticle && !hasManualReason) {
                delete data.wrongProduction;
                delete data.wrongProductionNote;
                data.wrongProductionAutoCleared = `rebuild: UK URL on London show (${hostname})`;
                try { safeWriteReview(path.join(showDir, file), data, { force: true }); } catch (e) {}
                stats.wrongProductionAutoCleared = (stats.wrongProductionAutoCleared || 0) + 1;
              }
            }
          } catch {}
        }
      }
      // allowEarlyDate/allowCrossMarket override wrongProduction — user explicitly approved the review.
      // EXCEPT: if there's an explicit wrongProductionReason (manual flag, audit-driven, CV-promoted)
      // OR contentVerification confirms wrongProduction with high confidence, keep the flag. Cross-market
      // contamination flags set by audit-review-contamination.js were getting stripped here, leaving
      // contamination unflagged on the next rebuild. See scripts/lib/wrong-production-autoclear.js.
      if (shouldAutoClearWrongProduction(data)) {
        delete data.wrongProduction;
        delete data.wrongProductionNote;
        const reason = data.allowCrossMarket ? 'allowCrossMarket' : 'allowEarlyDate';
        data.wrongProductionAutoCleared = `rebuild: ${reason} bypasses wrongProduction`;
        try { safeWriteReview(path.join(showDir, file), data, { force: true }); } catch (e) {}
        stats.wrongProductionAutoCleared = (stats.wrongProductionAutoCleared || 0) + 1;
      }
      // Nuclear guard: if manual clear is set, force wrongProduction=false regardless
      // of what earlier passes may have done in memory.
      // humanReviewedWrongProduction===false means "human verified this IS the correct production"
      // — equivalent to wrongProductionManualClear but used by opening-night correction sessions.
      if (data.wrongProductionManualClear || data.wrongProductionOverride || data.humanReviewedWrongProduction === false) {
        data.wrongProduction = false;
      }
      if (data.wrongProduction === true) {
        if (data.wrongProductionManualClear || data.wrongProductionOverride || data.humanReviewedWrongProduction === false) {
          console.log(`  [NUCLEAR GUARD FAILURE] ${showId}/${file}: wrongProduction=true despite manual clear — FORCING false`);
          data.wrongProduction = false;
        } else {
          logExclusion("skippedWrongProduction", showId, file, data);
          stats.skippedWrongProduction = (stats.skippedWrongProduction || 0) + 1;
          return;
        }
      }

      // Auto-reject reviews with blocked URLs (ticket pages, aggregators, social media)
      // This catches URLs that slipped through gather-reviews before the isBlockedReviewUrl guard
      // was added. Uses the same domain-filters.js shared with gather-reviews.
      if (data.url && isBlockedReviewUrl(data.url)) {
        logExclusion("skippedBlockedUrl", showId, file, data);
        stats.skippedBlockedUrl = (stats.skippedBlockedUrl || 0) + 1;
        return;
      }

      // Skip wrong-show reviews (review content is for a different show)
      // OVERRIDE: If this is a London show AND the review URL is from a UK/major outlet domain,
      // the wrongShow flag is almost certainly a false positive from LLM classification.
      // UK outlets reviewing London shows cannot be "wrong show" — they only cover London theatre.
      // BUT: Do NOT auto-clear if content verification flagged wrongArticle (e.g., news/preview, not a review).
      // AND: Do NOT auto-clear if the review date is >90 days before the show — that's a prior production.
      // AND: Do NOT auto-clear if any manual wrongShowReason is set — same pattern as wrongProduction
      // (cousin bug fixed 2026-04-15: regex filter missed manual reasons like "confirmed via audit")
      const isWrongArticle = (data.contentVerification && data.contentVerification.wrongArticle === true);
      const wsHasManualReason = !!data.wrongShowReason;
      let wsDateMismatch = false;
      if (data.publishDate && showDateMap[showId]) {
        const wsReviewDate = parseDate(data.publishDate);
        if (wsReviewDate && (showDateMap[showId] - wsReviewDate) > 90 * 86400000) {
          wsDateMismatch = true;
        }
      }
      if (data.wrongShow === true && isLondonMarket(showCat) && isUkOutletUrl(data.url) && !isWrongArticle && !wsHasManualReason && !wsDateMismatch) {
        delete data.wrongShow;
        delete data.wrongShowNote;
        data.wrongShowAutoCleared = `rebuild: UK/major outlet URL on London show`;
        try { safeWriteReview(path.join(showDir, file), data, { force: true }); } catch (e) {}
        stats.wrongShowAutoCleared = (stats.wrongShowAutoCleared || 0) + 1;
      }
      // allowEarlyDate/allowCrossMarket override wrongShow — user explicitly approved this review.
      // EXCEPT: if there's an explicit wrongShowReason (manual/audit/CV-promoted) OR contentVerification
      // confirms wrongArticle with high confidence, keep the flag. See scripts/lib/wrong-production-autoclear.js.
      if (shouldAutoClearWrongShow(data)) {
        delete data.wrongShow;
        delete data.wrongShowNote;
        delete data.wrongShowReason;
        const reason = data.allowCrossMarket ? 'allowCrossMarket' : 'allowEarlyDate';
        data.wrongShowAutoCleared = `rebuild: ${reason} bypasses wrongShow`;
        try { safeWriteReview(path.join(showDir, file), data, { force: true }); } catch (e) {}
        stats.wrongShowAutoCleared = (stats.wrongShowAutoCleared || 0) + 1;
      }
      if (data.wrongShow === true) {
        logExclusion("skippedWrongShow", showId, file, data);
        stats.skippedWrongShow = (stats.skippedWrongShow || 0) + 1;
        return;
      }

      // Skip fabricated entries (URLs fabricated by web-search LLM, confirmed dead via HTTP check)
      if (data.fabricatedEntry === true) {
        logExclusion("skippedFabricated", showId, file, data);
        stats.skippedFabricated = (stats.skippedFabricated || 0) + 1;
        return;
      }

      // Skip non-review entries (scraper misidentified content as a review)
      if (data.isNotReview === true) {
        logExclusion("skippedNotReview", showId, file, data);
        stats.skippedNotReview = (stats.skippedNotReview || 0) + 1;
        return;
      }

      // Skip scraper garbage (scraper identified content as non-review material)
      // BUT allow through if review has a valid score from aggregator data (excerpts + assignedScore)
      if (data.incompleteReason === 'scraper_garbage') {
        const hasAggregatorScore = (data.assignedScore && data.assignedScore >= 1 && data.assignedScore <= 100)
          || (data.originalScore && parseOriginalScore(data.originalScore, data.outletId) !== null)
          || (data.aggregatorStars && parseOriginalScore(data.aggregatorStars, data.outletId) !== null);
        const hasExcerpt = data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt || data.lboRoundupExcerpt || data.stagedoorExcerpt;
        if (!hasAggregatorScore && !hasExcerpt) {
          logExclusion("skippedScraperGarbage", showId, file, data);
          stats.skippedScraperGarbage = (stats.skippedScraperGarbage || 0) + 1;
          return;
        }
      }

      // Auto-fix relative URLs that look like BWW paths (missing domain prefix)
      if (data.url && !data.url.startsWith('http://') && !data.url.startsWith('https://')) {
        if (data.url.match(/^\/([-a-z]+)\/article\//)) {
          data.url = `https://www.broadwayworld.com${data.url}`;
          try { safeWriteReview(path.join(showDir, file), data); } catch (e) {}
          stats.fixedRelativeUrl = (stats.fixedRelativeUrl || 0) + 1;
        } else {
          // Non-BWW relative path (e.g. /people/Ben-Brantley/) — scraping artifact
          logExclusion("skippedInvalidUrl", showId, file, data);
          stats.skippedInvalidUrl = (stats.skippedInvalidUrl || 0) + 1;
          return;
        }
      }

      // Cross-show URL dedup: if this URL also exists in another show's directory,
      // flag the copy that's farther from its show's opening year as wrongProduction.
      // Catches aggregator contamination (e.g., ShowScore listing 2013 Broadway reviews
      // on a 2026 Off-Broadway page with the same title).
      if (data.url && !data.wrongProduction && !data.allowEarlyDate && !skipCrossShowDupeIds.has(showId)) {
        const norm = normalizeUrlForDedup(data.url);
        const entry = norm ? crossShowUrlIndex.get(norm) : null;
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
                if (shouldSkipWrongProductionAudit(data)) continue; // [GUARD:CROSS-SHOW-URL-DATED]
                console.log(`  [CROSS-SHOW URL] ${showId}/${file}: URL year ${reviewYear} closer to ${other.showId} (${other.showYear}) than ${showId} (${myYear})`);
                logExclusion("skippedCrossShowUrl", showId, file, data);
                stats.skippedCrossShowUrl = (stats.skippedCrossShowUrl || 0) + 1;
                data.wrongProduction = true;
                data.wrongProductionNote = `Same URL exists in ${other.showId} which is closer to review year ${reviewYear}`;
                safeWriteReview(path.join(showDir, file), data);
                return;
              }
            }
          }
          // Dateless shows (openingDate null) lose to any dated show with the same URL.
          // Without a date, we can't verify the review belongs to this show.
          if (!myYear && reviewYear) {
            for (const other of allCopies) {
              if (other.showId === showId || !other.showYear) continue;
              if (shouldSkipWrongProductionAudit(data)) continue; // [GUARD:CROSS-SHOW-URL-DATELESS]
              console.log(`  [CROSS-SHOW URL] ${showId}/${file}: dateless show loses to ${other.showId} (${other.showYear}) for URL year ${reviewYear}`);
              logExclusion("skippedCrossShowUrl", showId, file, data);
              stats.skippedCrossShowUrl = (stats.skippedCrossShowUrl || 0) + 1;
              data.wrongProduction = true;
              data.wrongProductionNote = `Dateless show — same URL exists in dated show ${other.showId} (${other.showYear})`;
              safeWriteReview(path.join(showDir, file), data);
              return;
            }
          }
        }
      }

      // Cross-market guard: skip reviews where outlet market doesn't match show market
      // Only isDualMarket outlets (NYT, Variety, Guardian, FT, etc.) and London-region
      // outlets can score West End shows. T1/T2 exemption was removed because US T1/T2
      // outlets (WSJ, Vulture, EW, etc.) don't review WE — their reviews in WE dirs are
      // Broadway leaks from aggregator scrapers. See March 2026 contamination audit.
      const showCategory = showCategoryMap[showId] || 'broadway';
      const rawOutlet = (data.outletId || data.outlet || '').toLowerCase();
      let canonicalOutlet = normalizeOutletCanonical(rawOutlet);

      // Auto-correct timeout → timeout-london based on URL path (systemic fix for shared-domain outlet)
      if (canonicalOutlet === 'timeout' && data.url) {
        try {
          const urlPath = new URL(data.url).pathname.toLowerCase();
          const urlHost = new URL(data.url).hostname.toLowerCase();
          if (urlPath.startsWith('/london') || urlHost.endsWith('.co.uk')) {
            data.outletId = 'timeout-london';
            data.outlet = 'Time Out London';
            if (data.wrongProduction && data.wrongProductionNote && data.wrongProductionNote.includes('US outlet "timeout"')) {
              delete data.wrongProduction;
              delete data.wrongProductionNote;
            }
            try { safeWriteReview(path.join(showDir, file), data, { force: true }); } catch (e) {}
            canonicalOutlet = 'timeout-london';
            stats.autoFixedTimeoutLondon = (stats.autoFixedTimeoutLondon || 0) + 1;
          }
        } catch (e) {}
      }

      if (isLondonMarket(showCategory) && !data.allowEarlyDate && !data.allowCrossMarket
          && !DUAL_MARKET_OUTLETS.has(canonicalOutlet) && !DUAL_MARKET_OUTLETS.has(rawOutlet)) {
        const outletRegion = outletRegionMap[canonicalOutlet] || outletRegionMap[rawOutlet];
        // URL-domain fallback: if outlet has no region in registry, check if the URL is a UK domain
        // This prevents unknown UK outlets (blogs, small reviewers) from being flagged as US
        let urlIsUK = false;
        if (!outletRegion && data.url) {
          try {
            const hostname = new URL(data.url).hostname || '';
            urlIsUK = hostname.endsWith('.co.uk') || hostname.endsWith('.org.uk')
              || hostname.includes('london') || (hostname.includes('theatre') && !hostname.includes('newyork'));
          } catch (e) { /* ignore malformed URLs */ }
        }
        if (outletRegion !== 'london' && !urlIsUK) {
          // Don't flag — and don't exclude — when contentVerification has already
          // affirmatively verified the production is correct with high confidence.
          // The cross-market heuristic ("US outlet on London show") produces false
          // positives for US theater bloggers covering specific London productions
          // (e.g. Jinkx Monsoon in End of the Rainbow at Soho Theatre Walthamstow).
          // High-confidence LLM content verification is a stronger signal than the
          // outlet-region heuristic. [GUARD:CROSS-MARKET-CV-OVERRIDE]
          const cv = data.contentVerification;
          const cvSaysCorrect = cv && cv.isValid === true
            && cv.wrongProduction === false && cv.confidence === 'high';
          if (cvSaysCorrect) {
            // skip the flag + skip the exclusion — let downstream pipeline use it
          } else {
            // Mark file permanently so future rebuilds skip it faster (line 1507) and it's visible on disk
            if (!data.wrongProduction && !shouldSkipWrongProductionAudit(data)) {
              // [GUARD:CROSS-MARKET-US-ON-LONDON]
              data.wrongProduction = true;
              data.wrongProductionNote = `Cross-market: US outlet "${rawOutlet}" reviewing London show`;
              try { safeWriteReview(path.join(showDir, file), data); } catch (e) {}
            }
            logExclusion("skippedCrossMarket", showId, file, data);
            stats.skippedCrossMarket = (stats.skippedCrossMarket || 0) + 1;
            if (!stats.crossMarketDetails) stats.crossMarketDetails = [];
            stats.crossMarketDetails.push({ showId, outlet: rawOutlet, file });
            return;
          }
        }
      }

      // Reverse cross-market guard: London outlets should not score Broadway/off-Broadway
      // Unlike the forward guard, we DON'T exempt Tier 1/2 here — a London Tier 1 outlet like
      // Evening Standard never covers Broadway. Only explicitly dual-market outlets (Guardian, FT, Variety)
      // are allowed to cross markets. Tier 1/2 exemption was designed for US outlets reviewing WE.
      if ((showCategory === 'broadway' || showCategory === 'off-broadway') && !data.allowEarlyDate && !data.allowCrossMarket
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
          // CV override — symmetric with the forward guard above.
          // [GUARD:CROSS-MARKET-CV-OVERRIDE]
          //
          // Tighten 2026-05-23: a UK-hosted URL (.co.uk / .org.uk) on a Broadway
          // or off-Broadway show cannot be CV-overridden. The LLM verifier reads
          // content semantics ("is this a review of this play?") and cannot tell
          // a London revival of the same title from the NYC production — see
          // rock-n-roll-2007 / west-end-best-friend--erifyli-gigante (Hampstead
          // Theatre 2023 review attached to the 2007 Broadway production). The
          // geographic signal (UK domain reviewing a Broadway show ID) is canonical;
          // legitimate dual-market coverage is already exempt via DUAL_MARKET_OUTLETS.
          const cv = data.contentVerification;
          let cvSaysCorrect = cv && cv.isValid === true
            && cv.wrongProduction === false && cv.confidence === 'high';
          if (cvSaysCorrect && data.url) {
            try {
              const cvHost = new URL(data.url).hostname || '';
              if (cvHost.endsWith('.co.uk') || cvHost.endsWith('.org.uk')) cvSaysCorrect = false;
            } catch (e) { /* malformed URL — leave cvSaysCorrect as-is */ }
          }
          if (cvSaysCorrect) {
            // skip the flag + skip the exclusion — let downstream pipeline use it
          } else {
            // Mark file permanently so future rebuilds skip it faster (line 1507) and it's visible on disk
            if (!data.wrongProduction && !shouldSkipWrongProductionAudit(data)) {
              // [GUARD:CROSS-MARKET-LONDON-ON-OTHER]
              data.wrongProduction = true;
              data.wrongProductionNote = `Cross-market: London outlet "${rawOutlet}" reviewing ${showCategory} show`;
              try { safeWriteReview(path.join(showDir, file), data); } catch (e) {}
            }
            logExclusion("skippedCrossMarket", showId, file, data);
            stats.skippedCrossMarket = (stats.skippedCrossMarket || 0) + 1;
            if (!stats.crossMarketDetails) stats.crossMarketDetails = [];
            stats.crossMarketDetails.push({ showId, outlet: rawOutlet, file, direction: 'london→broadway', urlFallback: urlIsUK });
            return;
          }
        }
      }

      // URL-path cross-market guard: catch Broadway reviews assigned to WE shows
      // (and vice versa) even from dual-market outlets. The outlet may cover both markets,
      // but a URL containing "-broadway-review" or "on-broadway" is reviewing a specific production.
      // Excludes broadwayworld.com (outlet domain, not a production indicator).
      // [GUARD:URL-PATH-CROSS-MARKET] outer guard covers both inner sites
      if (data.url && !data.wrongProduction && !shouldSkipWrongProductionAudit(data) && !data.allowEarlyDate && !data.allowCrossMarket) {
        try {
          const urlObj = new URL(data.url);
          const hostname = urlObj.hostname.replace(/^www\./, '');
          const urlPath = urlObj.pathname.toLowerCase();
          if (isLondonMarket(showCategory) && hostname !== 'broadwayworld.com' && !hostname.endsWith('.broadwayworld.com')) {
            // WE show but URL path contains Broadway production indicators
            if (/[-/](broadway-review|on-broadway|broadway[-/])/.test(urlPath)
                || /\/(chicago|national-tour)[-/]/.test(urlPath)) {
              data.wrongProduction = true;
              data.wrongProductionNote = `URL-path cross-market: "${urlPath}" contains Broadway/tour indicator on London show`;
              try { safeWriteReview(path.join(showDir, file), data); } catch (e) {}
              logExclusion("skippedUrlPathCrossMarket", showId, file, data);
              stats.skippedUrlPathCrossMarket = (stats.skippedUrlPathCrossMarket || 0) + 1;
              return;
            }
          } else if ((showCategory === 'broadway' || showCategory === 'off-broadway')
                     && hostname !== 'broadwayworld.com' && !hostname.endsWith('.broadwayworld.com')) {
            // Broadway show but URL path contains West End production indicators
            if (/[-/](west-end-review|london-review|london[-/])/.test(urlPath)) {
              data.wrongProduction = true;
              data.wrongProductionNote = `URL-path cross-market: "${urlPath}" contains London indicator on Broadway show`;
              try { safeWriteReview(path.join(showDir, file), data); } catch (e) {}
              logExclusion("skippedUrlPathCrossMarket", showId, file, data);
              stats.skippedUrlPathCrossMarket = (stats.skippedUrlPathCrossMarket || 0) + 1;
              return;
            }
          }
        } catch (e) { /* ignore malformed URLs */ }
      }

      // Skip pre-opening reviews (published before show opened — wrong production)
      // Broadway: 14-day grace period (preview coverage).
      // Off-Broadway/West End: 90-day grace period — matches the pre-opening guard threshold.
      // A review >90 days before the show opened is almost certainly a different production.
      // Long-run WE shows (opened before 2015): skip this guard entirely — decades of valid reviews.
      // Reviews with allowEarlyDate: true bypass all date checks.
      // routedFromShowId: already rerouted — publish date reflects the original show's era
      // priorRuns: review falls inside a declared earlier-run window (Phase 1 production-continuity)
      if (data.publishDate && showDateMap[showId] && !data.allowEarlyDate && !data.routedFromShowId && !showLongRunWE.has(showId)) {
        const pubDate = new Date(data.publishDate);
        const openDate = showDateMap[showId];
        const daysBefore = Math.ceil((openDate - pubDate) / (1000 * 60 * 60 * 24));
        const isFlexCategory = showCategory === 'off-broadway' || isLondonMarket(showCategory);
        const threshold = isFlexCategory ? 90 : 14;
        const inPriorRun = isWithinPriorRun(pubDate, showById[showId]?.priorRuns);
        if (daysBefore > threshold && !inPriorRun) {
          console.log(`  [PRE-OPENING] ${showId}/${file}: published ${daysBefore} days before opening (${data.publishDate} vs ${openDate.toISOString().split('T')[0]})`);
          logExclusion("skippedPreOpening", showId, file, data);
          stats.skippedPreOpening = (stats.skippedPreOpening || 0) + 1;
          // Also flag the source file for future reference
          if (!data.wrongProduction && !shouldSkipWrongProductionAudit(data)) {
            // [GUARD:DAYS-BEFORE-OPENED]
            data.wrongProduction = true;
            data.wrongProductionNote = `Review published ${daysBefore} days before show opened — likely reviewing a different production`;
            safeWriteReview(path.join(showDir, file), data);
          }
          return;
        }
      }

      // Skip non-reviews (profiles, interviews, previews, features, news articles)
      if (data.isNonReview === true || data.nonReviewFlag === true || data.nonReviewContent === true) {
        logExclusion("skippedNonReview", showId, file, data);
        stats.skippedNonReview = (stats.skippedNonReview || 0) + 1;
        return;
      }

      // Skip syndicated duplicates (same critic, different outlet, same review text)
      // Flagged by scripts/detect-syndicated-duplicates.js
      if (data.isSyndicatedDuplicate === true) {
        logExclusion("skippedSyndicated", showId, file, data);
        stats.skippedSyndicated = (stats.skippedSyndicated || 0) + 1;
        return;
      }

      // Runtime known-syndication dedup — catches unflagged secondary copies.
      // e.g. Chris Jones publishes in Chicago Tribune (primary) AND NY Daily News (secondary).
      // If primary file exists for this show, skip the secondary even without file-level flag.
      {
        const criticSynd = (data.criticName || '').toLowerCase().trim();
        const outletSynd = normalizeOutletCanonical(data.outletId || data.outlet || '');
        const syndConfig = KNOWN_SYNDICATION_PAIRS[criticSynd];
        if (syndConfig && syndConfig.secondary.includes(outletSynd)) {
          const primaryPrefix = `${syndConfig.primary}--`;
          const criticSlug = criticSynd.replace(/\s+/g, '-');
          // Only skip secondary if the primary file is unflagged (not wrongProduction/wrongShow).
          // A flagged primary shouldn't block a valid secondary — e.g., OB theatermania flagged
          // but Broadway whatsonstage is the real review for this production.
          const hasPrimary = allJsonFiles.some(f => {
            if (!f.startsWith(primaryPrefix) || !f.includes(criticSlug)) return false;
            try {
              const pData = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
              return !pData.wrongProduction && !pData.wrongShow;
            } catch { return false; }
          });
          if (hasPrimary) {
            logExclusion("skippedSyndicated", showId, file, data);
            stats.skippedSyndicated = (stats.skippedSyndicated || 0) + 1;
            return;
          }
        }
      }

      // Skip cross-outlet duplicates (different critic, same text across outlets)
      // Flagged by scripts/detect-cross-outlet-duplicates.js
      if (data.crossOutletDuplicate === true) {
        logExclusion("skippedCrossOutletDupe", showId, file, data);
        stats.skippedCrossOutletDupe = (stats.skippedCrossOutletDupe || 0) + 1;
        return;
      }

      // Handle reviews where fullText is from wrong author but excerpts may be valid
      // Soft flag: keeps excerpts, distrusts fullText. Set by apply-audit-flags.js or collect-review-texts.js
      if (data.fullTextWrongAuthor === true) {
        delete data.fullText;
        delete data.assignedScore;
        delete data.ensembleData;
        const hasExcerpt = !!(data.bwwExcerpt || data.dtliExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt || data.stagedoorExcerpt || data.lboRoundupExcerpt);
        // Respect a human contentTier override (the only direct contentTier setter
        // that bypassed classifyContentTier's manualContentTier check). Mirrors the
        // wrongProduction setter-guard discipline (shouldSkipWrongProductionAudit):
        // a committed manual override must never be silently downgraded. Piece 3.
        if (!data.manualContentTier) data.contentTier = hasExcerpt ? 'excerpt' : 'stub';
        if (!hasExcerpt) {
          logExclusion("skippedFullTextWrongAuthor", showId, file, data);
          stats.skippedFullTextWrongAuthor = (stats.skippedFullTextWrongAuthor || 0) + 1;
          return;
        }
        stats.fullTextWrongAuthorKeptAsExcerpt = (stats.fullTextWrongAuthorKeptAsExcerpt || 0) + 1;
        // Falls through — included as excerpt-only review
      }

      // Skip reviews flagged as wrong author attribution (hard block — both fullText AND excerpts are bad)
      // Flagged by detect-syndicated-duplicates.js author mismatch scanner
      if (data.wrongAttribution === true) {
        logExclusion("skippedWrongAttribution", showId, file, data);
        stats.skippedWrongAttribution = (stats.skippedWrongAttribution || 0) + 1;
        return;
      }

      // Skip reviews flagged as suspected misattribution by critic-registry guard
      // (critic at an outlet outside their known affiliation, and not a freelancer).
      // Defensive override: stale flag where current registry would no longer fire
      // (Notion 34e637c5-416f-81b8 — Susannah Clapp/guardian etc.).
      if (data.suspectedMisattribution === true && !isLikelyStaleSuspectedMisattribution(data, getCriticRegistry())) {
        logExclusion("skippedSuspectedMisattribution", showId, file, data);
        stats.skippedSuspectedMisattribution = (stats.skippedSuspectedMisattribution || 0) + 1;
        return;
      }

      // Garbage review guard: skip reviews where critic name matches a creative team member
      // of the SAME show (indicates scraped cast/crew info, not a real review)
      const criticLower = (data.criticName || '').toLowerCase().trim();
      if (criticLower && showCreativeTeamIndex[showId]?.has(criticLower)) {
        console.log(`  [CREATIVE-AS-CRITIC] ${showId}/${file}: critic "${data.criticName}" is a creative team member`);
        logExclusion("skippedGarbage", showId, file, data);
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
        logExclusion("skippedGarbage", showId, file, data);
        stats.skippedGarbage = (stats.skippedGarbage || 0) + 1;
        return;
      }

      // Blocklisted outlet IDs: scraping artifacts that are never valid outlets
      const BLOCKED_OUTLET_IDS = new Set(['advertisement', 'sponsored', 'promoted', 'ad', 'promo']);
      const rawOutletId = (data.outletId || '').toLowerCase();
      if (BLOCKED_OUTLET_IDS.has(rawOutletId)) {
        console.log(`  [BLOCKED-OUTLET] ${showId}/${file}: outletId "${rawOutletId}" is a scraping artifact`);
        logExclusion("skippedGarbage", showId, file, data);
        stats.skippedGarbage = (stats.skippedGarbage || 0) + 1;
        return;
      }

      // Date-based wrong-production guard: skip reviews published >30 days before previews/opening
      // Broadway reviews are embargoed until opening night; anything earlier is likely wrong-production
      // Reviews with allowEarlyDate: true bypass this (e.g., out-of-town tryouts, transfers)
      // WE shows are exempt: many are long-running transfers with reviews from the original run
      if (data.publishDate && showDateMap[showId] && !data.allowEarlyDate && !isLondonMarket(showCategory)) {
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
            logExclusion("skippedDateMismatch", showId, file, data);
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
            logExclusion("skippedLateDateMismatch", showId, file, data);
            stats.skippedLateDateMismatch = (stats.skippedLateDateMismatch || 0) + 1;
            return;
          }
        }
      }

      // URL-year cross-production guard for multi-production shows
      // If a review's URL or publish date contains a year clearly closer to a sibling
      // production, REROUTE it to the sibling's directory instead of dropping it.
      // Pure decision: pickRerouteTarget() in scripts/lib/review-guards.js (with tests).
      // Bypass: wrongProductionManualClear, wrongProductionOverride, allowEarlyDate, allowLateDate, routedFromShowId
      // routedFromShowId: file was already rerouted to this directory by a prior rebuild — don't re-evaluate
      if (multiProdYearGuard[showId]
          && !data.wrongProductionManualClear
          && !data.wrongProductionOverride
          && !data.allowEarlyDate
          && !data.allowLateDate
          && !data.routedFromShowId) {
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
        // Build run-window [startYear, endYear] from show data so pickRerouteTarget
        // can protect mid-run reviews of long-running shows from being misrouted
        // to a revival just because the revival is year-distance closer.
        // Fixes: mamma-mia-2001 (ran 2001–2015) had a 2014 NYT review being routed
        // to mamma-mia-2025 because |2014-2025|=11 < |2014-2001|=13.
        const startYear = showOpeningDateMap[showId]
          ? showOpeningDateMap[showId].getFullYear()
          : guard.showYear;
        const endYear = showClosingDateMap[showId]
          ? showClosingDateMap[showId].getFullYear()
          : new Date().getFullYear(); // still running → accept up to today
        const runWindow = [startYear, endYear];
        const decision = pickRerouteTarget(guard.showYear, guard.siblings, detectedYear, runWindow);
        if (decision.action === 'reroute') {
          const targetShowId = decision.targetShowId;
          const targetDir = path.join(reviewTextsDir, targetShowId);
          const targetPath = path.join(targetDir, file);
          const sourcePath = path.join(showDir, file);
          // Collision: target already has a file with this slug. Drop in this case
          // (matches old behavior — never overwrite an existing review).
          if (fs.existsSync(targetPath)) {
            console.log(`  [REROUTE COLLISION] ${showId}/${file}: target ${targetShowId}/${file} exists, dropping (${yearSource}=${detectedYear})`);
            stats.rerouteCollisionDropped = (stats.rerouteCollisionDropped || 0) + 1;
            logExclusion("skippedUrlYearMismatch", showId, file, data);
            stats.skippedUrlYearMismatch = (stats.skippedUrlYearMismatch || 0) + 1;
            return;
          }
          let targetWritten = false;
          try {
            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
            // Re-read source fresh to avoid clobbering concurrent updates, then stamp
            // routing metadata so future rebuilds have an audit trail.
            const sourceData = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
            sourceData.showId = targetShowId;
            sourceData.routedFromShowId = showId;
            sourceData.routedReason = `${yearSource}=${detectedYear} closer to ${targetShowId} (${decision.targetYear}) than ${showId} (${guard.showYear})`;
            sourceData.routedAt = new Date().toISOString();
            safeWriteReview(targetPath, sourceData);
            targetWritten = true;
            fs.unlinkSync(sourcePath);
            console.log(`  [REROUTE] ${showId}/${file} → ${targetShowId}/${file} (${yearSource}=${detectedYear}, dist ${decision.distance})`);
            stats.reroutedToSibling = (stats.reroutedToSibling || 0) + 1;
          } catch (e) {
            console.warn(`  [REROUTE FAIL] ${showId}/${file} → ${targetShowId}: ${e.message} — falling back to drop`);
            // If we wrote the target but the source unlink failed, roll back the
            // target to avoid leaving a duplicate file in two directories.
            if (targetWritten) {
              try { fs.unlinkSync(targetPath); } catch { /* best-effort rollback */ }
            }
            stats.rerouteFailedDropped = (stats.rerouteFailedDropped || 0) + 1;
            logExclusion("skippedUrlYearMismatch", showId, file, data);
            stats.skippedUrlYearMismatch = (stats.skippedUrlYearMismatch || 0) + 1;
          }
          // Skip processing this file in the current rebuild — it now lives at
          // the sibling directory and will be picked up next rebuild (or this one,
          // if the sibling sorts later alphabetically).
          return;
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
      // [GUARD:URL-YEAR-STANDALONE] outer-block guard
      // routedFromShowId: already rerouted — URL year reflects the original show, not a mismatch
      if (!data.publishDate && data.url && showDateMap[showId] && !data.wrongProduction
          && !shouldSkipWrongProductionAudit(data) && !data.allowEarlyDate
          && !data.routedFromShowId
          && !isLondonMarket(showCategory) && showCategory !== 'off-broadway') {
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
              logExclusion("skippedUrlYearStandalone", showId, file, data);
              stats.skippedUrlYearStandalone = (stats.skippedUrlYearStandalone || 0) + 1;
              data.wrongProduction = true;
              data.wrongProductionNote = `URL contains year ${closestYear} but show opens in ${showYear} — likely review of different production`;
              safeWriteReview(path.join(showDir, file), data);
              return;
            }
          }
        }
      }

      // Director cross-check for multi-production shows
      // If a review in an OLDER production's directory mentions a NEWER production's director,
      // it's almost certainly filed under the wrong show (validated pattern, zero false positives)
      // routedFromShowId: already rerouted — text may reference original show's era, skip re-evaluation
      if (multiProdDirectorGuard[showId] && !data.routedFromShowId && data.humanReviewedWrongProduction !== false) {
        const text = (data.fullText || data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || data.lboRoundupExcerpt || '').toLowerCase();
        if (text.length >= 30) {
          for (const [dirName, newerId] of multiProdDirectorGuard[showId]) {
            if (text.includes(dirName)) {
              console.log(`  [DIRECTOR GUARD] ${showId}/${file}: mentions director "${dirName}" from newer production ${newerId}`);
              logExclusion("skippedDirectorMismatch", showId, file, data);
              stats.skippedDirectorMismatch = (stats.skippedDirectorMismatch || 0) + 1;
              return;
            }
          }
        }
      }

      // Handle fullTextWrongAuthor at second guard point too
      if (data.fullTextWrongAuthor === true) {
        delete data.fullText;
        delete data.assignedScore;
        delete data.ensembleData;
        const hasExcerpt = !!(data.bwwExcerpt || data.dtliExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt || data.stagedoorExcerpt || data.lboRoundupExcerpt);
        // Respect a human contentTier override (the only direct contentTier setter
        // that bypassed classifyContentTier's manualContentTier check). Mirrors the
        // wrongProduction setter-guard discipline (shouldSkipWrongProductionAudit):
        // a committed manual override must never be silently downgraded. Piece 3.
        if (!data.manualContentTier) data.contentTier = hasExcerpt ? 'excerpt' : 'stub';
        if (!hasExcerpt) {
          logExclusion("skippedFullTextWrongAuthor", showId, file, data);
          stats.skippedFullTextWrongAuthor = (stats.skippedFullTextWrongAuthor || 0) + 1;
          return;
        }
        // Falls through — included as excerpt-only
      }

      // Skip misattributed reviews (LLM-hallucinated critic/outlet combos)
      if (data.wrongAttribution === true) {
        logExclusion("skippedWrongAttribution", showId, file, data);
        stats.skippedWrongAttribution = (stats.skippedWrongAttribution || 0) + 1;
        return;
      }

      // Skip suspected misattributions (critic-registry guard).
      // Defensive override: stale flag where current registry would no longer fire.
      if (data.suspectedMisattribution === true && !isLikelyStaleSuspectedMisattribution(data, getCriticRegistry())) {
        logExclusion("skippedSuspectedMisattribution", showId, file, data);
        stats.skippedSuspectedMisattribution = (stats.skippedSuspectedMisattribution || 0) + 1;
        return;
      }

      // Skip reviews with explicit rejection reason (garbage text, OCR junk, etc.)
      if (data.rejectionReason) {
        logExclusion("skippedRejectionReason", showId, file, data);
        stats.skippedRejectionReason = (stats.skippedRejectionReason || 0) + 1;
        return;
      }

      // Skip roundup articles — only when explicitly flagged via isRoundupArticle.
      // NOTE: Do NOT auto-skip based on URL patterns like BWW review-roundup URLs.
      // Many reviews are SOURCED from roundup pages but have individual critic/outlet
      // attribution and should count as original reviews.
      // Defensive override: stale flag on a substantial individual review (long
      // fullText + isFullReview + non-roundup URL) is treated as wrong. Notion 34e637c5.
      if (data.isRoundupArticle === true && !isLikelyStaleRoundupFlag(data)) {
        logExclusion("skippedRoundup", showId, file, data);
        stats.skippedRoundup = (stats.skippedRoundup || 0) + 1;
        return;
      }

      // Skip reviews rejected by LLM ensemble Step 0 (wrong_show, wrong_production, not_a_review, garbage)
      if (data.rejectedBy && Array.isArray(data.rejectedBy) && data.rejectedBy.length >= 2) {
        logExclusion("skippedLlmRejected", showId, file, data);
        stats.skippedLlmRejected = (stats.skippedLlmRejected || 0) + 1;
        return;
      }

      // Canonical exclusion signal: rejectedAt timestamp is set by llm-scoring when the ensemble
      // rejects a review (wrong_production, wrong_show, not_a_review, garbage_text). Unlike
      // rejectionReason (which clear-failure-flags erases when text is substantial) and
      // rejectedBy (which is often a single-string from the scoreability check rather than an
      // array), rejectedAt is never cleared except by a successful re-scrape in
      // collect-review-texts.js line 4247. Without this guard, the Vulture FILM review of
      // Hamlet (rejected 2026-04-20 as wrong_production) slipped back into reviews.json after
      // clear-failure-flags nulled its rejectionReason.
      if (data.rejectedAt && typeof data.rejectedAt === 'string') {
        const reFetched = data.textFetchedAt && typeof data.textFetchedAt === 'string' && data.textFetchedAt > data.rejectedAt;
        if (!reFetched) {
          logExclusion("skippedRejectedAt", showId, file, data);
          stats.skippedRejectedAt = (stats.skippedRejectedAt || 0) + 1;
          return;
        }
      }

      // Skip reviews where LLM reasoning indicates wrong content (error pages, press releases, etc.)
      // Guard: If we already have a humanReviewScore OR a numeric llmScore.score, the LLM did NOT
      // refuse to score — so the regex below is inappropriate. It was originally added to catch
      // cases where the LLM refused entirely and only wrote prose ("this is a press release").
      // Balusters 2026 (David Cote) hit this: LLM reasoning quoted the critic verbatim
      // ("The critic explicitly states 'This is not a review'"), regex matched the QUOTED phrase,
      // review silently excluded despite valid humanReviewScore=63. See postmortem-balusters.
      const reasoning = data.llmScore?.reasoning || '';
      const hasScore = Number.isFinite(data.humanReviewScore) || Number.isFinite(data.llmScore?.score);
      if (!hasScore && reasoning && /\b(error page|error message|website error|search result|not a review|press release|announcement rather than|reality TV|Bachelor in Paradise)\b/i.test(reasoning)) {
        logExclusion("skippedWrongContent", showId, file, data);
        stats.skippedWrongContent = (stats.skippedWrongContent || 0) + 1;
        return;
      }

      // Skip reviews where show title was never mentioned AND there are no aggregator excerpts
      // Reviews with valid excerpts from DTLI/BWW/ShowScore are likely legitimate even without title match
      if (data.showNotMentioned === true) {
        // Safety net: if fullText (or wrongFullText from collect-review-texts nulling) mentions
        // the show, clear the stale flag. collect-review-texts.js moves fullText → wrongFullText
        // when it sets showNotMentioned, so we must check both fields.
        const textToCheck = (data.fullText && data.fullText.length > 300) ? data.fullText
          : (data.wrongFullText && data.wrongFullText.length > 300) ? data.wrongFullText
          : null;
        if (textToCheck) {
          // Use real show title from shows.json if available (ID-derived titles miss hyphenated names like "Boeing-Boeing")
          const realTitle = showTitleMap && showTitleMap[data.showId || showId];
          const idTitle = (data.showId || showId || '').replace(/-\d{4}$/, '').replace(/-/g, ' ').toLowerCase();
          const showTitle = realTitle ? realTitle.toLowerCase() : idTitle;
          const shortTitle = showTitle.replace(/^the /, '').replace(/ musical$/, '');
          // Comma-subtitle fallback ("beaches, a new musical" → "beaches"). Opening-night
          // reviews for subtitled shows nearly always mention the short title only.
          const commaIdx = showTitle.indexOf(',');
          const commaShort = commaIdx > 0 ? showTitle.slice(0, commaIdx).trim() : '';
          const textLower = textToCheck.substring(0, 5000).toLowerCase();
          if ((showTitle.length >= 4 && textLower.includes(showTitle)) || (shortTitle.length >= 5 && textLower.includes(shortTitle)) || (commaShort.length >= 4 && textLower.includes(commaShort))) {
            data.showNotMentioned = false;
            delete data._showNotMentionedDiscoveryAttempted;
            // Restore fullText from wrongFullText if it was nulled out
            if (!data.fullText && data.wrongFullText) {
              data.fullText = data.wrongFullText;
              delete data.wrongFullText;
            }
            stats.showNotMentionedAutoCleared = (stats.showNotMentionedAutoCleared || 0) + 1;
            // Write fix back to source file — re-read from disk to avoid overwriting
            // fields (e.g. fullText) that may have been updated by a concurrent process
            try {
              const sourceData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
              sourceData.showNotMentioned = false;
              delete sourceData._showNotMentionedDiscoveryAttempted;
              if (!sourceData.fullText && sourceData.wrongFullText) {
                sourceData.fullText = sourceData.wrongFullText;
                delete sourceData.wrongFullText;
              }
              safeWriteReview(filePath, sourceData, { force: true });
            } catch (e) { console.warn('  Failed to write back showNotMentioned fix:', filePath, e.message); }
          }
        }

        // Second auto-clear: LLM previously verified content as valid but heuristic still set
        // showNotMentioned (happens when word count < 200 prevents LLM from running during
        // collect-review-texts). Trust the prior LLM verification BUT verify the wrongFullText
        // actually mentions a show keyword first — LLMs hallucinate isValid:true on garbage
        // pages (browser-update prompts, paywall walls, sidebar lists, wrong-show content)
        // and a naive auto-restore would re-introduce the bad data.
        if (data.showNotMentioned === true) {
          const cv = data.contentVerification;
          if (cv && cv.verifiedBy && cv.verifiedBy.startsWith('llm:') && cv.isValid === true && !cv.wrongArticle && data.wrongFullText) {
            // Final-mile keyword check: wrongFullText must mention something distinctive
            // about this show (title word, lead actor surname, director surname, or venue word).
            // Catches LLM hallucinations where verifiedBy=llm:gemini, isValid=true, but the
            // actual text is sidebar junk / wrong-show content / browser-update prompts.
            // See scripts/lib/review-guards.js for the shared implementation + tests.
            const show = showsData.shows.find(s => s.id === (data.showId || showId));
            const kwCheck = checkLlmVerificationAgainstKeywords(show, data.wrongFullText, cv);
            const matchedKeyword = kwCheck && kwCheck.passed ? kwCheck.matchedKeyword : null;

            if (matchedKeyword) {
              data.showNotMentioned = false;
              delete data._showNotMentionedDiscoveryAttempted;
              if (!data.fullText && data.wrongFullText) {
                data.fullText = data.wrongFullText;
                delete data.wrongFullText;
              }
              stats.showNotMentionedCvCleared = (stats.showNotMentionedCvCleared || 0) + 1;
              try {
                const sourceData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                sourceData.showNotMentioned = false;
                delete sourceData._showNotMentionedDiscoveryAttempted;
                if (!sourceData.fullText && sourceData.wrongFullText) {
                  sourceData.fullText = sourceData.wrongFullText;
                  delete sourceData.wrongFullText;
                }
                safeWriteReview(filePath, sourceData, { force: true });
              } catch (e) { console.warn('  Failed to write back showNotMentioned CV fix:', filePath, e.message); }
            } else {
              // LLM verified valid but content fails keyword check — likely an LLM hallucination.
              // Leave showNotMentioned set; the file stays out of scoring until re-collected.
              stats.showNotMentionedCvSkippedHallucination = (stats.showNotMentionedCvSkippedHallucination || 0) + 1;
            }
          }
        }

        if (data.showNotMentioned === true) {
          const hasExcerpt = data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt || data.lboRoundupExcerpt || data.stagedoorExcerpt;
          // Allow through if review has an aggregator-provided star rating (e.g. from WET roundup)
          // even when scraped text was paywall junk that didn't mention the show
          const hasOriginalScore = (data.originalScore && parseOriginalScore(data.originalScore, data.outletId) !== null)
            || (data.aggregatorStars && parseOriginalScore(data.aggregatorStars, data.outletId) !== null);
          if (!hasExcerpt && !hasOriginalScore) {
            logExclusion("skippedShowNotMentioned", showId, file, data);
            stats.skippedShowNotMentioned = (stats.skippedShowNotMentioned || 0) + 1;
            return;
          }
          stats.showNotMentionedWithExcerpts = (stats.showNotMentionedWithExcerpts || 0) + 1;
        }
      }

      // Cross-show + within-show duplicate text detection.
      // Same fullText fingerprint = same review. Catches:
      //   - Cross-show contamination (review for show A filed under show B)
      //   - Within-show misattribution (same Vulture review filed under multiple critic names)
      // Within-show wins go to the file with the better critic attribution: prefer files
      // without "(Pt. 2)" / "unknown" / lowercased typo variants in the critic name.
      if (data.fullText && data.fullText.length > 200 && !skipCrossShowDupeIds.has(showId)) {
        const cleanedForFp = (cleanText(data.fullText) || '').toLowerCase().replace(/\s+/g, '');
        if (cleanedForFp.length > 200) {
          const fp = crypto.createHash('sha256').update(cleanedForFp).digest('hex').substring(0, 16);
          const existing = crossShowFingerprints.get(fp);
          if (existing && existing.showId !== showId && !skipCrossShowDupeIds.has(existing.showId)) {
            logExclusion("skippedCrossShowDupe", showId, file, data);
            stats.skippedCrossShowDupe = (stats.skippedCrossShowDupe || 0) + 1;
            if (!stats.crossShowDupeDetails) stats.crossShowDupeDetails = [];
            stats.crossShowDupeDetails.push(`${showId}/${file} duplicates ${existing.showId}/${existing.file}`);
            return;
          }
          if (existing && existing.showId === showId) {
            // Within-show duplicate. Skip the second one.
            logExclusion("skippedWithinShowDupe", showId, file, data);
            stats.skippedWithinShowDupe = (stats.skippedWithinShowDupe || 0) + 1;
            if (!stats.withinShowDupeDetails) stats.withinShowDupeDetails = [];
            stats.withinShowDupeDetails.push(`${showId}/${file} duplicates ${showId}/${existing.file}`);
            return;
          }
          if (!existing) {
            crossShowFingerprints.set(fp, { showId, file });
          }
        }
      }

      // Critic-registry outlet resolution: when a review has an "unknown" outlet but the
      // critic is in the registry with a known primaryOutlet, resolve the outlet before dedup.
      // This fixes Show-Score shadow entries where no known-outlet file exists in the directory.
      const rawOutletKey = normalizeOutletCanonical(data.outletId || data.outlet);
      const rawCriticKey = normalizeCriticCanonical(data.criticName || 'unknown');
      if (/^(unknown|unnamed)$/.test(rawOutletKey) && !/^(unknown|unnamed)$/.test(rawCriticKey)) {
        const registryEntry = criticRegistry.critics && criticRegistry.critics[rawCriticKey];
        if (registryEntry && registryEntry.primaryOutlet && !registryEntry.isFreelancer) {
          const resolvedOutlet = registryEntry.primaryOutlet;
          const resolvedDisplayName = getOutletDisplayName(resolvedOutlet);
          console.log(`  [REGISTRY RESOLVE] ${showId}/${file}: unknown → ${resolvedOutlet} (${resolvedDisplayName}) via critic ${rawCriticKey}`);
          data.outletId = resolvedOutlet;
          data.outlet = resolvedDisplayName;
          stats.resolvedUnknownOutlet = (stats.resolvedUnknownOutlet || 0) + 1;
          if (!stats.resolvedUnknownOutletDetails) stats.resolvedUnknownOutletDetails = [];
          stats.resolvedUnknownOutletDetails.push(`${showId}/${file}: unknown → ${resolvedOutlet}`);
        }
      }

      // Default-critic resolution: when critic is unknown/missing and the outlet has a
      // defaultCritic in the registry (single-author outlets), use it. This must run before
      // dedup so the resolved critic name participates in deduplication.
      // multiAuthor=true outlets opt out of this fill-in — see scripts/lib/critic-fill-rules.js
      // and the The Recs / Celebrity Autobiography 2026-05-20 incident.
      {
        const oid = normalizeOutletCanonical(data.outletId || data.outlet);
        const crit = (data.criticName || '').trim().toLowerCase();
        if (!crit || crit === 'unknown' || crit === 'unnamed') {
          const outletEntry = outletRegistry.outlets[oid];
          if (shouldFillDefaultCritic(outletEntry)) {
            data.criticName = outletEntry.defaultCritic;
            stats.resolvedDefaultCritic = (stats.resolvedDefaultCritic || 0) + 1;
          }
        }
      }

      // Session 3 #13 — critic mis-attribution canonicalization at rebuild time.
      // Without this, existing review files written BEFORE the gather-reviews-side
      // canonicalization landed (e.g., Rocky Horror 2026-04-23 cote-notices--david-finkle.json)
      // carry wrong critic names and the dedup's multi-critic-allow guard (bothNamed &&
      // differentPeople → allowed) lets them through as distinct critics. Running
      // canonicalization here ensures both the file written by the old BWW extractor AND
      // the file written by the new path converge on the same critic name before dedup.
      {
        const oid = normalizeOutletCanonical(data.outletId || data.outlet);
        if (data.criticName) {
          const canon = canonicalizeCritic(oid, data.criticName);
          if (canon.canonicalized) {
            data.criticName = canon.name;
            stats.canonicalizedCriticAtRebuild = (stats.canonicalizedCriticAtRebuild || 0) + 1;
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
          logExclusion("skippedUnknownCriticDedup", showId, file, data);
          stats.skippedUnknownCriticDedup = (stats.skippedUnknownCriticDedup || 0) + 1;
          return;
        }
      }

      // Unknown-outlet dedup: if the outlet is "unknown" but a file from a real outlet
      // exists for this same critic in this show's directory, skip the unknown entry.
      // This catches Show-Score shadow entries (e.g., unknown--samuel-l-leiter.json) when
      // a real outlet file exists (e.g., theater-life--samuel-l-leiter.json).
      // We check the directory (not seenKeys) because the known-outlet file may have been
      // filtered by other guards (e.g., duplicateOf).
      if (/^(unknown|unnamed)$/.test(outletKey) && !/^(unknown|unnamed)$/.test(criticKey)) {
        const criticSuffix = `--${criticKey}.json`;
        const knownOutletFileExists = files.some(f =>
          f !== file && f.endsWith(criticSuffix) && !(/^(unknown|unnamed)--/.test(f))
        );
        if (knownOutletFileExists) {
          console.log(`  [UNKNOWN-OUTLET DEDUP] ${showId}/${file}: critic ${criticKey} has known-outlet file in directory (skipping)`);
          logExclusion("skippedUnknownOutletDedup", showId, file, data);
          stats.skippedUnknownOutletDedup = (stats.skippedUnknownOutletDedup || 0) + 1;
          return;
        }
      }

      // Outlet-as-critic dedup: if the critic name matches the outlet name, this is likely
      // a scraper that couldn't extract the real critic name. Skip if a real named critic
      // already exists at this outlet.
      if (data.criticName) {
        const rawCritic = data.criticName.toLowerCase().trim();
        const rawOutlet = (data.outlet || '').toLowerCase().trim();
        const rawOutletId = (data.outletId || '').toLowerCase().trim();
        const displayName = (getOutletDisplayName(outletKey) || '').toLowerCase().trim();
        const isCriticSameAsOutlet = rawCritic === rawOutlet || rawCritic === rawOutletId || rawCritic === displayName || criticKey === outletKey;

        if (isCriticSameAsOutlet) {
          let namedCriticExists = false;
          for (const existingKey of seenKeys) {
            const [existingOutlet, existingCritic] = existingKey.split('|');
            if (existingOutlet === outletKey && existingCritic !== criticKey && !/^(unknown|unnamed)$/.test(existingCritic)) {
              namedCriticExists = true;
              break;
            }
          }
          if (namedCriticExists) {
            logExclusion("skippedOutletAsCriticDedup", showId, file, data);
            stats.skippedOutletAsCriticDedup = (stats.skippedOutletAsCriticDedup || 0) + 1;
            return;
          }
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
        // Canonicalize: lowercase host, strip fragment + tracking params, drop trailing slash.
        // Non-tracking query params are preserved (some legacy CMS outlets use them as
        // article IDs). See scripts/lib/review-guards.js canonicalizeUrlForDedup — shared
        // across rebuild / gather / SERP / llm-extractor for consistent dedup behavior.
        // Rocky Horror 2026-04-23: ?triedRedirect=true let Cote Notices ship twice.
        const normalizedUrl = canonicalizeUrlForDedup(data.url);
        // Use canonical outletId for URL dedup
        const urlOutletKey = normalizeOutletCanonical(data.outletId || data.outlet);
        const urlDedupKey = `${urlOutletKey}|${normalizedUrl}`;
        const currentCritic = (data.criticName || '').toLowerCase().trim();
        if (seenUrlsByOutlet.has(urlDedupKey)) {
          const winner = seenUrlsByOutlet.get(urlDedupKey);
          // Allow through if BOTH files have different named critics — multi-critic pages
          // (e.g., Daily Mail dual reviews, NYT multiple critics, Variety rotating reviewers).
          // Content fingerprint dedup downstream catches cases where the text is identical.
          const bothNamed = currentCritic && currentCritic !== 'unknown' &&
                            winner.critic && winner.critic !== 'unknown';
          const differentPeople = bothNamed && currentCritic !== winner.critic;
          // Fuzzy critic dedup — catch typo-variant duplicates (Isabella Biedenahrn vs
          // Biedenharn, Marilyn vs Marylin Stasio, etc.) that the strict-equality check
          // above treats as distinct critics. Audit 2026-04-24 found 18 such pairs in
          // live data. Levenshtein ≤ 2 with min-length ≥ 6 is tight enough not to
          // collapse legitimate different critics (Ben Brantley vs Charles Isherwood
          // are edit-distance >> 2).
          const fuzzySame = differentPeople && areSameCriticFuzzy(currentCritic, winner.critic);
          if (differentPeople && !fuzzySame) {
            stats.allowedMultiCriticUrl = (stats.allowedMultiCriticUrl || 0) + 1;
          } else {
            // Files are sorted so real critic names come before "unknown" — first wins.
            // Fuzzy-matched typo-duplicates also fall through here.
            if (fuzzySame) {
              stats.skippedFuzzyCriticDuplicate = (stats.skippedFuzzyCriticDuplicate || 0) + 1;
              console.log(`  [FUZZY-CRITIC DEDUP] ${showId}/${file}: ${data.criticName} ≈ ${winner.critic} at ${urlOutletKey} (keeping ${winner.file})`);
            }
            logExclusion("skippedDuplicateUrl", showId, file, data);
            stats.skippedDuplicateUrl = (stats.skippedDuplicateUrl || 0) + 1;
            return;
          }
        } else {
          seenUrlsByOutlet.set(urlDedupKey, { file, critic: currentCritic });
        }

        // Cross-outlet URL dedup: same URL filed under different outlets (e.g., unknown + nytimes)
        // Files are sorted so real outlet names come before "unknown" — first wins
        // Also allow through if both have different named critics (same multi-critic logic)
        if (seenUrlsGlobal.has(normalizedUrl)) {
          const globalWinner = seenUrlsGlobal.get(normalizedUrl);
          const bothNamedGlobal = currentCritic && currentCritic !== 'unknown' &&
                                  globalWinner.critic && globalWinner.critic !== 'unknown';
          const differentPeopleGlobal = bothNamedGlobal && currentCritic !== globalWinner.critic;
          // Fuzzy check mirrors the same-outlet path — typo duplicates across the
          // cross-outlet index should also collapse (rare but possible).
          const fuzzySameGlobal = differentPeopleGlobal && areSameCriticFuzzy(currentCritic, globalWinner.critic);
          if (differentPeopleGlobal && !fuzzySameGlobal) {
            stats.allowedMultiCriticUrlCrossOutlet = (stats.allowedMultiCriticUrlCrossOutlet || 0) + 1;
          } else {
            if (fuzzySameGlobal) {
              stats.skippedFuzzyCriticDuplicateCrossOutlet = (stats.skippedFuzzyCriticDuplicateCrossOutlet || 0) + 1;
            }
            logExclusion("skippedCrossOutletDuplicateUrl", showId, file, data);
            stats.skippedCrossOutletDuplicateUrl = (stats.skippedCrossOutletDuplicateUrl || 0) + 1;
            return;
          }
        } else {
          seenUrlsGlobal.set(normalizedUrl, { file, critic: currentCritic });
        }
      }

      // Content fingerprint dedup: same review text at same outlet under different critic names
      // Belt-and-suspenders: catches duplicates even if duplicateTextOf flag was never set
      // Files are pre-sorted by quality (non-duplicate, verified, ensemble-scored first)
      // so first-seen is the preferred file.
      //
      // Single-author-outlet swap rule: when a fingerprint collision occurs at an outlet
      // with outlet.defaultCritic set, prefer the file whose criticName matches the default
      // critic. Defense-in-depth against cross-aggregator mis-attribution that URL dedup +
      // static CRITIC_CANONICAL_MAP miss (e.g., an outlet-registry-defaulting file beats a
      // randomly-attributed first-in file with the same text).
      if (data.fullText && data.fullText.length >= 100) {
        const fingerprint = computeContentFingerprint(data.fullText);
        if (fingerprint) {
          const outletKey2 = normalizeOutletCanonical(data.outletId || data.outlet);
          const fpKey = `${outletKey2}|${fingerprint}`;
          const outletEntry = outletRegistry.outlets[outletKey2];
          // multiAuthor=true outlets opt out of FINGERPRINT SWAP-TO-DEFAULT too —
          // see scripts/lib/critic-fill-rules.js. Otherwise a rotating-byline outlet
          // would still get its winner swapped to whichever incoming critic matches
          // the registry's defaultCritic.
          const defaultCritic = shouldFillDefaultCritic(outletEntry) ? outletEntry.defaultCritic : null;
          const defaultCriticKey = defaultCritic ? normalizeCriticCanonical(defaultCritic) : null;
          const incomingCriticKey = normalizeCriticCanonical(data.criticName || 'unknown');

          if (seenFingerprintsByOutlet.has(fpKey)) {
            const winnerRec = seenFingerprintsByOutlet.get(fpKey);
            const winnerFile = typeof winnerRec === 'string' ? winnerRec : winnerRec.file;
            const winnerCriticKey = typeof winnerRec === 'string' ? null : winnerRec.criticKey;
            // Swap-to-default: if the outlet has a defaultCritic and the incoming file's
            // critic matches it while the winner's doesn't, swap them. Incoming becomes the
            // winner; the prior winner is dropped. This is the proactive fix that the
            // existing post-hoc `detect-syndicated-duplicates.js` pass doesn't deliver.
            if (defaultCriticKey &&
                incomingCriticKey === defaultCriticKey &&
                winnerCriticKey && winnerCriticKey !== defaultCriticKey) {
              console.log(`  [FINGERPRINT SWAP-TO-DEFAULT] ${showId}/${file}: critic matches defaultCritic "${defaultCritic}" — replacing prior winner ${winnerFile}`);
              // Log the drop of the prior winner so the audit trail survives.
              logExclusion("skippedFingerprintDedupSwapped", showId, winnerFile, null, {
                reason: `swapped for ${file} (critic matches outlet.defaultCritic)`,
              });
              stats.swappedFingerprintToDefault = (stats.swappedFingerprintToDefault || 0) + 1;
              seenFingerprintsByOutlet.set(fpKey, { file, criticKey: incomingCriticKey });
              // Don't `return` — let the incoming file flow through to output below.
            } else {
              console.log(`  [FINGERPRINT DEDUP] ${showId}/${file}: same text as ${winnerFile} at ${outletKey2} (keeping ${winnerFile})`);
              logExclusion("skippedFingerprintDedup", showId, file, data);
              stats.skippedFingerprintDedup = (stats.skippedFingerprintDedup || 0) + 1;
              return;
            }
          } else {
            seenFingerprintsByOutlet.set(fpKey, { file, criticKey: incomingCriticKey });
          }

          // Cross-outlet fingerprint dedup: same article filed under different outlet names
          if (seenFingerprintsGlobal.has(fingerprint)) {
            const winnerRec = seenFingerprintsGlobal.get(fingerprint);
            const winnerFile = typeof winnerRec === 'string' ? winnerRec : winnerRec.file;
            console.log(`  [CROSS-OUTLET FINGERPRINT DEDUP] ${showId}/${file}: same text as ${winnerFile} (keeping ${winnerFile})`);
            logExclusion("skippedCrossOutletFingerprintDedup", showId, file, data);
            stats.skippedCrossOutletFingerprintDedup = (stats.skippedCrossOutletFingerprintDedup || 0) + 1;
            return;
          }
          seenFingerprintsGlobal.set(fingerprint, { file, criticKey: incomingCriticKey });
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
        // Auto-exclude: flagged reviews are excluded from reviews.json, not just audited.
        // Override: add "allowTourSignal": true to the review-text JSON to force inclusion.
        if (!data.allowTourSignal && showStatusMap[showId] !== 'tour-stop') {
          const tourCheck = isTourReviewExcerpt(introText);
          if (tourCheck.isTourReview) {
            flagForHumanReview(data, 'possible-tour-fulltext',
              `Tour signal in fullText intro: ${tourCheck.signal}`);
            logExclusion("skippedTourContamination", showId, file, data);
            stats.skippedTourContamination = (stats.skippedTourContamination || 0) + 1;
            return;
          }
        }

        // Film/TV detection (2+ film/streaming keywords, 0 theater keywords)
        // Auto-exclude: separate from tour detection — allowTourSignal does NOT bypass this.
        // Override: add "allowFilmSignal": true to the review-text JSON to force inclusion.
        if (!data.allowFilmSignal) {
          const filmCheck = isFilmTvReview(introText);
          if (filmCheck.isFilmTv) {
            flagForHumanReview(data, 'possible-film-tv-fulltext',
              `Film/TV signals in fullText intro: ${filmCheck.signals.join(', ')}`);
            logExclusion("skippedFilmTvContamination", showId, file, data);
            stats.skippedFilmTvContamination = (stats.skippedFilmTvContamination || 0) + 1;
            return;
          }
        }
      }

      // ROUNDUP URL DETECTION: Auto-flag reviews whose URL matches known roundup patterns.
      // Roundup pages aggregate multiple outlets' ratings — they are not individual reviews.
      // Guard: skip files where isRoundupArticle was manually cleared (shouldSkipRoundupAudit).
      if (data.url && !data.isRoundupArticle && !shouldSkipRoundupAudit(data)) {
        const roundupCheck = isRoundupUrl(data.url);
        if (roundupCheck.isRoundup) {
          data.isRoundupArticle = true;
          data.roundupNote = roundupCheck.reason;
          stats.autoFlaggedRoundup = (stats.autoFlaggedRoundup || 0) + 1;
          // Don't return — roundup reviews can still be scored, but the flag
          // prevents them from being treated as individual outlet reviews in display
        }
      }

      // VENUE MISMATCH DETECTION: Flag when review URL mentions a venue that doesn't
      // match the show's actual venue (e.g., URL says "national-theatre" but show is WE).
      // This catches reviews of pre-transfer/try-out runs filed under the WE production.
      if (data.url && !data.wrongProduction) {
        const showObj = showsData.shows.find(s => s.id === showId);
        const showVenue = showObj && showObj.venue;
        const showCat = showCategoryMap[showId] || 'broadway';
        const venueCheck = isVenueMismatch(data.url, showVenue, showCat);
        if (venueCheck.isMismatch) {
          flagForHumanReview(data, 'venue-url-mismatch', venueCheck.reason);
          stats.venueMismatchFlags = (stats.venueMismatchFlags || 0) + 1;
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
      const scorableText = data.fullText || data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt || data.lboRoundupExcerpt || '';
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

      const { score, source } = scoreResult;
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
        outlet: (getOutletDisplayName(canonicalOutletId) || data.outlet || data.outletId || 'Unknown').replace(/\s{2,}/g, ' '),
        assignedScore: score,
        scoreSource: source,
        bucket: scoreToBucket(score),
        thumb: scoreToThumb(score),
        criticName: data.criticName || null,
        url: data.url || null,
        publishDate: normalizePublishDate(data.publishDate) || (() => {
          // Backfill: extract date from URL when source file has no publishDate
          const urlDate = extractDateFromUrl(data.url);
          if (urlDate && urlDate.date) {
            stats.urlDateBackfills = (stats.urlDateBackfills || 0) + 1;
            // Validate: if extracted date year is before show opens, log warning
            if (showDateMap[showId]) {
              const showYear = showDateMap[showId].getFullYear();
              const extractedYear = parseInt(urlDate.date.substring(0, 4));
              if (extractedYear < showYear - 1) {
                console.log(`  [URL-DATE SUSPECT] ${showId}/${file}: URL date ${urlDate.date} is before show opens ${showYear} (${urlDate.source})`);
                if (!stats.urlDateSuspect) stats.urlDateSuspect = [];
                stats.urlDateSuspect.push({ showId, file, urlDate: urlDate.date, showYear, source: urlDate.source });
              }
            }
            return urlDate.date;
          }
          // NO opening-date fallback — see memory/feedback_no_opening_date_fallback.md
          // Stamping the show's opening date on undated reviews would mask wrong-production
          // issues (e.g., a tour review would look like a legitimate Broadway review).
          // Honest state: leave undated if no verifiable source found.
          return null;
        })(),
        originalRating: (source === 'originalScore-priority0' || source === 'originalScore-showscore-downgraded')
          ? data.originalScore || null
          : source === 'aggregatorStars-fallback'
          ? data.aggregatorStars || null
          : null,  // Don't display star rating when it wasn't used for scoring
        pullQuote: (() => {
          data._showStatus = showStatusMap[showId];
          const raw = selectBestExcerpt(data, showTitleMap[showId]);
          if (raw && isJunkExcerpt(raw)) return null;
          const quote = normalizeQuoteWrapping(raw);
          // Reject quotes ending with broken contractions (truncated at HTML entity boundaries)
          if (quote && /(^|\s)(he|she|it|we|they|who|wasn|wouldn|couldn|didn|don|isn|aren|won|haven|hasn|shouldn|mustn|weren|hadn|I)['\u2019]$/.test(quote)) {
            return null;
          }
          return quote;
        })(),
        dtliThumb: data.dtliThumb || null,
        bwwThumb: data.bwwThumb || null,
        contentTier: data.contentTier || 'none',
        // Ensemble scoring metadata (for confidence analysis + auditing)
        ...(data.ensembleData ? {
          scoreDelta: data.ensembleData.scoreDelta || 0,
          modelAgreement: data.ensembleData.modelAgreement || null,
          needsReview: data.ensembleData.needsReview || false,
          // Emergency flag: 1-of-N models succeeded — excluded from compositeScore by engine.ts
          ...(data.ensembleData.singleModelEmergency ? { singleModelEmergency: true } : {}),
        } : {}),
        ...(data.llmScore ? {
          scoreConfidence: data.llmScore.confidence || null,
        } : {})
      };

      // Sanitize display fields: decode HTML entities in critic name, outlet, pullQuote
      if (review.criticName) review.criticName = decodeHtmlEntities(review.criticName);
      if (review.outlet) review.outlet = decodeHtmlEntities(review.outlet);
      if (review.pullQuote) review.pullQuote = decodeHtmlEntities(review.pullQuote);

      // Critic's Pick is NYT-specific — only set when the review's URL is in
      // data/nyt-critics-picks.json (scraped from the NYT spotlight page).
      // Any non-NYT outlet carrying designation='Critics_Pick' is categorically
      // wrong (e.g. nyt-theater blog, newyorker) and gets cleared too.
      //
      // The previous regex-based auto-detection matched NYT site chrome (the
      // 'criticsPick' CSS class on every review page), producing ~10% false
      // positives — Fear of 13 / Helen Shaw 2026-04-15 was flagged despite not
      // being a pick. See memory/feedback_nyt_critics_pick_source.md.
      const isNytOutlet = review.outletId === 'nytimes' || (data.outletId || '').startsWith('nytimes');
      const desiredDesignation = (() => {
        if (isNytOutlet) {
          const pickUrl = review.url || data.url;
          return pickUrl && NYT_CRITICS_PICK_URLS.has(canonicalPickUrl(pickUrl)) ? 'Critics_Pick' : null;
        }
        // Non-NYT: clear Critics_Pick (FP from a legacy path); preserve anything else.
        if (data.designation === 'Critics_Pick') return null;
        return data.designation || null;
      })();
      review.designation = desiredDesignation;
      if ((data.designation || null) !== desiredDesignation) {
        try {
          const sourceData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          sourceData.designation = desiredDesignation;
          safeWriteReview(filePath, sourceData, { force: true });
        } catch (e) { /* read-only in CI */ }
      }

      allReviews.push(review);
      stats.byShow[showId].reviews++;
      stats.totalReviews++;

    } catch (e) {
      if (e instanceof SyntaxError) {
        console.error(`  [CORRUPTED] ${showId}/${file}: invalid JSON — ${e.message}`);
        logExclusion("skippedCorrupted", showId, file, null, { reason: "invalid JSON", error: e.message.substring(0, 200) });
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

      // Non-blocking — analyze-rebuild-drops.js sends qualitative alert email.
      if (driftedReviews.length > DRIFT_THRESHOLD) {
        console.log(`  ⚠️  Exceeds threshold (${DRIFT_THRESHOLD}). analyze-rebuild-drops.js will send an alert email.`);
      }
      console.log(`\n  📋 ACTION: This guard is NON-BLOCKING — the rebuild will continue.`);
      console.log(`     If drift is from opening night corrections: this is expected, no action needed.`);
      console.log(`     If unexpected: check data/audit/rebuild-score-drift.json for details.`);
      console.log(`     To fix wrong scores: set humanReviewScore on the source file (the only field rebuild respects).`);
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
    const explainedByFlagging = new Set(); // Shows where drop is explained by audit flags
    for (const [showId, oldCount] of oldCountByShow) {
      const newCount = newCountByShow.get(showId) || 0;
      const dropped = oldCount - newCount;
      if (dropped > REGRESSION_DROP_THRESHOLD) {
        // Count scored files on disk, separating unflagged from flagged.
        // Flagged files were excluded by audit steps (wrongProduction, wrongShow, etc.)
        // and their removal is intentional data cleanup, not corruption.
        // Also count files that inline guards would exclude (cross-market, pre-opening date)
        // even if the guard's fs.writeFileSync failed silently in CI (read-only checkout).
        const showDir = path.join(reviewTextsDir, showId);
        let scoredUnflagged = 0;
        let scoredFlagged = 0;
        let inlineGuardWouldExclude = 0;
        const sCat = showCategoryMap[showId] || 'broadway';
        const sEarliest = showDateMap[showId];
        if (fs.existsSync(showDir)) {
          for (const f of fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json')) {
            try {
              const d = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
              if (d.assignedScore == null) continue;
              // Explicit exclusion flags (set by audit passes or guard writes that succeeded)
              if (d.wrongShow || d.wrongProduction || d.duplicateOf || d.isRoundupArticle
                  || d.incompleteReason === 'wrong_content' || d.contentTier === 'invalid') {
                scoredFlagged++;
              } else {
                // Predict inline guard exclusions that don't persist flags to disk:
                // 1. Reverse cross-market: London outlet on Broadway/off-Broadway show
                let wouldBeExcluded = false;
                if ((sCat === 'broadway' || sCat === 'off-broadway') && !d.allowCrossMarket) {
                  const outlet = normalizeOutletCanonical(d.outletId || d.outlet || '');
                  if (!DUAL_MARKET_OUTLETS.has(outlet)) {
                    const region = outletRegionMap[outlet];
                    let urlIsUK = false;
                    if (!region && d.url) {
                      try { const h = new URL(d.url).hostname; urlIsUK = h.endsWith('.co.uk') || h.endsWith('.org.uk'); } catch {}
                    }
                    if (region === 'london' || urlIsUK) wouldBeExcluded = true;
                  }
                }
                // 2. Pre-opening date: review published well before show opened
                //    (priorRuns exemption mirrors the inclusion guard above)
                if (!wouldBeExcluded && d.publishDate && sEarliest && !d.allowEarlyDate && !d.routedFromShowId && !showLongRunWE.has(showId)) {
                  const pubDate = parseDate(d.publishDate);
                  if (pubDate) {
                    const daysBefore = Math.ceil((sEarliest - pubDate) / (1000 * 60 * 60 * 24));
                    const threshold = (sCat === 'off-broadway' || isLondonMarket(sCat)) ? 90 : 14;
                    const inPriorRun = isWithinPriorRun(pubDate, showById[showId]?.priorRuns);
                    if (daysBefore > threshold && !inPriorRun) wouldBeExcluded = true;
                  }
                }
                // 3. Syndication dedup
                if (!wouldBeExcluded) {
                  const criticLc = (d.criticName || '').toLowerCase().trim();
                  const outletLc = normalizeOutletCanonical(d.outletId || d.outlet || '');
                  const syndConfig = KNOWN_SYNDICATION_PAIRS[criticLc];
                  if (syndConfig && syndConfig.secondary.includes(outletLc)) wouldBeExcluded = true;
                }
                if (wouldBeExcluded) {
                  inlineGuardWouldExclude++;
                } else {
                  scoredUnflagged++;
                }
              }
            } catch {}
          }
        }
        // The disk-vs-build mismatch tells us if the rebuild is unexpectedly dropping reviews.
        // A small mismatch (<=REGRESSION_DROP_THRESHOLD) is expected from minor inline guards
        // (URL-year, etc.) that can't be predicted from file flags alone.
        const totalExcluded = scoredFlagged + inlineGuardWouldExclude;
        const diskMismatch = scoredUnflagged - newCount;
        if (diskMismatch <= REGRESSION_DROP_THRESHOLD) {
          // Drop is explained by audit flags + inline guard predictions + small tolerance
          explainedByFlagging.add(showId);
          const details = [];
          if (scoredFlagged > 0) details.push(`${scoredFlagged} flagged`);
          if (inlineGuardWouldExclude > 0) details.push(`${inlineGuardWouldExclude} inline guards`);
          if (diskMismatch > 0) details.push(`${diskMismatch} tolerance`);
          console.log(`  ℹ️  ${showId}: ${oldCount}→${newCount} (explained: ${details.join(', ')})`);
        } else if (scoredUnflagged + totalExcluded <= newCount) {
          // Source files were deleted — fewer scored files exist than build output
          console.log(`  ℹ️  ${showId}: ${oldCount}→${newCount} (expected — only ${scoredUnflagged} unflagged scored files on disk)`);
        } else {
          // Unexplained regression — rebuild is dropping unflagged scored files
          regressions.push({ showId, oldCount, newCount, dropped, scoredOnDisk: scoredUnflagged, flaggedScored: scoredFlagged, inlineGuardExcluded: inlineGuardWouldExclude, reason: 'scored files exist but being dropped' });
        }
      }
    }
    if (explainedByFlagging.size > 0) {
      console.log(`\n✅ ${explainedByFlagging.size} show(s) lost reviews due to audit flagging (intentional cleanup)`);
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

      // Non-blocking — analyze-rebuild-drops.js sends qualitative alert email.
      console.log(`\n  📋 ACTION: This guard is NON-BLOCKING — the rebuild will continue.`);
      console.log(`     If regressions are from opening night corrections (flagging wrongProduction, duplicates): expected.`);
      console.log(`     If unexpected: check data/audit/rebuild-regression.json for details.`);
      console.log(`     Each entry shows scored files on disk vs build output — disk mismatch = bug.`);
      console.log(`     If deploy is blocked: gh workflow run "Rebuild Reviews Data" -f force_write=true`);
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

      // Skip shows where the review drop was explained by audit flagging —
      // removing flagged reviews naturally shifts the average, and that's intentional.
      if (explainedByFlagging.has(showId)) continue;

      // Skip shows with ≤3 reviews — averages are mathematically volatile at this scale.
      // Losing 1 of 2-3 reviews shifts the mean 10-30 pts by arithmetic alone, not corruption.
      if (oldScores.length <= 3) continue;

      // Skip shows where the drop is within inline-guard tolerance (REGRESSION_DROP_THRESHOLD).
      // The regression guard (3B-ii) already accepted these as explained by inline guards
      // (cross-market, URL-year, dedup). Don't double-penalize with a drift failure here.
      const reviewDrop = oldScores.length - newScores.length;
      if (reviewDrop > 0 && reviewDrop <= REGRESSION_DROP_THRESHOLD) continue;

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

      // Non-blocking — analyze-rebuild-drops.js sends qualitative alert email.
      console.log(`\n  📋 ACTION: This guard is NON-BLOCKING — the rebuild will continue.`);
      console.log(`     Show-level drift without new reviews usually means: tier weight change, outlet remap, or duplicate detection.`);
      console.log(`     If from corrections: expected — scores shift when bad reviews are removed/fixed.`);
      console.log(`     Details: data/audit/rebuild-show-drift.json`);
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
// POST-PROCESSING: Outlet-level dedup — keep only one review per outlet+critic per show.
// Different critics at the same outlet are genuinely different reviews and both count.
// Only dedup when the SAME critic has multiple entries at the same outlet (true duplicate).
// Same-URL duplicates were already caught by seenUrlsByOutlet earlier in the pipeline.
{
  const beforeCount = allReviews.length;
  const byShowOutlet = new Map();
  for (const review of allReviews) {
    const criticKey = (review.criticName || 'unknown').toLowerCase().replace(/\s+/g, '');
    const key = `${review.showId}|${review.outletId}|${criticKey}`;
    if (!byShowOutlet.has(key)) {
      byShowOutlet.set(key, review);
    } else {
      const existing = byShowOutlet.get(key);
      const existDate = existing.publishDate || '';
      const newDate = review.publishDate || '';
      if (newDate > existDate) {
        byShowOutlet.set(key, review);
      }
    }
  }
  const deduped = [...byShowOutlet.values()];
  const removed = beforeCount - deduped.length;
  if (removed > 0) {
    console.log(`\nOutlet-level dedup: removed ${removed} duplicate-outlet reviews (keeping most recent per outlet)`);
    allReviews.length = 0;
    allReviews.push(...deduped);
    stats.skippedMultiCriticOutletDedup = removed;
  }
}

// POST-PROCESSING (pass 2): outlet-DISPLAY-NAME dedup, matching validate-data.js's
// duplicate outlet+critic invariant EXACTLY (scripts/validate-data.js ~L1441:
// key = outlet.toLowerCase().trim() | criticName.toLowerCase().trim() per show).
// Pass 1 above keys on outletId, so the same critic split across two outletId
// variants of one outlet — e.g. `timeout` ("Time Out") + `timeout-london`
// ("Time Out London"), both Andrzej Lukowski on showstopper-WE — survives pass 1
// but trips the Data Validation gate, turning main red until the next rebuild
// happens to clean it. Keying pass 2 on the display name guarantees the rebuild
// can never emit what the gate rejects. Keep the most-recent entry on collision.
{
  const beforeCount = allReviews.length;
  const byShowOutletName = new Map();
  for (const review of allReviews) {
    const outletKey = (review.outlet || 'unknown').toLowerCase().trim();
    const criticKey = (review.criticName || 'unknown').toLowerCase().trim();
    const key = `${review.showId}|${outletKey}|${criticKey}`;
    if (!byShowOutletName.has(key)) {
      byShowOutletName.set(key, review);
    } else {
      const existing = byShowOutletName.get(key);
      if ((review.publishDate || '') > (existing.publishDate || '')) {
        byShowOutletName.set(key, review);
      }
    }
  }
  const deduped = [...byShowOutletName.values()];
  const removed = beforeCount - deduped.length;
  if (removed > 0) {
    console.log(`\nOutlet-name dedup: removed ${removed} same-display-name+critic duplicate(s) (validate-data invariant)`);
    allReviews.length = 0;
    allReviews.push(...deduped);
    stats.skippedOutletNameDedup = removed;
  }
}

// Preserve manualEntry reviews from the current reviews.json that the pipeline didn't produce.
// These are direct corrections added via manual-review-direct.js. They survive until the pipeline
// produces a version with scoreSource='human-review' (meaning the source file was processed).
{
  try {
    const currentReviewsPath = reviewsJsonPath; // already defined earlier in the script
    if (fs.existsSync(currentReviewsPath)) {
      const currentData = JSON.parse(fs.readFileSync(currentReviewsPath, 'utf8'));
      const manualEntries = (currentData.reviews || []).filter(r => r.manualEntry === true);
      let preserved = 0;
      const normCritic = (name) => (name || 'unknown').toLowerCase().trim();
      for (const manual of manualEntries) {
        const manualCritic = normCritic(manual.criticName);
        // Match by showId + outletId + criticName. Outlets like NYSR have multiple
        // critics per show — matching only by outletId returns the wrong entry and
        // leaves the actual pipeline version un-replaced (causing a duplicate).
        const pipelineVersion = allReviews.find(r =>
          r.showId === manual.showId &&
          r.outletId === manual.outletId &&
          normCritic(r.criticName) === manualCritic
        );
        if (pipelineVersion && pipelineVersion.scoreSource === 'human-review') {
          // Pipeline processed the source file with humanReviewScore — it's authoritative
          continue;
        }
        if (pipelineVersion && pipelineVersion.assignedScore) {
          // Pipeline has an LLM score — keep manual entry (human score beats LLM)
          const idx = allReviews.indexOf(pipelineVersion);
          if (idx >= 0) allReviews[idx] = manual;
          preserved++;
        } else if (!pipelineVersion) {
          // Pipeline didn't produce this review at all — keep manual entry
          allReviews.push(manual);
          preserved++;
        }
      }
      if (preserved > 0) {
        console.log(`\n✅ Preserved ${preserved} manual entries from previous reviews.json`);
      }
    }
  } catch (e) {
    // Non-fatal: if we can't read current reviews.json, just proceed without manual entries
  }
}

const output = {
  _meta: {
    description: "Critic reviews - raw input data",
    lastUpdated: new Date().toISOString(),
    notes: "Rebuilt from review-texts. Reviews without valid scores are EXCLUDED.",
    stats: {
      totalReviews: stats.totalReviews,
      skippedNoScore: stats.skippedNoScore,
      skippedDuplicate: stats.skippedDuplicate,
      skippedDuplicateUrl: stats.skippedDuplicateUrl || 0,
      allowedMultiCriticUrl: stats.allowedMultiCriticUrl || 0,
      skippedCrossOutletDuplicateUrl: stats.skippedCrossOutletDuplicateUrl || 0,
      allowedMultiCriticUrlCrossOutlet: stats.allowedMultiCriticUrlCrossOutlet || 0,
      skippedFuzzyCriticDuplicate: stats.skippedFuzzyCriticDuplicate || 0,
      skippedFuzzyCriticDuplicateCrossOutlet: stats.skippedFuzzyCriticDuplicateCrossOutlet || 0,
      swappedFingerprintToDefault: stats.swappedFingerprintToDefault || 0,
      skippedDuplicateText: stats.skippedDuplicateText || 0,
      skippedFingerprintDedup: stats.skippedFingerprintDedup || 0,
      skippedUnknownCriticDedup: stats.skippedUnknownCriticDedup || 0,
      skippedUnknownOutletDedup: stats.skippedUnknownOutletDedup || 0,
      skippedWrongProduction: stats.skippedWrongProduction || 0,
      skippedFabricated: stats.skippedFabricated || 0,
      skippedCrossShowUrl: stats.skippedCrossShowUrl || 0,
      skippedCrossMarket: stats.skippedCrossMarket || 0,
      skippedMultiCriticOutletDedup: stats.skippedMultiCriticOutletDedup || 0,
      skippedUrlYearStandalone: stats.skippedUrlYearStandalone || 0,
      showScoreDowngradedFallback: stats.showScoreDowngradedFallback || 0,
      recoveredFromGarbage: stats.recoveredFromGarbage || 0,
      scoreSources: stats.scoreSources
    }
  },
  reviews: allReviews
};

// REVIEW COUNT REGRESSION GUARD: warn if rebuild would lose >2% of reviews.
// Logs prominently and writes audit trail, but proceeds with the write.
// Pass --force-write to suppress this warning when the drop is intentional.
{
  const forceWrite = process.argv.includes('--force-write');
  let existingCount = 0;
  try {
    const existing = JSON.parse(fs.readFileSync(reviewsJsonPath, 'utf8'));
    existingCount = (existing.reviews || []).length;
  } catch (e) { /* first run, no existing file */ }

  if (existingCount > 0) {
    const newCount = allReviews.length;
    const lost = existingCount - newCount;
    const pctLost = (lost / existingCount * 100).toFixed(1);
    if (lost > 0 && parseFloat(pctLost) > 2.0) {
      if (forceWrite) {
        console.log(`\n⚠️  REGRESSION GUARD: Dropping ${lost} reviews (${pctLost}%) — suppressed by --force-write`);
      } else {
        console.error(`\n🚨 REGRESSION GUARD: Rebuild is dropping ${lost} reviews (${pctLost}% loss)`);
        console.error(`   Existing: ${existingCount} reviews → New: ${newCount} reviews`);
        console.error(`   This usually means the review-texts checkout is stale or incomplete.`);
        console.error(`   PROCEEDING WITH WRITE — deploy may be blocked by pre-deploy-check.js (3% threshold).`);
        console.error(`   Details: data/audit/rebuild-regression.json`);
        console.error(`   To override: gh workflow run "Rebuild Reviews Data" -f reason="..." -f force_write=true`);
      }
      // Write audit trail for tracking
      try {
        const auditDir = path.join(path.dirname(reviewsJsonPath), 'audit');
        if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
        fs.writeFileSync(path.join(auditDir, 'rebuild-regression.json'), JSON.stringify({
          timestamp: new Date().toISOString(),
          existingCount,
          newCount,
          lost,
          pctLost: parseFloat(pctLost),
          argv: process.argv.slice(2),
        }, null, 2) + '\n');
      } catch (auditErr) {
        console.error(`   Could not write audit file: ${auditErr.message}`);
      }
    }
    if (lost > 0 && parseFloat(pctLost) <= 2.0) {
      console.log(`\n⚠️  Review count decreased by ${lost} (${pctLost}%) — within 2% threshold, proceeding.`);
    }
  }
}

// Write output atomically (tmp + rename) to prevent torn writes if CI is killed
// mid-write. Also validate the written file parses — catches encoding bugs.
// (Postmortem audit fix: reviews.json direct writeFileSync was non-atomic.)
//
// Symlink safety: if reviewsJsonPath is a symlink to the private repo
// (setup-local-data.sh default for local dev), fs.renameSync would REPLACE the
// symlink with the tmp file — breaking the single-source-of-truth contract
// (memory/feedback_dual_repo_data_files.md). Resolve through symlinks so local
// rebuilds continue to write into the private repo's copy directly.
const reviewsTmpPath = reviewsJsonPath + '.tmp';
fs.writeFileSync(reviewsTmpPath, JSON.stringify(output, null, 2));
// Validate the tmp file parses before renaming over the live file
try {
  JSON.parse(fs.readFileSync(reviewsTmpPath, 'utf8'));
} catch (parseErr) {
  try { fs.unlinkSync(reviewsTmpPath); } catch {}
  console.error(`❌ reviews.json tmp file failed JSON.parse validation: ${parseErr.message}`);
  console.error(`   Refusing to overwrite live reviews.json. Rebuild aborted.`);
  process.exit(1);
}
let reviewsRenameTarget = reviewsJsonPath;
try {
  // realpathSync throws ENOENT if the file doesn't exist (first-time write);
  // in that case we fall through with the original path.
  reviewsRenameTarget = fs.realpathSync(reviewsJsonPath);
} catch (_) { /* file doesn't exist yet — rename writes through to reviewsJsonPath */ }
try {
  fs.renameSync(reviewsTmpPath, reviewsRenameTarget);
} catch (renameErr) {
  // EXDEV: cross-device rename (tmp is on the worktree fs but the symlink
  // target is on a different mount — e.g., iCloud-synced directory under
  // ~/Documents or /Volumes/...). Can't renameSync across devices.
  //
  // Naive `copyFileSync(tmp, target)` is NOT atomic on a multi-MB file —
  // a concurrent reader (dev server, Next.js static export, another script)
  // can see a truncated half-written reviews.json. Two-hop: copy to a tmp
  // file ALONGSIDE the target (same FS → atomic rename possible), then
  // renameSync over the target.
  if (renameErr.code === 'EXDEV') {
    const targetDir = path.dirname(reviewsRenameTarget);
    const targetTmp = path.join(targetDir, '.reviews.json.cross-dev.tmp');
    fs.copyFileSync(reviewsTmpPath, targetTmp);
    fs.renameSync(targetTmp, reviewsRenameTarget); // atomic on same FS
    fs.unlinkSync(reviewsTmpPath);
  } else {
    throw renameErr;
  }
}

// Sync deploy watermark so pre-deploy-check.js doesn't block on intentional count changes.
// This prevents the scenario where a legitimate cleanup (e.g., excluding wrongProduction reviews)
// causes every subsequent deploy to fail until someone manually fixes the watermark.
{
  const watermarkPath = path.join(__dirname, '..', 'data', 'audit', 'deploy-watermark.json');
  try {
    const showsForWatermark = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
    const showCount = (showsForWatermark.shows || []).length;
    const newWatermark = { showCount, reviewCount: allReviews.length, updatedAt: new Date().toISOString() };
    const dir = path.dirname(watermarkPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(watermarkPath, JSON.stringify(newWatermark, null, 2) + '\n');
    console.log(`\n📌 Deploy watermark synced: ${showCount} shows, ${allReviews.length} reviews`);
  } catch (e) {
    console.log(`\n⚠️  Could not sync deploy watermark: ${e.message}`);
  }
}

// ========================================
// 3.5: LOCKS INDEX (admin audit trail)
// ========================================
// Scans data/review-texts/*\/*.json for human-locked humanReviewScore files
// and writes public/data/admin/locks.json. Drives /admin/locks UI.
// No scoring impact — read-only over disk + single JSON write. Errors
// surface to stderr with a GitHub Actions ::warning:: annotation (CI sees
// it in the summary) but don't fail the rebuild — locks.json is an audit
// surface, not core data.
{
  try {
    const { writeLocksIndex } = require('./lib/locks-index');
    const locksReviewTextsDir = path.join(__dirname, '..', 'data', 'review-texts');
    const locksOutPath = path.join(__dirname, '..', 'public', 'data', 'admin', 'locks.json');
    const stats = writeLocksIndex({ reviewTextsDir: locksReviewTextsDir, outputPath: locksOutPath });
    console.log(`\n🔒 Locks index: ${stats.count} locks (${stats.withRationale} with rationale, ${stats.withoutRationale} without) → public/data/admin/locks.json`);
  } catch (e) {
    console.error(`\n::warning::Locks index generation failed: ${e.message}`);
    console.error(`   /admin/locks page will ship empty until the next successful rebuild. Stack: ${e.stack}`);
  }
}

// ========================================
// 3.6: CRITIC COVERAGE INDEX (admin digest)
// ========================================
// Reads data/audit/critic-coverage-audit.json (full critic audit array) and
// last 12 history snapshots from data/audit/critic-coverage-history/*.json,
// then writes public/data/admin/critic-coverage.json.
// Drives /admin/critic-coverage UI. No scoring impact — read-only over disk
// + single JSON write. Errors surface to stderr with a ::warning:: annotation
// but don't fail the rebuild — this is an audit surface, not core data.
{
  try {
    const criticAuditPath = path.join(__dirname, '..', 'data', 'audit', 'critic-coverage-audit.json');
    const criticHistoryDir = path.join(__dirname, '..', 'data', 'audit', 'critic-coverage-history');
    const criticOutPath = path.join(__dirname, '..', 'public', 'data', 'admin', 'critic-coverage.json');

    // Read current audit
    const auditEntries = JSON.parse(fs.readFileSync(criticAuditPath, 'utf8'));

    // Read last 12 history snapshots (sorted ascending = oldest first)
    let historySnapshots = [];
    if (fs.existsSync(criticHistoryDir)) {
      const histFiles = fs.readdirSync(criticHistoryDir)
        .filter(f => f.endsWith('.json'))
        .sort() // lexicographic = chronological for YYYY-MM-DD-HHmmss filenames
        .slice(-12); // keep last 12
      historySnapshots = histFiles.map(f => JSON.parse(fs.readFileSync(path.join(criticHistoryDir, f), 'utf8')));
    }

    // Derive current summary from audit entries
    const totalCritics = auditEntries.length;
    const totalGaps = auditEntries.reduce((s, e) => s + (e.missingCount || 0), 0);
    // gapsByBucket: audit entries have no `bucket` field — source from latest history snapshot
    // (same pattern as gapsBySource below; bucket categorisation lives in audit-critic-coverage-bucket.js)
    const latestSnapshot = historySnapshots.length > 0 ? historySnapshots[historySnapshots.length - 1] : null;
    const gapsByBucket = latestSnapshot?.gapsByBucket ?? { A: 0, B: 0, C: 0, D: 0, E: 0 };
    // gapsBySource: copy from most recent snapshot, or default
    const gapsBySource = latestSnapshot && latestSnapshot.gapsBySource
      ? latestSnapshot.gapsBySource
      : { muckrack: totalGaps };

    // Top 10 critics by missingCount (project only needed fields, no missing array)
    const topCriticsByGap = [...auditEntries]
      .sort((a, b) => (b.missingCount || 0) - (a.missingCount || 0))
      .slice(0, 10)
      .map(e => ({
        name: e.name,
        outlet: e.outlet,
        tier: e.tier,
        missingCount: e.missingCount || 0,
        lastDate: e.lastDate || null,
      }));

    const digest = {
      generatedAt: new Date().toISOString(),
      current: { totalCritics, totalGaps, gapsByBucket, gapsBySource },
      history: historySnapshots, // oldest first (already sorted ascending)
      topCriticsByGap,
    };

    fs.mkdirSync(path.dirname(criticOutPath), { recursive: true });
    fs.writeFileSync(criticOutPath, JSON.stringify(digest, null, 2), 'utf8');
    console.log(`\n📊 Critic coverage index: ${totalCritics} critics, ${totalGaps} gaps, ${historySnapshots.length} history snapshots → public/data/admin/critic-coverage.json`);
  } catch (e) {
    console.error(`\n::warning::Critic coverage index generation failed: ${e.message}`);
    console.error(`   /admin/critic-coverage page will ship empty until the next successful rebuild. Stack: ${e.stack}`);
  }
}

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
console.log(`  Allowed (multi-critic same URL): ${stats.allowedMultiCriticUrl || 0}`);
console.log(`  Skipped (cross-outlet duplicate URL): ${stats.skippedCrossOutletDuplicateUrl || 0}`);
console.log(`  Allowed (multi-critic cross-outlet URL): ${stats.allowedMultiCriticUrlCrossOutlet || 0}`);
console.log(`  Skipped (corrupted/invalid JSON): ${stats.skippedCorrupted || 0}`);
console.log(`  Skipped (wrong production): ${stats.skippedWrongProduction || 0}`);
if (stats.contentVerificationPromoted > 0) {
  console.log(`  ⚠️  contentVerification → top-level promoted: ${stats.contentVerificationPromoted}`);
}
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
console.log(`  Skipped (upcoming shows): ${stats.skippedUpcomingShows || 0}`);
console.log(`  Skipped (orphan directories): ${stats.skippedOrphanDirs || 0}`);
console.log(`  Skipped (tour contamination): ${stats.skippedTourContamination || 0}`);
console.log(`  Skipped (film/TV contamination): ${stats.skippedFilmTvContamination || 0}`);
console.log(`  Skipped (date mismatch >30d): ${stats.skippedDateMismatch || 0}`);
console.log(`  Skipped (director cross-check): ${stats.skippedDirectorMismatch || 0}`);
console.log(`  Skipped (URL-year cross-production): ${stats.skippedUrlYearMismatch || 0}`);
console.log(`  Rerouted to sibling (URL-year): ${stats.reroutedToSibling || 0}`);
if (stats.rerouteCollisionDropped > 0) {
  console.log(`  Reroute collision dropped: ${stats.rerouteCollisionDropped}`);
}
if (stats.rerouteFailedDropped > 0) {
  console.log(`  Reroute failed dropped: ${stats.rerouteFailedDropped}`);
}
console.log(`  Skipped (URL-year standalone): ${stats.skippedUrlYearStandalone || 0}`);
console.log(`  Skipped (wrong content/reasoning): ${stats.skippedWrongContent || 0}`);
if (stats.skippedFullTextWrongAuthor > 0) {
  console.log(`  Skipped (fullTextWrongAuthor, no excerpts): ${stats.skippedFullTextWrongAuthor}`);
}
if (stats.skippedSuspectedMisattribution > 0) {
  console.log(`  Skipped (suspected misattribution via critic-registry): ${stats.skippedSuspectedMisattribution}`);
}
if (stats.fullTextWrongAuthorKeptAsExcerpt > 0) {
  console.log(`  Kept as excerpt (fullTextWrongAuthor with excerpts): ${stats.fullTextWrongAuthorKeptAsExcerpt}`);
}
if (stats.domainMismatchDetected > 0) {
  console.log(`  Detected (URL-domain mismatch, audit-only): ${stats.domainMismatchDetected}`);
}
console.log(`  Skipped (rejection reason): ${stats.skippedRejectionReason || 0}`);
console.log(`  Skipped (roundup article): ${stats.skippedRoundup || 0}`);
console.log(`  Skipped (duplicate text flag): ${stats.skippedDuplicateText || 0}`);
if (stats.circularDuplicateRecovered > 0) {
  console.log(`  Recovered (circular/stale duplicate flags): ${stats.circularDuplicateRecovered}`);
}
if (stats.staleDuplicateTextCleared > 0) {
  console.log(`  Recovered (stale duplicateTextOf — text changed): ${stats.staleDuplicateTextCleared}`);
}
if (stats.dupeRefExcludedRecovered > 0) {
  console.log(`  Recovered (duplicate ref would be excluded by other guards): ${stats.dupeRefExcludedRecovered}`);
}
if (stats.staleContentVerificationCleared > 0) {
  console.log(`  Recovered (stale contentVerification — text fetched after verification): ${stats.staleContentVerificationCleared}`);
}
console.log(`  Resolved (default critic from outlet registry): ${stats.resolvedDefaultCritic || 0}`);
console.log(`  Skipped (unknown critic dedup): ${stats.skippedUnknownCriticDedup || 0}`);
console.log(`  Skipped (unknown outlet dedup): ${stats.skippedUnknownOutletDedup || 0}`);
console.log(`  Skipped (fingerprint dedup): ${stats.skippedFingerprintDedup || 0}`);
console.log(`  Skipped (cross-show duplicate text): ${stats.skippedCrossShowDupe || 0}`);
if (stats.crossShowDupeDetails && stats.crossShowDupeDetails.length > 0) {
  stats.crossShowDupeDetails.forEach(d => console.log(`    - ${d}`));
}
console.log(`  Skipped (within-show duplicate text): ${stats.skippedWithinShowDupe || 0}`);
if (stats.withinShowDupeDetails && stats.withinShowDupeDetails.length > 0) {
  stats.withinShowDupeDetails.slice(0, 30).forEach(d => console.log(`    - ${d}`));
  if (stats.withinShowDupeDetails.length > 30) {
    console.log(`    ... +${stats.withinShowDupeDetails.length - 30} more`);
  }
}
console.log(`  Skipped (show not mentioned, no excerpts): ${stats.skippedShowNotMentioned || 0}`);
if (stats.showIdMismatches > 0) {
  console.log(`  ⚠️  showId mismatches (file vs directory): ${stats.showIdMismatches}`);
}
if (stats.showNotMentionedAutoCleared > 0) {
  console.log(`  Auto-cleared stale showNotMentioned (fullText valid): ${stats.showNotMentionedAutoCleared}`);
}
if (stats.showNotMentionedCvCleared > 0) {
  console.log(`  Auto-cleared stale showNotMentioned (LLM-verified valid, wrongFullText restored): ${stats.showNotMentionedCvCleared}`);
}
if (stats.showNotMentionedCvSkippedHallucination > 0) {
  console.log(`  Skipped CV-based restore (LLM verified valid but wrongFullText fails keyword check — likely hallucination): ${stats.showNotMentionedCvSkippedHallucination}`);
}
if (stats.showNotMentionedWithExcerpts > 0) {
  console.log(`  Show not mentioned but has excerpts (allowed): ${stats.showNotMentionedWithExcerpts}`);
}
if (stats.wrongProdWEOBAutoCleared > 0) {
  console.log(`  Auto-cleared wrongProduction (WE/OB URL-year exempt): ${stats.wrongProdWEOBAutoCleared}`);
}
if (stats.recoveredFromGarbage > 0) {
  console.log(`  Recovered from garbageFullText: ${stats.recoveredFromGarbage}`);
}
if (stats.staleEnsembleCleared > 0) {
  console.log(`  Stale ensembleData cleared (non-ensemble model): ${stats.staleEnsembleCleared}`);
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

// URL date backfill summary
if (stats.urlDateBackfills > 0) {
  console.log(`\n📅 URL date backfills: ${stats.urlDateBackfills} reviews gained publishDate from URL`);
}
if (stats.openingDateFallbacks > 0) {
  console.log(`📅 Opening date fallbacks: ${stats.openingDateFallbacks} reviews used show opening date as publishDate`);
}
if (stats.urlDateSuspect && stats.urlDateSuspect.length > 0) {
  console.log(`  ⚠️  URL-date suspect (year before show opens): ${stats.urlDateSuspect.length}`);
  stats.urlDateSuspect.slice(0, 10).forEach(d =>
    console.log(`    ${d.showId}/${d.file}: URL date ${d.urlDate}, show opens ${d.showYear} (${d.source})`)
  );
  if (stats.urlDateSuspect.length > 10) {
    console.log(`    ...and ${stats.urlDateSuspect.length - 10} more`);
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
const blockedSingleModel = stats.blockedSingleModel || 0;
if (blockedSingleModel > 0) {
  console.log(`\nENSEMBLE QUALITY GATE:`);
  console.log(`  Blocked (no ensemble data): ${blockedSingleModel}`);
  console.log(`  → Run ensemble scoring to fix: gh workflow run "LLM Ensemble Score Reviews" -f needs_rescore=true`);
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
    if (!registryIds.has(outletId.toLowerCase()) && !isJunkOutlet(outletId)) {
      newOutlets.push(outletId);
    }
  }

  if (newOutlets.length > 0) {
    // Build a URL → domain map from existing reviews to auto-populate domain field
    const outletDomainHints = {};
    for (const r of allReviews) {
      if (r.outletId && r.url && !outletDomainHints[r.outletId]) {
        try {
          const hostname = new URL(r.url).hostname.replace(/^www\./, '');
          if (hostname) outletDomainHints[r.outletId] = hostname;
        } catch (e) { /* ignore invalid URLs */ }
      }
    }

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
        domain: outletDomainHints[outletId] || null
      };
    }
    if (outletRegistry._meta) {
      outletRegistry._meta.lastUpdated = new Date().toISOString();
    }
    const registryPath = path.join(__dirname, '..', 'data', 'outlet-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify(outletRegistry, null, 2));
    console.log(`\n✅ AUTO-REGISTERED ${newOutlets.length} new outlet(s) in outlet-registry.json (Tier 3):`);
    for (const id of newOutlets.sort()) {
      console.log(`  + ${id}`);
    }
    console.log('  Review tiers manually if needed.');
    console.log('  ⚠ IMPORTANT: Also update outlet-registry.json in the PRIVATE repo (~/broadway-scorecard-data/data/outlet-registry.json).');
    console.log('    CI uses the private repo copy — reviews scored here won\'t appear in production until the private registry is updated.');
    console.log('    Quick sync: cp data/outlet-registry.json ~/broadway-scorecard-data/data/ && cd ~/broadway-scorecard-data && git add data/outlet-registry.json && git commit -m "sync outlet registry" && git push');
  }
}

try {
  const showCounts = allReviews.reduce((acc, r) => { acc[r.showId] = (acc[r.showId] || 0) + 1; return acc; }, {});
  for (const [showId, reviewCount] of Object.entries(showCounts)) {
    emitStage({ showId, stage: 'rebuilt', metadata: { reviewCount } });
  }
} catch (e) { process.stderr.write(`[stage-latency] rebuild emit failed: ${e.message}\n`); }

console.log('\n=== DONE ===');
console.log(`\nReviews saved to: ${reviewsJsonPath}`);
