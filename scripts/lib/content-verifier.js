/**
 * LLM-Based Content Verification
 *
 * Primary content gate for scraped review texts. Runs by default on all
 * reviews with 200+ chars. Detects:
 *   1. Wrong article (different topic, different show entirely)
 *   2. Wrong production (tour, regional, off-Broadway, West End — not Broadway)
 *   3. Film/TV content (movie adaptation, streaming, TV special)
 *   4. Truncation (paywall, incomplete content)
 *   5. Navigation/junk (scraped footer instead of article)
 *
 * Provider chain: Gemini Flash (cheapest) → GPT-4o-mini → Claude Sonnet → heuristic fallback
 * Falls back to heuristic checks when no API keys are available.
 */

const https = require('https');

// ============================================================
// LLM Provider Implementations (cheapest → most expensive)
// ============================================================

/**
 * Call Gemini Flash — ~$0.0001/review (practically free)
 */
function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 400 }
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
    req.write(body);
    req.end();
  });
}

/**
 * Call OpenAI GPT-4o-mini — ~$0.0003/review
 */
function callOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
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
    req.write(body);
    req.end();
  });
}

/**
 * Call Claude Sonnet — ~$0.003/review (most expensive, last resort)
 */
function callClaude(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }]
    });

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
            resolve(json.content?.[0]?.text || '');
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

// ============================================================
// Provider Chain
// ============================================================

/** Get available providers in order of preference (cheapest first) */
function getProviderChain() {
  const providers = [];
  if (process.env.GEMINI_API_KEY) providers.push({ name: 'gemini', call: callGemini });
  if (process.env.OPENAI_API_KEY) providers.push({ name: 'openai', call: callOpenAI });
  if (process.env.ANTHROPIC_API_KEY) providers.push({ name: 'claude', call: callClaude });
  return providers;
}

/**
 * Call LLM with automatic fallback through provider chain
 * @returns {{ text: string, provider: string }}
 */
async function callWithFallback(prompt) {
  const chain = getProviderChain();
  if (chain.length === 0) return null;

  for (let i = 0; i < chain.length; i++) {
    const { name, call } = chain[i];
    try {
      const text = await call(prompt);
      return { text, provider: name };
    } catch (e) {
      console.log(`    ${name} verify error: ${e.message}`);
      if (i < chain.length - 1) {
        console.log(`    Falling back to ${chain[i + 1].name}...`);
      }
    }
  }

  return null; // All providers failed
}

// ============================================================
// Main Verification
// ============================================================

/**
 * Verify scraped content matches expected review for the correct market
 *
 * @param {Object} params
 * @param {string} params.scrapedText - The scraped full text
 * @param {string} params.excerpt - Known excerpt from aggregator
 * @param {string} params.showTitle - Show title for context
 * @param {string} params.outletName - Outlet name
 * @param {string} params.criticName - Critic name
 * @param {string} [params.openingDate] - Opening date (YYYY-MM-DD) for temporal context
 * @param {string} [params.venue] - Venue name
 * @param {string} [params.market] - Market: 'broadway' (default), 'west-end', 'off-broadway'
 * @returns {Object} { isValid, confidence, issues, truncated, wrongArticle, wrongProduction, isFilmTv, reasoning, verifiedBy }
 */
