/**
 * LLM-Based Explicit Score Extractor
 *
 * Extracts explicit critic ratings (stars, letter grades, numeric scores)
 * from review text using Gemini Flash (primary) or OpenAI (fallback).
 *
 * Includes multi-layer validation:
 *   1. JSON-LD fast-path (no LLM needed for machine-readable structured data)
 *   2. LLM extraction with battle-tested prompt
 *   3. Text verification (anti-hallucination)
 *   4. Post-validation (rejects hypotheticals, runtimes, metaphors, etc.)
 *   5. Asterisk count correction (heuristic fix for LLM miscounts)
 *   6. Optional cross-verification with 2nd LLM
 *
 * Usage:
 *   const { extractExplicitScore } = require('./lib/llm-score-extractor');
 *   const result = await extractExplicitScore({ text, html, outletId });
 *   // Returns: { originalScore: "3.5/5 stars", normalizedScore: 70,
 *   //            source: "llm-gemini", raw: "***½ out of four" } | null
 */

const https = require('https');
const path = require('path');
const fs = require('fs');
const { normalizeLlmResult: sharedNormalizeLlmResult, LETTER_GRADES } = require('./score-parsers');
const { GEMINI_FLASH, GPT4O_MINI } = require('./models');

// Lazy-load outlet-registry for starScale lookups. Tests can avoid this by
// passing `opts.starScale` directly to extractExplicitScore.
let _outletRegistryStarScaleCache = null;
function resolveStarScaleFromRegistry(outletId) {
  if (!outletId) return null;
  if (_outletRegistryStarScaleCache === null) {
    try {
      const p = path.join(__dirname, '..', '..', 'data', 'outlet-registry.json');
      _outletRegistryStarScaleCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
      _outletRegistryStarScaleCache = { outlets: {} };
    }
  }
  const entry = _outletRegistryStarScaleCache.outlets[outletId];
  // Guard against bad data: starScale must be positive finite. A 0 or string
  // would silently propagate Infinity/NaN into normalizedScore.
  if (!entry || !Number.isFinite(entry.starScale) || entry.starScale <= 0) return null;
  return entry.starScale;
}

// ============================================================
// LLM Prompt — battle-tested against 450+ reviews
// ============================================================
const SYSTEM_PROMPT = `You are a data extraction assistant. Your job is to determine whether a theater review contains an EXPLICIT critic rating — a formal score the critic or publication assigned to the show being reviewed.

EXPLICIT ratings include:
- Star ratings using asterisks: "***½ out of four stars", "* * * out of four", "(*** 1/2 out of four stars)"
- Star ratings using symbols: ★★★☆☆, ★★★★½
- Numeric star ratings: "3.5/5 stars", "3 out of 5 stars" — denominator must be from the text, NOT inferred
- Letter grades: "Grade: B+", "Rating: A-", "EW Grade: B"
- Numeric scores: "7/10", "8 out of 10", "85/100"

DENOMINATOR RULES — be strict:
- If the rating text shows an explicit denominator (e.g. "/5", "out of four"), use it.
- If the user prompt includes "starScale: N" for this outlet, that is GROUND TRUTH for bare star displays
  (e.g. raw "★★★★" with no empty-star glyphs and no explicit "/4" or "/5"). Use starScale as the denominator.
- DO NOT invent a denominator. If text shows just "4 stars" with no "out of" phrase AND no starScale is provided,
  return {"found": false} rather than guess.

COUNTING ASTERISK STARS — be precise:
- Each * character = 1 star. Count them carefully.
- ½ or 1/2 after the asterisks = add 0.5
- Examples: ** = 2, **½ = 2.5, *** = 3, ***½ = 3.5, **** = 4
- Spaced: * * * = 3, * * * ½ = 3.5, * * * * = 4
- Mixed: * * *½ = 3.5, ** ½ = 2.5

NOT explicit ratings (do NOT extract these):
- Adjective uses of "star" like "five-star knockout", "four-star dining", "a star turn" — these describe quality colloquially, not a formal rating
- HYPOTHETICAL ratings: "If I gave stars, it would get five", "I'd give it an A", "deserves 5 stars" — these are opinions about what a rating WOULD be, not an actual published rating
- Show runtimes: "2-1/2 hours", "runs 90 minutes", "a 3 hour show" — these are durations, not scores
- Aggregator scores or other critics' ratings mentioned in passing
- Audience ratings or box office numbers
- Sentiment words like "recommended" or "critics' pick" (designations, not scores)
- Percentages about capacity, grosses, or Rotten Tomatoes
- The show's own musical score/soundtrack discussion
- Star ratings belonging to OTHER reviews quoted in the text (e.g. "Read John Smith's ★★★★ review")
- Bare single letters that could be article "a" or other words — only extract letter grades with clear context like "Grade:" or "Rating:"

Return ONLY a JSON object (no markdown, no explanation):
- If found: {"found": true, "raw": "<exact text>", "value": <number>, "scale": <number>, "type": "<stars|letter|numeric>"}
  - "raw": the exact substring from the review containing the rating (include "out of four/five" part)
  - "value": the numeric value (e.g. 3.5 for ***½, 83 for B)
  - "scale": the maximum of the scale (e.g. 4, 5, 10, 100)
  - "type": the format category
- If NOT found: {"found": false}`;

