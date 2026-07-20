/**
 * Pure helper functions extracted from rebuild-all-reviews.js for testability.
 *
 * These functions ARE the production code — rebuild-all-reviews.js imports from here.
 * Scoring thresholds and constants come from score-extractors.js (single source of truth).
 */

const { BUCKET_SCORES, THUMB_SCORES, scoreToBucket, scoreToThumb, OUTLET_VERIFIED_SOURCES, KNOWN_STAR_OUTLETS, OUTLET_STAR_AUTHORITATIVE, extractScore } = require('./score-extractors');
const { parseOriginalScore } = require('./score-parsers');
const { decodeHtmlEntities } = require('./text-cleaning');
const { AGGREGATOR_SCORE_SOURCES: AGGREGATOR_SOURCES_SET } = require('./review-normalization');

// Low-reliability star EXTRACTION sources — automated CSS/generic pattern matches
// that often read the wrong element (pagination, dates, sidebars). The LLM may
// override these; everything else (json-ld, verified star images, svg/unicode
// stars, letter grades, outlet APIs) is the critic's own published rating and is
// trusted. Module-scoped so both the P0.4 late-star fall-through (keyed on
// originalScoreSource) and the P0.5 reliability check use ONE list.
const LOW_RELIABILITY_STAR_SOURCES = new Set([
  'css-stars', 'star-class', 'css-rating', 'star-rating',
  'text-pattern', 'og-description', 'wp-api-title',
  'numeric-stars',    // Generic "X/5" pattern — false positives from pagination, dates, URLs
]);

// Whether a raw originalScore string is an UNAMBIGUOUS rating form that re-parses
// reliably (letter grade like "A"/"B+", or a star form like "3/5", "4 stars",
// "★★★"). Bare numbers ("5", "85") are AMBIGUOUS — "5" could mean 5/100 or 5 stars
// — so they are NOT unambiguous and must defer to the stored originalScoreNormalized
// (Pattern Card #7). Used by the stale-normalized guard in the P0 scoring path.
function isUnambiguousRatingString(raw) {
  if (raw == null) return false;
  const s = String(raw).trim();
  if (!s) return false;
  if (/^[A-Fa-f][+-]?$/.test(s)) return true;            // letter grade token
  if (/\d\s*\/\s*\d/.test(s)) return true;               // X/N (3/5, 8/10)
  if (/\bstars?\b/i.test(s)) return true;                // "4 stars", "3.5 stars"
  if (/[★⭑✪☆]/.test(s)) return true;                     // glyph stars
  if (/\bout of\b/i.test(s)) return true;                // "4 out of 5"
  return false;                                          // bare number / freeform → ambiguous
}

// ===================================================
// TEXT CLEANING
// ===================================================

function normalizeThumb(thumb) {
  if (thumb === 'Meh' || thumb === 'Flat') return 'Flat';
  return thumb; // 'Up' or 'Down'
}

const { normalizeDate } = require('./date-utils');
function normalizePublishDate(dateStr) {
  return normalizeDate(dateStr);
}

