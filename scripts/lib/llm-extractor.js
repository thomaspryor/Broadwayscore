#!/usr/bin/env node
/**
 * LLM Fallback Extractor for Aggregator Pages
 *
 * When regex-based extraction returns 0 reviews from an aggregator page that
 * clearly has review content (detected via structural markers), this module
 * uses Claude Sonnet to extract structured review data from the raw HTML.
 *
 * This makes aggregator extraction resilient to site redesigns — regex handles
 * the 99% case cheaply, LLM handles the 1% when CSS classes or DOM structure change.
 *
 * Usage (from an async caller):
 *   const { llmFallbackExtract } = require('./lib/llm-extractor');
 *   const reviews = extractDTLIReviews(html, showId, url, title);
 *   if (reviews.length === 0 && hasStructuralMarkers(html, 'dtli')) {
 *     const llmReviews = await llmFallbackExtract(html, { aggregator: 'dtli', showTitle, showId });
 *   }
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================================
// HTML Cleaning
// ============================================================

function cleanHtmlForLLM(html) {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Keep tags but strip attributes (preserves structure for LLM context)
    .replace(/<([a-z]+)\s[^>]*>/gi, '<$1>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  // Truncate to ~10K chars — enough for 20-30 reviews
  return text.slice(0, 10000);
}

// ============================================================
// Structural Marker Detection
// ============================================================

const STRUCTURAL_MARKERS = {
  dtli: ['review-item', 'BigThumbs', 'review-item-attribution', 'didtheylikeit'],
  bww: ['BlogPosting', 'roundup', 'broadwayworld.com', 'review-roundup'],
};

/**
 * Check if HTML has structural markers indicating review content is present
 * (even if our regex couldn't parse it due to format change).
 */
function hasStructuralMarkers(html, aggregator) {
  const markers = STRUCTURAL_MARKERS[aggregator];
  if (!markers) return false;
  const lowerHtml = html.toLowerCase();
  // Require at least 2 markers to avoid false positives on boilerplate pages
  let found = 0;
  for (const marker of markers) {
    if (lowerHtml.includes(marker.toLowerCase())) found++;
  }
  return found >= 2;
}

/**
 * Count the expected number of reviews on an aggregator page based on structural
 * signals that do not depend on the block parser. Used to detect PARTIAL regex
 * extraction (e.g. BWW adds a new review format and we catch 5 of 8).
 *
 * DTLI: thumb summary images `thumbs-{up,meh,down}/thumb-N.png` carry the total;
 * fallback to counting review-item blocks.
 * BWW: each review gets one thumb image (`uptrans|middletrans|downtrans\d*\.png`
 * or `BigThumbs_{UP,MEH,DOWN}\.(gif|png)`); fallback to BlogPosting entries.
 *
 * Returns 0 when no signal is available — callers should gate partial-fallback
 * on `expected >= MIN_CONFIDENT_EXPECTED` to avoid acting on noise.
 */
function countExpectedReviews(html, aggregator) {
  if (!html || typeof html !== 'string') return 0;
  if (aggregator === 'dtli') {
    const up = html.match(/thumbs-up\/thumb-(\d+)\.png/);
    const meh = html.match(/thumbs-meh\/thumb-(\d+)\.png/);
    const down = html.match(/thumbs-down\/thumb-(\d+)\.png/);
    if (up || meh || down) {
      return (up ? parseInt(up[1], 10) : 0)
        + (meh ? parseInt(meh[1], 10) : 0)
        + (down ? parseInt(down[1], 10) : 0);
    }
    // Fallback: block count
    const blocks = html.match(/class="(?:poster-)?review-item"/gi);
    return blocks ? blocks.length : 0;
  }
  if (aggregator === 'bww') {
    // Count thumb-bearing <img> tags rather than raw regex hits. A naive
    // global match double-counts when BWW serves retina variants in the same
    // tag (e.g. `<img src="uptrans.png" srcset="uptrans@2x.png 2x">`) or
    // transitions between legacy BigThumbs_ and new uptrans formats inside a
    // single tag. One thumb per <img> is the ground truth for "1 review".
    const THUMB_RE = /(?:uptrans|middletrans|downtrans)\d*\.png|BigThumbs_(?:UP|MEH|DOWN)\.(?:gif|png)/i;
    const imgTags = html.match(/<img\b[^>]*>/gi);
    if (imgTags && imgTags.length) {
      let count = 0;
      for (const tag of imgTags) {
        if (THUMB_RE.test(tag)) count++;
      }
      if (count > 0) return count;
    }
    // Fallback: JSON-LD BlogPosting entries
    const blogs = html.match(/"@type"\s*:\s*"BlogPosting"/g);
    return blogs ? blogs.length : 0;
  }
  return 0;
}

/**
 * Is the regex extraction a partial miss relative to `expected`?
 * Gate callers so the LLM only fires when there's a meaningful gap (not 1-off
 * rounding from a missing thumb image) and the expected count is credible.
 */