// ============================================================
// Text truncation — send full text for <6K, truncate for >6K
// ============================================================
function buildUserPrompt(text, outlet, starScale) {
  let excerpt = text;
  if (text.length > 6000) {
    excerpt = text.substring(0, 2000) + '\n\n[...middle truncated...]\n\n' + text.substring(text.length - 2000);
  }
  // starScale is structured (not English) so it ages better when we swap models.
  const scaleLine = Number.isFinite(starScale) ? `starScale: ${starScale}\n` : '';
  return `Outlet: ${outlet}\n${scaleLine}\nReview text:\n${excerpt}`;
}

// ============================================================
// JSON-LD fast-path — machine-readable structured data, no LLM needed
// ============================================================
function extractFromJsonLd(html, starScale) {
  if (!html) return null;

  const match = html.match(/"ratingValue"\s*:\s*"?(\d+(?:\.\d+)?)"?/i);
  if (!match) return null;

  const rating = parseFloat(match[1]);

  // Determine scale: explicit bestRating from JSON-LD > outlet's starScale > heuristic fallback.
  // The heuristic (rating <= 5 ? 5 : 100) was the bug pre-fix: it could not tell "4 out of 4"
  // from "4 out of 5" when bestRating was missing, silently producing a 100% score on a 4/5 review.
  // Positive-finite guard on starScale prevents 0/NaN/"5" propagating to Infinity in division.
  const scaleMatch = html.match(/"bestRating"\s*:\s*"?(\d+)"?/i);
  const validStarScale = Number.isFinite(starScale) && starScale > 0 ? starScale : null;
  const scale = scaleMatch
    ? parseInt(scaleMatch[1])
    : (validStarScale != null ? validStarScale : (rating <= 5 ? 5 : 100));

  // Reject unreasonable values (including scale=0 if it somehow snuck past)
  if (!Number.isFinite(scale) || scale <= 0) return null;
  if (rating < 1 || rating > scale) return null;
  // TimeOut retired 1-2 star reviews; "1/5" from JSON-LD is typically a guide page
  if (scale === 5 && rating < 2) return null;

  const normalizedScore = scale === 100 ? Math.round(rating) : Math.round((rating / scale) * 100);

  return {
    originalScore: scale <= 10 ? `${rating}/${scale} stars` : `${rating}/${scale}`,
    normalizedScore,
    source: 'json-ld',
    raw: `ratingValue: ${rating}`
  };
}

