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

// Confidence threshold below which the LLM tiebreaker fires
const LLM_CONFIDENCE_THRESHOLD = 0.75;

// ============================================================
// LLM Providers (following content-verifier.js pattern exactly)
// ============================================================

function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 20 }
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
      model: 'gpt-4o-mini',
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
 * @returns {Promise<{ match: boolean|null, provider: string }>}
 */
async function llmValidatePageMatch(headingText, showTitle) {
  const prompt = `Is this page a theater review or review roundup for the show "${showTitle}"?\nPage title and headings: "${headingText.substring(0, 500)}"\nAnswer YES or NO only.`;

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
 * Validate that a fetched HTML page is about the target show.
 * Checks page title + headings (NOT body text — too noisy for roundup pages).
 * Uses LLM tiebreaker when word-match confidence is low.
 *
 * @param {string} html - The full HTML of the fetched page
 * @param {string} showTitle - The show title we're looking for
 * @param {object} [options] - Optional configuration
 * @param {boolean} [options.skipLlm] - Skip LLM tiebreaker (for testing)
 * @returns {Promise<{ valid: boolean, confidence: number, reason: string, provider?: string }>}
 */
async function validatePageMatchesShow(html, showTitle, options = {}) {
  const $ = cheerio.load(html);

  // Extract page title + headings only (not body text)
  const pageTitle = $('title').text() || '';
  const h1Text = $('h1').map((_, el) => $(el).text()).get().join(' ');
  const h2Text = $('h2').first().text() || '';
  const headingText = `${pageTitle} ${h1Text} ${h2Text}`.trim();

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

  // Slug fallback: check if multi-word show slug appears in page title
  // Only for multi-word slugs (contain hyphen) — single-word slugs are too ambiguous
  const showSlug = showTitle.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-').trim();
  if (showSlug.includes('-') && showSlug.length >= 4 && pageTitle.toLowerCase().includes(showSlug)) {
    return { valid: true, confidence: 0.85, reason: 'slug in page title' };
  }

  // Low confidence or borderline — try LLM tiebreaker
  if (!options.skipLlm) {
    const llmResult = await llmValidatePageMatch(headingText, showTitle);

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
  LLM_CONFIDENCE_THRESHOLD,
};
