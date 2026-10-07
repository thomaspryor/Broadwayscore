/**
 * Recoupment article classifier — shared by:
 *   - scripts/scrape-recoupment-announcements.js (Friday SERP pipeline)
 *   - scripts/poll-trade-press-rss.js (hourly RSS poller)
 *   - scripts/reconcile-recoupment-claims.js (pending-claim verifier)
 *
 * BRO-4623: callers pass opts.show (the shows.json record). That adds the
 * production's venue and dates to the prompt and runs the deterministic
 * wrong-production guard (recoupment-production-guard.js) on the verdict:
 * a pre-first-preview date or a tour / West End / Off-Broadway article is
 * turned into recouped:false, productionMatch 'wrong-production'. Without
 * opts.show the classifier had only a title to go on and matched the 2012
 * Death of a Salesman and the Beetlejuice national tour to 2025-26 runs.
 *
 * Single LLM call (OpenAI gpt-4o-mini) over a stripped-HTML article body,
 * returning a structured verdict. Shared verbatim — both callers gate on
 * the same {productionMatch, confidence} pair, so contract drift here
 * silently breaks both pipelines. Test fixtures live in
 * tests/unit/recoupment-classify.test.mjs.
 */

const https = require('https');
const { GPT4O_MINI } = require('./models');
const { applyProductionGuard, extractHeadlines, extractPublishedDate, productionStartDate } = require('./recoupment-production-guard');

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

// One line describing THIS production, so the model can reject articles
// about an earlier revival or a tour of the same title.
function describeProduction(show) {
  if (!show) return '';
  const parts = ['Broadway'];
  if (show.venue) parts.push(`at the ${show.venue}`);
  const start = productionStartDate(show);
  if (show.previewsStartDate) parts.push(`first preview ${show.previewsStartDate}`);
  if (show.openingDate) parts.push(`opened ${show.openingDate}`);
  if (show.status === 'closed' && show.closingDate) parts.push(`closed ${show.closingDate}`);
  if (!start && parts.length === 1) return '';
  return parts.join(', ');
}

function buildPrompt(showTitle, url, text, show = null) {
  const production = describeProduction(show);
  const productionLine = production ? `\nThis production: ${production}` : '';
  const productionRules = production
    ? `\n- A recoupment dated or reported BEFORE this production's first preview belongs to an EARLIER production and does NOT count.
- A national tour, West End, Off-Broadway, regional or international production of the same title does NOT count, even if the article also mentions the Broadway run.`
    : '';
  return `You are extracting a single fact from a trade-press article about a Broadway show.

Show: "${showTitle}"${productionLine}
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
- An article mentioning recoupment of a DIFFERENT show does NOT count.${productionRules}

Respond with a single JSON object:
{
  "recouped": true | false,
  "recoupedDate": "YYYY-MM-DD" or null,    // date the show recouped, if stated
  "articleDate": "YYYY-MM-DD" or null,     // when the article was published
  "productionMatch": "exact" | "same-title-different-year" | "different-show" | "unclear",
  "productionType": "broadway" | "tour" | "west-end" | "off-broadway" | "other" | "unclear",  // which production the RECOUPMENT is about
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
 * @param {object} [opts.show] - shows.json record of the production being
 *   checked; enables the production context + wrong-production guard
 * @param {string} [opts.headline] - SERP / RSS title of the article
 * @returns {Promise<{recouped, recoupedDate, articleDate, productionMatch, productionType?, confidence, evidence, reason?, guardReason?}>}
 */
async function classifyArticle(showTitle, url, html, opts = {}) {
  const text = extractArticleText(html);
  if (text.length < 200) {
    return { recouped: false, confidence: 'low', reason: 'article body too short or unfetched' };
  }
  const prompt = buildPrompt(showTitle, url, text, opts.show || null);
  const apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
  const openaiFn = opts.openaiFn || ((p) => callOpenAI(p, apiKey));
  let verdict;
  try {
    const raw = await openaiFn(prompt);
    verdict = JSON.parse(raw);
  } catch (e) {
    return { recouped: false, confidence: 'low', reason: `LLM error: ${e.message}` };
  }
  return applyProductionGuard(verdict, {
    show: opts.show || null,
    url,
    publishedDate: extractPublishedDate(html),
    headlines: [opts.headline, ...extractHeadlines(html)],
  });
}

module.exports = { classifyArticle, extractArticleText, buildPrompt, describeProduction };