// ============================================================
// LLM Providers
// ============================================================
function callGemini(systemPrompt, userPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [
      { role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }
    ],
    generationConfig: { temperature: 0.0, maxOutputTokens: 200 }
  });

  return new Promise((resolve, reject) => {
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
        } else if (res.statusCode === 429) {
          reject(new Error('RATE_LIMIT'));
        } else {
          reject(new Error(`Gemini HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function callOpenAI(systemPrompt, userPrompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const body = JSON.stringify({
    model: GPT4O_MINI,
    temperature: 0.0,
    max_tokens: 200,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  });

  return new Promise((resolve, reject) => {
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
        } else if (res.statusCode === 429) {
          reject(new Error('RATE_LIMIT'));
        } else {
          reject(new Error(`OpenAI HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function callLLM(systemPrompt, userPrompt, provider) {
  if (provider === 'openai') return callOpenAI(systemPrompt, userPrompt);
  return callGemini(systemPrompt, userPrompt);
}

async function callLLMWithRetry(systemPrompt, userPrompt, provider) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await callLLM(systemPrompt, userPrompt, provider);
    } catch (e) {
      if (e.message === 'RATE_LIMIT') {
        const wait = (attempt + 1) * 5000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  return null;
}

// ============================================================
// Response parsing
// ============================================================
function parseResponse(text) {
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    if (!obj.found) return null;
    if (typeof obj.value !== 'number' || typeof obj.scale !== 'number') return null;
    if (obj.value < 0 || obj.value > obj.scale) return null;
    if (obj.scale <= 0) return null;
    return obj;
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const obj = JSON.parse(match[0]);
        if (!obj.found) return null;
        if (typeof obj.value !== 'number' || typeof obj.scale !== 'number') return null;
        return obj;
      } catch (_) {}
    }
    return null;
  }
}

// ============================================================
// Validation pipeline
// ============================================================

/**
 * Heuristic: independently count asterisks to catch LLM miscounts.
 */
function validateAsteriskCount(result) {
  if (!result || result.type !== 'stars') return result;
  const raw = result.raw || '';

  const asterisks = (raw.match(/\*/g) || []).length;
  if (asterisks === 0) return result;

  const hasHalf = /½|1\/2/.test(raw);
  const heuristicValue = asterisks + (hasHalf ? 0.5 : 0);

  let heuristicScale = result.scale;
  if (/out of four|of four|\/4/.test(raw)) heuristicScale = 4;
  else if (/out of five|of five|\/5/.test(raw)) heuristicScale = 5;

  if (heuristicValue !== result.value) {
    return { ...result, value: heuristicValue, scale: heuristicScale };
  }

  return result;
}

/**
 * Text verification: confirm the LLM's claimed rating exists in the source text.
 * Catches hallucinations where the LLM invents a rating.
 */
function verifyInText(result, fullText) {
  if (!result || !fullText) return null;
  const ft = fullText;
  const lower = ft.toLowerCase();

  // --- Letter grades ---
  if (result.type === 'letter') {
    const gradeMatch = (result.raw || '').match(/([A-D][+\-–—]?|F)/i);
    if (!gradeMatch) return null;
    const grade = gradeMatch[1].replace(/[–—]/g, '-');

    const escapedGrade = grade.replace('+', '\\+').replace('-', '\\-');
    const dashVariants = grade.endsWith('-')
      ? [escapedGrade, escapedGrade.slice(0, -2) + '[–—]']
      : [escapedGrade];

    // Position 1: First 100 chars (review starts with grade)
    const first100 = ft.slice(0, 100);
    for (const v of dashVariants) {
      if (new RegExp('(^|\\s)' + v + '(\\s|$)', 'm').test(first100)) return result;
    }

    // Position 2: Last 500 chars (grade near end before boilerplate)
    const last500 = ft.slice(-500);
    for (const v of dashVariants) {
      if (new RegExp('[.!?\\n]\\s*' + v + '(\\s|$|\\(|[A-Z])').test(last500)) return result;
      if (new RegExp(v + '\\s*[\\(F]').test(last500)) return result;
      if (new RegExp(v + '\\s*$', 'm').test(last500)) return result;
    }

    // Position 3: "Grade: X" or "Rating: X" anywhere
    for (const v of dashVariants) {
      if (new RegExp('(grade|rating)\\s*:\\s*' + v, 'i').test(ft)) return result;
    }

    return null;
  }

  // --- Star ratings ---
  if (result.type === 'stars') {
    // Restrict star verification to last 500 chars to avoid matching ratings
    // for OTHER shows mentioned in the same article (common in USA Today, EW).
    const last500 = ft.slice(-500);
    const last500Lower = last500.toLowerCase();

    // First: check if the specific X/Y rating appears near end of text (most reliable)
    const slashMatch = (result.raw || '').match(/([\d.½]+)\s*\/\s*(\d+)/);
    if (slashMatch && (last500Lower.includes(slashMatch[1] + '/' + slashMatch[2]) || last500Lower.includes(slashMatch[1] + ' / ' + slashMatch[2]))) return result;

    // Check for "X out of Y" written out near end
    if (last500Lower.includes('out of four') || last500Lower.includes('out of five') || last500Lower.includes('out of 4') || last500Lower.includes('out of 5')) return result;
    if (last500Lower.includes('two and a half') || last500Lower.includes('three and a half') || last500Lower.includes('one and a half') || last500Lower.includes('two and one-half') || last500Lower.includes('three and one-half')) return result;

    // Check for actual star symbols near end (★⭐☆) — require 2+ consecutive to avoid
    // stray unicode. Single * is NOT sufficient (too many false positives from
    // footnotes, markdown, emphasis markers).
    if (/[★⭐]{2,}|[★⭐].*[★⭐☆]|☆/.test(last500)) return result;
    if (/\*{2,}\s*(\/|out of)/i.test(last500)) return result;

    // URL-encoded stars (rare, from HTML scraping artifacts)
    if (last500Lower.includes('%bd') || last500Lower.includes('%2a')) return result;

    return null;
  }

  // --- Numeric ratings ---
  if (result.type === 'numeric') {
    const slashMatch = (result.raw || '').match(/([\d.]+)\s*\/\s*(\d+)/);
    if (slashMatch) {
      if (lower.includes(slashMatch[1] + '/' + slashMatch[2])) return result;
      if (lower.includes(slashMatch[1] + ' / ' + slashMatch[2])) return result;
      if (lower.includes(slashMatch[1] + ' out of ' + slashMatch[2])) return result;
    }
    if (lower.includes('rating:') || lower.includes('score:') || lower.includes('grade:')) {
      const num = String(result.value);
      if (lower.includes(num)) return result;
    }

    return null;
  }

  return result;
}

/**
 * Post-extraction sanity checks to catch LLM false positives.
 */
function postValidate(result) {
  if (!result) return null;
  const raw = (result.raw || '').toLowerCase();

  // Reject hypothetical ratings
  if (/\b(if i gave|i would give|i'd give|would get|deserves?|should get|worthy of)\b/.test(raw)) return null;

  // Reject runtimes misidentified as scores
  if (/\b(hours?|minutes?|mins?|hrs?)\b/.test(raw)) return null;

  // Reject audience/aggregator scores
  if (/\b(user rating|audience|show score|rotten tomatoes|metacritic|average rating)\b/.test(raw)) return null;

  // Reject metaphorical star usage
  if (/\bgold star\b/.test(raw) || /\b\w+-star\s+(meal|restaurant|dining|hotel|resort|service|treatment|performance)\b/.test(raw)) return null;

  // Reject adjectival star uses without formal notation
  if (/\b(one|two|three|four|five|six|seven)-star\b/.test(raw) || /\b(one|two|three|four|five) stars?\b/.test(raw)) {
    if (!/[*★☆]/.test(raw) && !/out of/.test(raw) && !/\/[45]/.test(raw)) return null;
  }

  // Reject bare asterisk ratings without explicit scale
  if (result.type === 'stars' && /\*/.test(raw) && !/out of|\/[45]|\bof (four|five|4|5)\b/.test(raw)) return null;

  // Reject bare single-letter grades without context
  if (result.type === 'letter') {
    const gradeMatch = raw.match(/([a-d][+\-]?|f)/i);
    if (gradeMatch) {
      const grade = gradeMatch[0];
      if (grade.length === 1 && raw.trim().length > 5) {
        // Single letter in a long raw string — require "Grade:" or "Rating:" with colon
        if (!/\b(grade|rating)\s*:/i.test(raw)) return null;
      }
    }
  }

  return result;
}

/**
 * Cross-verify with a second LLM when the result diverges significantly
 * from the existing score (>15 points). Optional — only runs when a
 * second provider key is available and currentScore is provided.
 */
async function crossVerify(result, userPrompt, primaryProvider) {
  const altProvider = primaryProvider === 'gemini' && process.env.OPENAI_API_KEY ? 'openai'
    : primaryProvider === 'openai' && process.env.GEMINI_API_KEY ? 'gemini'
    : null;
  if (!altProvider) return result;

  try {
    const altResponse = await callLLMWithRetry(SYSTEM_PROMPT, userPrompt, altProvider);
    if (!altResponse) return result;

    const altParsed = parseResponse(altResponse);
    if (!altParsed) return null; // Second LLM says no rating — reject

    const altValidated = validateAsteriskCount(altParsed);
    const normalizedPrimary = result.value / result.scale;
    const normalizedAlt = altValidated.value / altValidated.scale;

    if (Math.abs(normalizedPrimary - normalizedAlt) > 0.15) return null; // Disagreement — reject

    return result;
  } catch (e) {
    return result; // Cross-verify failed, keep primary
  }
}

// Score normalization — imported from shared score-parsers.js
function normalizeScore(result) {
  return sharedNormalizeLlmResult(result);
}

// ============================================================
// Main entry point
// ============================================================

/**
 * Extract explicit rating from review content.
 *
 * @param {object} opts
 * @param {string} opts.text - Review fullText
 * @param {string} [opts.html] - Raw HTML (for JSON-LD fast-path)
 * @param {string} [opts.outletId] - Outlet identifier
 * @param {string} [opts.provider] - 'gemini' (default) or 'openai'
 * @param {number} [opts.currentScore] - Existing score for cross-verify threshold
 * @param {boolean} [opts.verbose] - Extra logging
 * @returns {Promise<{originalScore: string, normalizedScore: number, source: string, raw: string} | null>}
 */
async function extractExplicitScore(opts) {
  const { text, html, outletId, verbose } = opts;
  const provider = opts.provider || (process.env.GEMINI_API_KEY ? 'gemini' : 'openai');
  const currentScore = opts.currentScore || null;

  // Resolve outlet's known star scale (when available) once, pass it as
  // ground truth to JSON-LD and LLM paths. Pre-fix: Gemini guessed
  // (The Recs ★★★★ → "4/4 stars" → 100). Post-fix: outlet says "5",
  // bare-star rating normalizes correctly.
  const starScale = opts.starScale != null
    ? opts.starScale
    : resolveStarScaleFromRegistry(outletId);

  // 1. JSON-LD fast-path (free, instant, no LLM)
  if (html) {
    const jsonLdResult = extractFromJsonLd(html, starScale);
    if (jsonLdResult) {
      if (verbose) console.log(`    -> JSON-LD score: ${jsonLdResult.originalScore}`);
      return jsonLdResult;
    }
  }

  // 2. Skip if no meaningful text
  if (!text || text.length < 200) return null;

  // 3. Call LLM
  const userPrompt = buildUserPrompt(text, outletId || '', starScale);
  const responseText = await callLLMWithRetry(SYSTEM_PROMPT, userPrompt, provider);
  if (!responseText) return null;

  // 4. Parse response
  let parsed = parseResponse(responseText);
  if (!parsed) return null;

  // 5. Text verification — confirm the rating exists in source text
  parsed = verifyInText(parsed, text);
  if (!parsed) {
    if (verbose) console.log(`    -> Text verification rejected LLM result`);
    return null;
  }

  // 6. Post-validation — reject hypotheticals, runtimes, etc.
  parsed = postValidate(parsed);
  if (!parsed) {
    if (verbose) console.log(`    -> Post-validation rejected LLM result`);
    return null;
  }

  // 7. Asterisk count correction
  parsed = validateAsteriskCount(parsed);

  // 8. Cross-verify with 2nd LLM when delta > 15 points from current score
  const tentativeNorm = normalizeScore(parsed);
  if (tentativeNorm && currentScore && Math.abs(tentativeNorm.normalizedScore - currentScore) > 15) {
    const verified = await crossVerify(parsed, userPrompt, provider);
    if (!verified) {
      if (verbose) console.log(`    -> Cross-verify rejected: ${tentativeNorm.originalScore} vs current ${currentScore}`);
      return null;
    }
    parsed = verified;
  }

  // 9. Normalize to final output
  const normalized = normalizeScore(parsed);
  if (!normalized) return null;

  return {
    originalScore: normalized.originalScore,
    normalizedScore: normalized.normalizedScore,
    source: `llm-${provider}`,
    raw: normalized.raw
  };
}

module.exports = {
  extractExplicitScore,
  extractFromJsonLd,
  // Export internals for testing
  SYSTEM_PROMPT,
  buildUserPrompt,
  parseResponse,
  validateAsteriskCount,
  verifyInText,
  postValidate,
  crossVerify,
  normalizeScore
};