function isPartialExtraction(extractedCount, expectedCount, {
  minExpected = 5,
  minGap = 3,
} = {}) {
  if (expectedCount < minExpected) return false;
  if (extractedCount >= expectedCount) return false;
  return (expectedCount - extractedCount) >= minGap;
}

function _normalizeCriticForDedup(name) {
  if (!name || typeof name !== 'string') return '';
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
}

function _normalizeUrlForDedup(url) {
  if (!url || typeof url !== 'string') return '';
  return url.toLowerCase().replace(/#.*$/, '').replace(/\?.*$/, '').replace(/\/$/, '');
}

/**
 * Merge LLM-extracted reviews into a regex-extracted baseline.
 *
 * The regex pass is authoritative — it knows the aggregator's markup and pulls
 * reliable outlet/critic/URL pairs. The LLM pass is a safety net that catches
 * reviews the regex missed when markup changes. Dedup prevents double-counting
 * when the LLM re-extracts something the regex already has.
 *
 * Dedup key (in order): normalized URL → `${outletId}|${normalized criticName}`.
 * A review with neither a usable URL nor a known outletId is dropped (can't be
 * matched to anything anyway, and would pollute downstream pipelines).
 */
function mergeAggregatorReviews(regexReviews, llmReviews) {
  const merged = Array.isArray(regexReviews) ? [...regexReviews] : [];
  if (!Array.isArray(llmReviews) || llmReviews.length === 0) return merged;

  const seenUrls = new Set();
  const seenOutletCritic = new Set();
  for (const r of merged) {
    const u = _normalizeUrlForDedup(r.url);
    if (u) seenUrls.add(u);
    const oid = (r.outletId || '').toLowerCase();
    const cn = _normalizeCriticForDedup(r.criticName);
    if (oid && cn) seenOutletCritic.add(`${oid}|${cn}`);
  }

  let added = 0;
  for (const r of llmReviews) {
    const oid = (r.outletId || '').toLowerCase();
    const u = _normalizeUrlForDedup(r.url);
    const cn = _normalizeCriticForDedup(r.criticName);

    if (!oid && !u) continue; // unanchorable — skip

    if (u && seenUrls.has(u)) continue;
    if (oid && cn && seenOutletCritic.has(`${oid}|${cn}`)) continue;

    merged.push(r);
    if (u) seenUrls.add(u);
    if (oid && cn) seenOutletCritic.add(`${oid}|${cn}`);
    added++;
  }

  return merged;
}

// ============================================================
// Claude API (copied from classify-non-reviews.js pattern)
// ============================================================

function callClaude(systemPrompt, userPrompt, maxTokens = 2000) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Promise.reject(new Error('ANTHROPIC_API_KEY not set'));
  const body = JSON.stringify({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: maxTokens,
    temperature: 0.1,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
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
            resolve(json.content?.[0]?.text || '');
          } catch (e) { reject(new Error(`Claude parse error: ${e.message}`)); }
        } else if (res.statusCode === 429) {
          reject(new Error('RATE_LIMIT'));
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callClaudeWithRetry(systemPrompt, userPrompt, maxTokens = 2000, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await callClaude(systemPrompt, userPrompt, maxTokens);
    } catch (e) {
      if (e.message === 'RATE_LIMIT') {
        const delay = Math.pow(2, attempt) * 5000;
        console.log(`  LLM extractor rate limited, waiting ${delay / 1000}s...`);
        await sleep(delay);
      } else if (e.message.includes('ANTHROPIC_API_KEY')) {
        // No key — can't retry, return gracefully
        console.warn(`  ⚠ LLM fallback unavailable: ${e.message}`);
        return null;
      } else if (attempt < maxRetries - 1) {
        await sleep(2000);
      } else {
        throw e;
      }
    }
  }
}

// ============================================================
// Aggregator-specific prompts
// ============================================================

const DTLI_PROMPT = `You are extracting theater review data from a "Did They Like It" (DTLI) aggregator page.

Extract EVERY individual critic review listed on this page. For each review, extract:
- outlet: The publication name (e.g., "New York Times", "Variety", "TheaterMania")
- criticName: The critic's name (e.g., "Jesse Green", "Elisabeth Vincentelli"). Use "Unknown" if not found.
- verdict: One of "UP", "MEH", or "DOWN" (the thumb verdict for this review)
- url: The URL linking to the full review (if present)
- excerpt: A brief quote or excerpt from the review (if present)

Return a JSON array. Example:
[{"outlet":"New York Times","criticName":"Jesse Green","verdict":"MEH","url":"https://nytimes.com/...","excerpt":"..."}]

Return ONLY the JSON array, no other text.`;

