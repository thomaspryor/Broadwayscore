#!/usr/bin/env node
/**
 * Batch Commercial Research Script
 *
 * Researches commercial/financial data for Broadway shows not yet in commercial.json.
 * Writes results to commercial-pending-review.json for human review before merging.
 *
 * Data sources:
 *   - SEC EDGAR Form D filings (capitalization)
 *   - Google Search via ScrapingBee/Bright Data (recoupment, capitalization articles)
 *   - Trade press articles (Deadline, Variety, Playbill, etc.)
 *   - Claude Sonnet AI analysis of gathered evidence
 *
 * Usage:
 *   node scripts/batch-commercial-research.js [options]
 *
 * Options:
 *   --dry-run              Preview without writing
 *   --shows=SLUG,SLUG      Specific shows by slug
 *   --top-historical=N     Top N historical shows by all-time gross
 *   --skip-sec             Skip SEC EDGAR lookups
 *   --apply                Apply pending review file to commercial.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const COMMERCIAL_PATH = path.join(DATA_DIR, 'commercial.json');
const GROSSES_PATH = path.join(DATA_DIR, 'grosses.json');
const PENDING_PATH = path.join(DATA_DIR, 'commercial-pending-review.json');
const PROGRESS_PATH = path.join(DATA_DIR, 'commercial-batch-progress.json');

// ---------------------------------------------------------------------------
// CLI Arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const flags = {};
for (const arg of args) {
  if (arg.startsWith('--')) {
    const [key, val] = arg.slice(2).split('=');
    flags[key] = val || true;
  }
}

const DRY_RUN = flags['dry-run'] === true;
const SHOW_LIST = flags['shows'] ? flags['shows'].split(',') : null;
const TOP_HISTORICAL = parseInt(flags['top-historical']) || 0;
const SKIP_SEC = flags['skip-sec'] === true;
const APPLY_MODE = flags['apply'] === true;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;

// ---------------------------------------------------------------------------
// Optional modules
// ---------------------------------------------------------------------------
let secEdgarScraper;
try {
  secEdgarScraper = require('./lib/sec-edgar-scraper');
} catch (e) {
  // SEC EDGAR module not available
}

let universalScraper;
try {
  universalScraper = require('./lib/scraper');
} catch (e) {
  // Scraper module not available
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Fetch a URL via ScrapingBee.
 */
function fetchViaScrapingBee(url) {
  return new Promise((resolve, reject) => {
    if (!SCRAPINGBEE_KEY) {
      reject(new Error('SCRAPINGBEE_API_KEY required'));
      return;
    }
    const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=false&premium_proxy=true`;
    https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(data);
        else reject(new Error(`ScrapingBee ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    }).on('error', reject);
  });
}

/**
 * Google search via ScrapingBee's Google Search API.
 * Returns array of {title, url, snippet}.
 */
async function googleSearch(query) {
  return new Promise((resolve) => {
    if (!SCRAPINGBEE_KEY) {
      resolve([]);
      return;
    }

    const params = new URLSearchParams({
      api_key: SCRAPINGBEE_KEY,
      search: query,
      nb_results: '8',
    });
    const apiUrl = `https://app.scrapingbee.com/api/v1/store/google?${params}`;

    https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.warn(`    ⚠️  Google search API returned ${res.statusCode}`);
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const results = (parsed.organic_results || []).slice(0, 5).map(r => ({
            title: r.title || '',
            url: r.url || r.link || '',
            snippet: r.description || '',
          }));
          resolve(results);
        } catch {
          // Fall back to regex parsing of raw HTML
          const results = [];
          const titleRegex = /<h3[^>]*>(.*?)<\/h3>/g;
          const linkRegex = /<a[^>]*href="(https?:\/\/(?!google\.com|gstatic\.com)[^"]+)"[^>]*>/g;
          let match;
          const titles = [];
          while ((match = titleRegex.exec(data)) !== null) {
            titles.push(match[1].replace(/<[^>]+>/g, ''));
          }
          const links = [];
          while ((match = linkRegex.exec(data)) !== null) {
            links.push(match[1]);
          }
          for (let i = 0; i < Math.min(titles.length, links.length, 5); i++) {
            results.push({ title: titles[i], url: links[i] });
          }
          resolve(results);
        }
      });
    }).on('error', () => {
      resolve([]);
    });
  });
}

