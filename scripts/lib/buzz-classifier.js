/**
 * Buzz Classifier Module
 *
 * Uses LLMs to classify Reddit comments for Broadway show sentiment.
 * Primary: Gemini Flash (cheap), Fallback: GPT-4o-mini, Final: Claude Sonnet
 *
 * Features:
 * - Zod schema validation on all responses
 * - Automatic retry with explicit schema on validation failure
 * - Fallback chain across providers
 *
 * Usage:
 *   const { classifyBatch } = require('./buzz-classifier');
 *   const results = await classifyBatch('Wicked', comments);
 */

const https = require('https');
const { GEMINI_FLASH, GPT4O_MINI, CLAUDE_SONNET, KIMI } = require('./models');

// Zod-like schema validation (inline to avoid dependency)
const VALID_SENTIMENTS = ['enthusiastic', 'positive', 'mixed', 'negative', 'neutral'];

// Map common LLM synonym responses to valid sentiment values
const SENTIMENT_ALIASES = {
  'amazing': 'enthusiastic', 'incredible': 'enthusiastic', 'fantastic': 'enthusiastic',
  'great': 'positive', 'good': 'positive', 'favorable': 'positive', 'loved': 'enthusiastic',
  'okay': 'mixed', 'mediocre': 'mixed', 'meh': 'mixed', 'decent': 'mixed',
  'bad': 'negative', 'terrible': 'negative', 'awful': 'negative', 'hated': 'negative',
  'poor': 'negative', 'disappointing': 'negative',
  'indifferent': 'neutral', 'bland': 'neutral'
};

function normalizeSentiment(sentiment) {
  if (!sentiment) return sentiment;
  const lower = sentiment.toLowerCase().trim();
  return SENTIMENT_ALIASES[lower] || lower;
}

function validateClassification(item) {
  if (typeof item !== 'object' || item === null) return false;
  if (typeof item.id !== 'number') return false;
  if (typeof item.is_relevant !== 'boolean') return false;
  if (item.is_relevant && item.sentiment) {
    // Normalize before validating (maps "amazing"→"enthusiastic", etc.)
    item.sentiment = normalizeSentiment(item.sentiment);
    if (!VALID_SENTIMENTS.includes(item.sentiment)) {
      return false;
    }
  }
  return true;
}