async function verifyContent({ scrapedText, excerpt, showTitle, outletName, criticName, openingDate, venue, market }) {
  if (!scrapedText || scrapedText.length < 200) {
    return {
      isValid: false,
      confidence: 'high',
      issues: ['Content too short (<200 chars)'],
      truncated: true,
      wrongArticle: false,
      wrongProduction: false,
      isFilmTv: false,
      verifiedBy: 'skip-short'
    };
  }

  // Market-aware prompt construction
  const effectiveMarket = market || 'broadway';
  const marketConfig = {
    'broadway': {
      label: 'Broadway',
      description: 'shows performed in Broadway theaters in New York City',
      dateLabel: 'Broadway opening date',
      venueLabel: 'Broadway venue',
      wrongProdExamples: [
        'National tour, touring production, touring company, "on tour"',
        'Regional theater (Ahmanson, Kennedy Center, Old Globe, Goodman, etc.)',
        'Off-Broadway or Off-Off-Broadway venue',
        'West End / London production',
        'Pre-Broadway tryout or out-of-town engagement'
      ]
    },
    'west-end': {
      label: 'West End',
      description: 'shows performed in West End theaters in London',
      dateLabel: 'West End opening date',
      venueLabel: 'West End venue',
      wrongProdExamples: [
        'UK touring production, "on tour"',
        'Regional UK theater (not a West End venue)',
        'Broadway / New York production',
        'Edinburgh Fringe or other festival',
        'Pre-West End tryout or transfer preview'
      ]
    },
    'off-broadway': {
      label: 'Off-Broadway',
      description: 'shows performed in Off-Broadway theaters in New York City',
      dateLabel: 'Off-Broadway opening date',
      venueLabel: 'Off-Broadway venue',
      wrongProdExamples: [
        'Broadway production (different from Off-Broadway run)',
        'National tour, touring production',
        'Regional theater production',
        'West End / London production'
      ]
    }
  };
  const mc = marketConfig[effectiveMarket] || marketConfig['broadway'];

  const dateContext = openingDate ? `\n- ${mc.dateLabel}: ${openingDate}` : '';
  const venueContext = venue ? `\n- ${mc.venueLabel}: ${venue}` : '';
  const excerptContext = excerpt ? `\n- Known excerpt: "${excerpt.substring(0, 300)}"` : '';

  const wrongProdList = mc.wrongProdExamples.map(e => `   - ${e}`).join('\n');

  const prompt = `You are a content verification assistant for a theater review aggregator. We are verifying reviews of **${mc.label}** productions (${mc.description}).

I scraped what should be a ${mc.label} theater review. Verify if the content is valid.

**Expected Review:**
- Show: "${showTitle}"
- Market: ${mc.label}
- Outlet: ${outletName}
- Critic: ${criticName || 'Unknown'}${dateContext}${venueContext}${excerptContext}

**Scraped Content (first 2500 chars):**
${scrapedText.substring(0, 2500)}

**Total scraped length:** ${scrapedText.length} characters

Analyze the content and respond with ONLY valid JSON (no markdown fences):
{
  "isValid": true/false,
  "confidence": "high"/"medium"/"low",
  "wrongArticle": true/false,
  "wrongProduction": true/false,
  "isFilmTv": true/false,
  "truncated": true/false,
  "issues": ["list of issues found"],
  "reasoning": "1-2 sentence explanation"
}

**Check these specific things:**

1. **Wrong article**: Is this about a completely different show, or not a theater review at all (news article, obituary, listicle, etc.)?

2. **Wrong production** (IMPORTANT): Is this reviewing a NON-${mc.label} production of "${showTitle}"? Red flags:
${wrongProdList}
   A review of the ${mc.label} production that merely *mentions* other productions is NOT a wrong production — it must be *reviewing* a non-${mc.label} staging.

3. **Film/TV content**: Is this a review of a film adaptation, TV special, streaming version, or filmed stage production (not a live ${mc.label} performance)?

4. **Truncation**: Does the text end mid-sentence, hit a paywall ("subscribe to read more"), or appear incomplete?

5. **Junk content**: Is this mostly navigation, footer, cookie notices, or non-article content?

Set isValid=true only if the content is a review of the ${mc.label} production and is not truncated/junk.`;

  const result = await callWithFallback(prompt);

  if (!result) {
    // No LLM providers available — fall back to heuristics
    return heuristicVerify({ scrapedText, excerpt, showTitle });
  }

  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        isValid: parsed.isValid ?? true,
        confidence: parsed.confidence || 'medium',
        issues: parsed.issues || [],
        truncated: parsed.truncated || false,
        wrongArticle: parsed.wrongArticle || false,
        wrongProduction: parsed.wrongProduction || false,
        isFilmTv: parsed.isFilmTv || false,
        reasoning: parsed.reasoning || '',
        verifiedBy: `llm:${result.provider}`
      };
    }

    console.log(`    LLM verify (${result.provider}): could not parse JSON, falling back to heuristic`);
    return heuristicVerify({ scrapedText, excerpt, showTitle });

  } catch (error) {
    console.error(`    LLM verify parse error: ${error.message}`);
    return heuristicVerify({ scrapedText, excerpt, showTitle });
  }
}

