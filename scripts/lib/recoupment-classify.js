/**
 * Recoupment article classifier — shared by:
 *   - scripts/scrape-recoupment-announcements.js (Friday SERP pipeline)
 *   - scripts/poll-trade-press-rss.js (hourly RSS poller)
 *
 * Single LLM call (OpenAI gpt-4o-mini) over a stripped-HTML article body,
 * returning a structured verdict. Shared verbatim — both callers gate on
 * the same {productionMatch, confidence} pair, so contract drift here
 * silently breaks both pipelines. Test fixtures live in
 * tests/unit/recoupment-classify.test.mjs.
 */

const https = require('https');
const { GPT4O_MINI } = require('./models');

const ENDPOINT = { hostname: 'api.openai.com', path: '/v1/chat/completions' };
const MODEL = GPT4O_MINI;

/**
 * Strip HTML to first 6KB of plain text. Whitespace-normalized.
 * Returns '' for empty/null input.
 */
function extractArticleText(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);
}

function buildPrompt(showTitle, url, text) {
  return `You are extracting a single fact from a trade-press article about a Broadway show.

Show: "${showTitle}"
Article URL: ${url}
Article text (truncated):
"""
${text}
"""

Question: Does this article state that THIS SPECIFIC production of "${showTitle}" has recouped its capitalization (earned back its investors' money)?

Important rules:
- "Recouped" means the show paid back its full initial capital investment.
- "Tracking to recoup", "expected to recoup", "on pace to recoup" do NOT count as recouped.
- An article about a PRIOR production of the same title (e.g. a 2009 revival when we're asking about a 2026 production) does NOT count.
- An article mentioning recoupment of a DIFFERENT show does NOT count.

Respond with a single JSON object:
{
  "recouped": true | false,
  "recoupedDate": "YYYY-MM-DD" or null,    // date the show recouped, if stated
  "articleDate": "YYYY-MM-DD" or null,     // when the article was published
  "productionMatch": "exact" | "same-title-different-year" | "different-show" | "unclear",
  "confidence": "high" | "medium" | "low",
  "evidence": "short quote from article supporting your answer"
}`;
}

function callOpenAI(prompt, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 400,
      response_format: { type: 'json_object' },
    });
    const req = https.request({
      ...ENDPOINT,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.choices[0].message.content);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

/**
 * Classify whether an article reports recoupment of a specific show production.
 *
 * @param {string} showTitle
 * @param {string} url - article URL (used in prompt context)
 * @param {string} html - raw article HTML (or stripped text — extractArticleText handles both)
 * @param {object} opts
 * @param {string} opts.apiKey - OPENAI_API_KEY override (defaults to process.env.OPENAI_API_KEY)
 * @param {function} opts.openaiFn - injectable callOpenAI replacement (for tests)
 * @returns {Promise<{recouped, recoupedDate, articleDate, productionMatch, confidence, evidence, reason?}>}
 */
async function classifyArticle(showTitle, url, html, opts = {}) {
  const text = extractArticleText(html);
  if (text.length < 200) {
    return { recouped: false, confidence: 'low', reason: 'article body too short or unfetched' };
  }
  const prompt = buildPrompt(showTitle, url, text);
  const apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
  const openaiFn = opts.openaiFn || ((p) => callOpenAI(p, apiKey));
  try {
    const raw = await openaiFn(prompt);
    return JSON.parse(raw);
  } catch (e) {
    return { recouped: false, confidence: 'low', reason: `LLM error: ${e.message}` };
  }
}

module.exports = { classifyArticle, extractArticleText, buildPrompt };