const BWW_PROMPT = `You are extracting theater review data from a BroadwayWorld Review Roundup page.

Extract EVERY individual critic review listed on this page. For each review, extract:
- outlet: The publication name (e.g., "New York Times", "Variety", "Time Out")
- criticName: The critic's name. Use "Unknown" if not found.
- verdict: One of "Up", "Meh", or "Down" (the thumb/sentiment for this review, if indicated)
- url: The URL linking to the full review (if present)
- excerpt: A brief quote or excerpt from the review (if present)

Return a JSON array. Example:
[{"outlet":"Variety","criticName":"Frank Rizzo","verdict":"Up","url":"https://variety.com/...","excerpt":"..."}]

Return ONLY the JSON array, no other text.`;

// ============================================================
// URL Hallucination Guard
// ============================================================

function verifyUrlsAgainstHtml(reviews, rawHtml) {
  return reviews.map(r => {
    if (r.url && !rawHtml.includes(r.url)) {
      // LLM fabricated this URL — remove it
      return { ...r, url: null };
    }
    return r;
  });
}

// ============================================================
// Main extraction function
// ============================================================

/**
 * LLM fallback extraction for aggregator pages.
 * Call this when regex extraction returns 0 reviews but the page has
 * structural markers indicating review content is present.
 *
 * @param {string} rawHtml - The full raw HTML (for URL verification)
 * @param {Object} opts
 * @param {string} opts.aggregator - 'dtli' or 'bww'
 * @param {string} opts.showTitle - Show title for context
 * @param {string} opts.showId - Show ID for logging
 * @returns {Array} - Array of review objects, or empty array on failure
 */
async function llmFallbackExtract(rawHtml, { aggregator, showTitle, showId }) {
  const prompt = aggregator === 'dtli' ? DTLI_PROMPT : BWW_PROMPT;
  const cleanedHtml = cleanHtmlForLLM(rawHtml);

  console.log(`    ⚠ ${aggregator.toUpperCase()} regex extracted 0 reviews — trying LLM fallback (${cleanedHtml.length} chars)...`);

  try {
    const response = await callClaudeWithRetry(
      prompt,
      `Show: "${showTitle}"\n\nPage HTML:\n${cleanedHtml}`,
      3000
    );

    if (!response) return []; // API key missing or unrecoverable error

    // Parse JSON from response (handle markdown code blocks)
    let jsonStr = response.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    let reviews;
    try {
      reviews = JSON.parse(jsonStr);
    } catch {
      console.log(`    ✗ LLM fallback returned unparseable response`);
      return [];
    }

    if (!Array.isArray(reviews)) {
      console.log(`    ✗ LLM fallback returned non-array`);
      return [];
    }

    // Hallucination guard: verify URLs exist in source HTML
    reviews = verifyUrlsAgainstHtml(reviews, rawHtml);

    // Map to aggregator-specific field shapes
    const mapped = reviews.map(r => {
      const outletId = (r.outlet || '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      if (aggregator === 'dtli') {
        return {
          showId,
          outletId,
          outlet: r.outlet || 'Unknown',
          criticName: r.criticName || 'Unknown',
          url: r.url || null,
          dtliExcerpt: r.excerpt || null,
          dtliThumb: (r.verdict || '').toUpperCase() === 'UP' ? 'UP'
            : (r.verdict || '').toUpperCase() === 'DOWN' ? 'DOWN'
            : (r.verdict || '').toUpperCase() === 'MEH' ? 'MEH' : null,
          source: 'dtli',
        };
      } else {
        // BWW
        return {
          showId,
          outletId,
          outlet: r.outlet || 'Unknown',
          criticName: r.criticName || 'Unknown',
          url: r.url || null,
          bwwExcerpt: r.excerpt || null,
          bwwThumb: r.verdict === 'Up' ? 'Up'
            : r.verdict === 'Down' ? 'Down'
            : r.verdict === 'Meh' ? 'Meh' : null,
          source: 'bww-roundup',
        };
      }
    }).filter(r => r.outlet !== 'Unknown' || r.url); // Drop reviews with no outlet and no URL

    console.log(`    ✓ LLM fallback extracted ${mapped.length} reviews`);

    // Log fallback usage for monitoring
    logFallbackUsage(aggregator, showId, mapped.length, rawHtml.length);

    return mapped;
  } catch (e) {
    console.log(`    ✗ LLM fallback error: ${e.message}`);
    return [];
  }
}

function logFallbackUsage(aggregator, showId, reviewCount, htmlLength) {
  try {
    const auditPath = path.join(__dirname, '../../data/audit/extraction-fallbacks.json');
    let entries = [];
    if (fs.existsSync(auditPath)) {
      entries = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    }
    entries.push({
      aggregator,
      showId,
      date: new Date().toISOString(),
      llmCount: reviewCount,
      htmlLength,
    });
    // Keep last 100 entries
    if (entries.length > 100) entries = entries.slice(-100);
    fs.writeFileSync(auditPath, JSON.stringify(entries, null, 2) + '\n');
  } catch {
    // Non-critical — don't fail the extraction over audit logging
  }
}

module.exports = {
  cleanHtmlForLLM,
  hasStructuralMarkers,
  llmFallbackExtract,
  countExpectedReviews,
  isPartialExtraction,
  mergeAggregatorReviews,
};
