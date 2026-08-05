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
const { serpQuery } = require('./lib/url-discovery');
const { isLondonMarket } = require('./lib/venue-classification');
const {
  validateCastExtraction,
  isOperaSourceUrl,
  scoreSerpResult,
  SERP_MIN_SCORE,
} = require('./lib/cast-extraction-guards');
const { GEMINI_FLASH, CLAUDE_HAIKU } = require('./lib/models');
const { shouldTombstone, shouldAbortMassWipe } = require('./lib/cast-tombstone');

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
  const isWestEnd = isLondonMarket(category);
  const location = isWestEnd ? 'west end london' : 'off-broadway new york';

  // Broad query — no site: filters (they eliminate too many valid results for OB/WE)
  const query = `"${title}" cast ${year || ''} ${location}`.trim();

  const results = await serpQuery(query);
  if (!results) return [];

  // Score via shared lib so tests can verify historical bad URLs would be
  // rejected (see tests/unit/cast-extraction-guards.test.mjs). Pass year +
  // category so the lib's year-mismatch and market-mismatch defenses can
  // fire (added 2026-05-24).
  const scored = results.map(r => scoreSerpResult(r, { title, year, category }));

  return scored
    .filter(r => r.score >= SERP_MIN_SCORE && r.url)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(r => ({ url: r.url, title: r.title }));
}

// ============================================================================
// Page fetching via ScrapingBee
// ============================================================================

async function fetchPageText(url) {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) throw new Error('SCRAPINGBEE_API_KEY not set');

  // Targeted selectors for cast/credits sections — avoids nav/footer noise
  const extractRules = {
    main: {
      selector: 'main, article, .cast, .credits, .people, [class*="cast"], [class*="credit"], [id*="cast"], .show-detail, .production-detail',
      output: 'text',
    },
    fallback: { selector: 'body', output: 'text' },
  };

  // BWW and Lortel need JS rendering for dynamic content
  const needsJs = url.includes('broadwayworld.com') || url.includes('lortel.org');
  const renderParam = needsJs ? '&render_js=true&wait=3000' : '&render_js=false';

  const fetchUrl = `https://app.scrapingbee.com/api/v1?api_key=${apiKey}&url=${encodeURIComponent(url)}${renderParam}&extract_rules=${encodeURIComponent(JSON.stringify(extractRules))}`;

  const result = await httpRequest(fetchUrl, { timeout: 45000 });
  if (result.statusCode !== 200) return null;

  try {
    const data = JSON.parse(result.body);
    // Prefer targeted selector, fall back to body
    const text = (data.main || data.fallback || '').substring(0, 20000);
    return text;
  } catch {
    return result.body.substring(0, 20000);
  }
}

// ============================================================================
// LLM cast extraction
// ============================================================================

