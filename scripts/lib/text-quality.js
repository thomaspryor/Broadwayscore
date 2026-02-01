/**
 * Text Quality Assessment Module
 *
 * Assesses review text quality for LLM scoring decisions.
 * Does NOT use character count as a proxy for quality.
 */

// Verdict language patterns - indicates the critic's final assessment
const VERDICT_PATTERNS = [
  // Positive verdicts
  /\b(must[- ]see|essential|brilliant|masterpiece|triumph|unmissable)\b/i,
  /\b(highly recommend|worth (seeing|the trip|every penny))\b/i,
  /\b(don'?t miss|not to be missed|shouldn'?t miss)\b/i,
  /\b(hits (its|the) (target|mark)|delivers|succeeds|soars)\b/i,
  /\b(exhilarating|thrilling|riveting|captivating|mesmerizing)\b/i,
  /\b(remarkable|extraordinary|exceptional|stunning|dazzling)\b/i,
  /\b(best .{0,20} (season|year|broadway))\b/i,

  // Negative verdicts
  /\b(skip|avoid|miss this one|don'?t bother)\b/i,
  /\b(disappointing|disappoints|waste of time)\b/i,
  /\b(fails to|never comes together|doesn'?t work)\b/i,
  /\b(falls (flat|short)|misses the mark|underwhelms)\b/i,
  /\b(tedious|tiresome|dreary|dull|lifeless)\b/i,

  // Qualified/mixed verdicts
  /\b(worth seeing (despite|if)|recommended (with|for))\b/i,
  /\b(flawed but|imperfect but|despite .{0,30} worth)\b/i,
  /\b(mixed (results|feelings|bag))\b/i,
  /\b(has (its|some) (moments|charms))\b/i,

  // Star/grade language often appears with verdicts
  /\b\d\s*(out of|\/)\s*\d\s*(stars?|points?)?\b/i,
  /\bgrade:?\s*[A-F][+-]?\b/i,

  // Common closing phrases
  /\b(in (short|sum|summary|conclusion))\b/i,
  /\b(the (bottom line|verdict|takeaway))\b/i,
];

// Truncation signals - indicates text was cut off
const TRUNCATION_PATTERNS = [
  // Paywall/subscription markers
  /subscribe to (continue|read|keep)/i,
  /sign in to (continue|read|keep)/i,
  /to continue reading/i,
  /read more\.?\.?\.?$/i,
  /continue reading/i,
  /for subscribers only/i,
  /members only/i,
  /unlock this article/i,

  // Cut-off indicators
  /\.{3}\s*$/,  // Ends with ellipsis
  /[a-z,]\s*$/,  // Ends mid-word or after comma (no punctuation)

  // Promotional interruptions (often appear at truncation point)
  /advertisement\s*$/i,
  /sponsored content/i,
];

// Corruption signals - indicates garbage mixed into text
const CORRUPTION_PATTERNS = [
  // Mastheads
  /^democracy dies in darkness/i,
  /^all the news that'?s fit to print/i,

  // Navigation elements
  /\bshare\s+(this\s+)?(article|story|on)\b/i,
  /\blisten\s+\d+\s*min\b/i,
  /\bcomment\s*\(\d+\)/i,
  /\bsave\s+(article|story)\b/i,

  // Photo/media credits mixed in
  /\(?\s*(photo|image|credit|getty|ap photo|reuters)\s*:?/i,
  /\bcredit\s*\.\.\./i,

  // Cookie/privacy notices
  /\bcookies?\s+(policy|settings|preferences)\b/i,
  /\bprivacy\s+(policy|notice)\b/i,

  // Social media junk
  /\bfollow us on\b/i,
  /\btweet\s+this\b/i,
];

/**
 * Check if text contains verdict language
 * @param {string} text - Text to check
 * @param {boolean} checkEndOnly - If true, only check last 600 chars
 * @returns {boolean}
 */
function hasVerdict(text, checkEndOnly = false) {
  if (!text) return false;

  const textToCheck = checkEndOnly ? text.slice(-600) : text;

  return VERDICT_PATTERNS.some(pattern => pattern.test(textToCheck));
}

/**
 * Check if text shows truncation signals
 * @param {string} text
 * @returns {{isTruncated: boolean, signals: string[]}}
 */
function checkTruncation(text) {
  if (!text) return { isTruncated: false, signals: [] };

  const signals = [];

  for (const pattern of TRUNCATION_PATTERNS) {
    if (pattern.test(text)) {
      signals.push(pattern.toString());
    }
  }

  // Check for abrupt ending (no sentence-final punctuation in last 20 chars)
  const ending = text.slice(-20).trim();
  if (ending && !/[.!?]["']?\s*$/.test(ending)) {
    // But not if it ends with a quote attribution or similar
    if (!/["']\s*$/.test(ending) && !/—\s*\w+\s*$/.test(ending)) {
      signals.push('no-final-punctuation');
    }
  }

  return {
    isTruncated: signals.length > 0,
    signals
  };
}

/**
 * Check if text has corruption (garbage mixed in)
 * @param {string} text
 * @returns {{isCorrupted: boolean, signals: string[]}}
 */
function checkCorruption(text) {
  if (!text) return { isCorrupted: false, signals: [] };

  const signals = [];

  for (const pattern of CORRUPTION_PATTERNS) {
    if (pattern.test(text)) {
      signals.push(pattern.toString());
    }
  }

  // Check for suspicious character sequences (encoding issues)
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) {
    signals.push('control-characters');
  }

  // Check for repeated navigation-like text (but not "email" which is common in content)
  // Only flag if we see specific nav patterns like "Share Save Print"
  if (/\b(share|save|print)\b[^.]{0,20}\b(share|save|print)\b/i.test(text)) {
    signals.push('repeated-nav-elements');
  }
  // Or explicit nav bars
  if (/Share\s+(on\s+)?(Facebook|Twitter|Email|Print)/i.test(text)) {
    signals.push('social-sharing-bar');
  }

  return {
    isCorrupted: signals.length > 0,
    signals
  };
}

/**
 * Remove trailing website junk from text for assessment
 * @param {string} text
 * @returns {string}
 */
function stripTrailingJunk(text) {
  if (!text) return text;

  // Common patterns that indicate end of actual review content
  const junkPatterns = [
    /\n\s*(When we learn of a mistake|If you spot an error|A version of this)[^]*$/i,
    /\n\s*(Share full article|Related Content|Advertisement|Share this)[^]*$/i,
    /\n\s*(Running time|Tickets|At the .{0,50}Theater|Through \w+ \d+)[^]*$/i,
    /\n\s*Learn more\s*$/i,
    /\n\s*More from[^]*$/i,
    /\n\s*Read more[^]*$/i,

    // NYT-style related article sections (headlines followed by colons)
    // Pattern: "Headline Title: More text" after sentence end - strip headline onward, keep the period
    /(?<=\.)\s+[A-Z][A-Za-z\s]{5,50}:\s+[A-Z][^]*$/,

    // More explicit related content patterns
    /\s+(Related|Also Read|You May Also Like|More Stories|Recommended)[:\s][^]*$/i,

    // Vulture/Vox related content
    /\s+See All\s*$/i,
    /\s+More:\s+[^]*$/i,
  ];

  let cleaned = text;
  for (const pattern of junkPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  return cleaned.trim();
}

/**
 * Check if text ends properly (with sentence-final punctuation)
 * @param {string} text
 * @returns {boolean}
 */
function endsProperlyWithPunctuation(text) {
  if (!text) return false;
  const trimmed = text.trim();
  // Ends with . ! ? optionally followed by closing quote
  return /[.!?]["']?\s*$/.test(trimmed);
}

/**
 * Assess fullText quality
 * @param {string} fullText
 * @param {boolean} useCleanedText - If true, clean text before assessing
 * @returns {'complete' | 'truncated' | 'corrupted' | null}
 */
function assessFullText(fullText, useCleanedText = true) {
  if (!fullText || fullText.length < 50) {
    return null;
  }

  // Clean text for assessment - removes known artifacts
  const textToAssess = useCleanedText ? cleanText(fullText) : fullText;

  if (!textToAssess || textToAssess.length < 50) {
    return null;
  }

  // After cleaning, check if still has corruption signals
  const corruption = checkCorruption(textToAssess);
  if (corruption.isCorrupted && corruption.signals.length > 1) {
    // Only mark corrupted if multiple signals (single photo credit is tolerable)
    return 'corrupted';
  }

  // Check for explicit truncation signals
  const truncation = checkTruncation(textToAssess);
  if (truncation.isTruncated) {
    return 'truncated';
  }

  // If text ends with proper punctuation, it's likely complete
  // (even without explicit verdict language - some reviews are subtle)
  if (endsProperlyWithPunctuation(textToAssess)) {
    return 'complete';
  }

  // Text doesn't end properly - likely truncated
  return 'truncated';
}

/**
 * Score a text source for quality (higher = better)
 * @param {Object} source
 * @returns {number}
 */
function scoreSource(source) {
  let score = 0;

  // Base score by type
  if (source.type === 'fullText') {
    if (source.status === 'complete') score = 100;
    else if (source.status === 'truncated') score = 40;
    else if (source.status === 'corrupted') score = 20;
  } else if (source.type === 'excerpt') {
    score = 60; // Curated excerpts are reliable
  }

  // Bonus for having verdict
  if (source.hasVerdict) {
    score += 25;
  }

  // Small bonus for length (but not the primary factor)
  if (source.text?.length > 1000) score += 5;
  if (source.text?.length > 2000) score += 5;

  return score;
}

/**
 * Get the best text source for LLM scoring
 * @param {Object} review - Review object with fullText and excerpt fields
 * @returns {{text: string, type: string, status: string, confidence: string, reasoning: string}}
 */
function getBestTextForScoring(review) {
  // 2B: Skip scoring of flagged text — treat fullText as null so excerpt fallback is used
  const hasDataQualityFlag = review.misattributedFullText || review.wrongShow ||
    review.wrongProduction || review.showNotMentioned;

  if (hasDataQualityFlag && review.fullText) {
    const flagName = review.misattributedFullText ? 'misattributedFullText' :
      review.wrongShow ? 'wrongShow' : review.wrongProduction ? 'wrongProduction' : 'showNotMentioned';
    // Proceed without fullText — only excerpts will be used
    const reviewWithoutFullText = { ...review, fullText: null };
    const excerptResult = getBestTextForScoring(reviewWithoutFullText);
    excerptResult.reasoning = `Skipped fullText (${flagName} flag). ${excerptResult.reasoning}`;
    return excerptResult;
  }

  const sources = [];

  // Assess fullText if present - use CLEANED text for assessment and output
  if (review.fullText && review.fullText.length >= 50) {
    const cleaned = cleanText(review.fullText);
    const status = assessFullText(review.fullText, true); // assess with cleaning
    sources.push({
      text: cleaned,  // Return cleaned text, not raw
      type: 'fullText',
      status: status,
      hasVerdict: hasVerdict(cleaned),
      field: 'fullText',
      originalLength: review.fullText.length,
      cleanedLength: cleaned.length
    });
  }

  // Add aggregator excerpts
  const excerptFields = [
    { field: 'showScoreExcerpt', name: 'Show Score' },
    { field: 'dtliExcerpt', name: 'DTLI' },
    { field: 'bwwExcerpt', name: 'BWW' },
    { field: 'nycTheatreExcerpt', name: 'NYC Theatre' }
  ];

  for (const { field, name } of excerptFields) {
    const excerpt = review[field];
    if (excerpt && excerpt.length >= 30) {
      sources.push({
        text: excerpt,
        type: 'excerpt',
        status: 'curated',
        hasVerdict: hasVerdict(excerpt),
        field: field,
        sourceName: name
      });
    }
  }

  if (sources.length === 0) {
    return {
      text: null,
      type: null,
      status: 'insufficient',
      confidence: 'none',
      reasoning: 'No usable text found'
    };
  }

  // Score and sort sources
  sources.forEach(s => { s.score = scoreSource(s); });
  sources.sort((a, b) => b.score - a.score);

  const best = sources[0];

  // 2A: Augment short fullText (300-1500 chars) with non-duplicate excerpts
  if (best.type === 'fullText' && best.text && best.text.length >= 300 && best.text.length <= 1500) {
    const excerptSources = sources.filter(s => s.type === 'excerpt');
    if (excerptSources.length > 0) {
      const additionalExcerpts = [];
      for (const excerptSource of excerptSources) {
        // Skip if the excerpt is already a substring of fullText
        if (best.text.includes(excerptSource.text)) continue;
        additionalExcerpts.push(excerptSource.text);
      }
      if (additionalExcerpts.length > 0) {
        const separator = '\n\n--- Additional context from this review ---\n';
        const combined = best.text + separator + additionalExcerpts.join('\n\n');
        // Cap at 3000 chars total
        best.text = combined.substring(0, 3000);
        best.augmented = true;
        best.augmentedExcerptCount = additionalExcerpts.length;
      }
    }
  }

  // Determine confidence level
  let confidence;
  let reasoning;

  if (best.type === 'fullText' && best.status === 'complete') {
    confidence = 'high';
    reasoning = 'Complete review text with verdict';
  } else if (best.type === 'fullText' && best.status === 'complete' && !best.hasVerdict) {
    confidence = 'medium';
    reasoning = 'Complete text but no clear verdict language detected';
  } else if (best.type === 'excerpt' && best.hasVerdict) {
    confidence = 'medium';
    reasoning = `Curated ${best.sourceName} excerpt with verdict`;
  } else if (best.type === 'excerpt') {
    confidence = 'medium';
    reasoning = `Curated ${best.sourceName} excerpt`;
  } else if (best.type === 'fullText' && best.status === 'truncated') {
    // Check if we have a better excerpt
    const excerptWithVerdict = sources.find(s => s.type === 'excerpt' && s.hasVerdict);
    if (excerptWithVerdict) {
      // Prefer excerpt with verdict over truncated fullText without
      if (!best.hasVerdict) {
        const betterSource = excerptWithVerdict;
        return {
          text: betterSource.text,
          type: betterSource.type,
          status: betterSource.status,
          confidence: 'medium',
          reasoning: `Truncated fullText lacks verdict; using curated ${betterSource.sourceName} excerpt with verdict instead`,
          field: betterSource.field
        };
      }
    }
    confidence = 'low';
    reasoning = 'Truncated text - may be missing final verdict';
  } else if (best.type === 'fullText' && best.status === 'corrupted') {
    confidence = 'low';
    reasoning = 'Text contains artifacts/corruption - needs cleaning';
  } else {
    confidence = 'low';
    reasoning = 'Limited text available';
  }

  return {
    text: best.text,
    type: best.type,
    status: best.status,
    confidence,
    reasoning,
    field: best.field,
    allSources: sources.map(s => ({
      field: s.field,
      type: s.type,
      status: s.status,
      score: s.score,
      hasVerdict: s.hasVerdict,
      length: s.text?.length
    }))
  };
}

/**
 * Clean corrupted text by removing common artifacts
 * @param {string} text
 * @returns {string}
 */
function cleanText(text) {
  if (!text) return text;

  let cleaned = text;

  // === LEADING JUNK ===

  // Remove common mastheads
  cleaned = cleaned.replace(/^(Democracy Dies in Darkness|All the News That's Fit to Print)\s*/i, '');

  // Remove Vox Media affiliate disclosure (various formats)
  cleaned = cleaned.replace(/^Things you buy through our links[^.]*\.\s*/i, '');
  cleaned = cleaned.replace(/^We may earn a commission[^.]*\.\s*/i, '');

  // Remove leading photo credits (e.g., "Photo: Name\n")
  cleaned = cleaned.replace(/^Photo\s*:\s*[^\n]+[\n\s]*/i, '');

  // Remove leading whitespace and empty lines
  cleaned = cleaned.replace(/^[\s\n]+/, '');

  // Sometimes the junk has multiple lines - clean again
  if (cleaned.match(/^(Photo|Things you buy|We may earn)/i)) {
    cleaned = cleaned.replace(/^[^\n]+\n\s*/i, '');
  }

  // === INLINE JUNK ===

  // Remove photo captions (various formats)
  cleaned = cleaned.replace(/\([^)]*(?:Photo|Credit|Getty|AP Photo|Reuters)[^)]*\)/gi, '');
  cleaned = cleaned.replace(/Photo\s*:\s*[A-Z][^.\n]{0,50}\s*/gi, ''); // "Photo: Name"
  cleaned = cleaned.replace(/Credit\s*\.{3}[^.]+\./gi, '');
  cleaned = cleaned.replace(/\(Getty Images\)/gi, '');

  // Remove "Listen X min Share Comment" patterns
  cleaned = cleaned.replace(/Listen\s*\d+\s*min\s*(Share\s*)?(Comment\s*)?/gi, '');

  // Remove social sharing prompts
  cleaned = cleaned.replace(/Share\s+(this\s+)?(article|story|on\s+\w+)/gi, '');

  // Remove cookie/privacy notices
  cleaned = cleaned.replace(/We use cookies[^.]+\./gi, '');
  cleaned = cleaned.replace(/Privacy Policy[^.]*\./gi, '');

  // === TRAILING JUNK ===

  // Use stripTrailingJunk for thorough trailing cleanup
  cleaned = stripTrailingJunk(cleaned);

  // Remove trailing metadata (theater info already handled by stripTrailingJunk)
  cleaned = cleaned.replace(/\n\s*(?:Running time|Tickets|Through\s+\w+\s+\d+)[^]*$/i, '');

  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

module.exports = {
  hasVerdict,
  checkTruncation,
  checkCorruption,
  assessFullText,
  getBestTextForScoring,
  cleanText,
  stripTrailingJunk,
  endsProperlyWithPunctuation,
  scoreSource
};
