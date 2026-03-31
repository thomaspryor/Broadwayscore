#!/usr/bin/env node
/**
 * West End Review Score Audit
 *
 * Fetches WE show pages from the LIVE site, then verifies each review's
 * score against the actual review page content using OpenAI + Gemini.
 *
 * Checks:
 * 1. Star rating on review page matches our assigned score
 * 2. Review is for the correct production (not a different run/show)
 * 3. Score reasonableness vs review sentiment
 *
 * Usage: node scripts/audit-we-reviews.js [--show <show-id>] [--limit <n>]
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- Helpers ---

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchURL(url, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        fetchURL(redirectUrl, { timeout }).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function htmlToText(html) {
  // Strip scripts, styles, nav elements
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  // Truncate to ~4000 chars to keep LLM costs reasonable
  return text.slice(0, 4000);
}

async function callOpenAI(prompt, { model = 'gpt-4o', maxTokens = 500 } = {}) {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature: 0
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (data.error) reject(new Error(data.error.message));
          else resolve(data.choices[0].message.content);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callGemini(prompt) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 500 }
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (data.error) reject(new Error(data.error.message));
          else resolve(data.candidates[0].content.parts[0].text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildAuditPrompt(reviewText, review, showTitle) {
  return `You are auditing a theatre review for accuracy. Analyze this review page content and answer these questions in JSON format:

SHOW WE THINK THIS REVIEWS: "${showTitle}" (West End production)
OUR ASSIGNED SCORE: ${review.assignedScore}/100
OUTLET: ${review.outlet}
CRITIC: ${review.criticName || 'Unknown'}
REVIEW URL: ${review.url}

REVIEW PAGE CONTENT:
${reviewText}

Answer in this exact JSON format (no markdown, no code fences):
{
  "starRating": "The explicit star/number rating given (e.g. '4/5', '3/5', '8/10', 'B+') or null if no rating found",
  "starRatingConverted": "The star rating converted to a 0-100 scale (e.g. 4/5 = 80, 3/5 = 60, 8/10 = 80) or null",
  "ourScore": ${review.assignedScore},
  "scoreMismatch": true/false (true if starRatingConverted differs from ourScore by more than 10 points),
  "sentiment": "rave/positive/mixed/negative/pan",
  "sentimentMatchesScore": true/false (does the overall sentiment match a score of ${review.assignedScore}?),
  "showReviewed": "The exact show/production name mentioned in the review",
  "isCorrectProduction": true/false (is this reviewing the current West End production of ${showTitle}?),
  "wrongProductionReason": "explanation if wrong production, null otherwise",
  "isPaywalled": true/false (is the content behind a paywall/login wall?),
  "isAccessible": true/false (could you read enough content to make judgments?),
  "issues": ["list of any other issues found, e.g. 'review is about a touring production', 'URL is broken', 'review is a roundup not a single review'"]
}`;
}

async function auditReview(review, showTitle) {
  const result = {
    showId: review.showId,
    outlet: review.outlet,
    critic: review.criticName,
    url: review.url,
    ourScore: review.assignedScore,
    errors: []
  };

  // Fetch the review page
  let pageText;
  try {
    const html = await fetchURL(review.url);
    pageText = htmlToText(html);
    if (pageText.length < 200) {
      result.errors.push('Page content too short (likely paywall/block)');
      result.pageLength = pageText.length;
      return result;
    }
  } catch (e) {
    result.errors.push(`Fetch failed: ${e.message}`);
    return result;
  }

  const prompt = buildAuditPrompt(pageText, review, showTitle);

  // Call both OpenAI and Gemini in parallel
  const [openaiResult, geminiResult] = await Promise.allSettled([
    callOpenAI(prompt),
    callGemini(prompt)
  ]);

  // Parse responses
  function parseJSON(text) {
    if (!text) return null;
    // Strip markdown code fences if present
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    try { return JSON.parse(text); } catch { return null; }
  }

  result.openai = openaiResult.status === 'fulfilled' ? parseJSON(openaiResult.value) : null;
  result.gemini = geminiResult.status === 'fulfilled' ? parseJSON(geminiResult.value) : null;

  if (openaiResult.status === 'rejected') result.errors.push(`OpenAI: ${openaiResult.reason.message}`);
  if (geminiResult.status === 'rejected') result.errors.push(`Gemini: ${geminiResult.reason.message}`);

  // Flag issues where both models agree
  result.flags = [];
  const o = result.openai;
  const g = result.gemini;

  if (o && g) {
    // Both say score mismatch
    if (o.scoreMismatch && g.scoreMismatch) {
      result.flags.push(`SCORE_MISMATCH: Star rating ${o.starRating || g.starRating} → ${o.starRatingConverted || g.starRatingConverted}/100 vs our ${review.assignedScore}`);
    }
    // Both say wrong production
    if (o.isCorrectProduction === false && g.isCorrectProduction === false) {
      result.flags.push(`WRONG_PRODUCTION: ${o.wrongProductionReason || g.wrongProductionReason}`);
    }
    // Both say sentiment doesn't match
    if (o.sentimentMatchesScore === false && g.sentimentMatchesScore === false) {
      result.flags.push(`SENTIMENT_MISMATCH: Sentiment ${o.sentiment}/${g.sentiment} vs score ${review.assignedScore}`);
    }
    // Either says it's a roundup or other issues
    const allIssues = [...(o.issues || []), ...(g.issues || [])];
    if (allIssues.length > 0) {
      result.flags.push(...allIssues.map(i => `ISSUE: ${i}`));
    }
  } else if (o || g) {
    // Only one model responded — use that one but mark as single-source
    const single = o || g;
    const src = o ? 'OpenAI' : 'Gemini';
    if (single.scoreMismatch) result.flags.push(`SCORE_MISMATCH (${src} only): Star ${single.starRating} → ${single.starRatingConverted}/100 vs our ${review.assignedScore}`);
    if (single.isCorrectProduction === false) result.flags.push(`WRONG_PRODUCTION (${src} only): ${single.wrongProductionReason}`);
    if (single.sentimentMatchesScore === false) result.flags.push(`SENTIMENT_MISMATCH (${src} only): ${single.sentiment} vs ${review.assignedScore}`);
  }

  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const showFilter = args.includes('--show') ? args[args.indexOf('--show') + 1] : null;
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : Infinity;

  // Load data
  const showsData = require(path.join(__dirname, '..', 'data', 'shows.json'));
  const reviewsData = require(path.join(__dirname, '..', 'data', 'reviews.json'));

  const weShows = showsData.shows.filter(s => s.category === 'west-end');
  const weShowMap = Object.fromEntries(weShows.map(s => [s.id, s]));
  const weIds = new Set(weShows.map(s => s.id));

  let weReviews = reviewsData.reviews.filter(r => weIds.has(r.showId));

  if (showFilter) {
    weReviews = weReviews.filter(r => r.showId.includes(showFilter));
  }

  // Limit
  if (limit < weReviews.length) {
    weReviews = weReviews.slice(0, limit);
  }

  console.log(`\n🔍 WE Review Audit: ${weReviews.length} reviews across ${new Set(weReviews.map(r => r.showId)).size} shows\n`);

  const results = [];
  const flagged = [];
  const fetchErrors = [];

  // Process with concurrency limit of 3
  const CONCURRENCY = 3;
  let idx = 0;

  async function processNext() {
    while (idx < weReviews.length) {
      const i = idx++;
      const r = weReviews[i];
      const show = weShowMap[r.showId];
      const showTitle = show ? show.title : r.showId;

      process.stdout.write(`[${i+1}/${weReviews.length}] ${r.outlet} → ${showTitle}...`);

      try {
        const result = await auditReview(r, showTitle);
        results.push(result);

        if (result.flags.length > 0) {
          flagged.push(result);
          console.log(` ⚠️  ${result.flags.length} flag(s)`);
          result.flags.forEach(f => console.log(`     → ${f}`));
        } else if (result.errors.length > 0) {
          fetchErrors.push(result);
          console.log(` ❌ ${result.errors[0]}`);
        } else {
          console.log(` ✅`);
        }
      } catch (e) {
        console.log(` ❌ ${e.message}`);
        results.push({ showId: r.showId, outlet: r.outlet, url: r.url, errors: [e.message] });
      }

      // Rate limit
      await sleep(500);
    }
  }

  // Run concurrent workers
  const workers = Array.from({ length: CONCURRENCY }, () => processNext());
  await Promise.all(workers);

  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('AUDIT SUMMARY');
  console.log('='.repeat(80));
  console.log(`Total reviews audited: ${results.length}`);
  console.log(`Reviews with flags: ${flagged.length}`);
  console.log(`Fetch errors: ${fetchErrors.length}`);

  if (flagged.length > 0) {
    console.log('\n📋 FLAGGED REVIEWS:');
    console.log('-'.repeat(80));
    flagged.forEach(r => {
      console.log(`\n${r.showId} | ${r.outlet} | ${r.critic || 'Unknown'}`);
      console.log(`  URL: ${r.url}`);
      console.log(`  Our score: ${r.ourScore}`);
      if (r.openai) {
        console.log(`  OpenAI: star=${r.openai.starRating}, converted=${r.openai.starRatingConverted}, sentiment=${r.openai.sentiment}, correctProd=${r.openai.isCorrectProduction}`);
      }
      if (r.gemini) {
        console.log(`  Gemini: star=${r.gemini.starRating}, converted=${r.gemini.starRatingConverted}, sentiment=${r.gemini.sentiment}, correctProd=${r.gemini.isCorrectProduction}`);
      }
      r.flags.forEach(f => console.log(`  ⚠️  ${f}`));
    });
  }

  if (fetchErrors.length > 0) {
    console.log('\n❌ FETCH ERRORS:');
    fetchErrors.forEach(r => {
      console.log(`  ${r.showId} | ${r.outlet} | ${r.url} → ${r.errors[0]}`);
    });
  }

  // Save full results to file
  const outPath = path.join(__dirname, '..', 'data', 'we-audit-results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    auditDate: new Date().toISOString(),
    totalReviews: results.length,
    flaggedCount: flagged.length,
    fetchErrorCount: fetchErrors.length,
    flagged,
    fetchErrors: fetchErrors.map(r => ({ showId: r.showId, outlet: r.outlet, url: r.url, error: r.errors[0] })),
    allResults: results
  }, null, 2));
  console.log(`\nFull results saved to: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
