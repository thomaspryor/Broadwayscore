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
 * Falls back to heuristic checks when ANTHROPIC_API_KEY is unavailable.
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
 * Verify scraped content matches expected Broadway review
 *
 * @param {Object} params
 * @param {string} params.scrapedText - The scraped full text
 * @param {string} params.excerpt - Known excerpt from aggregator
 * @param {string} params.showTitle - Show title for context
 * @param {string} params.outletName - Outlet name
 * @param {string} params.criticName - Critic name
 * @param {string} [params.openingDate] - Broadway opening date (YYYY-MM-DD) for temporal context
 * @param {string} [params.venue] - Broadway venue name
 * @returns {Object} { isValid, confidence, issues, truncated, wrongArticle, wrongProduction, isFilmTv, reasoning, verifiedBy }
 */
async function verifyContent({ scrapedText, excerpt, showTitle, outletName, criticName, openingDate, venue }) {
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
      wrongArticle: false,
      wrongProduction: false,
      isFilmTv: false,
      verifiedBy: 'skip-short'
    };
  }

  const dateContext = openingDate ? `\n- Broadway opening date: ${openingDate}` : '';
  const venueContext = venue ? `\n- Broadway venue: ${venue}` : '';
  const excerptContext = excerpt ? `\n- Known excerpt: "${excerpt.substring(0, 300)}"` : '';

  const prompt = `You are a content verification assistant for a Broadway review aggregator. We only include reviews of Broadway productions (shows performed in Broadway theaters in New York City).

I scraped what should be a Broadway theater review. Verify if the content is valid.

**Expected Review:**
- Show: "${showTitle}"
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

2. **Wrong production** (IMPORTANT): Is this reviewing a NON-Broadway production of "${showTitle}"? Red flags:
   - National tour, touring production, touring company, "on tour"
   - Regional theater (Ahmanson, Kennedy Center, Old Globe, Goodman, etc.)
   - Off-Broadway or Off-Off-Broadway venue
   - West End / London production
   - Pre-Broadway tryout or out-of-town engagement
   A review of the BROADWAY production that merely *mentions* a tour or previous run is NOT a wrong production — it must be *reviewing* a non-Broadway staging.

3. **Film/TV content**: Is this a review of a film adaptation, TV special, streaming version, or filmed stage production (not a live Broadway performance)?

4. **Truncation**: Does the text end mid-sentence, hit a paywall ("subscribe to read more"), or appear incomplete?

5. **Junk content**: Is this mostly navigation, footer, cookie notices, or non-article content?

Set isValid=true only if the content is a review of the BROADWAY production and is not truncated/junk.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0].text;

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        isValid: result.isValid ?? true,
        confidence: result.confidence || 'medium',
        issues: result.issues || [],
        truncated: result.truncated || false,
        wrongArticle: result.wrongArticle || false,
        wrongProduction: result.wrongProduction || false,
        isFilmTv: result.isFilmTv || false,
        reasoning: result.reasoning || '',
        verifiedBy: 'llm'
      };
    }

    // Couldn't parse - fall back to heuristics
    console.log('    LLM verify: could not parse JSON response, falling back to heuristic');
    return heuristicVerify({ scrapedText, excerpt, showTitle });

  } catch (error) {
    console.error(`    LLM verification error: ${error.message}`);
    // Fall back to heuristics on error
    return heuristicVerify({ scrapedText, excerpt, showTitle });
  }
}

/**
 * Heuristic-based content verification (no API needed)
 * Used as fallback when LLM is unavailable
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