function validateClassifications(arr) {
  if (!Array.isArray(arr)) return { success: false, error: 'Not an array' };
  for (let i = 0; i < arr.length; i++) {
    if (!validateClassification(arr[i])) {
      return { success: false, error: `Invalid item at index ${i}: ${JSON.stringify(arr[i])}` };
    }
  }
  return { success: true, data: arr };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Human-readable "TARGET PRODUCTION" descriptor from the show context. Gives the
 * classifier the anchors (venue, market, type, run window) it needs to tell a
 * comment about THIS staging from an unrelated work that merely shares the name.
 */
function buildProductionDescriptor(showTitle, showContext) {
  if (!showContext) return `"${showTitle}"`;
  const parts = [];
  const type = (showContext.type || '').toLowerCase();
  const typeLabel = type === 'opera' ? 'opera'
    : type === 'musical' ? 'musical'
    : type === 'play' ? 'play'
    : 'stage production';
  const market = showContext.market || showContext.marketName || '';
  const marketPhrase = market === 'West End' ? 'in the West End'
    : market === 'Broadway' ? 'on Broadway'
    : market === 'Off-Broadway' ? 'Off-Broadway in New York'
    : market ? `at ${market}` : '';
  let lead = `the ${typeLabel}`;
  if (marketPhrase) lead += ` playing ${marketPhrase}`;
  parts.push(lead);
  if (showContext.venue) parts.push(`at ${showContext.venue}`);
  const opened = (showContext.openingDate || '').slice(0, 4);
  const closed = (showContext.closingDate || '').slice(0, 4);
  if (opened) parts.push(closed && closed !== opened ? `(${opened}–${closed})` : `(opened ${opened})`);
  return `"${showTitle}" — ${parts.join(', ')}`;
}

/**
 * Build classification prompt for LLM.
 *
 * @param {string} showTitle
 * @param {Array}  comments   each may carry a `postTitle` (the Reddit thread it
 *                            came from). When present it is shown to the model and
 *                            the production-reference gate applies; when absent
 *                            (e.g. golden-fixture cases) the model falls back to the
 *                            legacy "assume the thread is about the target" behavior
 *                            so eval fixtures are unaffected.
 * @param {boolean} explicit  emit the strict-schema note (retry path)
 * @param {object|null} showContext {venue, market, type, openingDate, closingDate}
 */
function buildPrompt(showTitle, comments, explicit = false, showContext = null) {
  const anyPostTitles = comments.some(c => c && c.postTitle);
  const formatted = comments.map((c, i) => {
    const body = c.body.slice(0, 300).replace(/\n/g, ' ');
    // Prefix each comment with the thread it was posted under, so the model can
    // judge whether the thread is actually about the target production.
    const thread = c.postTitle ? `(in Reddit thread titled: "${String(c.postTitle).slice(0, 160).replace(/\n/g, ' ')}") ` : '';
    return `[${i + 1}] ${thread}${body}`;
  }).join('\n\n');

  const productionDescriptor = buildProductionDescriptor(showTitle, showContext);

  // Production-reference gate. Only meaningful when the comments carry thread
  // titles — that's the signal that distinguishes an on-topic staging thread from
  // a novel/film/common-phrase collision. Without thread titles we preserve the
  // legacy assume-target default so hand-labeled fixtures (bodies only) still pass.
  const productionGate = anyPostTitles ? `
CRITICAL — MATCH THE PRODUCTION, NOT JUST THE NAME:
Each comment is shown with the title of the Reddit thread it was posted under. Use
that thread title to decide whether the comment is really about ${productionDescriptor}.
   - If the thread title is about a DIFFERENT subject that merely shares words with
     the show's name — a novel, a film/TV adaptation, a city or place, a common
     phrase, a person, or a DIFFERENT production/revival/tour — mark the comment NOT
     relevant, EVEN IF it says "I saw it", "I loved it", or "the show was great".
     A name collision is not evidence the person saw THIS production.
   - MULTI-SHOW / ROUNDUP THREADS: if the thread title is a general theatre thread
     that is NOT specifically about "${showTitle}" — e.g. a list of many shows, a
     "what did you see / what should I see" thread, a season roundup, a first-preview
     or awards thread, or a thread named after a DIFFERENT show — then the thread is
     NOT evidence for "${showTitle}". A comment there counts ONLY if it EXPLICITLY
     names or unmistakably describes seeing "${showTitle}". Ambiguous "I saw it" / "the
     show was great" in such a thread is NOT relevant (it is almost certainly about a
     different show being discussed).
   - Any comment that names or is clearly about a DIFFERENT show is NOT relevant, no
     matter what thread it is in.
   - Treat an ambiguous "I saw it" / "the show" as referring to "${showTitle}" ONLY
     when the thread title is clearly about "${showTitle}" as this staged production
     (it names the show, its venue, or its market). Otherwise require the comment
     itself to name "${showTitle}".
   - If a comment gives NO thread title, assume the thread is about "${showTitle}".
` : '';

  const schemaNote = explicit ? `
IMPORTANT: You MUST respond with ONLY a JSON array. No other text.
Each object MUST have exactly these fields:
- "id": number (1-indexed position)
- "is_relevant": boolean (true or false, not string)
- "sentiment": string (ONLY if is_relevant is true, must be one of: "enthusiastic", "positive", "mixed", "negative", "neutral")

Example response:
[{"id": 1, "is_relevant": true, "sentiment": "positive"}, {"id": 2, "is_relevant": false}]
` : '';

  return `Classify each Reddit comment to determine if it's an AUDIENCE REACTION to seeing "${showTitle}".

TARGET PRODUCTION: ${productionDescriptor}

CONTEXT: These comments were pulled from Reddit by searching for "${showTitle}", but a title search also catches threads about unrelated works that share the name. We want to measure AUDIENCE BUZZ — how theatergoers feel about seeing this specific production.
${productionGate}

For each comment, determine:
1. is_relevant: Is this comment an AUDIENCE REACTION to seeing "${showTitle}"?

   ✓ YES - Mark relevant if the comment is about seeing/watching "${showTitle}":
   - "I saw it and loved it" (in context, "it" means ${showTitle})
   - "We saw it in May and felt underwhelmed"
   - "I saw ${showTitle} last week"
   - "The show was incredible"
   - "I was not blown away"
   - "Totally lived up to the hype"
   - Sharing personal experience of watching the show

   ✗ NO - Mark NOT relevant if:
   - The person has NOT actually seen the show yet — e.g., "I refuse to see it", "I won't go", "I've heard it's bad", "planning to see it", "I'm about to see it", "seeing it tonight", "going tomorrow", "can't wait to see it"
   - Boycott or protest sentiment about the show's creators, source material author, or associated artists — not a review of the production itself
   - Opinions about source material (book, film, original artist) rather than the theatrical production — e.g., "the book was terrible" or "I don't support the author"
   - Comment is about a DIFFERENT show by name - e.g., "I saw Hamilton..." or "Book of Mormon was better"
   - Industry talk: injuries, cast contracts, working conditions, backstage drama, closing notices
   - Technical theater: stage rakes, set measurements, lighting rigs, costumes, props
   - Meta discussion: ticket prices, lottery, seating, scheduling
   - Venue/logistics: stage door experience, usher behavior, concessions, bathrooms, crowd behavior, accessibility — these are about the venue, not the show
   - Just mentions "${showTitle}" in passing without an audience opinion

   IMPORTANT: The person MUST have ALREADY attended/seen the show (past tense). Future tense ("I'm going to see it") or present anticipation ("about to see it") = NOT relevant. If comment discusses a different show BY NAME, mark not relevant. For an ambiguous "I saw it" / "the show" that names no other show, resolve it using the thread title per the MATCH THE PRODUCTION rule above (assume "${showTitle}" only when the thread is about this production; when no thread title is given, assume "${showTitle}").

2. sentiment (only if is_relevant is true):
   - enthusiastic: Strong positive - superlatives like amazing, incredible, best, 10/10, life-changing, cried happy tears, "blown away"
   - positive: Liked it - enjoyed, good, fun, recommend, worth seeing, glad I went. Also: sharing a highlight moment, describing participation in interactive elements, or any implied enjoyment
   - mixed: Explicitly mentions BOTH good AND bad aspects in the SAME comment — e.g., "loved the performances but the story didn't work"
   - negative: Disappointed, boring, not worth it, wouldn't recommend, waste of money, walked out, regretted going
   - neutral: ONLY for purely factual statements with absolutely zero sentiment (extremely rare — almost every audience reaction has some sentiment)

   POSITIVE SIGNALS — do NOT mark these neutral:
   - "Saw it twice" / "going back" / "taking my mom" → positive (they wouldn't return if they didn't like it)
   - Sharing a specific moment they enjoyed or found moving → positive or enthusiastic
   - Describing participation in interactive elements (chosen by performer, brought on stage) → positive (this is a highlight)
   - Answering "should I see it?" affirmatively → positive
   - Sharing the experience without complaint → positive (people don't share neutral experiences)

   If you're unsure between neutral and positive, choose positive. Neutral should be <5% of relevant comments.
${schemaNote}
Comments to classify:
${formatted}

Respond with a JSON array: [{"id": 1, "is_relevant": true, "sentiment": "positive"}, ...]`;
}

/**
 * Call Gemini Flash API
 */
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH}:generateContent?key=${apiKey}`;

  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, thinkingConfig: { thinkingBudget: 0 } }
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

/**
 * Call OpenAI API (GPT-4o-mini)
 */
async function callOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const body = JSON.stringify({
    model: GPT4O_MINI,
    temperature: 0.1,
    messages: [{ role: 'user', content: prompt }]
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
            const text = json.choices?.[0]?.message?.content || '';
            resolve(text);
          } catch (e) {
            reject(new Error(`OpenAI parse error: ${e.message}`));
          }
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

/**
 * Call Kimi K2.5 via OpenRouter API
 */
async function callKimi(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  const body = JSON.stringify({
    model: KIMI,
    temperature: 0.1,
    messages: [{ role: 'user', content: prompt }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://broadwayscorecard.com',
        'X-Title': 'Broadway Scorecard Reddit Buzz'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            const text = json.choices?.[0]?.message?.content || '';
            resolve(text);
          } catch (e) {
            reject(new Error(`Kimi parse error: ${e.message}`));
          }
        } else {
          reject(new Error(`Kimi HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Call Anthropic API (Claude Sonnet)
 */
