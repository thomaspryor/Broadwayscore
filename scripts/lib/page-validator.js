/**
 * Page-Level Content Validation for Aggregator Scrapers
 *
 * Prevents cross-show contamination by validating that a fetched page
 * is actually about the target show. Two-layer approach:
 *
 *   Layer 1: titleWordsMatchWithConfidence() against page headings (free, instant)
 *   Layer 2: LLM tiebreaker via Gemini Flash when confidence < 0.75 (~$0.0001/call)
 *
 * Fallback chain: Gemini → OpenAI → accept-with-warning
 * (Safe direction: when uncertain, ACCEPT rather than reject valid reviews)
 *
 * Usage:
 *   const { validatePageMatchesShow } = require('./lib/page-validator');
 *   const result = await validatePageMatchesShow(html, 'Romeo + Juliet');
 *   if (!result.valid) { console.log('Wrong show:', result.reason); }
 */

const https = require('https');
const cheerio = require('cheerio');
const { titleWordsMatchWithConfidence } = require('./show-matching');
const { GEMINI_FLASH, GPT4O_MINI } = require('./models');

// Confidence threshold below which the LLM tiebreaker fires
const LLM_CONFIDENCE_THRESHOLD = 0.75;

// ============================================================
// LLM Providers (following content-verifier.js pattern exactly)
// ============================================================

function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH}:generateContent?key=${apiKey}`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 20, thinkingConfig: { thinkingBudget: 0 } }
    });

    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
            resolve(text);
          } catch (e) {
            reject(new Error(`Gemini parse error: ${e.message}`));
          }
        } else {
          reject(new Error(`Gemini HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Gemini timeout')); });
    req.write(body);
    req.end();
  });
}

function callOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: GPT4O_MINI,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 20,
      temperature: 0.1
    });

    const req = https.request('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            resolve(json.choices?.[0]?.message?.content || '');
          } catch (e) {
            reject(new Error(`OpenAI parse error: ${e.message}`));
          }
        } else {
          reject(new Error(`OpenAI HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('OpenAI timeout')); });
    req.write(body);
    req.end();
  });
}

// ============================================================
// LLM Page Validation
// ============================================================

/**
 * Parse a YES/NO response from the LLM, handling case, punctuation, whitespace.
 * Returns true for YES, false for NO, null for unparseable.
 */
function parseYesNo(response) {
  if (!response) return null;
  const clean = response.trim().replace(/[^a-zA-Z]/g, '').toLowerCase();
  if (clean === 'yes') return true;
  if (clean === 'no') return false;
  // Handle responses starting with yes/no followed by explanation
  if (clean.startsWith('yes')) return true;
  if (clean.startsWith('no')) return false;
  return null;
}

/**
 * Ask an LLM whether a page is about a specific show.
 * Fallback chain: Gemini → OpenAI → null (accept with warning).
 *
 * @param {string} headingText - Page title + headings text
 * @param {string} showTitle - The show we're looking for
 * @param {object} [options]
 * @param {number} [options.openingYear] - Show's opening year for disambiguation
 * @returns {Promise<{ match: boolean|null, provider: string }>}
 */
async function llmValidatePageMatch(headingText, showTitle, options = {}) {
  const yearHint = options.openingYear ? ` The show opened in ${options.openingYear}.` : '';
  const isOpera = options.productionType === 'opera';
  // BWW opera reviews carry the composer in the heading ("Kaija Saariaho's
  // INNOCENCE — An Opera About a Killing Spree"), and the default "Broadway/
  // West End show" framing pushes Gemini to NO on otherwise-correct pages.
  // Switch the production frame for opera so cast/composer/festival context
  // doesn't bias the answer.
  const productionFrame = isOpera ? 'opera production' : 'Broadway/West End show';
  const titleNote = isOpera
    ? `\nThe title "${showTitle}" should appear in the headings. Opera reviews commonly include the COMPOSER name (e.g., "Puccini's TOSCA", "Saariaho's INNOCENCE") and house name (Met Opera, Lyric Opera, etc.) — that's normal and counts as a match. Reject only if the page is about a clearly DIFFERENT production (different festival venue from a different year, different opera title) or a recording/film.`
    : `\nThe show title "${showTitle}" should appear in the page headings. Headings may include additional context like cast names, dates, or "Review Roundup" — that's normal.\nAnswer NO if: the page is about a movie, book, TV show, or concert (not a stage production), OR about a genuinely DIFFERENT show (e.g., "Blood/Love" vs "Bloody Bloody Andrew Jackson").`;
  const prompt = `Is this page a THEATER review or review roundup for the ${productionFrame} titled "${showTitle}"?${yearHint}${titleNote}\nPage title and headings: "${headingText.substring(0, 500)}"\nAnswer YES or NO only.`;

  // Try Gemini first (cheapest)
  try {
    const response = await callGemini(prompt);
    const result = parseYesNo(response);
    if (result !== null) {
      return { match: result, provider: 'gemini' };
    }
  } catch (e) {
    // Fall through to next provider
  }

  // Try OpenAI
  try {
    const response = await callOpenAI(prompt);
    const result = parseYesNo(response);
    if (result !== null) {
      return { match: result, provider: 'openai' };
    }
  } catch (e) {
    // Fall through to accept-with-warning
  }

  // All providers failed — accept with warning (safe direction)
  return { match: null, provider: 'none' };
}

// ============================================================
// Main Validation Function
// ============================================================

/**
 * Extract a YYYY (year) from a URL's trailing date suffix.
 * BroadwayWorld URLs reliably encode the article publish date as YYYYMMDD
 * at the end of the slug (optionally followed by a 1-2 digit dedup suffix):
 *   .../article/Review-Roundup-BIG-FISH-Opens-on-Broadway-20131005
 *   .../article/BWW-Review-Charming-CATS-Revival-20160731
 *   .../article/Review-BIG-FISH-Makes-Wholesome-The-New-Hip-201310061
 *
 * Returns year as a number, or null if no recognizable date pattern.
 */
function extractYearFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  // Match YYYYMMDD at end of slug, optionally followed by 1-2 dedup digits
  // and optional trailing slash/query/hash
  const m = url.match(/-(\d{4})(\d{2})(\d{2})\d{0,2}(?:[/?#]|$)/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  // Sanity bounds: 1990-2100, valid month/day
  if (year < 1990 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return year;
}

/**
 * Validate that a fetched HTML page is about the target show.
 * Checks page title + headings (NOT body text — too noisy for roundup pages).
 * Uses LLM tiebreaker when word-match confidence is low.
 *
 * @param {string} html - The full HTML of the fetched page
 * @param {string} showTitle - The show title we're looking for
 * @param {object} [options] - Optional configuration
 * @param {boolean} [options.skipLlm] - Skip LLM tiebreaker (for testing)
 * @param {number} [options.openingYear] - Show's opening year for year-mismatch detection
 * @param {string} [options.pageUrl] - URL of the fetched page for URL-based date extraction
 * @returns {Promise<{ valid: boolean, confidence: number, reason: string, provider?: string }>}
 */
async function validatePageMatchesShow(html, showTitle, options = {}) {
  const $ = cheerio.load(html);

  // Extract page title + headings only (not body text)
  const pageTitle = $('title').text() || '';
  const h1Text = $('h1').map((_, el) => $(el).text()).get().join(' ');
  const h2Text = $('h2').first().text() || '';
  const headingText = `${pageTitle} ${h1Text} ${h2Text}`.trim();

  // Layer 0a: URL date extraction (fastest check, no network/LLM)
  // BWW URLs reliably encode the article publish date. If that date's year
  // is 4+ years off the show's opening year, this is almost certainly a
  // different production — catches Big Fish (2013) roundup being matched to
  // Bigfoot (2026) when the heading doesn't contain a disambiguating year.
  // Runs BEFORE heading-year check because URL dates are more reliable
  // (headings may omit year or mention future festival dates).
  if (options.openingYear && options.pageUrl) {
    const urlYear = extractYearFromUrl(options.pageUrl);
    if (urlYear && Math.abs(urlYear - options.openingYear) >= 4) {
      return { valid: false, confidence: 0, reason: `URL date mismatch: article year ${urlYear} vs show opened ${options.openingYear}` };
    }
  }

  // Layer 0b: Heading year-mismatch detection (fast, pre-word-match)
  // If headings mention a specific year that's far from the show's opening year,
  // this is very likely the wrong production or wrong show entirely.
  if (options.openingYear) {
    const yearsInHeading = headingText.match(/\b(19\d{2}|20\d{2})\b/g);
    if (yearsInHeading && yearsInHeading.length > 0) {
      const headingYears = yearsInHeading.map(Number);
      const closestDiff = Math.min(...headingYears.map(y => Math.abs(y - options.openingYear)));
      if (closestDiff >= 4) {
        return { valid: false, confidence: 0, reason: `year mismatch: heading years [${headingYears.join(',')}] vs show opened ${options.openingYear}` };
      }
    }
  }

  // Layer 1: Word-match with confidence
  const match = titleWordsMatchWithConfidence(showTitle, headingText);

  // High confidence match — accept without LLM
  if (match.matched && match.confidence >= LLM_CONFIDENCE_THRESHOLD) {
    return { valid: true, confidence: match.confidence, reason: 'headings match (high confidence)' };
  }

  // High confidence non-match — reject without LLM when ZERO words from title appear
  // This covers both multi-word titles and single-word titles where the word isn't present.
  // Partial matches (e.g., "Sweeney" found but not "Todd") go to LLM tiebreaker.
  if (!match.matched && match.matchCount === 0 && match.words.length >= 1) {
    return { valid: false, confidence: 0, reason: `headings "${headingText.substring(0, 80)}" don't match "${showTitle}"` };
  }

  // Short-title full-match guard: for titles with 2-3 meaningful words, a missing
  // word almost always means a different show — e.g., "Drunk Romeo & Juliet" is
  // NOT "Romeo + Juliet" (Broadway Connor/Zegler revival, 2024). The LLM tiebreaker
  // cannot reliably distinguish brand prefixes (Drunk, Bad, Lunatic's) from base
  // titles, so reject short-title partial matches without LLM rescue.
  if (match.words && match.words.length >= 2 && match.words.length <= 3
      && match.matchCount > 0 && match.matchCount < match.words.length) {
    const missing = match.missingWords || [];
    return {
      valid: false,
      confidence: match.confidence,
      reason: `short-title partial match: missing [${missing.join(',')}] from headings "${headingText.substring(0, 80)}"`
    };
  }

  // Slug fallback: check if multi-word show slug appears in page title
  // Only for multi-word slugs (contain hyphen) — single-word slugs are too ambiguous
  const showSlug = showTitle.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-').trim();
  if (showSlug.includes('-') && showSlug.length >= 4 && pageTitle.toLowerCase().includes(showSlug)) {
    return { valid: true, confidence: 0.85, reason: 'slug in page title' };
  }

  // Low confidence or borderline — try LLM tiebreaker
  if (!options.skipLlm) {
    const llmResult = await llmValidatePageMatch(headingText, showTitle, { openingYear: options.openingYear, productionType: options.productionType });

    // Log every LLM decision for debugging
    console.log(`  [LLM-VALIDATE] "${showTitle}" | headings: "${headingText.substring(0, 60)}" | result: ${llmResult.match} | provider: ${llmResult.provider} | word-confidence: ${match.confidence}`);

    if (llmResult.match === true) {
      return { valid: true, confidence: 0.9, reason: `LLM confirmed (${llmResult.provider})`, provider: llmResult.provider };
    }
    if (llmResult.match === false) {
      return { valid: false, confidence: 0, reason: `LLM rejected (${llmResult.provider}): headings "${headingText.substring(0, 80)}"`, provider: llmResult.provider };
    }
    // llmResult.match === null — all providers failed, fall through to accept
  }

  // Final fallback: accept if word-match said yes (even low confidence), reject if it said no
  // Safe direction: accept borderline matches rather than dropping valid reviews
  if (match.matched) {
    console.log(`  [WARN] Low-confidence match accepted without LLM: "${showTitle}" (confidence: ${match.confidence})`);
    return { valid: true, confidence: match.confidence, reason: 'low-confidence match accepted (no LLM available)' };
  }

  return { valid: false, confidence: 0, reason: `no match: headings "${headingText.substring(0, 80)}" vs "${showTitle}"` };
}

module.exports = {
  validatePageMatchesShow,
  titleWordsMatchWithConfidence,
  parseYesNo,
  extractYearFromUrl,
  LLM_CONFIDENCE_THRESHOLD,
};
