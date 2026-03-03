#!/usr/bin/env node
/**
 * Backfill cast data via web search + LLM extraction.
 *
 * For shows where IBDB doesn't have data (Off-Broadway, West End),
 * searches the web for cast/credits pages and uses an LLM to extract
 * structured cast data.
 *
 * Usage:
 *   node scripts/backfill-cast-web.js [options]
 *
 * Options:
 *   --category=CAT     Filter: off-broadway, west-end (default: both)
 *   --dry-run          Show what would be processed
 *   --force            Re-process shows with existing cast files
 *   --show-filter=ID   Process a single show
 *   --limit=N          Max shows to process (default: unlimited)
 *
 * Requires: SCRAPINGBEE_API_KEY, ANTHROPIC_API_KEY (or GEMINI_API_KEY)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const CAST_DIR = path.join(__dirname, '..', 'data', 'cast');

// Parse CLI arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

function getArgValue(prefix) {
  const arg = args.find(a => a.startsWith(prefix));
  if (!arg) return null;
  return arg.includes('=') ? arg.split('=')[1] : args[args.indexOf(arg) + 1];
}

const categoryFilter = getArgValue('--category');
const showFilter = getArgValue('--show-filter');
const limit = parseInt(getArgValue('--limit') || '0', 10);

// Rate limiting
const SERP_DELAY_MS = 1000;
const LLM_DELAY_MS = 500;
const FETCH_DELAY_MS = 1000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================================
// HTTP helpers
// ============================================================================

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 30000;
    const urlObj = new URL(url);
    const proto = urlObj.protocol === 'https:' ? https : require('http');
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)',
        ...(options.headers || {}),
      },
      timeout,
    };
    const req = proto.request(reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ============================================================================
// SERP search via ScrapingBee
// ============================================================================

async function searchCast(title, year, category) {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) throw new Error('SCRAPINGBEE_API_KEY not set');

  const isWestEnd = category === 'west-end';
  const location = isWestEnd ? 'west end london' : 'off-broadway new york';
  const sites = isWestEnd
    ? 'site:whatsonstage.com OR site:broadwayworld.com OR site:playbill.com OR site:timeout.com'
    : 'site:playbill.com OR site:broadwayworld.com OR site:theatermania.com OR site:timeout.com';

  const query = `"${title}" cast ${year || ''} ${location} ${sites}`.trim();
  const searchUrl = `https://app.scrapingbee.com/api/v1/store/google?api_key=${apiKey}&search=${encodeURIComponent(query)}`;

  const result = await httpRequest(searchUrl);
  if (result.statusCode !== 200) {
    console.log(`  SERP HTTP ${result.statusCode}`);
    return [];
  }

  const data = JSON.parse(result.body);
  const results = data.organic_results || data.results || [];

  // Filter to cast/credits-related pages
  return results
    .filter(r => {
      const url = (r.url || r.link || '').toLowerCase();
      const titleText = (r.title || '').toLowerCase();
      // Prefer pages about cast/credits
      return url.includes('cast') || url.includes('credit') || url.includes('people') ||
        titleText.includes('cast') || titleText.includes('starring') ||
        titleText.includes(title.toLowerCase().split(':')[0].trim());
    })
    .slice(0, 3)
    .map(r => ({ url: r.url || r.link, title: r.title || '' }));
}

// ============================================================================
// Page fetching via ScrapingBee
// ============================================================================

async function fetchPageText(url) {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) throw new Error('SCRAPINGBEE_API_KEY not set');

  const fetchUrl = `https://app.scrapingbee.com/api/v1?api_key=${apiKey}&url=${encodeURIComponent(url)}&render_js=false&extract_rules=${encodeURIComponent(JSON.stringify({ text: { selector: 'body', output: 'text' } }))}`;

  const result = await httpRequest(fetchUrl, { timeout: 45000 });
  if (result.statusCode !== 200) return null;

  try {
    const data = JSON.parse(result.body);
    return (data.text || '').substring(0, 8000); // Cap at 8K chars for LLM
  } catch {
    return result.body.substring(0, 8000);
  }
}

// ============================================================================
// LLM cast extraction
// ============================================================================

async function extractCastWithLLM(pageText, showTitle) {
  // Try Gemini first (cheapest), then Anthropic
  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  const prompt = `Extract the cast members from this web page about the show "${showTitle}". Return ONLY a JSON array of objects with "name" and "role" fields. Only include named principal roles — exclude ensemble, chorus, swings, standbys, understudies, and unnamed roles. If you cannot find cast information, return an empty array [].

Example output:
[{"name": "John Smith", "role": "Hamlet"}, {"name": "Jane Doe", "role": "Ophelia"}]

Web page text:
${pageText}`;

  if (geminiKey) {
    try {
      return await callGemini(prompt, geminiKey);
    } catch (e) {
      console.log(`  Gemini failed: ${e.message}`);
    }
  }

  if (anthropicKey) {
    try {
      return await callAnthropic(prompt, anthropicKey);
    } catch (e) {
      console.log(`  Anthropic failed: ${e.message}`);
    }
  }

  throw new Error('No LLM API key available (GEMINI_API_KEY or ANTHROPIC_API_KEY)');
}

async function callGemini(prompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const result = await httpRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2000 }
    }),
  });

  if (result.statusCode !== 200) throw new Error(`Gemini HTTP ${result.statusCode}`);
  const json = JSON.parse(result.body);
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return parseJsonFromLLM(text);
}

async function callAnthropic(prompt, apiKey) {
  const result = await httpRequest('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      temperature: 0.1,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (result.statusCode !== 200) throw new Error(`Anthropic HTTP ${result.statusCode}`);
  const json = JSON.parse(result.body);
  const text = json.content?.[0]?.text || '';
  return parseJsonFromLLM(text);
}

function parseJsonFromLLM(text) {
  // Extract JSON array from LLM response (may have markdown fences)
  const match = text.match(/\[[\s\S]*?\]/);
  if (!match) return [];

  try {
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    // Validate structure
    return arr.filter(m =>
      typeof m.name === 'string' && m.name.length > 1 && m.name.length < 100 &&
      (!m.role || (typeof m.role === 'string' && m.role.length < 200))
    );
  } catch {
    return [];
  }
}

// ============================================================================
// Main
// ============================================================================

async function processShow(show) {
  const year = show.openingDate ? show.openingDate.split('-')[0] :
    show.previewsStartDate ? show.previewsStartDate.split('-')[0] : null;

  // Step 1: Search for cast pages
  console.log(`  Searching for cast pages...`);
  let searchResults;
  try {
    searchResults = await searchCast(show.title, year, show.category);
  } catch (e) {
    console.log(`  SERP error: ${e.message}`);
    return null;
  }

  if (searchResults.length === 0) {
    // Try broader search without site filter
    console.log(`  No site-specific results, trying broader search...`);
    await sleep(SERP_DELAY_MS);
    try {
      const apiKey = process.env.SCRAPINGBEE_API_KEY;
      const isWE = show.category === 'west-end';
      const loc = isWE ? 'west end london' : 'off-broadway nyc';
      const query = `"${show.title}" cast ${year || ''} ${loc}`;
      const searchUrl = `https://app.scrapingbee.com/api/v1/store/google?api_key=${apiKey}&search=${encodeURIComponent(query)}`;
      const result = await httpRequest(searchUrl);
      if (result.statusCode === 200) {
        const data = JSON.parse(result.body);
        searchResults = (data.organic_results || data.results || [])
          .slice(0, 3)
          .map(r => ({ url: r.url || r.link, title: r.title || '' }));
      }
    } catch (e) {
      console.log(`  Broad search error: ${e.message}`);
    }
  }

  if (searchResults.length === 0) {
    console.log(`  No search results found`);
    return null;
  }

  // Step 2: Fetch page text and extract cast
  for (const sr of searchResults) {
    console.log(`  Fetching: ${sr.url}`);
    await sleep(FETCH_DELAY_MS);

    let pageText;
    try {
      pageText = await fetchPageText(sr.url);
    } catch (e) {
      console.log(`  Fetch error: ${e.message}`);
      continue;
    }

    if (!pageText || pageText.length < 100) {
      console.log(`  Page too short (${(pageText || '').length} chars)`);
      continue;
    }

    // Step 3: LLM extraction
    console.log(`  Extracting cast via LLM...`);
    await sleep(LLM_DELAY_MS);

    let cast;
    try {
      cast = await extractCastWithLLM(pageText, show.title);
    } catch (e) {
      console.log(`  LLM error: ${e.message}`);
      continue;
    }

    if (cast.length >= 2) {
      console.log(`  Found ${cast.length} cast members`);
      return {
        cast,
        sourceUrl: sr.url,
      };
    }
    console.log(`  Only ${cast.length} members found, trying next page...`);
  }

  return null;
}

async function main() {
  console.log('='.repeat(60));
  console.log('BACKFILL CAST DATA VIA WEB SEARCH');
  console.log('='.repeat(60));

  if (dryRun) console.log('  MODE: dry-run');
  if (force) console.log('  MODE: force');
  if (categoryFilter) console.log('  Category:', categoryFilter);
  if (showFilter) console.log('  Show filter:', showFilter);
  if (limit) console.log('  Limit:', limit);
  console.log('');

  // Verify API keys
  const hasSerp = !!process.env.SCRAPINGBEE_API_KEY;
  const hasLLM = !!process.env.GEMINI_API_KEY || !!process.env.ANTHROPIC_API_KEY;
  if (!hasSerp) { console.error('SCRAPINGBEE_API_KEY required'); process.exit(1); }
  if (!hasLLM) { console.error('GEMINI_API_KEY or ANTHROPIC_API_KEY required'); process.exit(1); }
  console.log(`  SERP: ScrapingBee | LLM: ${process.env.GEMINI_API_KEY ? 'Gemini Flash' : 'Claude Haiku'}`);

  // Ensure cast directory exists
  if (!fs.existsSync(CAST_DIR)) fs.mkdirSync(CAST_DIR, { recursive: true });

  // Load shows
  const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  let shows = showsData.shows;
  console.log(`  Total shows: ${shows.length}`);

  // Filter to target shows
  if (showFilter) {
    shows = shows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (shows.length === 0) { console.error(`No show found: ${showFilter}`); process.exit(1); }
  } else {
    // Default: OB + WE shows without cast files
    shows = shows.filter(s => {
      const cat = s.category || 'broadway';
      if (categoryFilter && cat !== categoryFilter) return false;
      if (!categoryFilter && cat === 'broadway') return false; // Skip Broadway (use IBDB)
      if (!force && fs.existsSync(path.join(CAST_DIR, `${s.id}.json`))) return false;
      return true;
    });
  }

  if (limit > 0) shows = shows.slice(0, limit);

  console.log(`  Shows to process: ${shows.length}`);
  if (shows.length === 0) { console.log('Nothing to do.'); return; }

  if (dryRun) {
    shows.forEach(s => console.log(`  Would process: ${s.id} (${s.title}) [${s.category}]`));
    console.log(`\n  Total: ${shows.length}`);
    return;
  }

  // Process shows
  let success = 0, failed = 0, skipped = 0;

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    console.log(`\n[${i + 1}/${shows.length}] ${show.title} (${show.id}) [${show.category}]`);

    try {
      const result = await processShow(show);

      if (!result || result.cast.length < 2) {
        console.log(`  No usable cast data found`);
        // Write tombstone to prevent re-processing
        const tombstone = {
          showId: show.id,
          source: 'web-search',
          scrapedAt: new Date().toISOString(),
          openingNightCast: [],
          currentCast: null,
        };
        fs.writeFileSync(
          path.join(CAST_DIR, `${show.id}.json`),
          JSON.stringify(tombstone, null, 2) + '\n'
        );
        skipped++;
        continue;
      }

      // Write cast file in standard format
      const castFile = {
        showId: show.id,
        source: 'web-search',
        sourceUrl: result.sourceUrl,
        scrapedAt: new Date().toISOString(),
        openingNightCast: result.cast.map(m => ({
          name: m.name,
          role: m.role || undefined,
        })),
        currentCast: (show.status === 'open' || show.status === 'previews')
          ? result.cast.map(m => ({ name: m.name, role: m.role || undefined }))
          : null,
      };

      fs.writeFileSync(
        path.join(CAST_DIR, `${show.id}.json`),
        JSON.stringify(castFile, null, 2) + '\n'
      );
      console.log(`  Saved: ${result.cast.length} cast members`);
      success++;

    } catch (e) {
      console.log(`  Error: ${e.message}`);
      failed++;
    }

    // Rate limit
    if (i < shows.length - 1) await sleep(SERP_DELAY_MS);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Success:  ${success}`);
  console.log(`  No data:  ${skipped}`);
  console.log(`  Failed:   ${failed}`);
  console.log(`  Total:    ${shows.length}`);

  // GitHub Actions output
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `success_count=${success}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `total_processed=${shows.length}\n`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
