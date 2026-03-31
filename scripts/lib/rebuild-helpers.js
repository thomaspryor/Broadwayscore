/**
 * Pure helper functions extracted from rebuild-all-reviews.js for testability.
 *
 * These functions ARE the production code — rebuild-all-reviews.js imports from here.
 * Scoring thresholds and constants come from score-extractors.js (single source of truth).
 */

const { BUCKET_SCORES, THUMB_SCORES, scoreToBucket, scoreToThumb, OUTLET_VERIFIED_SOURCES } = require('./score-extractors');
const { parseOriginalScore } = require('./score-parsers');
const { decodeHtmlEntities } = require('./text-cleaning');

// ===================================================
// TEXT CLEANING
// ===================================================

function normalizeThumb(thumb) {
  if (thumb === 'Meh' || thumb === 'Flat') return 'Flat';
  return thumb; // 'Up' or 'Down'
}

const MONTH_TO_NUM = { january:'01', february:'02', march:'03', april:'04', may:'05', june:'06', july:'07', august:'08', september:'09', october:'10', november:'11', december:'12' };
function normalizePublishDate(dateStr) {
  if (!dateStr) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const isoTs = dateStr.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoTs) return isoTs[1];
  const mdy = dateStr.match(/^(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i);
  if (mdy && MONTH_TO_NUM[mdy[1].toLowerCase()]) {
    return `${mdy[3]}-${MONTH_TO_NUM[mdy[1].toLowerCase()]}-${mdy[2].padStart(2, '0')}`;
  }
  if (/previous production/i.test(dateStr)) return null;
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
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

  // P0: Human-reviewed score
  if (data.humanReviewScore && data.humanReviewScore >= 1 && data.humanReviewScore <= 100) {
    return { score: data.humanReviewScore, source: 'human-review' };
  }

  // P0.5: originalScore (aggregator-provided)
  // Downgrade aggregator-sourced ratings for WE ONLY when the aggregator is rating
  // the show independently (e.g., Show Score's own 1-100). Trust the rating when
  // a known star-rating outlet's score is relayed through an aggregator (e.g.,
  // WestEndTheatre.com reporting "Guardian: 4/5" — that IS the Guardian's real rating).
  const AGGREGATOR_SOURCES = new Set([
    'show-score', 'show-score-playwright', 'showscore-roundup',
    'theatre-reviews', 'theatre-reviews-roundup',
    'westendtheatre', 'stagedoor',
    'bww-roundup', 'bww-reviews', 'playbill-verdict',
    'lbo-roundup', 'nyc-theatre',
  ]);
  // Outlets known to publish their own star ratings — when an aggregator reports
  // a star rating for one of these outlets, it's relaying the outlet's own score.
  const KNOWN_STAR_OUTLETS = new Set([
    'timeout', 'timeout-london', 'guardian', 'telegraph', 'times-uk', 'standard',
    'independent', 'i-paper', 'financialtimes', 'daily-mail', 'the-express',
    'artsdesk', 'thestage', 'whatsonstage', 'london-theatre',
    'metro', 'the-sun', 'digital-spy', 'radio-times',
  ]);
  const isAggregatorSource = AGGREGATOR_SOURCES.has(data.source);
  const isWestEnd = data._showCategory === 'west-end' || data._showCategory === 'off-west-end';
  const isOutletVerified = OUTLET_VERIFIED_SOURCES.has(data.scoreSource);
  const isKnownStarOutlet = KNOWN_STAR_OUTLETS.has(data.outletId);
  // Only downgrade if: aggregator source + WE + NOT outlet-verified + NOT a known star outlet
  const downgradeShowScore = isAggregatorSource && isWestEnd && !isOutletVerified && !isKnownStarOutlet;

  // Effective score: use originalScore, or for known star outlets, treat aggregatorStars
  // as the outlet's own published rating (aggregators relay "Guardian: 4/5" etc.)
  const effectiveOriginalScore = data.originalScore
    || (data.aggregatorStars && isKnownStarOutlet ? data.aggregatorStars : null);
  const effectiveScoreLabel = data.originalScore ? 'originalScore' : 'aggregatorStars (known star outlet)';

  if (effectiveOriginalScore && !downgradeShowScore) {
    if (data.scoreConfidence === 'low' || data.scoreSource === 'star-icon' || data.scoreSource === 'star-icon-cleared') {
      inc('skippedLowConfidenceOriginal');
    } else {
      const parsed = parseOriginalScore(effectiveOriginalScore, data.outletId);
      if (parsed !== null) {
        const llm = data.llmScore && data.llmScore.score;
        const llmConf = data.llmScore && data.llmScore.confidence;
        // LOW reliability = automated CSS/generic extraction that often reads wrong elements.
        // LLM can override these. Everything else (json-ld, verified star images, letter
        // grades, unicode stars) is the critic's own published rating — never override.
        const LOW_RELIABILITY_EXTRACTION = new Set([
          'css-stars', 'star-class', 'css-rating', 'star-rating',
          'text-pattern', 'og-description', 'wp-api-title',
          'numeric-stars',    // Generic "X/5" pattern — false positives from pagination, dates, URLs
          'lbo-css-stars',    // CSS class extraction — sometimes reads wrong element on page
        ]);
        const isHighReliability = !LOW_RELIABILITY_EXTRACTION.has(data.scoreSource);
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
  // Lower priority than LLM/outlet-verified but keeps review in the dataset.
  if (data.aggregatorStars) {
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

module.exports = {
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
  // Re-export from score-extractors for convenience
  scoreToBucket,
  scoreToThumb,
};