// ============================================================
// Heuristic Fallback
// ============================================================

/**
 * Heuristic-based content verification (no API needed)
 * Used as fallback when all LLM providers are unavailable
 */
function heuristicVerify({ scrapedText, excerpt, showTitle }) {
  const issues = [];
  let truncated = false;
  let wrongArticle = false;

  if (!scrapedText) {
    return {
      isValid: false,
      confidence: 'high',
      issues: ['No content'],
      truncated: true,
      wrongArticle: false,
      wrongProduction: false,
      isFilmTv: false,
      verifiedBy: 'heuristic'
    };
  }

  const text = scrapedText.toLowerCase();
  const showLower = (showTitle || '').toLowerCase();

  // Check if show title appears in text
  const showMentioned = showLower && (
    text.includes(showLower) ||
    text.includes(showLower.replace(/[^a-z0-9]/g, ''))
  );

  if (!showMentioned && showTitle && showTitle.length > 3) {
    issues.push(`Show title "${showTitle}" not found in content`);
    wrongArticle = true;
  }

  // Check for truncation signals
  const truncationSignals = [
    'subscribe to', 'sign in to', 'create an account', 'members only',
    'continue reading', 'read more', 'premium content', 'paywall',
    'already a subscriber', 'log in to continue'
  ];

  for (const signal of truncationSignals) {
    if (text.includes(signal)) {
      issues.push(`Truncation signal: "${signal}"`);
      truncated = true;
    }
  }

  // Check if ends mid-sentence
  const trimmed = scrapedText.trim();
  const lastChar = trimmed.slice(-1);
  if (!['.', '!', '?', '"', "'", ')'].includes(lastChar)) {
    issues.push('Content may be truncated (does not end with punctuation)');
    truncated = true;
  }

  // Check excerpt match (if provided)
  if (excerpt && excerpt.length > 50) {
    const excerptNorm = excerpt.toLowerCase().replace(/[^a-z0-9\s]/g, '').substring(0, 100);
    const textNorm = text.replace(/[^a-z0-9\s]/g, '');
    const excerptWords = excerptNorm.split(/\s+/).filter(w => w.length > 4);
    const matchingWords = excerptWords.filter(w => textNorm.includes(w));
    const matchRate = matchingWords.length / excerptWords.length;

    if (matchRate < 0.3 && excerptWords.length > 5) {
      issues.push(`Low excerpt match rate: ${(matchRate * 100).toFixed(0)}%`);
      wrongArticle = true;
    }
  }

  // Check for navigation/junk content
  const junkSignals = [
    'privacy policy', 'terms of use', 'cookie policy', 'all rights reserved',
    'advertisement', 'sponsored content', 'related articles'
  ];

  let junkCount = 0;
  for (const signal of junkSignals) {
    if (text.includes(signal)) junkCount++;
  }

  if (junkCount >= 3) {
    issues.push('Content appears to be mostly navigation/footer junk');
  }

  const isValid = !wrongArticle && issues.length <= 1;

  return {
    isValid,
    confidence: issues.length === 0 ? 'high' : issues.length <= 2 ? 'medium' : 'low',
    issues,
    truncated,
    wrongArticle,
    wrongProduction: false, // Heuristics can't reliably detect this
    isFilmTv: false, // Heuristics can't reliably detect this
    verifiedBy: 'heuristic'
  };
}

/**
 * Quick check if content is likely a valid review (fast, no API)
 */
function quickValidityCheck(text, showTitle) {
  if (!text || text.length < 300) return false;

  const lower = text.toLowerCase();

  const theaterWords = ['broadway', 'theater', 'theatre', 'musical', 'stage', 'performance', 'actor', 'cast', 'director'];
  const hasTheaterContent = theaterWords.some(w => lower.includes(w));

  const showMentioned = !showTitle || lower.includes(showTitle.toLowerCase());

  const junkRatio = (lower.match(/privacy|terms|cookie|subscribe|sign in/g) || []).length;

  return hasTheaterContent && showMentioned && junkRatio < 3;
}

module.exports = {
  verifyContent,
  heuristicVerify,
  quickValidityCheck
};
