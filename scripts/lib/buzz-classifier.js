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
 * Build classification prompt for LLM
 */
function buildPrompt(showTitle, comments, explicit = false) {
  const formatted = comments.map((c, i) =>
    `[${i + 1}] ${c.body.slice(0, 300).replace(/\n/g, ' ')}`
  ).join('\n\n');

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

TARGET SHOW: "${showTitle}"

CONTEXT: These comments are from Reddit threads about "${showTitle}". When a comment says "I saw it" or "the show", it likely refers to "${showTitle}" unless another show is explicitly named.

We want to measure AUDIENCE BUZZ - how theatergoers feel about "${showTitle}" specifically.

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

   IMPORTANT: The person MUST have ALREADY attended/seen the show (past tense). Future tense ("I'm going to see it") or present anticipation ("about to see it") = NOT relevant. If comment discusses a different show BY NAME, mark not relevant. But if it says "I saw it" or "the show" without naming another show, assume it's about "${showTitle}".

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
    generationConfig: { temperature: 0.1 }
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
async function classifyBatch(showTitle, comments, provider = null, retryCount = 0) {
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
  const prompt = buildPrompt(showTitle, comments, retryCount > 0);

  let responseText;
  try {
    responseText = await callLLM(provider, prompt);
  } catch (e) {
    console.warn(`  ${provider} API error: ${e.message}`);
    // Try next provider in chain
    const nextProvider = PROVIDERS[PROVIDERS.indexOf(provider) + 1];
    if (nextProvider) {
      console.log(`  Falling back to ${nextProvider}...`);
      return classifyBatch(showTitle, comments, nextProvider, 0);
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
      return classifyBatch(showTitle, comments, provider, retryCount + 1);
    }
    // Try next provider
    const nextProvider = PROVIDERS[PROVIDERS.indexOf(provider) + 1];
    if (nextProvider) {
      console.log(`  Falling back to ${nextProvider}...`);
      return classifyBatch(showTitle, comments, nextProvider, 0);
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
      return classifyBatch(showTitle, comments, provider, retryCount + 1);
    }
    // Try next provider
    const nextProvider = PROVIDERS[PROVIDERS.indexOf(provider) + 1];
    if (nextProvider) {
      console.log(`  Falling back to ${nextProvider}...`);
      return classifyBatch(showTitle, comments, nextProvider, 0);
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
 * @returns {Promise<Array>} All classifications
 */
async function classifyAllComments(showTitle, comments, batchSize = 150, provider = 'gemini', concurrency = 4) {
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
      group.map(({ batch }) => classifyBatch(showTitle, batch, provider))
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
  parseJsonArray,
  validateClassifications,
  callLLM
};