async function extractCastWithLLM(pageText, showTitle, showYear, showVenue) {
  // Try Gemini first (cheapest), then Anthropic
  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  const yearLine = showYear ? `Year/season: ${showYear}` : '';
  const venueLine = showVenue ? `Venue/market: ${showVenue}` : '';

  // Wrong-show defense: instruct LLM to refuse when page is about a different
  // production sharing the title. The web-search backfill has historically
  // grabbed pages for: Met Opera productions with the same name (Kavalier &
  // Clay), other shows by the same creative (Sting → "The Last Ship"), or
  // older productions of a same-titled play (Pride 2009 vs Pride 2026 WE).
  const prompt = `Extract the cast members from this web page about the show "${showTitle}".
${yearLine}
${venueLine}

WHEN TO RETURN AN EMPTY ARRAY []:
- The page is about a DIFFERENT show that shares the title (e.g. an opera with the same name, an older revival in a different year, a touring production at a different venue).
- The page is about a different show ENTIRELY (e.g. a "related links" or "you might also like" page).
- The page is an actor's biography page, news article about unrelated cast announcement, or general theatre news.
- The page has cast for a show but the show name / year / venue clearly does not match the target.
- You can't find named cast members, only ensemble or staff.

EXTRACTION RULES (when the page IS about the right show):
- Return ONLY a JSON array of objects with "name" and "role" fields.
- ALWAYS include the role/character name for each actor. If roles are listed, use them.
- Only include named PRINCIPAL roles — exclude ensemble, chorus, swings, standbys, understudies, and unnamed roles.
- If multiple actors play the SAME role (alternates), include only the FIRST actor listed for that role.
- Each person should appear only ONCE in the output.
- The "role" field MUST be a character name (e.g. "Hamlet", "Pegeen Mike") — NEVER a cast-list column header ("Original", "Replacement", "Standby"), NEVER another show title (e.g. "Bridgerton", "Top Boy"), NEVER a biography snippet ("in his first professional role"). If you can't find a real character name, omit the role field.
- "name" MUST be in natural first-last order (e.g. "Gethin Jenkins"), NEVER LASTNAME-FIRSTNAME ("Jenkins Gethin") — if the page lists names "LASTNAME, FIRSTNAME", reverse them.

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

function deriveVenueLabel(category) {
  if (!category) return null;
  if (category === 'broadway') return 'Broadway';
  if (category === 'off-broadway') return 'Off-Broadway, New York';
  if (category === 'west-end' || category === 'off-west-end') return 'West End, London';
  return category;
}

async function callGemini(prompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH}:generateContent?key=${apiKey}`;
  const result = await httpRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } }
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
      model: CLAUDE_HAIKU,
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
  // Use first [ and last ] to capture full array (lazy regex truncates nested objects)
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket === -1 || lastBracket === -1 || lastBracket <= firstBracket) return [];

  try {
    const arr = JSON.parse(text.substring(firstBracket, lastBracket + 1));
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

// Returns { fetchFailed, cast, sourceUrl? }. fetchFailed distinguishes a
// transient failure (SERP error, page fetch error, LLM error, or a blocked/
// too-short page we can't actually read) from a genuine empty (search
// succeeded and every candidate page was read and cleanly rejected, or 0
// search results came back) — mirrors backfill-cast.js's IBDB fix (#712).
// Only genuine empties should be tombstoned; shouldTombstone() reads this.
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
    return { fetchFailed: true, cast: [] };
  }

  if (searchResults.length === 0) {
    console.log(`  No search results found`);
    return { fetchFailed: false, cast: [] };
  }

  // Step 2: Fetch page text and extract cast
  const showIsOpera = /\bopera\b|the met\b/.test(String(show.title || '').toLowerCase());
  let anyTransientFailure = false;

  for (const sr of searchResults) {
    // Skip opera-publication domains for non-opera shows entirely — saves
    // the ScrapingBee fetch + LLM call. Kavalier-Clay landed on parterre.com
    // and the LLM extracted Met Opera cast; this blocks the same class of
    // mistake at the source.
    if (!showIsOpera && isOperaSourceUrl(sr.url)) {
      console.log(`  Skipping opera-domain source: ${sr.url}`);
      continue;
    }

    console.log(`  Fetching: ${sr.url}`);
    await sleep(FETCH_DELAY_MS);

    let pageText;
    try {
      pageText = await fetchPageText(sr.url);
    } catch (e) {
      console.log(`  Fetch error: ${e.message}`);
      anyTransientFailure = true;
      continue;
    }

    // fetchPageText also returns null on a non-200 (blocked/rate-limited)
    // response without throwing — treat that the same as a fetch error, not
    // as "page confirmed empty."
    if (!pageText || pageText.length < 100) {
      console.log(`  Page too short or blocked (${(pageText || '').length} chars)`);
      anyTransientFailure = true;
      continue;
    }

    // Step 3: LLM extraction
    console.log(`  Extracting cast via LLM...`);
    await sleep(LLM_DELAY_MS);

    let cast;
    try {
      cast = await extractCastWithLLM(pageText, show.title, year, deriveVenueLabel(show.category));
    } catch (e) {
      console.log(`  LLM error: ${e.message}`);
      anyTransientFailure = true;
      continue;
    }

    // Step 4: Contamination guards — reject wrong-show extractions even if
    // the LLM dutifully returned cast. Cleaned drops safe-to-strip column-
    // header roles (e.g. "Original" / "Standby") without failing the page.
    const { ok, reasons, cleaned } = validateCastExtraction(cast, show.title);
    if (!ok) {
      console.log(`  Rejected (${reasons.join(', ')}) — trying next page...`);
      continue;
    }

    if (cleaned.length >= 2) {
      console.log(`  Found ${cleaned.length} cast members`);
      return {
        fetchFailed: false,
        cast: cleaned,
        sourceUrl: sr.url,
      };
    }
    console.log(`  Only ${cleaned.length} members found, trying next page...`);
  }

  return { fetchFailed: anyTransientFailure, cast: [] };
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
    // Default: OB + WE shows
    shows = shows.filter(s => {
      const cat = s.category || 'broadway';
      if (categoryFilter && cat !== categoryFilter) return false;
      if (!categoryFilter && cat === 'broadway') return false; // Skip Broadway (use IBDB)
      return true;
    });
  }

  // Skip shows that already have a cast file unless --force — applies even
  // under --show-filter, matching backfill-cast.js's pattern. Without this,
  // `--show-filter=X` (no --force) on a show with a populated cast file would
  // reprocess and could tombstone it with no backup and no circuit-breaker
  // check (both are gated on `force` below) — undercutting this fix's whole
  // purpose for the single-show retry case an operator is most likely to hit.
  if (!force) {
    const beforeExisting = shows.length;
    shows = shows.filter(s => !fs.existsSync(path.join(CAST_DIR, `${s.id}.json`)));
    const skippedExisting = beforeExisting - shows.length;
    if (skippedExisting > 0) {
      console.log(`  Skipping ${skippedExisting} show(s) with existing cast file (use --force to reprocess)`);
    }
  }

  if (limit > 0) shows = shows.slice(0, limit);

  console.log(`  Shows to process: ${shows.length}`);
  if (shows.length === 0) { console.log('Nothing to do.'); return; }

  if (dryRun) {
    shows.forEach(s => console.log(`  Would process: ${s.id} (${s.title}) [${s.category}]`));
    console.log(`\n  Total: ${shows.length}`);
    return;
  }

  // Mass-wipe circuit breaker (--force only): count how many shows about to
  // be reprocessed currently have a populated cast file, mirroring
  // backfill-cast.js's guard (task #712 — the same bug class).
  let populatedBefore = 0;
  if (force) {
    for (const s of shows) {
      try {
        const existing = JSON.parse(fs.readFileSync(path.join(CAST_DIR, `${s.id}.json`), 'utf8'));
        if (Array.isArray(existing.openingNightCast) && existing.openingNightCast.length > 0) populatedBefore++;
      } catch { /* no existing file or unreadable — not "populated" */ }
    }
  }
  const wipedBackups = [];

  // Process shows
  let success = 0, failed = 0, skipped = 0;

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    console.log(`\n[${i + 1}/${shows.length}] ${show.title} (${show.id}) [${show.category}]`);

    try {
      const result = await processShow(show);

      if (!result.cast || result.cast.length < 2) {
        // A transient failure (SERP/fetch/LLM error, blocked page) must NOT
        // be tombstoned — a tombstone permanently blocks re-scraping (default
        // runs skip shows with an existing cast file), so one bad run would
        // empty a show forever. Same class as the IBDB Hamilton incident.
        if (!shouldTombstone(result)) {
          console.log(`  Transient search/fetch failure — NOT tombstoning; will retry next run`);
          failed++;
          continue;
        }

        console.log(`  No usable cast data found`);

        // Back up the existing file before overwriting IF it was populated —
        // the mass-wipe circuit breaker below needs to be able to restore it.
        const existingPath = path.join(CAST_DIR, `${show.id}.json`);
        let wasPopulated = false;
        if (force && fs.existsSync(existingPath)) {
          try {
            const existingRaw = fs.readFileSync(existingPath, 'utf8');
            const existingParsed = JSON.parse(existingRaw);
            if (Array.isArray(existingParsed.openingNightCast) && existingParsed.openingNightCast.length > 0) {
              wasPopulated = true;
              wipedBackups.push({ path: existingPath, content: existingRaw });
            }
          } catch { /* unreadable existing file — nothing to back up */ }
        }

        // Genuine empty (search/pages checked, nothing usable found): write
        // an empty tombstone so we don't re-process a show that truly has none.
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

        if (wasPopulated && shouldAbortMassWipe(populatedBefore, wipedBackups.length)) {
          console.error(`\nMASS-WIPE CIRCUIT BREAKER: ${wipedBackups.length}/${populatedBefore} previously-populated cast files came back empty this run.`);
          console.error(`   Restoring all ${wipedBackups.length} and aborting before more damage.`);
          for (const b of wipedBackups) fs.writeFileSync(b.path, b.content);
          process.exit(1);
        }
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