function fixMojibake(text) {
  if (!text) return text;
  return text
    .replace(/\u00e2\u0080\u0099/g, '\u2019')
    .replace(/\u00e2\u0080\u0098/g, '\u2018')
    .replace(/\u00e2\u0080\u009c/g, '\u201c')
    .replace(/\u00e2\u0080\u009d/g, '\u201d')
    .replace(/\u00e2\u0080\u0094/g, '\u2014')
    .replace(/\u00e2\u0080\u0093/g, '\u2013')
    .replace(/\u00e2\u0080\u00a6/g, '\u2026')
    .replace(/â€™/g, '\u2019')
    .replace(/â€˜/g, '\u2018')
    .replace(/â€œ/g, '\u201c')
    .replace(/â€\u009d/g, '\u201d')
    .replace(/â€"/g, '\u2014')
    .replace(/â€"/g, '\u2013')
    .replace(/â€¦/g, '\u2026')
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

function fixMissingPeriods(text) {
  if (!text) return text;
  let result = text;
  result = result.replace(/(\d{4})\s+([A-Z][a-z])/g, '$1. $2');
  result = result.replace(/No Comment\s*(BY\s)/i, 'No Comment. $1');
  result = result.replace(/\)([A-Z][a-z])/g, '). $1');
  result = result.replace(/Darkness([A-Z][a-z])/g, 'Darkness. $1');
  return result;
}

// ===================================================
// EXCERPT QUALITY GATES
// ===================================================

function isJunkExcerpt(text) {
  if (!text) return true;

  const junkPatterns = [
    /^Home\s+(Legit|News|Reviews)/i,
    /^\d{1,2}:\d{2}\s*(AM|PM)\s*(PT|ET|CT)/i,
    /Plus Icon.*Latest/i,
    /See All\s+[A-Z]/i,
    /\d+ (day|week|month|hour)s? ago/i,
    /Related Stories/i,
    /By [A-Z][a-z]+ [A-Z][a-z]+ Plus Icon/i,
    /TV Review.*TV Review/i,
    /Photo:/i,
    /Matthew Murphy\s+[A-Z]/,
    /\bdefineSlot\b|\bsetTargeting\b|\bgoogletag\b/i,
    /blogherads/i,
    /^NYC Events,?\s+Restaurants/i,
    /Cititour\.com\s*Review/i,
    /^(Facebook|Twitter|Pinterest|Threads)\s+(Twitter|Facebook|Pinterest|X\b)/i,
    /^Visit the Site/i,
    /^Tickets from \$/i,
    /By clicking submit/i,
    /<a\s+href=/i,
    /^Home\s*[>|]/i,
    /newsletter in your inbox/i,
    /Get all the top news.*discount/i,
    /Open\/Close Dates/i,
    /\bprivacy policy\b/i,
    /^Skip to (content|main)/i,
    /^Democracy Dies/i,
    /^Q:\s/i,
    /^Posted on\s+\w+\s+\d/i,
    /^This article was published more than/i,
    /^Listen\d+\s*min/i,
    /rose lovers|Bachelor in Paradise|couples grapple/i,
    /^(MUSIC|THEATER).*Add Topic/i,
    /^Trump says|^Biden|^Senate\s+(votes|passes)/i,
    /Keep Watching|mins ago\s/i,
    /Hear this story/i,
  ];

  for (const pattern of junkPatterns) {
    if (pattern.test(text)) return true;
  }

  const first50 = text.substring(0, 50);
  const datePatterns = first50.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+/gi) || [];
  if (datePatterns.length >= 2) return true;

  if (text.length >= 40) {
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
    if (words.length >= 5) {
      const commonWords = new Set(['the', 'and', 'of', 'to', 'a', 'in', 'is', 'it', 'that', 'for', 'was', 'on', 'are', 'with', 'as', 'but', 'this', 'his', 'her', 'not', 'has', 'had', 'an', 'be', 'at', 'by', 'or', 'its', 'from', 'who', 'than', 'if', 'so', 'no', 'more']);
      const commonCount = words.filter(w => commonWords.has(w)).length;
      const ratio = commonCount / words.length;
      if (ratio < 0.03) return true;
    }
  }

  return false;
}

function isGenericQuote(text) {
  if (!text) return true;
  const lower = text.toLowerCase().trim();

  const genericPatterns = [
    /^(it('s| is)|this is) (a )?(must[- ]see|worth seeing|not to be missed)\b/,
    /^don'?t miss (it|this)/,
    /^(highly )?recommended\.?$/,
    /^(go )?see (it|this show)/,
    /^a (great|good|wonderful|terrible|bad) show\.?$/,
  ];

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

  if (lower.length < 100 && /(must[- ]see|not to be missed|highly recommended)\b/.test(lower)) {
    return true;
  }

  return false;
}

function trimToCompleteSentence(text) {
  if (!text) return text;
  const trimmed = text.trim();

  const contractionMatch = trimmed.match(/(^|\s)(he|she|it|we|they|who|wasn|wouldn|couldn|didn|don|isn|aren|won|haven|hasn|shouldn|mustn|weren|hadn|I)['\u2019]$/);
  if (contractionMatch) {
    const match = trimmed.match(/^(.*[.!?"\u201D])\s/s);
    if (match && match[1].length >= 40) return match[1].trim();
    return trimmed;
  }

  if (/[.!?"\u201D)]\s*$/.test(trimmed)) return trimmed;
  if (/[.!?][')\u2019]\s*$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/^(.*[.!?"\u201D'])\s*\S+.*$/s);
  if (match && match[1].length >= 40) return match[1].trim();
  return trimmed;
}

function normalizeQuoteWrapping(text) {
  if (!text) return text;
  let result = text.trim();
  if ((result.startsWith('"') || result.startsWith('\u201c')) &&
      (result.endsWith('"') || result.endsWith('\u201d'))) {
    result = result.slice(1, -1).trim();
  }
  return result;
}

// ===================================================
// EXCERPT CLEANING
// ===================================================

/**
 * Clean excerpt text from aggregator sources.
 * Strips ad code, navigation boilerplate, photo credits, multi-critic concatenation.
 * Truncates to 350 chars at sentence boundary. Returns null for junk/empty input.
 */
function cleanExcerpt(text) {
  if (!text) return null;

  let cleaned = fixMissingPeriods(fixMojibake(decodeHtmlEntities(text)));

  // Reject URLs masquerading as excerpts
  if (/^https?:\/\//i.test(cleaned.trim())) return null;

  // --- Layer 1: Systematic excerpt quality gates ---
  cleaned = cleaned.replace(/Average Rating:.*$/s, '');
  cleaned = cleaned.replace(/\{\s*"@context".*$/s, '');
  cleaned = cleaned.replace(/^\*?CRITIC[''\u2019]?S PICK\*?\s*/i, '');
  cleaned = cleaned.replace(/^[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-zA-Z'-]+,\s+[A-Z][\w\s&.'-]{2,40}:\s*/, '');
  cleaned = cleaned.replace(/^[,\s]*:\s*/, '');
  cleaned = cleaned.replace(/[\u0080-\u009F]/g, '');
  cleaned = cleaned.replace(/â\s/g, '\u2014 ');
  cleaned = cleaned.replace(/â$/, '\u2014');

  // Strip navigation/boilerplate prefixes
  cleaned = cleaned.replace(/^Skip to (content|main content)\s*/i, '');
  cleaned = cleaned.replace(/^(This article was published more than[^.]*\.\s*)?Democracy Dies in Darkness\s*/i, '');
  cleaned = cleaned.replace(/^Q:\s+[^?]*\?\s*/i, '');
  cleaned = cleaned.replace(/^Posted on\s+\w+\s+\d{1,2},?\s+\d{4}\s*/i, '');
  cleaned = cleaned.replace(/^No Comment\s*(BY\s+)?/i, '');
  cleaned = cleaned.replace(/^Listen\s*\d+\s*min\s*/i, '');
  cleaned = cleaned.replace(/^[A-Z][^.]{10,80}\.\s*\([A-Z][a-z]+ [A-Z][a-z]+\)\s*/i, '');
  cleaned = cleaned.replace(/^Review by\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s*(?:—\s*)?/i, '');
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

  // Strip trailing boilerplate
  cleaned = cleaned.replace(/\s*By clicking submit[^]*$/i, '');
  cleaned = cleaned.replace(/\s*<a\s+href=[^]*$/i, '');
  cleaned = cleaned.replace(/\s*Copyright ©[^]*$/i, '');
  cleaned = cleaned.replace(/\s*Visit the Site\S*[^]*$/i, '');
  cleaned = cleaned.replace(/\s*(Read more|Continue reading|Read the full review)\.?\s*$/i, '');

  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Skip if starts mid-word/mid-sentence (unless it's a quote)
  if (/^[a-z]/.test(cleaned) && !cleaned.startsWith('"')) {
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

// ===================================================
// SCORING LOGIC
// ===================================================

/**
 * Check if contentVerification is stale (text was re-fetched after verification,
 * or content hash has changed). Returns false if verification should be ignored.
 */
function isContentVerificationActive(data) {
  if (!data.contentVerification || !data.contentVerification.wrongArticle) return false;

  // Stale if text was fetched after verification
  if (data.textFetchedAt && data.contentVerification.verifiedAt) {
    const fetchedAt = new Date(data.textFetchedAt).getTime();
    const verifiedAt = new Date(data.contentVerification.verifiedAt).getTime();
    if (fetchedAt > verifiedAt) return false;
  }

  // Stale if content hash changed
  if (data.contentVerification.contentHash && data.fullText) {
    const crypto = require('crypto');
    const currentHash = crypto.createHash('md5').update(data.fullText.substring(0, 2500)).digest('hex');
    if (data.contentVerification.contentHash !== currentHash) return false;
  }

  return true;
}

/**
 * Determine the best score for a review from all available sources.
 *
 * This is the core scoring priority logic used by rebuild-all-reviews.js.
 * It takes a review data object and returns { score, source } or null.
 *
 * @param {object} data - Review data with score fields
 * @param {object} [opts] - Options
 * @param {object} [opts.stats] - Stats object to increment counters on
 * @param {function} [opts.flagForHumanReview] - Callback for flagging reviews
 * @returns {{ score: number, source: string } | null}
 */
function getBestScore(data, opts = {}) {
  const stats = opts.stats || {};
  const flagForHumanReview = opts.flagForHumanReview || (() => {});
  const inc = (key) => { stats[key] = (stats[key] || 0) + 1; };

  // Skip if explicitly marked as TO_BE_CALCULATED
  if (data.scoreStatus === 'TO_BE_CALCULATED') {
    return null;
  }

  // P0: Human-reviewed score (manual override — always wins)
  // Semantic: humanReviewScoreProvisional === true means the operator wrote a
  // tentative score but wants the LLM to override once a real score lands.
  // Default (undefined / false) is LOCKED — humanReviewScore is the final word,
  // which is the Rocky Horror 2026-04-23 Helen Shaw case the brief codifies.
  if (data.humanReviewScore && data.humanReviewScore >= 1 && data.humanReviewScore <= 100) {
    if (data.humanReviewScoreProvisional !== true) {
      return { score: data.humanReviewScore, source: 'human-review' };
    }
    inc('humanReviewScoreProvisionalSkipped');
  }

  // P0a: Adjudicated score (LLM re-evaluation of flagged reviews — beats LLM but not human)
  // EXCEPTION: skip adjudication when the review has an outlet-verified originalScore
  // from a KNOWN star outlet. Star ratings are authoritative ground truth per
  // memory/feedback_star_score_cap.md — the adjudicator should not override them.
  // Stale adjudicatedScore values sitting on files with explicit stars are bugs.
  if (data.adjudicatedScore && data.adjudicatedScore >= 1 && data.adjudicatedScore <= 100) {
    const hasVerifiedStarScore = data.originalScore
      && OUTLET_VERIFIED_SOURCES.has(data.scoreSource)
      && OUTLET_STAR_AUTHORITATIVE.has(data.outletId);
    if (!hasVerifiedStarScore) {
      return { score: data.adjudicatedScore, source: 'adjudicated' };
    }
    inc('adjudicationSkippedExplicitStars');
  }

  // P0.4: anchored-v6 / llm-v6 (Phase B Sprint 3, 2026-05-16)
  // When the file was scored with the anchored-bands path
  // (ANCHORED_BANDS_PILOT=1, see scripts/llm-scoring/ensemble-scorer.ts), the
  // llmScore.score has ALREADY been constrained to the critic's band. It is
  // the canonical answer — no need to fall through to P0.5 (originalScore)
  // or P1 (raw LLM). This precedence beats originalScore because the LLM was
  // deliberately given the critic's star/grade as a hard constraint and
  // produced a within-band score; the originalScore (linear star-flat) is
  // now superseded by the within-band LLM verdict.
  //
  // 'anchored-v6': high-reliability star/grade was detected → V6 prompt with band
  // 'llm-v6':       no star OR low-reliability extraction → V6 prompt no band
  //
  // humanReviewScore (P0) + adjudicatedScore (P0a) still override — manual
  // verdicts always win.
  //
  // EXCEPTION (2026-06-30): 'llm-v6' means "no usable star AT SCORING TIME". But
  // on opening nights the LLM scores the text immediately and the outlet's star
  // widget is scraped LATER, leaving scoreSource='llm-v6' alongside a now-present
  // high-reliability star this early return would ignore — so a published 2/5
  // showed as 62, a 3/5 as 77 (7 bucket-crossing live errors: care Time Out,
  // dark-of-the-moon WhatsOnStage/everything-theatre, an-ideal-husband Times,
  // mass, please-please-me). When an 'llm-v6' review now carries a parseable
  // originalScore, fall through to P0.5 so the published star (and its existing
  // reliability/LLM-conflict logic) decides. 'anchored-v6' already used the
  // star's band as a hard constraint — keep returning it as-is.
  // llmScore.band is only ever written by the anchored scorer, so its presence
  // proves this llmScore is a band-constrained (anchored) verdict — even when a
  // later star extraction overwrote scoreSource with its extraction label
  // (e.g. 'telegraph-svg-stars'), which used to knock the file out of this
  // early return and ship the flat star conversion via P0.5 (2026-07-11).
  const anchoredBand = data.llmScore && data.llmScore.band;
  let hasAnchoredBandMarker = !!(anchoredBand && typeof anchoredBand.floor === 'number');
  // Staleness guard (marker path only — a real 'anchored-v6'/'llm-v6' stamp is
  // handled by the existing logic below): the star can CHANGE after anchoring
  // (equus telegraph: anchored to an aggregator-relayed 5/5, the outlet's own
  // svg extraction later wrote 4/5). If the current originalScore parses to a
  // flat value outside the anchored band (±2 for boundary rounding), the
  // marker is stale — fall through so the current published star decides at
  // P0.5. Deliberately NOT re-flagged for re-anchor: band detection may keep
  // preferring the stale relay field, which would re-flag forever.
  if (hasAnchoredBandMarker
      && data.scoreSource !== 'anchored-v6' && data.scoreSource !== 'llm-v6'
      && data.originalScore) {
    const currentFlat = parseOriginalScore(data.originalScore, data.outletId);
    if (currentFlat !== null
        && (currentFlat < anchoredBand.floor - 2 || currentFlat > anchoredBand.ceiling + 2)) {
      hasAnchoredBandMarker = false;
    }
  }
  if ((data.scoreSource === 'anchored-v6' || data.scoreSource === 'llm-v6' || hasAnchoredBandMarker)
      && data.llmScore && typeof data.llmScore.score === 'number'
      && data.llmScore.score >= 0 && data.llmScore.score <= 100) {
    // Band marker present → the verdict is anchored regardless of the stamp.
    const effectiveV6Source = (data.scoreSource === 'anchored-v6' || hasAnchoredBandMarker)
      ? 'anchored-v6' : 'llm-v6';
    // Only HIGH-reliability late stars win — a low-reliability extraction
    // (numeric-stars/css-stars, often a false positive) must NOT override the
    // LLM, which is why llm-v6 kept the LLM in the first place.
    //
    // Reliability of the late star (2026-07-11 hardening):
    // - originalScoreSource present → trust its reliability class.
    // - originalScoreSource ABSENT → the raw value must be an unambiguous
    //   rating form ("5/5 stars", "★★★★", "A-"). A bare numeric with no
    //   extraction source is an aggregator's normalized 0-100 relay (e.g.
    //   Show Score writing originalScore=100), NOT a published star — it was
    //   knocking llm-v6 out of this early return and the raw aggregator
    //   number then shipped via P3b over the LLM's sentiment score (JCS
    //   london-theatre: LLM 94, site showed 100).
    const lateStarReliable = data.originalScoreSource
      ? !LOW_RELIABILITY_STAR_SOURCES.has(data.originalScoreSource)
      : isUnambiguousRatingString(data.originalScore);
    const llmV6HasLateStar = effectiveV6Source === 'llm-v6'
      && data.originalScore
      && lateStarReliable
      && parseOriginalScore(data.originalScore, data.outletId) !== null;
    if (!llmV6HasLateStar) {
      return { score: data.llmScore.score, source: effectiveV6Source };
    }
  }

  // P0.5: originalScore (aggregator-provided)
  // Downgrade aggregator-sourced ratings for WE ONLY when the aggregator is rating
  // the show independently (e.g., Show Score's own 1-100). Trust the rating when
  // a known star-rating outlet's score is relayed through an aggregator (e.g.,
  // WestEndTheatre.com reporting "Guardian: 4/5" — that IS the Guardian's real rating).
  const AGGREGATOR_SOURCES = new Set([
    'show-score', 'show-score-playwright', 'showscore-roundup',
    'theatre-reviews', 'theatre-reviews-roundup',
    'westendtheatre', 'stagedoor', 'theatre-record',
    'bww-roundup', 'bww-reviews', 'playbill-verdict',
    'lbo-roundup', 'lbo-individual', 'nyc-theatre',
  ]);
  // KNOWN_STAR_OUTLETS imported from score-extractors.js (single source of truth)
  const isAggregatorSource = AGGREGATOR_SOURCES.has(data.source);
  const isWestEnd = data._showCategory === 'west-end' || data._showCategory === 'off-west-end';
  const isOutletVerified = OUTLET_VERIFIED_SOURCES.has(data.scoreSource);
  const isKnownStarOutlet = KNOWN_STAR_OUTLETS.has(data.outletId);
  // First-party LBO byline reviews (Stuart King + Nicola Wright + Shehrazade
  // Zafar-Arif) come through source='lbo-individual'. These are LBO's own
  // editorial team — the bstarsN class on those pages IS the critic's
  // published rating, not a third-party aggregator score. Treat them like a
  // known-star-outlet to bypass downgrade. (Stuart King report 2026-04-26.)
  const isLBOFirstParty = data.source === 'lbo-individual' && data.outletId === 'london-box-office';
  // Only downgrade if: aggregator source + WE + NOT outlet-verified + NOT a known star outlet + NOT LBO first-party
  const downgradeShowScore = isAggregatorSource && isWestEnd && !isOutletVerified && !isKnownStarOutlet && !isLBOFirstParty;

  // Skip P0 if score was deliberately cleared by audit (aggregator in wrong slot,
  // extraction with no evidence, outlet doesn't publish star ratings).
  // EXCEPTION: Tier 1.5 clearing ("extraction-no-evidence-in-text") was incorrect when:
  // (a) The outlet is a KNOWN_STAR_OUTLET — they DO publish star ratings
  // (b) The scoreSource is unicode-stars or word-stars — these are unambiguous formats
  //     that were correctly extracted but textContainsStarRating() couldn't find in fullText
  //     because the stars were in HTML structure, not the article body text.
  const isTier15Cleared = data.originalScoreCleared === true &&
    data.originalScoreClearedReason && data.originalScoreClearedReason.startsWith('extraction-no-evidence');
  const UNAMBIGUOUS_STAR_SOURCES = new Set(['unicode-stars', 'word-stars']);
  // Don't override for outlets explicitly marked as no-score (noScoreExtractor).
  // Their unicode-stars extractions came from aggregator page structure, not the outlet.
  const { OUTLET_EXTRACTORS } = require('./score-extractors');
  const outletExtractor = OUTLET_EXTRACTORS[data.outletId];
  const isNoScoreOutlet = outletExtractor && outletExtractor('', '')?.__skipGeneric;
  // Also override for outlets with real extractors (not noScoreExtractor) — they're
  // recognized star-rating outlets whose scores were incorrectly cleared.
  const hasRealExtractor = outletExtractor && !isNoScoreOutlet;
  const isTier15Override = isTier15Cleared && !isNoScoreOutlet &&
    (isKnownStarOutlet || UNAMBIGUOUS_STAR_SOURCES.has(data.scoreSource) || hasRealExtractor);
  const scoreCleared = data.originalScoreCleared === true && !isTier15Override;
  // Also skip if scoreSource is a known aggregator source — these should be in
  // aggregatorStars, not originalScore (prevents re-contamination even if
  // originalScore gets re-set by a CI process that hasn't been updated yet)
  const isAggregatorScoreSource = AGGREGATOR_SOURCES_SET && AGGREGATOR_SOURCES_SET.has(data.scoreSource);

  // Effective score: use originalScore, or for known star outlets, treat aggregatorStars
  // as the outlet's own published rating (aggregators relay "Guardian: 4/5" etc.)
  // When Tier 1.5 override is active, recover the original score:
  // 1. If originalScore still populated: use it (unless previousOriginalScore differs significantly,
  //    in which case prefer previousOriginalScore as ground truth from before clearing)
  // 2. If originalScore was nulled: use previousOriginalScore (saved by P0 script before clearing)
  let resolvedOriginalScore = data.originalScore;
  if (isTier15Override && !data.originalScore && data.previousOriginalScore) {
    // Score was nulled by P0 script — recover from previousOriginalScore
    resolvedOriginalScore = String(data.previousOriginalScore);
  }
  const effectiveOriginalScore = (!scoreCleared && !isAggregatorScoreSource && resolvedOriginalScore)
    || (data.aggregatorStars && (isKnownStarOutlet || isLBOFirstParty) ? data.aggregatorStars : null);
  const effectiveScoreLabel = data.originalScore ? 'originalScore' : 'aggregatorStars (known star outlet)';

  if (effectiveOriginalScore && !downgradeShowScore) {
    if (data.scoreConfidence === 'low' || data.scoreSource === 'star-icon' || data.scoreSource === 'star-icon-cleared') {
      inc('skippedLowConfidenceOriginal');
    } else {
      // Pattern Card #7: prefer originalScoreNormalized (set at extraction time with the correct
      // star/letter/numeric scale) over re-parsing the raw string. Re-parsing "5" as a bare
      // integer returns 5/100 (pan) when it was extracted as "5 stars" (100/100 rave).
      // Fall back to parseOriginalScore() when normalizedValue is absent (older records).
      const normalizedFromExtraction = (typeof data.originalScoreNormalized === 'number' && data.originalScoreNormalized >= 0 && data.originalScoreNormalized <= 100)
        ? data.originalScoreNormalized : null;
      const reparsedOriginal = parseOriginalScore(effectiveOriginalScore, data.outletId);
      // Stale-normalized guard (2026-06-29): originalScoreNormalized is a stored
      // field that can go stale and silently override a correct grade. 11 corpus-
      // wide, e.g. the-piano-lesson-2022 EW "A" with stored normalized 20 → the
      // rebuild emitted assignedScore 20 (Pan) even though originalScore="A" and the
      // LLM agreed Rave. When the raw originalScore is an UNAMBIGUOUS letter/star
      // form (the re-parse is reliable — unlike a bare number where "5" could be 5
      // or 100, which is why Pattern Card #7 prefers the stored value) AND the
      // stored normalized disagrees with the canonical re-parse by >6, the stored
      // value is stale: trust the re-parse. Bare-number originalScores still defer
      // to the stored normalized.
      let parsed;
      if (reparsedOriginal !== null && normalizedFromExtraction !== null
          && isUnambiguousRatingString(effectiveOriginalScore)
          && Math.abs(reparsedOriginal - normalizedFromExtraction) > 6) {
        inc('staleNormalizedOverridden');
        parsed = reparsedOriginal;
      } else {
        parsed = normalizedFromExtraction ?? reparsedOriginal;
      }
      if (parsed !== null) {
        const llm = data.llmScore && data.llmScore.score;
        const llmConf = data.llmScore && data.llmScore.confidence;
        // LOW reliability = automated CSS/generic extraction that often reads wrong elements.
        // LLM can override these. Everything else (json-ld, verified star images, letter
        // grades, unicode stars) is the critic's own published rating — never override.
        // Single source: module-scoped LOW_RELIABILITY_STAR_SOURCES (lbo-css-stars
        // promoted to HIGH reliability 2026-04-01: first bstarsN is always the
        // review rating, second is a sidebar related article; 33/33 matched).
        const LOW_RELIABILITY_EXTRACTION = LOW_RELIABILITY_STAR_SOURCES;
        // Outlet-level trust overrides generic scoreSource labels. Outlets in
        // OUTLET_STAR_AUTHORITATIVE have dedicated extractors (or well-understood
        // markup) and publish their own star ratings; a generic "css-stars" /
        // "numeric-stars" label from their dedicated path must not downgrade them
        // to LOW-reliability where a high-confidence LLM could overwrite them.
        const isHighReliability =
          !LOW_RELIABILITY_EXTRACTION.has(data.scoreSource) ||
          OUTLET_STAR_AUTHORITATIVE.has(data.outletId);
        // RAW-vs-RAW comparison: this 25-point bucket-jump guard decides whether
        // to TRUST the LLM over a low-reliability star extraction. The decision
        // must be made on the raw LLM score so the threshold semantics match
        // the historical behavior the guard was tuned for.
        if (llm && llmConf !== 'low' && Math.abs(parsed - llm) > 25) {
          const parsedBucket = parsed >= 70 ? 'positive' : parsed <= 40 ? 'negative' : 'mixed';
          const llmBucket = llm >= 70 ? 'positive' : llm <= 40 ? 'negative' : 'mixed';
          if (parsedBucket !== llmBucket) {
            flagForHumanReview(data, 'originalScore-llm-conflict',
              `${effectiveScoreLabel} "${effectiveOriginalScore}" (=${parsed}, bucket=${parsedBucket}) vs LLM ${llm} (bucket=${llmBucket}, conf=${llmConf})` +
              (isHighReliability ? ` [HIGH-reliability: ${data.scoreSource} — kept]` : ' [LOW-reliability — LLM override]'));
            // Only let LLM override LOW-reliability extractions (css-stars reading
            // wrong element, generic pattern matches). HIGH-reliability sources
            // (json-ld, verified star images, letter grades) are the critic's own
            // published rating and must be kept.
            if (llmConf === 'high' && !isHighReliability) {
              inc('originalScoreOverriddenByLLM');
              return { score: llm, source: 'llmScore-override-star-conflict' };
            }
          }
        }
        return { score: parsed, source: 'originalScore-priority0' };
      }
    }
  }

  // P0.75: Inline star recovery at rebuild time
  // When originalScore is missing, try extracting from fullText. Two cases:
  // (a) Non-KNOWN outlets with Tier 1.5 clearing (KNOWN outlets are handled above by P0.5 override)
  // (b) KNOWN_STAR_OUTLETS that never had originalScore extracted (only fullText available)
  // Respects scoreConfidence === 'low' (skip unreliable extractions).
  //
  // SAFETY: Inline recovery is lower-reliability than explicit originalScore — the stars
  // may come from pull-quotes, ad copy, or unrelated content in fullText. So we apply
  // the same LLM-bucket-conflict guard as P0.5's LOW_RELIABILITY path: if the LLM
  // score disagrees strongly (>25pt delta AND different bucket) with high confidence,
  // trust the LLM and flag for human review.
  if (!effectiveOriginalScore && (isKnownStarOutlet || isTier15Cleared) && data.fullText && data.scoreConfidence !== 'low') {
    const recovered = extractScore('', data.fullText, data.outletId);
    if (recovered && recovered.normalizedScore != null) {
      // Only trust unicode-stars and word-stars sources — these are unambiguous
      const TRUSTED_RECOVERY_SOURCES = new Set(['unicode-stars', 'unicode-stars-fallthrough', 'word-stars']);
      if (TRUSTED_RECOVERY_SOURCES.has(recovered.source)) {
        const recoveredScore = recovered.normalizedScore;
        const llm = data.llmScore && data.llmScore.score;
        const llmConf = data.llmScore && data.llmScore.confidence;
        if (llm && llmConf !== 'low' && Math.abs(recoveredScore - llm) > 25) {
          const recBucket = recoveredScore >= 70 ? 'positive' : recoveredScore <= 40 ? 'negative' : 'mixed';
          const llmBucket = llm >= 70 ? 'positive' : llm <= 40 ? 'negative' : 'mixed';
          if (recBucket !== llmBucket) {
            flagForHumanReview(data, 'inline-recovery-llm-conflict',
              `inline-recovery (${recovered.source}=${recoveredScore}, bucket=${recBucket}) vs LLM ${llm} (bucket=${llmBucket}, conf=${llmConf})` +
              ' [inline-recovery treated as LOW-reliability — LLM override on high conf]');
            if (llmConf === 'high') {
              inc('inlineRecoveryOverriddenByLLM');
              return { score: llm, source: 'llmScore-override-inline-recovery-conflict' };
            }
          }
        }
        inc('inlineStarRecovery');
        return { score: recoveredScore, source: 'originalScore-inline-recovery' };
      }
    }
  }

  // P1: LLM score (HIGH/MEDIUM confidence with ensemble)
  if (data.llmScore && data.llmScore.score) {
    const confidence = data.llmScore.confidence;
    const needsReview = data.ensembleData?.needsReview;

    const cvWrongArticle = isContentVerificationActive(data);
    const staleCvCleared = data.contentVerification?.wrongArticle && !cvWrongArticle;
    if (staleCvCleared) inc('staleContentVerificationCleared');

    const hasOriginalFullText = data.fullText && data.fullText.trim().length > 100 && !data.fullTextRecoveredFrom && !cvWrongArticle;
    const effectiveConfidence = (!hasOriginalFullText && confidence !== 'low') ? 'low' : confidence;

    if (effectiveConfidence !== 'low' && !needsReview) {
      const hasEnsemble = !!data.ensembleData;
      if (!hasEnsemble) {
        inc('blockedSingleModel');
      } else {
        return { score: data.llmScore.score, source: 'llmScore' };
      }
    }
  }

  // P2: Thumb-validated LLM
  const hasLowConfLlm = data.llmScore?.score && !!data.ensembleData &&
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
      return 'neutral';
    };
    const bucketDirection = (bucket) => {
      if (bucket === 'Rave' || bucket === 'Positive') return 'positive';
      if (bucket === 'Negative' || bucket === 'Pan') return 'negative';
      return 'neutral';
    };

    const llmDir = bucketDirection(llmBucket);
    const bwwScoreDir = data.bwwScore != null
      ? (data.bwwScore >= 7 ? 'positive' : data.bwwScore <= 3 ? 'negative' : 'neutral')
      : null;

    const thumbDirs = [];
    const dtliIsMeh = dtliThumbNorm === 'Flat';
    const bwwIsMeh = bwwThumbNorm === 'Flat';
    if (dtliThumbNorm && !dtliIsMeh) thumbDirs.push(thumbDirection(dtliThumbNorm));
    if (bwwThumbNorm && !bwwIsMeh) thumbDirs.push(thumbDirection(bwwThumbNorm));
    if (bwwScoreDir && bwwScoreDir !== 'neutral' && !bwwThumbNorm) thumbDirs.push(bwwScoreDir);
    const agreeing = thumbDirs.filter(d => d === llmDir).length;
    const disagreeing = thumbDirs.filter(d => d !== llmDir && d !== 'neutral').length;

    if (agreeing > 0 && disagreeing === 0) {
      inc('thumbValidatedLlm');
      return { score: llmScore, source: agreeing >= 2 ? 'llmScore-thumb-validated' : 'llmScore-thumb-boosted' };
    }

    if (disagreeing > 0 && agreeing === 0) {
      if (disagreeing >= 2) {
        flagForHumanReview(data, 'both-thumbs-disagree-with-llm',
          `LLM=${llmScore} (${llmBucket}), thumbs=${dtliThumbNorm || '-'}/${bwwThumbNorm || '-'}`);
      }
    }
  }

  // P3b: Downgraded ShowScore originalScore (WE only)
  if (downgradeShowScore && data.originalScore) {
    const parsed = parseOriginalScore(data.originalScore, data.outletId);
    if (parsed !== null) {
      inc('showScoreDowngradedFallback');
      return { score: parsed, source: 'originalScore-showscore-downgraded' };
    }
  }

  // P4: LLM score fallback (low conf / needs review / excerpt-only)
  if (data.llmScore && data.llmScore.score) {
    const confidence = data.llmScore.confidence;
    const needsReview = data.ensembleData?.needsReview;
    const isExcerptOnly = !(data.fullText && data.fullText.trim().length > 100 && !data.fullTextRecoveredFrom);
    const hasEnsemble = !!data.ensembleData;

    if (!hasEnsemble) {
      inc('blockedSingleModel');
    } else if (confidence === 'low' || isExcerptOnly) {
      return { score: data.llmScore.score, source: 'llmScore-lowconf' };
    } else if (needsReview) {
      return { score: data.llmScore.score, source: 'llmScore-review' };
    }
  }

  // P4b: Existing assignedScore — score validation already happened, trust it.
  // Previously gated behind scoreSource/thumb checks, but assignedScore in 1-100
  // means the review was validated (manually or by pipeline). contentTier=invalid
  // should prevent re-scoring (via isScoreable) but not exclude from reviews.json.
  if (data.assignedScore && data.assignedScore >= 1 && data.assignedScore <= 100) {
    return { score: data.assignedScore, source: 'assignedScore' };
  }

  // P5: Bucket mapping
  if (data.bucket && BUCKET_SCORES[data.bucket]) {
    return { score: BUCKET_SCORES[data.bucket], source: 'bucket' };
  }

  // P5.5: bwwScore fallback
  if (data.bwwScore != null && data.bwwScore >= 1 && data.bwwScore <= 10) {
    return { score: data.bwwScore * 10, source: 'bwwScore-fallback' };
  }

  // P5.7: aggregatorStars fallback — third-party star ratings from aggregator sites.
  // Only trust if the outlet actually publishes star ratings (KNOWN_STAR_OUTLETS).
  // Otherwise the aggregator may have invented the rating (e.g., London Theatre).
  if (data.aggregatorStars && isKnownStarOutlet) {
    const parsed = parseOriginalScore(data.aggregatorStars, data.outletId);
    if (parsed !== null) {
      inc('aggregatorStarsFallback');
      return { score: parsed, source: 'aggregatorStars-fallback' };
    }
  }

  // P6: Thumb mappings
  if (data.dtliThumb && THUMB_SCORES[data.dtliThumb]) {
    return { score: THUMB_SCORES[data.dtliThumb], source: 'thumb' };
  }
  if (data.bwwThumb && THUMB_SCORES[data.bwwThumb]) {
    return { score: THUMB_SCORES[data.bwwThumb], source: 'thumb' };
  }
  if (data.thumb && THUMB_SCORES[data.thumb]) {
    return { score: THUMB_SCORES[data.thumb], source: 'thumb' };
  }

  return null;
}

// ===================================================
// URL DATE EXTRACTION
// ===================================================

// Show-title years that look like dates but aren't
const TITLE_YEARS = new Set(['1776', '1984', '1812', '1921', '1992', '1940', '2026']);

const MONTH_ABBR_TO_NUM = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function validateCalendarDate(year, month, day) {
  if (year < 1970 || year > 2027 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Extract a publish date from a review URL. Returns { date, dateSource } or null.
 * date is YYYY-MM-DD for full dates, YYYY-MM for month-only, or null.
 * yearOnly is set when only a year could be extracted (for wrong-production flagging).
 */
function extractDateFromUrl(url) {
  if (!url) return null;
  const pathOnly = url.split('?')[0].split('#')[0];

  // Pattern 1: /YYYY/MM/DD/ (WordPress-style, most reliable)
  const slashMatch = pathOnly.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
  if (slashMatch && !TITLE_YEARS.has(slashMatch[1])) {
    const result = validateCalendarDate(parseInt(slashMatch[1]), parseInt(slashMatch[2]), parseInt(slashMatch[3]));
    if (result) return { date: result, source: 'url-ymd' };
  }

  // Pattern 2: /YYYY/mon/DD (Guardian-style: /2018/apr/22)
  const guardianMatch = pathOnly.match(/\/(20\d\d)\/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\/(\d{1,2})/i);
  if (guardianMatch) {
    const month = MONTH_ABBR_TO_NUM[guardianMatch[2].toLowerCase()];
    if (month) {
      const result = validateCalendarDate(parseInt(guardianMatch[1]), parseInt(month), parseInt(guardianMatch[3]));
      if (result) return { date: result, source: 'url-guardian' };
    }
  }

  // Pattern 3: YYYYMMDD at end of URL path (BWW-style: -20241010)
  const bwwMatch = pathOnly.match(/[^0-9](20\d\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[^0-9]|$)/);
  if (bwwMatch) {
    const result = validateCalendarDate(parseInt(bwwMatch[1]), parseInt(bwwMatch[2]), parseInt(bwwMatch[3]));
    if (result) return { date: result, source: 'url-compact' };
  }

  // Pattern 4: YYYY-MM-DD in path (Bloomberg, LA Times)
  const dashMatch = pathOnly.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (dashMatch && !TITLE_YEARS.has(dashMatch[1])) {
    const y = parseInt(dashMatch[1]), m = parseInt(dashMatch[2]), d = parseInt(dashMatch[3]);
    // Reject if it doesn't look like a date (e.g., 1776-10-17 is a title year pattern)
    if (y >= 2000 && y <= 2027) {
      const result = validateCalendarDate(y, m, d);
      if (result) return { date: result, source: 'url-dash' };
    }
  }

  // Pattern 5: blogspot.com/YYYY/MM/ (year+month only)
  const blogspotMatch = pathOnly.match(/\.blogspot\.com\/(\d{4})\/(\d{2})\//);
  if (blogspotMatch) {
    const y = parseInt(blogspotMatch[1]), m = parseInt(blogspotMatch[2]);
    if (y >= 2000 && y <= 2027 && m >= 1 && m <= 12) {
      return { date: `${y}-${String(m).padStart(2, '0')}`, source: 'url-blogspot-ym' };
    }
  }

  // Pattern 6: Talkin' Broadway off-broadway section — /ob/MM_DD_YY.html or
  // /page/ob/MM_DD_YY.html, optional trailing letter for same-day multi-review
  // disambiguation (02_08_24b.html). Scoped to the domain since the shape is
  // generic. TB has been behind a Cloudflare managed challenge since ~2026-04
  // (fetchPage can't reach it — see collect-review-texts.js), so this URL-only
  // path is the only viable date source for TB off-broadway reviews.
  if (/talkinbroadway\.com/i.test(url)) {
    const tbMatch = pathOnly.match(/\/(?:page\/)?ob\/(\d{1,2})_(\d{1,2})_(\d{2})[a-z]?\.html/i);
    if (tbMatch) {
      const month = parseInt(tbMatch[1], 10);
      const day = parseInt(tbMatch[2], 10);
      const yy = parseInt(tbMatch[3], 10);
      const year = yy <= 30 ? 2000 + yy : 1900 + yy;
      const result = validateCalendarDate(year, month, day);
      if (result) return { date: result, source: 'url-tb-ob' };
    }
  }

  // Pattern 7: Year-only extraction (for wrong-production flagging, not display)
  // Look for /YYYY/ bounded by path separators
  const yearMatch = pathOnly.match(/\/(20\d\d)\//);
  if (yearMatch && !TITLE_YEARS.has(yearMatch[1])) {
    const y = parseInt(yearMatch[1]);
    if (y >= 2000 && y <= 2027) {
      return { date: null, yearOnly: y, source: 'url-year-only' };
    }
  }

  return null;
}

module.exports = {
  isUnambiguousRatingString,
  // Text cleaning
  normalizeThumb,
  normalizePublishDate,
  fixMojibake,
  fixMissingPeriods,
  // Excerpt quality
  isJunkExcerpt,
  isGenericQuote,
  trimToCompleteSentence,
  normalizeQuoteWrapping,
  cleanExcerpt,
  // Scoring
  isContentVerificationActive,
  getBestScore,
  // URL date extraction
  extractDateFromUrl,
  // Re-export from score-extractors for convenience
  scoreToBucket,
  scoreToThumb,
};
