/**
 * LLM-Based Content Verification
 *
 * Uses Claude/OpenAI to verify scraped content quality:
 * 1. Matches expected review (compare to excerpt)
 * 2. Detects wrong article (different topic scraped)
 * 3. Detects truncation (paywall/incomplete content)
 */

const Anthropic = require('@anthropic-ai/sdk').default;

let anthropic = null;

function initClient() {
  if (!anthropic && process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic();
  }
  return anthropic;
}

/**
 * Verify scraped content matches expected review
 *
 * @param {Object} params
 * @param {string} params.scrapedText - The scraped full text
 * @param {string} params.excerpt - Known excerpt from aggregator
 * @param {string} params.showTitle - Show title for context
 * @param {string} params.outletName - Outlet name
 * @param {string} params.criticName - Critic name
 * @returns {Object} { isValid, confidence, issues, truncated, wrongArticle }
 */
async function verifyContent({ scrapedText, excerpt, showTitle, outletName, criticName }) {
  const client = initClient();

  if (!client) {
    // No API key - fall back to heuristic checks
    return heuristicVerify({ scrapedText, excerpt, showTitle });
  }

  if (!scrapedText || scrapedText.length < 200) {
    return {
      isValid: false,
      confidence: 'high',
      issues: ['Content too short (<200 chars)'],
      truncated: true,
      wrongArticle: false
    };
  }

  const prompt = `You are a content verification assistant for a Broadway review aggregator.

I scraped what should be a theater review. Verify if the content is valid.

**Expected Review:**
- Show: "${showTitle}"
- Outlet: ${outletName}
- Critic: ${criticName || 'Unknown'}
- Known excerpt: "${excerpt || 'No excerpt available'}"

**Scraped Content (first 2000 chars):**
${scrapedText.substring(0, 2000)}

**Scraped Content Length:** ${scrapedText.length} characters

Analyze and respond with JSON only:
{
  "isValid": true/false,
  "confidence": "high"/"medium"/"low",
  "issues": ["list of issues found"],
  "truncated": true/false,
  "wrongArticle": true/false,
  "reasoning": "brief explanation"
}

Check for:
1. Does the content discuss "${showTitle}" (the Broadway show)?
2. If excerpt provided, does the scraped text contain similar content/phrases?
3. Is the content truncated (ends mid-sentence, has paywall text, "subscribe to read more")?
4. Is this a different article (movie review, news article, different show)?
5. Is this navigation/footer junk instead of actual review content?

Respond ONLY with valid JSON.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0].text;

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        isValid: result.isValid,
        confidence: result.confidence || 'medium',
        issues: result.issues || [],
        truncated: result.truncated || false,
        wrongArticle: result.wrongArticle || false,
        reasoning: result.reasoning || '',
        verifiedBy: 'llm'
      };
    }

    // Couldn't parse - fall back to heuristics
    return heuristicVerify({ scrapedText, excerpt, showTitle });

  } catch (error) {
    console.error(`    LLM verification error: ${error.message}`);
    // Fall back to heuristics on error
    return heuristicVerify({ scrapedText, excerpt, showTitle });
  }
}

/**
 * Heuristic-based content verification (no API needed)
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
    // Normalize both texts
    const excerptNorm = excerpt.toLowerCase().replace(/[^a-z0-9\s]/g, '').substring(0, 100);
    const textNorm = text.replace(/[^a-z0-9\s]/g, '');

    // Check if key phrases from excerpt appear in text
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

  // Determine overall validity
  const isValid = !wrongArticle && issues.length <= 1;

  return {
    isValid,
    confidence: issues.length === 0 ? 'high' : issues.length <= 2 ? 'medium' : 'low',
    issues,
    truncated,
    wrongArticle,
    verifiedBy: 'heuristic'
  };
}

/**
 * Quick check if content is likely a valid review (fast, no API)
 */
function quickValidityCheck(text, showTitle) {
  if (!text || text.length < 300) return false;

  const lower = text.toLowerCase();

  // Must contain some theater-related words
  const theaterWords = ['broadway', 'theater', 'theatre', 'musical', 'stage', 'performance', 'actor', 'cast', 'director'];
  const hasTheaterContent = theaterWords.some(w => lower.includes(w));

  // Should mention the show (if we know the title)
  const showMentioned = !showTitle || lower.includes(showTitle.toLowerCase());

  // Should not be mostly junk
  const junkRatio = (lower.match(/privacy|terms|cookie|subscribe|sign in/g) || []).length;

  return hasTheaterContent && showMentioned && junkRatio < 3;
}

module.exports = {
  verifyContent,
  heuristicVerify,
  quickValidityCheck
};
