#!/usr/bin/env node
/**
 * Review Score Audit (Broadway + West End)
 *
 * Fetches review URLs, sends content to OpenAI + Gemini to verify:
 * 1. Star rating on review page matches our assigned score
 * 2. Review is for the correct production (not a different run/show)
 * 3. Score reasonableness vs review sentiment
 *
 * Usage:
 *   node scripts/audit-we-reviews.js --market west-end [--show <show-id>] [--limit <n>]
 *   node scripts/audit-we-reviews.js --market broadway [--show <show-id>] [--limit <n>] [--priority revivals]
 *
 * Options:
 *   --market <market>    broadway | west-end (default: west-end)
 *   --show <show-id>     Filter to one show (substring match)
 *   --limit <n>          Max reviews to audit
 *   --priority revivals  Prioritize multi-production/revival shows (Broadway)
 *   --concurrency <n>    Concurrent workers (default: 3)
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

// --- Market-specific prompt builders ---

function buildPromptWestEnd(reviewText, review, show) {
  return `You are auditing a theatre review for accuracy. Analyze this review page content and answer these questions in JSON format:

SHOW WE THINK THIS REVIEWS: "${show.title}" (West End production)
OUR ASSIGNED SCORE: ${review.assignedScore}/100
OUTLET: ${review.outlet}
CRITIC: ${review.criticName || 'Unknown'}
REVIEW URL: ${review.url}
SHOW VENUE: ${show.venue || 'Unknown'}

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
  "isCorrectProduction": true/false (is this reviewing the current West End production of ${show.title}?),
  "wrongProductionReason": "explanation if wrong production, null otherwise",
  "isPaywalled": true/false (is the content behind a paywall/login wall?),
  "isAccessible": true/false (could you read enough content to make judgments?),
  "issues": ["list of any other issues found, e.g. 'review is about a touring production', 'URL is broken', 'review is a roundup not a single review'"]
}`;
}

function buildPromptBroadway(reviewText, review, show) {
  const yearFromId = show.id.match(/-(\d{4})$/)?.[1] || '';
  const openingYear = show.openingDate ? show.openingDate.slice(0, 4) : yearFromId;
  const revivalNote = show.isRevival ? `This is a REVIVAL (${openingYear}). Prior productions of this title exist — make sure this review is about the ${openingYear} production, not an earlier one.` : '';

  return `You are auditing a Broadway theatre review for accuracy. Your PRIMARY task is detecting wrong-production reviews — reviews filed under this show but actually reviewing a different production, a touring production, an off-Broadway run, or a film/TV adaptation.

SHOW: "${show.title}" (Broadway, ${openingYear})
${revivalNote}
VENUE: ${show.venue || 'Unknown'}
OUR ASSIGNED SCORE: ${review.assignedScore}/100
OUTLET: ${review.outlet}
CRITIC: ${review.criticName || 'Unknown'}
REVIEW URL: ${review.url}

NOTE: Most Broadway critics (New York Times, Vulture, Variety, Time Out New York, New Yorker) do NOT use star ratings. Only report a star rating if one is explicitly shown on the page (e.g. NY Post, Entertainment Weekly sometimes use letter grades or stars). Do not guess or infer ratings.

REVIEW PAGE CONTENT:
${reviewText}

Answer in this exact JSON format (no markdown, no code fences):
{
  "starRating": "Explicit star/number/letter rating if shown on page, or null if none",
  "starRatingConverted": "Rating converted to 0-100 scale, or null",
  "ourScore": ${review.assignedScore},
  "scoreMismatch": true/false (true only if an explicit rating was found AND differs from ourScore by >10 points),
  "sentiment": "rave/positive/mixed/negative/pan",
  "sentimentMatchesScore": true/false,
  "showReviewed": "The exact show/production name mentioned in the review",
  "productionYear": "The year of the production being reviewed (from dates, cast, or context clues)",
  "venueInReview": "The theatre/venue mentioned in the review, or null",
  "isCorrectProduction": true/false (is this the ${openingYear} Broadway production at ${show.venue || 'the correct venue'}?),
  "wrongProductionReason": "explanation if wrong — e.g. 'reviews the 2004 original, not the 2024 revival', 'this is a touring production', 'this is the off-Broadway run', 'this reviews the film adaptation'. null if correct.",
  "isTourReview": true/false (does this review a touring/regional production?),
  "isFilmTvReview": true/false (does this review the film/TV adaptation?),
  "isPaywalled": true/false,
  "isAccessible": true/false,
  "issues": ["any other issues: roundup article, wrong show entirely, URL broken, etc."]
}`;
}

async function auditReview(review, show, market) {
  const result = {
    showId: review.showId,
    outlet: review.outlet,
    critic: review.criticName,
    url: review.url,
    ourScore: review.assignedScore,
    errors: []
  };

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

  const prompt = market === 'broadway'
    ? buildPromptBroadway(pageText, review, show)
    : buildPromptWestEnd(pageText, review, show);

  const [openaiResult, geminiResult] = await Promise.allSettled([
    callOpenAI(prompt),
    callGemini(prompt)
  ]);

  function parseJSON(text) {
    if (!text) return null;
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    try { return JSON.parse(text); } catch { return null; }
  }

  result.openai = openaiResult.status === 'fulfilled' ? parseJSON(openaiResult.value) : null;
  result.gemini = geminiResult.status === 'fulfilled' ? parseJSON(geminiResult.value) : null;

  if (openaiResult.status === 'rejected') result.errors.push(`OpenAI: ${openaiResult.reason.message}`);
  if (geminiResult.status === 'rejected') result.errors.push(`Gemini: ${geminiResult.reason.message}`);

  result.flags = [];
  const o = result.openai;
  const g = result.gemini;

  if (o && g) {
    if (o.scoreMismatch && g.scoreMismatch) {
      result.flags.push(`SCORE_MISMATCH: Star rating ${o.starRating || g.starRating} → ${o.starRatingConverted || g.starRatingConverted}/100 vs our ${review.assignedScore}`);
    }
    if (o.isCorrectProduction === false && g.isCorrectProduction === false) {
      result.flags.push(`WRONG_PRODUCTION: ${o.wrongProductionReason || g.wrongProductionReason}`);
    }
    if (o.sentimentMatchesScore === false && g.sentimentMatchesScore === false) {
      result.flags.push(`SENTIMENT_MISMATCH: Sentiment ${o.sentiment}/${g.sentiment} vs score ${review.assignedScore}`);
    }
    // Broadway-specific: tour and film detection (both agree)
    if (market === 'broadway') {
      if (o.isTourReview && g.isTourReview) {
        result.flags.push(`TOUR_REVIEW: Both models agree this reviews a touring production`);
      }
      if (o.isFilmTvReview && g.isFilmTvReview) {
        result.flags.push(`FILM_TV_REVIEW: Both models agree this reviews the film/TV version`);
      }
    }
    const allIssues = [...(o.issues || []), ...(g.issues || [])];
    if (allIssues.length > 0) {
      result.flags.push(...allIssues.map(i => `ISSUE: ${i}`));
    }
  } else if (o || g) {
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
  const market = args.includes('--market') ? args[args.indexOf('--market') + 1] : 'west-end';
  const showFilter = args.includes('--show') ? args[args.indexOf('--show') + 1] : null;
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : Infinity;
  const priorityMode = args.includes('--priority') ? args[args.indexOf('--priority') + 1] : null;
  const concurrency = args.includes('--concurrency') ? parseInt(args[args.indexOf('--concurrency') + 1]) : 3;

  const showsData = require(path.join(__dirname, '..', 'data', 'shows.json'));
  const reviewsData = require(path.join(__dirname, '..', 'data', 'reviews.json'));

  // Filter shows by market
  let targetShows;
  if (market === 'west-end') {
    targetShows = showsData.shows.filter(s => s.category === 'west-end');
  } else if (market === 'broadway') {
    // Broadway shows have no category field, or category === 'broadway'
    targetShows = showsData.shows.filter(s => !s.category || s.category === 'broadway');
  } else {
    targetShows = showsData.shows.filter(s => s.category === market);
  }

  const showMap = Object.fromEntries(targetShows.map(s => [s.id, s]));
  const showIds = new Set(targetShows.map(s => s.id));

  // Get reviews — skip those with no URL
  let reviews = reviewsData.reviews.filter(r => showIds.has(r.showId) && r.url);

  if (showFilter) {
    reviews = reviews.filter(r => r.showId.includes(showFilter));
  }

  // For Broadway, prioritize multi-production/revival shows
  if (market === 'broadway' && priorityMode === 'revivals') {
    // Find shows with isRevival or multiple productions of the same title
    const titleGroups = {};
    targetShows.forEach(s => {
      const normTitle = s.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!titleGroups[normTitle]) titleGroups[normTitle] = [];
      titleGroups[normTitle].push(s.id);
    });
    const multiProdIds = new Set();
    Object.values(titleGroups).filter(g => g.length > 1).forEach(g => g.forEach(id => multiProdIds.add(id)));
    targetShows.filter(s => s.isRevival).forEach(s => multiProdIds.add(s.id));

    // Sort: multi-production/revival shows first, then by review count
    const reviewCountByShow = {};
    reviews.forEach(r => { reviewCountByShow[r.showId] = (reviewCountByShow[r.showId] || 0) + 1; });

    reviews.sort((a, b) => {
      const aPriority = multiProdIds.has(a.showId) ? 1 : 0;
      const bPriority = multiProdIds.has(b.showId) ? 1 : 0;
      if (aPriority !== bPriority) return bPriority - aPriority;
      return (reviewCountByShow[b.showId] || 0) - (reviewCountByShow[a.showId] || 0);
    });

    console.log(`Priority mode: revivals — ${multiProdIds.size} multi-production/revival shows prioritized`);
  }

  if (limit < reviews.length) {
    reviews = reviews.slice(0, limit);
  }

  const marketLabel = market === 'west-end' ? 'WE' : market === 'broadway' ? 'BW' : market.toUpperCase();
  console.log(`\n🔍 ${marketLabel} Review Audit: ${reviews.length} reviews across ${new Set(reviews.map(r => r.showId)).size} shows\n`);

  const results = [];
  const flagged = [];
  const fetchErrors = [];

  let idx = 0;
  async function processNext() {
    while (idx < reviews.length) {
      const i = idx++;
      const r = reviews[i];
      const show = showMap[r.showId] || { id: r.showId, title: r.showId };

      process.stdout.write(`[${i+1}/${reviews.length}] ${r.outlet} → ${show.title}...`);

      try {
        const result = await auditReview(r, show, market);
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

      await sleep(500);
    }
  }

  const workers = Array.from({ length: concurrency }, () => processNext());
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

  const outFile = market === 'broadway' ? 'broadway-audit-results.json' : 'we-audit-results.json';
  const outPath = path.join(__dirname, '..', 'data', outFile);
  fs.writeFileSync(outPath, JSON.stringify({
    market,
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