/**
 * Verify a URL actually resolves and contains relevant content.
 * Returns { valid: true, snippet } or { valid: false }.
 */
async function verifySourceUrl(url, showTitle) {
  try {
    const content = await fetchViaScrapingBee(url);
    // Strip HTML but preserve original case for Claude
    const text = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const lowerText = text.toLowerCase();
    const titleWords = showTitle.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const hasTitle = titleWords.some(w => lowerText.includes(w));
    const hasFinancial = /capital|invest|recoup|gross|budget|cost|million|\$\d/i.test(text);

    if (hasTitle && hasFinancial) {
      // Find the most relevant section — center around the show title mention
      const titleIdx = lowerText.indexOf(titleWords.find(w => lowerText.includes(w)) || '');
      const start = Math.max(0, titleIdx - 200);
      const snippet = text.slice(start, start + 3000).trim();
      return { valid: true, snippet };
    }
    return { valid: false };
  } catch {
    return { valid: false };
  }
}

/**
 * Plausibility checks for commercial data.
 * Returns { plausible: true } or { plausible: false, reason }.
 */
function checkPlausibility(data, grossesData) {
  const issues = [];

  if (data.capitalization != null) {
    if (data.capitalization < 500000 || data.capitalization > 100000000) {
      issues.push(`Capitalization $${(data.capitalization / 1e6).toFixed(1)}M outside plausible range ($0.5M-$100M)`);
    }
  }

  if (data.weeklyRunningCost != null) {
    if (data.weeklyRunningCost < 100000 || data.weeklyRunningCost > 3000000) {
      issues.push(`Weekly running cost $${(data.weeklyRunningCost / 1000).toFixed(0)}K outside plausible range ($100K-$3M)`);
    }
  }

  // Cross-check: if recouped, capitalization should be < all-time gross
  if (data.recouped && data.capitalization && grossesData) {
    const allTimeGross = grossesData.allTime?.gross || 0;
    if (allTimeGross > 0 && data.capitalization > allTimeGross * 0.6) {
      issues.push(`Capitalization ($${(data.capitalization / 1e6).toFixed(1)}M) > 60% of all-time gross ($${(allTimeGross / 1e6).toFixed(1)}M) for recouped show`);
    }
  }

  return issues.length > 0
    ? { plausible: false, reason: issues.join('; ') }
    : { plausible: true };
}

/**
 * Call Claude Sonnet to analyze gathered evidence for a show.
 */