async function callClaude(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const body = JSON.stringify({
    model: CLAUDE_SONNET,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            const text = json.content?.[0]?.text || '';
            resolve(text);
          } catch (e) {
            reject(new Error(`Claude parse error: ${e.message}`));
          }
        } else {
          reject(new Error(`Claude HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Call LLM by provider name
 */
async function callLLM(provider, prompt) {
  switch (provider) {
    case 'kimi': return callKimi(prompt);
    case 'gemini': return callGemini(prompt);
    case 'openai': return callOpenAI(prompt);
    case 'claude': return callClaude(prompt);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Parse JSON array from LLM response text
 */
function parseJsonArray(text) {
  // Try to find JSON array in response
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;

  try {
    // Clean up common issues
    let cleaned = match[0]
      .replace(/,\s*]/g, ']')       // Remove trailing commas before ]
      .replace(/,\s*}/g, '}')       // Remove trailing commas before }
      .replace(/}\s*{/g, '},{')     // Fix missing commas between objects
      .replace(/'/g, '"');          // Replace single quotes with double

    return JSON.parse(cleaned);
  } catch (e) {
    // Try to extract individual objects as fallback
    const objMatches = [...match[0].matchAll(/\{[^{}]*\}/g)];
    const objects = [];
    for (const m of objMatches) {
      try {
        objects.push(JSON.parse(m[0].replace(/'/g, '"')));
      } catch (_) { /* skip malformed */ }
    }
    return objects.length > 0 ? objects : null;
  }
}

/**
 * Get default provider based on available API keys
 * Kimi is primary (best quality), then Gemini (cheapest), then OpenAI, then Claude
 */
function getDefaultProvider() {
  if (process.env.OPENROUTER_API_KEY) return 'kimi';  // Kimi via OpenRouter
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  throw new Error('No LLM API key available');
}

/**
 * Classify a batch of comments using LLM
 *
 * @param {string} showTitle - Name of the Broadway show
 * @param {Array} comments - Array of { body, score } objects
 * @param {string} provider - 'kimi' | 'gemini' | 'openai' | 'claude'
 * @param {number} retryCount - Internal retry counter
 * @returns {Promise<Array>} Array of { id, is_relevant, sentiment? } objects
 */
async function classifyBatch(showTitle, comments, provider = null, retryCount = 0, showContext = null) {
  if (!provider) provider = getDefaultProvider();

  const MAX_RETRIES = 2;
  const PROVIDERS = ['kimi', 'gemini', 'openai', 'claude'].filter(p => {
    if (p === 'kimi') return !!process.env.OPENROUTER_API_KEY;
    if (p === 'gemini') return !!process.env.GEMINI_API_KEY;
    if (p === 'openai') return !!process.env.OPENAI_API_KEY;
    if (p === 'claude') return !!process.env.ANTHROPIC_API_KEY;
    return false;
  });

  // Build prompt (explicit schema on retry)
  const prompt = buildPrompt(showTitle, comments, retryCount > 0, showContext);

  let responseText;
  try {
    responseText = await callLLM(provider, prompt);
  } catch (e) {
    console.warn(`  ${provider} API error: ${e.message}`);
    // Try next provider in chain
    const nextProvider = PROVIDERS[PROVIDERS.indexOf(provider) + 1];
    if (nextProvider) {
      console.log(`  Falling back to ${nextProvider}...`);
      return classifyBatch(showTitle, comments, nextProvider, 0, showContext);
    }
    throw e;
  }

  // Parse JSON from response
  const parsed = parseJsonArray(responseText);
  if (!parsed) {
    console.warn(`  No valid JSON array in ${provider} response`);
    if (retryCount < MAX_RETRIES) {
      console.log(`  Retrying with explicit schema (attempt ${retryCount + 1})...`);
      await sleep(1000);
      return classifyBatch(showTitle, comments, provider, retryCount + 1, showContext);
    }
    // Try next provider
    const nextProvider = PROVIDERS[PROVIDERS.indexOf(provider) + 1];
    if (nextProvider) {
      console.log(`  Falling back to ${nextProvider}...`);
      return classifyBatch(showTitle, comments, nextProvider, 0, showContext);
    }
    // Return empty array as last resort
    console.warn(`  All providers failed, returning empty classifications`);
    return [];
  }

  // Validate schema
  const validation = validateClassifications(parsed);
  if (!validation.success) {
    console.warn(`  Schema validation failed: ${validation.error}`);
    if (retryCount < MAX_RETRIES) {
      console.log(`  Retrying with explicit schema (attempt ${retryCount + 1})...`);
      await sleep(1000);
      return classifyBatch(showTitle, comments, provider, retryCount + 1, showContext);
    }
    // Try next provider
    const nextProvider = PROVIDERS[PROVIDERS.indexOf(provider) + 1];
    if (nextProvider) {
      console.log(`  Falling back to ${nextProvider}...`);
      return classifyBatch(showTitle, comments, nextProvider, 0, showContext);
    }
    // Return what we have, filtering invalid items
    return parsed.filter(validateClassification);
  }

  return validation.data;
}

/**
 * Classify comments in batches
 *
 * @param {string} showTitle - Name of the Broadway show
 * @param {Array} comments - All comments to classify
 * @param {number} batchSize - Comments per LLM call (default 50)
 * @param {string} provider - Starting provider (default 'gemini')
 * @param {number} concurrency - Parallel LLM calls
 * @param {object|null} showContext - {venue, market, type, openingDate, closingDate}
 *   for the production-reference gate. Each comment may also carry a `postTitle`.
 * @returns {Promise<Array>} All classifications
 */
async function classifyAllComments(showTitle, comments, batchSize = 150, provider = 'gemini', concurrency = 4, showContext = null) {
  const allClassifications = [];

  // Create all batch definitions
  const batchDefs = [];
  for (let i = 0; i < comments.length; i += batchSize) {
    batchDefs.push({ start: i, batch: comments.slice(i, i + batchSize) });
  }

  // Process in groups of `concurrency` (parallel LLM calls)
  for (let g = 0; g < batchDefs.length; g += concurrency) {
    const group = batchDefs.slice(g, g + concurrency);

    const results = await Promise.all(
      group.map(({ batch }) => classifyBatch(showTitle, batch, provider, 0, showContext))
    );

    // Map results back to original comments
    for (let k = 0; k < results.length; k++) {
      const batch = group[k].batch;
      const batchResults = results[k];
      for (let j = 0; j < batchResults.length && j < batch.length; j++) {
        allClassifications.push({
          ...batchResults[j],
          comment: batch[j],
          upvotes: batch[j].score
        });
      }
    }

    // Log progress
    const classified = Math.min((g + group.length) * batchSize, comments.length);
    console.log(`    Classified ${classified}/${comments.length} comments...`);

    // Brief pause between groups
    if (g + concurrency < batchDefs.length) {
      await sleep(200);
    }
  }

  return allClassifications;
}

module.exports = {
  classifyBatch,
  classifyAllComments,
  // Expose for testing
  buildPrompt,
  buildProductionDescriptor,
  parseJsonArray,
  validateClassifications,
  callLLM
};