async function analyzeShowWithClaude(show, evidence) {
  if (!ANTHROPIC_KEY) {
    throw new Error('ANTHROPIC_API_KEY required for analysis');
  }

  const openingYear = show.openingDate ? show.openingDate.split('-')[0] : 'unknown';
  const isHistorical = show.openingDate && parseInt(show.openingDate.split('-')[0]) < 2005;

  const systemPrompt = `You are a Broadway financial analyst. Given evidence about a Broadway show, extract structured commercial data.

Rules:
1. Only extract data that is EXPLICITLY stated in the evidence. Do NOT guess, estimate, or infer.
2. If evidence is thin or contradictory, return null for fields you cannot confirm.
3. For capitalization, look for "capitalized at", "budget of", "investment of", "$X million to produce", or SEC Form D offering amounts.
4. For weekly running costs, look for "running costs of", "weekly nut", "costs $X per week to operate".
5. For recoupment, look for "recouped", "paid back", "returned investment", "broke even".
6. Recoupment dates should be in YYYY-MM format if month is known, YYYY if only year.
7. For designation, use: Miracle (mega-hit, 10+ year run), Windfall (solid hit, recouped well), Easy Winner (limited run, recouped fast), Trickle (barely broke even), Fizzle (closed, recovered 30%+), Flop (closed, recovered <30%), Nonprofit, TBD (insufficient data).
8. ALWAYS include source URLs for every claim. If you cannot cite a specific URL from the evidence, say null.
9. costMethodology should be: "sec-filing" if from SEC, "trade-reported" if from Deadline/Variety/Playbill, "industry-estimate" if uncertain.
${isHistorical ? '10. This is a historical show — data may be sparse. Be EXTRA conservative. Use industry-estimate methodology if sources are not definitive.' : ''}

Respond with ONLY a JSON object (no markdown fences):
{
  "capitalization": <number or null>,
  "capitalizationSource": "<description of source>" or null,
  "weeklyRunningCost": <number or null>,
  "costMethodology": "<methodology>",
  "recouped": <boolean or null>,
  "recoupedDate": "<YYYY-MM or YYYY>" or null,
  "recoupedSource": "<description>" or null,
  "designation": "<designation>",
  "notes": "<brief summary of financial situation>",
  "sources": [{"type": "trade"|"sec"|"reddit", "url": "<url>", "date": "<date if known>"}],
  "confidence": "high"|"medium"|"low"
}`;

  const userContent = `Show: "${show.title}" (${openingYear})
Venue: ${show.venue || 'unknown'}
Status: ${show.status}
Opening: ${show.openingDate || 'unknown'}
Closing: ${show.closingDate || 'unknown'}

Evidence gathered:
${evidence}`;

  // Truncate evidence to avoid hitting token limits
  const truncatedContent = userContent.length > 30000
    ? userContent.slice(0, 30000) + '\n\n[Evidence truncated]'
    : userContent;

  // Clean non-UTF8 / control characters that break JSON
  const cleanContent = truncatedContent.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');

  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [
      { role: 'user', content: cleanContent },
    ],
    system: systemPrompt,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.error) {
            reject(new Error(`Claude API error: ${response.error.message || JSON.stringify(response.error)}`));
            return;
          }
          const text = response.content?.[0]?.text || '';
          // Strip markdown fences
          let jsonStr = text;
          const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (fenceMatch) jsonStr = fenceMatch[1];
          const objMatch = jsonStr.match(/\{[\s\S]*\}/);
          if (objMatch) jsonStr = objMatch[0];
          resolve(JSON.parse(jsonStr));
        } catch (err) {
          reject(new Error(`Failed to parse Claude response: ${err.message}\nRaw: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Research pipeline for a single show
// ---------------------------------------------------------------------------
async function researchShow(show, grossesData) {
  const evidence = [];
  const verifiedUrls = new Set(); // Track URLs we've already verified
  const openingYear = show.openingDate ? parseInt(show.openingDate.split('-')[0]) : null;
  const isPreModern = openingYear && openingYear < 2005;

  console.log(`\n  🔍 Researching "${show.title}" (${show.openingDate || 'unknown date'})...`);

  // --- SEC EDGAR ---
  if (!SKIP_SEC && !isPreModern && secEdgarScraper && secEdgarScraper.isAvailable()) {
    try {
      console.log(`    SEC EDGAR...`);
      const filings = await secEdgarScraper.searchFormDFilings({ showName: show.title });
      if (filings && filings.length > 0) {
        for (const filing of filings.slice(0, 3)) {
          try {
            const parsed = await secEdgarScraper.parseFormDFiling(filing.filingUrl);
            if (parsed && parsed.totalOfferingAmount) {
              evidence.push(`[SEC EDGAR Form D] ${filing.entityName}: Total offering amount $${parsed.totalOfferingAmount.toLocaleString()}. Filed ${filing.dateFiled || 'unknown date'}. CIK: ${filing.cik || 'unknown'}.`);
              console.log(`    ✅ SEC: Found Form D - $${(parsed.totalOfferingAmount / 1e6).toFixed(1)}M`);
            }
          } catch (err) {
            // Individual filing parse failure
          }
          await sleep(1000); // SEC rate limit
        }
      } else {
        console.log(`    ⏭️  SEC: No filings found`);
      }
    } catch (err) {
      console.log(`    ⚠️  SEC error: ${err.message}`);
    }
  } else if (isPreModern) {
    console.log(`    ⏭️  SEC: Skipped (pre-2005 show)`);
  }

  // --- Google Search ---
  if (SCRAPINGBEE_KEY) {
    const queries = [
      `"${show.title}" broadway capitalization budget investment million`,
      `"${show.title}" broadway recouped "paid back" "broke even"`,
    ];

    for (const query of queries) {
      console.log(`    Google: "${query.slice(0, 60)}..."`);
      const results = await googleSearch(query);

      for (const result of results.slice(0, 3)) {
        // Skip non-relevant domains
        if (/wikipedia|imdb|ibdb|playbill\.com\/person/.test(result.url)) continue;

        // Verify the URL has relevant content
        const verification = await verifySourceUrl(result.url, show.title);
        if (verification.valid) {
          verifiedUrls.add(result.url);
          evidence.push(`[Web: ${result.url}]\n${verification.snippet.slice(0, 2000)}`);
          console.log(`    ✅ Verified: ${result.url.slice(0, 60)}...`);
        }
        await sleep(2000); // Rate limit
      }
      await sleep(2000);
    }
  }

  if (evidence.length === 0) {
    console.log(`    ❌ No evidence found`);
    return null;
  }

  console.log(`    📊 Analyzing ${evidence.length} pieces of evidence with Claude...`);

  // --- Claude Analysis ---
  try {
    const analysis = await analyzeShowWithClaude(show, evidence.join('\n\n---\n\n'));

    if (!analysis) {
      console.log(`    ❌ Claude returned no data`);
      return null;
    }

    // Normalize capitalization — Claude sometimes returns in millions (e.g., 13.5 for $13.5M)
    if (analysis.capitalization != null && analysis.capitalization > 0 && analysis.capitalization < 1000) {
      analysis.capitalization = analysis.capitalization * 1e6;
    }
    if (analysis.weeklyRunningCost != null && analysis.weeklyRunningCost > 0 && analysis.weeklyRunningCost < 10000) {
      analysis.weeklyRunningCost = analysis.weeklyRunningCost * 1000;
    }

    // Plausibility check
    const showGrosses = grossesData?.shows?.[show.slug];
    const plausibility = checkPlausibility(analysis, showGrosses);
    if (!plausibility.plausible) {
      console.log(`    ⚠️  Plausibility check failed: ${plausibility.reason}`);
      analysis.notes = `[PLAUSIBILITY WARNING: ${plausibility.reason}] ${analysis.notes || ''}`;
      analysis.confidence = 'low';
    }

    // Verify source URLs from Claude — accept if already verified in evidence phase
    if (analysis.sources && Array.isArray(analysis.sources)) {
      const verifiedSources = [];
      for (const source of analysis.sources) {
        if (source.url && source.url.startsWith('http')) {
          if (verifiedUrls.has(source.url)) {
            verifiedSources.push(source); // Already verified during evidence gathering
          } else {
            // New URL from Claude — verify it
            const check = await verifySourceUrl(source.url, show.title);
            if (check.valid) {
              verifiedSources.push(source);
            } else {
              console.log(`    ⚠️  Unverified source URL removed: ${source.url}`);
            }
          }
        } else {
          verifiedSources.push(source); // Keep non-URL sources
        }
      }
      analysis.sources = verifiedSources;
    }

    // If no verified sources remain, downgrade confidence
    const hasVerifiedUrl = analysis.sources?.some(s => s.url && s.url.startsWith('http'));
    if (!hasVerifiedUrl) {
      analysis.costMethodology = 'industry-estimate';
      analysis.confidence = 'low';
    }

    // Historical shows default to industry-estimate
    if (isPreModern && analysis.costMethodology !== 'sec-filing') {
      analysis.costMethodology = 'industry-estimate';
    }

    return analysis;
  } catch (err) {
    console.log(`    ❌ Claude analysis failed: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Apply mode: merge pending into commercial.json
// ---------------------------------------------------------------------------
function applyPending() {
  if (!fs.existsSync(PENDING_PATH)) {
    console.log('❌ No pending file found at', PENDING_PATH);
    process.exit(1);
  }

  const pending = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
  const commercial = JSON.parse(fs.readFileSync(COMMERCIAL_PATH, 'utf8'));

  let applied = 0;
  let skipped = 0;

  for (const [showId, entry] of Object.entries(pending.shows || {})) {
    if (commercial.shows[showId]) {
      console.log(`  ⏭️  "${showId}" already in commercial.json — skipping`);
      skipped++;
      continue;
    }

    // Build the commercial entry (strip research metadata)
    const commercialEntry = {
      designation: entry.designation || 'TBD',
      capitalization: entry.capitalization || null,
      capitalizationSource: entry.capitalizationSource || null,
      weeklyRunningCost: entry.weeklyRunningCost || null,
      costMethodology: entry.costMethodology || 'industry-estimate',
      recouped: entry.recouped != null ? entry.recouped : null,
      recoupedDate: entry.recoupedDate || null,
      recoupedSource: entry.recoupedSource || null,
      notes: entry.notes || '',
      sources: entry.sources || [],
      lastUpdated: new Date().toISOString().split('T')[0],
      firstAdded: new Date().toISOString().split('T')[0],
    };

    commercial.shows[showId] = commercialEntry;
    console.log(`  ✅ Applied "${showId}" → ${commercialEntry.designation}`);
    applied++;
  }

  if (applied > 0) {
    fs.writeFileSync(COMMERCIAL_PATH, JSON.stringify(commercial, null, 2) + '\n');
    console.log(`\n✅ Applied ${applied} shows to commercial.json (${skipped} skipped)`);
  } else {
    console.log('\nNo new shows to apply.');
  }
}

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------
function selectTargets(shows, commercial, grosses) {
  const existingIds = new Set(Object.keys(commercial.shows || {}));

  if (SHOW_LIST) {
    return shows.filter(s => SHOW_LIST.includes(s.slug) || SHOW_LIST.includes(s.id))
      .filter(s => !existingIds.has(s.id));
  }

  if (TOP_HISTORICAL) {
    // Rank by all-time gross, filter to shows not in commercial.json
    return shows
      .filter(s => !existingIds.has(s.id))
      .filter(s => s.status === 'closed' || s.status === 'open')
      .map(s => {
        const grossData = grosses.shows?.[s.slug];
        const allTimeGross = grossData?.allTime?.gross || 0;
        return { ...s, allTimeGross };
      })
      .sort((a, b) => b.allTimeGross - a.allTimeGross)
      .slice(0, TOP_HISTORICAL);
  }

  // Default: all shows without commercial data
  return shows.filter(s => !existingIds.has(s.id));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('💰 Broadway Commercial Data Batch Research');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : APPLY_MODE ? 'APPLY' : 'LIVE'}`);

  // Apply mode
  if (APPLY_MODE) {
    applyPending();
    return;
  }

  // Load data
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows || showsData;
  const commercial = JSON.parse(fs.readFileSync(COMMERCIAL_PATH, 'utf8'));
  const grosses = fs.existsSync(GROSSES_PATH)
    ? JSON.parse(fs.readFileSync(GROSSES_PATH, 'utf8'))
    : { shows: {} };

  // Select targets
  const targets = selectTargets(shows, commercial, grosses);

  if (targets.length === 0) {
    console.log('  No target shows to research.');
    return;
  }

  console.log(`  Targets: ${targets.length} shows`);
  if (SHOW_LIST) console.log(`  Shows: ${SHOW_LIST.join(', ')}`);
  if (TOP_HISTORICAL) console.log(`  Top ${TOP_HISTORICAL} by all-time gross`);
  if (SKIP_SEC) console.log(`  SEC EDGAR: SKIPPED`);
  console.log('');

  // Load or create progress file
  let pending = { generatedAt: new Date().toISOString(), shows: {} };
  if (fs.existsSync(PROGRESS_PATH)) {
    try {
      pending = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
      console.log(`  📂 Resuming from progress file (${Object.keys(pending.shows).length} shows done)`);
    } catch {
      // Start fresh
    }
  }

  // Research each show
  let researched = 0;
  let succeeded = 0;
  let failed = 0;

  for (const show of targets) {
    // Skip if already in progress file
    if (pending.shows[show.id]) {
      console.log(`  ⏭️  "${show.title}" already researched — skipping`);
      succeeded++;
      continue;
    }

    researched++;
    const result = await researchShow(show, grosses);

    if (result) {
      pending.shows[show.id] = {
        title: show.title,
        slug: show.slug,
        openingDate: show.openingDate,
        status: show.status,
        ...result,
        researchedAt: new Date().toISOString(),
      };
      succeeded++;

      // Log result
      const cap = result.capitalization ? `$${(result.capitalization / 1e6).toFixed(1)}M` : '?';
      const rec = result.recouped != null ? (result.recouped ? 'Yes' : 'No') : '?';
      console.log(`  ✅ ${show.title}: Cap ${cap}, Recouped: ${rec}, ${result.designation} [${result.confidence}]`);
    } else {
      failed++;
      console.log(`  ❌ ${show.title}: No usable data found`);
    }

    // Save progress after every show
    if (!DRY_RUN) {
      fs.writeFileSync(PROGRESS_PATH, JSON.stringify(pending, null, 2) + '\n');
    }

    // Rate limit between shows
    await sleep(3000);
  }

  // --- Summary ---
  console.log('\n--- Summary ---');
  console.log(`  Researched: ${researched}`);
  console.log(`  Succeeded:  ${succeeded}`);
  console.log(`  Failed:     ${failed}`);
  console.log(`  Success rate: ${targets.length > 0 ? Math.round(succeeded / targets.length * 100) : 0}%`);

  // Confidence breakdown
  const highConf = Object.values(pending.shows).filter(s => s.confidence === 'high').length;
  const medConf = Object.values(pending.shows).filter(s => s.confidence === 'medium').length;
  const lowConf = Object.values(pending.shows).filter(s => s.confidence === 'low').length;
  console.log(`  Confidence: ${highConf} high, ${medConf} medium, ${lowConf} low`);

  // Write pending file
  if (!DRY_RUN && Object.keys(pending.shows).length > 0) {
    fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2) + '\n');
    console.log(`\n📋 Pending review file written to ${PENDING_PATH}`);
    console.log(`   Review the data, then run: node scripts/batch-commercial-research.js --apply`);

    // Clean up progress file
    if (fs.existsSync(PROGRESS_PATH)) {
      fs.unlinkSync(PROGRESS_PATH);
    }
  } else if (DRY_RUN) {
    console.log('\n🏁 Dry run complete — no files written');

    // Print preview
    for (const [id, data] of Object.entries(pending.shows)) {
      console.log(`\n  ${data.title} (${id}):`);
      console.log(`    Designation: ${data.designation}`);
      console.log(`    Capitalization: ${data.capitalization ? '$' + (data.capitalization / 1e6).toFixed(1) + 'M' : 'null'}`);
      console.log(`    Weekly Cost: ${data.weeklyRunningCost ? '$' + (data.weeklyRunningCost / 1000).toFixed(0) + 'K' : 'null'}`);
      console.log(`    Recouped: ${data.recouped}`);
      console.log(`    Confidence: ${data.confidence}`);
      console.log(`    Sources: ${(data.sources || []).length}`);
    }
  }
}

main().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
