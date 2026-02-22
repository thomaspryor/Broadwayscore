#!/usr/bin/env node
/**
 * Scrape Tony Award nominee data from IBDB
 *
 * Extracts person-level Tony nominations/wins for all shows in awards.json.
 * Uses Playwright to handle Cloudflare protection on IBDB.
 *
 * Usage:
 *   node scripts/scrape-tony-nominees.js [--resume] [--test=N] [--missing] [--show=ID] [--year=YYYY]
 *
 * Options:
 *   --resume     Resume from checkpoint (data/tony-nominations-checkpoint.json)
 *   --test=N     Only process first N shows (for testing)
 *   --missing    Only process shows where awards.json expects noms but tony-nominations.json has 0
 *   --show=ID    Process a single show by ID (ignores checkpoint)
 *   --year=YYYY  Only process shows from a specific Tony season year
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const AWARDS_FILE = path.join(__dirname, '..', 'data', 'awards.json');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'tony-nominations.json');
const CHECKPOINT_FILE = path.join(__dirname, '..', 'data', 'tony-nominations-checkpoint.json');
const DELAY_MS = 3500; // 3.5s between requests (slower to avoid rate limiting)

// Map IBDB's verbose category names to our short-form names
const CATEGORY_MAP = {
  'Best Musical': 'Best Musical',
  'Best Play': 'Best Play',
  'Best Revival of a Musical': 'Best Revival of a Musical',
  'Best Revival of a Play': 'Best Revival of a Play',
  'Best Revival (Musical or Play)': 'Best Revival of a Musical',
  'Best Book of a Musical': 'Best Book of a Musical',
  'Best Original Score Written for the Theatre': 'Best Original Score',
  'Best Original Score (Music and/or Lyrics) Written for the Theatre': 'Best Original Score',
  'Best Original Musical Score': 'Best Original Score',
  'Best Score': 'Best Original Score',
  'Best Performance by an Actor in a Leading Role in a Musical': 'Best Actor in a Musical',
  'Best Performance by an Actress in a Leading Role in a Musical': 'Best Actress in a Musical',
  'Best Performance by an Actor in a Leading Role in a Play': 'Best Actor in a Play',
  'Best Performance by an Actress in a Leading Role in a Play': 'Best Actress in a Play',
  'Best Performance by an Actor in a Featured Role in a Musical': 'Best Featured Actor in a Musical',
  'Best Performance by an Actress in a Featured Role in a Musical': 'Best Featured Actress in a Musical',
  'Best Performance by an Actor in a Featured Role in a Play': 'Best Featured Actor in a Play',
  'Best Performance by an Actress in a Featured Role in a Play': 'Best Featured Actress in a Play',
  'Best Direction of a Musical': 'Best Direction of a Musical',
  'Best Direction of a Play': 'Best Direction of a Play',
  'Best Choreography': 'Best Choreography',
  'Best Orchestrations': 'Best Orchestrations',
  'Best Scenic Design of a Musical': 'Best Scenic Design of a Musical',
  'Best Scenic Design of a Play': 'Best Scenic Design of a Play',
  'Best Scenic Design': 'Best Scenic Design',
  'Best Costume Design of a Musical': 'Best Costume Design of a Musical',
  'Best Costume Design of a Play': 'Best Costume Design of a Play',
  'Best Costume Design': 'Best Costume Design',
  'Best Lighting Design of a Musical': 'Best Lighting Design of a Musical',
  'Best Lighting Design of a Play': 'Best Lighting Design of a Play',
  'Best Lighting Design': 'Best Lighting Design',
  'Best Sound Design of a Musical': 'Best Sound Design of a Musical',
  'Best Sound Design of a Play': 'Best Sound Design of a Play',
  'Best Sound Design': 'Best Sound Design',
  // Older/retired categories
  'Best Actor in Play': 'Best Actor in a Play',
  'Best Lyrics': 'Best Original Score',
  'Most Innovative Production of a Revival': 'Best Revival of a Musical',
  'Reproduction (Play or Musical)': 'Best Revival of a Play',
  'Best Reproduction (Play or Musical)': 'Best Revival of a Play',
  'Best Reproduction': 'Best Revival of a Play',
  'Best Revival': 'Best Revival of a Play',
};

function mapCategory(ibdbCategory) {
  // Direct map
  if (CATEGORY_MAP[ibdbCategory]) return CATEGORY_MAP[ibdbCategory];

  // Fuzzy match — strip "Best Performance by" prefix patterns
  for (const [long, short] of Object.entries(CATEGORY_MAP)) {
    if (ibdbCategory.toLowerCase().includes(long.toLowerCase())) return short;
  }

  // Return as-is if no match (we'll log these)
  return ibdbCategory;
}

function extractPersonId(url) {
  // URL: /broadway-cast-staff/lin-manuel-miranda-459893
  if (!url) return null;
  const match = url.match(/(\d+)$/);
  return match ? match[1] : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if page is a Cloudflare challenge or IBDB error page.
 * Returns error message if detected, null if page is valid IBDB content.
 */
async function detectPageError(page) {
  const currentUrl = page.url();

  // Cloudflare challenge redirect
  if (currentUrl.includes('/cdn-cgi/') || currentUrl.includes('challenges.cloudflare.com')) {
    return 'Cloudflare challenge detected';
  }

  // Check page content for Cloudflare markers
  const hasCloudflare = await page.evaluate(() => {
    const body = document.body?.innerHTML || '';
    return body.includes('cf-browser-verification') ||
           body.includes('challenge-platform') ||
           body.includes('Checking your browser') ||
           body.includes('cf-challenge');
  }).catch(() => false);

  if (hasCloudflare) {
    return 'Cloudflare challenge page content detected';
  }

  // IBDB 404 / redirect to search
  if (currentUrl.includes('/broadway-search') || currentUrl.includes('/search')) {
    return 'IBDB redirected to search (show not found)';
  }

  return null;
}

async function scrapeShowAwardsInner(page, ibdbUrl, showId, season) {
  const nominations = [];
  const url = ibdbUrl + '#Awards';

  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

  // Check for Cloudflare or error pages
  const pageError = await detectPageError(page);
  if (pageError) {
    throw new Error(pageError);
  }

  // Wait for the Awards tab content to load
  // Click the Awards link to reveal the section — try up to 2 times
  let hasTony = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const awardsLink = page.locator('a[href="#Awards"]').first();
    if (await awardsLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await awardsLink.click();
      await sleep(attempt === 0 ? 1500 : 3000);
    }

    // Wait for Tony Award heading to appear
    const tonyHeading = page.locator('h3:has-text("Tony Award")');
    hasTony = await tonyHeading.isVisible({ timeout: 8000 }).catch(() => false);
    if (hasTony) break;

    // If first attempt failed, scroll to trigger lazy load
    if (attempt === 0) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
      await sleep(1000);
    }
  }

  if (!hasTony) {
    // Not an error — this IBDB page genuinely has no Tony section
    return { nominations, error: null, noTonySection: true };
  }

    // Extract award entries from the page
    // Structure: Each award block has an h4 (category) and text with "YYYY Winner/Nominee"
    // followed by person links
    const entries = await page.evaluate(() => {
      const results = [];

      // Find the Tony Award section
      const h3s = document.querySelectorAll('h3');
      let tonySection = null;
      for (const h3 of h3s) {
        if (h3.textContent.includes('Tony Award')) {
          tonySection = h3.closest('div');
          break;
        }
      }

      if (!tonySection) return results;

      // Get all h4 elements within the Tony section (each is a category)
      // But we need to handle the structure: each category block is a sibling div
      // containing an h4 and the nomination details
      const blocks = tonySection.querySelectorAll(':scope > div, :scope > img + div');

      // Alternative: walk through all children of tonySection
      const children = Array.from(tonySection.children);
      let currentCategory = null;

      for (const child of children) {
        // Skip images (trophy icons)
        if (child.tagName === 'IMG') continue;

        const h4 = child.querySelector('h4');
        if (!h4) continue;

        const category = h4.textContent.trim();
        const detailDiv = child.querySelector('div') || child;
        const text = detailDiv.textContent.trim();

        // Determine winner or nominee
        const isWinner = text.includes('Winner');
        const isNominee = text.includes('Nominee');

        if (!isWinner && !isNominee) continue;

        // Extract year
        const yearMatch = text.match(/(\d{4})\s+(Winner|Nominee)/);
        const year = yearMatch ? parseInt(yearMatch[1]) : null;

        // Extract person links
        const links = child.querySelectorAll('a[href*="/broadway-cast-staff/"]');

        if (links.length > 0) {
          for (const link of links) {
            const name = link.textContent.trim();
            const href = link.getAttribute('href');
            const personId = href ? href.match(/(\d+)$/)?.[1] : null;

            if (name && personId) {
              results.push({
                category,
                name,
                ibdbPersonId: personId,
                won: isWinner,
                year,
              });
            }
          }
        } else {
          // Show-level award (e.g., Best Musical) — no person link
          results.push({
            category,
            name: null,
            ibdbPersonId: null,
            won: isWinner,
            year,
          });
        }
      }

      return results;
    });

    // Convert to our format
    for (const entry of entries) {
      const mappedCategory = mapCategory(entry.category);

      // Determine ceremony number from year
      const ceremony = entry.year ? entry.year - 1946 : null;

      nominations.push({
        season: season || '',
        ceremony: ceremony,
        showId,
        category: mappedCategory,
        name: entry.name || '(show-level)',
        ibdbPersonId: entry.ibdbPersonId || '',
        won: entry.won,
        _ibdbCategory: entry.category, // Keep original for debugging
      });
    }

  return { nominations, error: null, noTonySection: false };
}

/**
 * Scrape Tony data for a show with 2-attempt retry.
 * Returns { nominations: [], error: string|null, noTonySection: boolean }
 */
async function scrapeShowAwards(page, ibdbUrl, showId, season) {
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await scrapeShowAwardsInner(page, ibdbUrl, showId, season);
      return result;
    } catch (err) {
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      const errorMsg = err.message || String(err);
      console.error(`  ERROR ${showId}: ${errorMsg} (attempt ${attempt}/${MAX_ATTEMPTS})`);

      if (!isLastAttempt) {
        console.log(`  Retrying in 5s with extended timeout...`);
        await sleep(5000);
        // For retry, try with a fresh navigation
        await page.goto('about:blank').catch(() => {});
      } else {
        return { nominations: [], error: errorMsg, noTonySection: false };
      }
    }
  }

  // Should not reach here, but safety net
  return { nominations: [], error: 'Unknown error', noTonySection: false };
}

async function main() {
  const args = process.argv.slice(2);
  const resume = args.includes('--resume');
  const testMatch = args.find(a => a.startsWith('--test='));
  const testLimit = testMatch ? parseInt(testMatch.split('=')[1]) : 0;
  const missingOnly = args.includes('--missing');
  const showMatch = args.find(a => a.startsWith('--show='));
  const singleShowId = showMatch ? showMatch.split('=')[1] : null;
  const yearMatch = args.find(a => a.startsWith('--year='));
  const yearFilter = yearMatch ? yearMatch.split('=')[1] : null;

  // Load awards data
  const awardsData = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
  const showIds = Object.keys(awardsData.shows).filter(id => {
    const show = awardsData.shows[id];
    return show.tony && (show.tony.nominations > 0 || (show.tony.wins && show.tony.wins.length > 0));
  });

  console.log(`Found ${showIds.length} shows with Tony data in awards.json`);

  // Load cast files to get IBDB URLs
  const castDir = path.join(__dirname, '..', 'data', 'cast');
  const showIbdbUrls = {};
  let noUrlCount = 0;
  for (const id of showIds) {
    const castFile = path.join(castDir, id + '.json');
    if (fs.existsSync(castFile)) {
      const cast = JSON.parse(fs.readFileSync(castFile, 'utf8'));
      if (cast.ibdbUrl) {
        showIbdbUrls[id] = cast.ibdbUrl;
      } else {
        noUrlCount++;
      }
    } else {
      noUrlCount++;
    }
  }

  console.log(`${Object.keys(showIbdbUrls).length} shows have IBDB URLs (${noUrlCount} missing)`);

  // Load checkpoint if resuming
  let allNominations = [];
  let processedShows = new Set();
  let failedShows = new Map(); // showId → { reason, failedAt }

  if (resume && fs.existsSync(CHECKPOINT_FILE)) {
    const checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
    allNominations = checkpoint.nominations || [];
    processedShows = new Set(checkpoint.processedShows || []);
    // Load failed shows from checkpoint (new format)
    if (checkpoint.failedShows) {
      for (const entry of checkpoint.failedShows) {
        if (typeof entry === 'string') {
          failedShows.set(entry, { reason: 'unknown', failedAt: checkpoint.savedAt });
        } else {
          failedShows.set(entry.showId, { reason: entry.reason, failedAt: entry.failedAt });
        }
      }
    }
    console.log(`Resuming from checkpoint: ${processedShows.size} processed, ${failedShows.size} failed, ${allNominations.length} nominations`);
  }

  // Determine which shows to process based on flags
  let toProcess;

  if (singleShowId) {
    // --show=ID mode: process a single show regardless of checkpoint
    if (!showIbdbUrls[singleShowId]) {
      console.error(`Show ${singleShowId} has no IBDB URL. Cannot scrape.`);
      process.exit(1);
    }
    toProcess = [singleShowId];
    console.log(`Single-show mode: ${singleShowId}`);
  } else if (missingOnly) {
    // --missing mode: only shows where awards.json expects noms but tony-nominations.json has 0
    const existingData = fs.existsSync(OUTPUT_FILE)
      ? JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'))
      : { nominations: [] };
    const existingByShow = new Map();
    for (const n of existingData.nominations) {
      if (n.name !== '(show-level)') {
        existingByShow.set(n.showId, (existingByShow.get(n.showId) || 0) + 1);
      }
    }
    toProcess = showIds.filter(id => {
      const expected = awardsData.shows[id]?.tony?.nominations || 0;
      const actual = existingByShow.get(id) || 0;
      return expected > 0 && actual === 0 && showIbdbUrls[id];
    });
    // Also load existing nominations so we can merge
    allNominations = existingData.nominations || [];
    console.log(`Missing-only mode: ${toProcess.length} shows with 0 person-level noms (expected > 0)`);
  } else {
    // Normal mode: filter by unprocessed + has URL
    // Note: failedShows are NOT in processedShows, so they're automatically retried
    toProcess = showIds.filter(id => !processedShows.has(id) && showIbdbUrls[id]);
  }

  // Apply year filter if specified
  if (yearFilter) {
    toProcess = toProcess.filter(id => {
      const season = awardsData.shows[id]?.tony?.season || '';
      return season.startsWith(yearFilter);
    });
    console.log(`Year filter (${yearFilter}): ${toProcess.length} shows`);
  }

  if (testLimit > 0) {
    toProcess = toProcess.slice(0, testLimit);
    console.log(`Test mode: processing ${testLimit} shows`);
  }

  console.log(`${toProcess.length} shows to process`);

  if (toProcess.length === 0) {
    console.log('Nothing to do!');
    if (allNominations.length > 0 && !missingOnly) {
      writeOutput(allNominations, showIds.length, processedShows.size);
    }
    return;
  }

  // Launch browser
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  let consecutiveErrors = 0;

  try {
    for (let i = 0; i < toProcess.length; i++) {
      const showId = toProcess[i];
      const ibdbUrl = showIbdbUrls[showId];
      const season = awardsData.shows[showId]?.tony?.season || '';
      const expected = awardsData.shows[showId]?.tony?.nominations || 0;

      console.log(`[${i + 1}/${toProcess.length}] ${showId}...`);

      const result = await scrapeShowAwards(page, ibdbUrl, showId, season);

      if (result.error) {
        // Scrape failed with an error — add to failedShows, NOT processedShows
        console.log(`  ✗ Failed: ${result.error}`);
        failedShows.set(showId, { reason: result.error, failedAt: new Date().toISOString() });
        consecutiveErrors++;
      } else if (result.nominations.length > 0) {
        // Success with data
        console.log(`  → ${result.nominations.length} nominations (${result.nominations.filter(n => n.won).length} wins)`);
        allNominations.push(...result.nominations);
        processedShows.add(showId);
        failedShows.delete(showId); // Clear any previous failure
        consecutiveErrors = 0;
      } else if (result.noTonySection) {
        // IBDB page loaded but genuinely has no Tony section
        if (expected > 0) {
          console.log(`  ⚠ No Tony section on IBDB (expected ${expected} noms) — marking processed`);
        }
        processedShows.add(showId);
        failedShows.delete(showId);
        consecutiveErrors = 0;
      } else {
        // Page loaded, Tony section found, but 0 entries extracted — unexpected
        if (expected > 0) {
          console.log(`  ⚠ Tony section found but 0 entries (expected ${expected}) — marking failed`);
          failedShows.set(showId, { reason: 'zero-entries-unexpected', failedAt: new Date().toISOString() });
          consecutiveErrors++;
        } else {
          processedShows.add(showId);
          consecutiveErrors = 0;
        }
      }

      // Checkpoint every 50 shows
      if ((i + 1) % 50 === 0 || i === toProcess.length - 1) {
        saveCheckpoint(allNominations, processedShows, failedShows);
        console.log(`  📁 Checkpoint saved (${processedShows.size} processed, ${failedShows.size} failed, ${allNominations.length} noms)`);
      }

      // Stop if too many consecutive errors (likely rate-limited)
      if (consecutiveErrors >= 10) {
        console.error('⛔ 10 consecutive errors — likely rate-limited or Cloudflare blocked. Stopping.');
        console.error('   Run with --resume to continue later.');
        saveCheckpoint(allNominations, processedShows, failedShows);
        break;
      }

      // Rate limit
      if (i < toProcess.length - 1) {
        await sleep(DELAY_MS);
      }
    }
  } finally {
    await browser.close();
  }

  // Write final output
  writeOutput(allNominations, showIds.length, processedShows.size, awardsData);
}

function saveCheckpoint(nominations, processedShows, failedShows) {
  const failedArray = Array.from(failedShows.entries()).map(([showId, info]) => ({
    showId,
    reason: info.reason,
    failedAt: info.failedAt,
  }));
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({
    nominations,
    processedShows: Array.from(processedShows),
    failedShows: failedArray,
    savedAt: new Date().toISOString(),
  }, null, 2));
}

function writeOutput(nominations, expectedShowCount, actualShowCount, awardsData) {
  // Remove _ibdbCategory debug field from final output
  const cleaned = nominations.map(({ _ibdbCategory, ...rest }) => rest);

  // Deduplicate: same (showId, category, ibdbPersonId) should appear only once
  const seen = new Set();
  const deduped = cleaned.filter(n => {
    const key = `${n.showId}|${n.category}|${n.ibdbPersonId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (deduped.length < cleaned.length) {
    console.log(`  Deduped: ${cleaned.length} → ${deduped.length} (removed ${cleaned.length - deduped.length} duplicates)`);
  }

  const finalNominations = deduped;

  // === REGRESSION GATE ===
  // If previous data exists, abort if we'd lose >5% of nominations
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      const previous = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      const previousCount = previous._meta?.totalNominations || previous.nominations?.length || 0;
      if (previousCount > 0 && finalNominations.length < previousCount * 0.95) {
        console.error(`\n⛔ REGRESSION GATE: Refusing to write output!`);
        console.error(`   Previous: ${previousCount} nominations`);
        console.error(`   New:      ${finalNominations.length} nominations`);
        console.error(`   This is a ${Math.round((1 - finalNominations.length / previousCount) * 100)}% drop — likely a scraping failure.`);
        console.error(`   To force, delete ${OUTPUT_FILE} first, then re-run.`);
        process.exit(1);
      }
    } catch (e) {
      // If we can't read previous file, proceed (don't block on parse error)
    }
  }

  const output = {
    _meta: {
      description: 'Person-level Tony Award nominations and wins',
      lastUpdated: new Date().toISOString().split('T')[0],
      source: 'IBDB',
      coverage: '1970-present',
      expectedShowCount,
      actualShowCount,
      totalNominations: finalNominations.length,
      totalWins: finalNominations.filter(n => n.won).length,
    },
    nominations: finalNominations,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n✅ Written ${finalNominations.length} nominations to ${OUTPUT_FILE}`);
  console.log(`   ${output._meta.totalWins} wins, ${finalNominations.length - output._meta.totalWins} nominations-only`);
  console.log(`   ${actualShowCount}/${expectedShowCount} shows processed`);

  // Report unmatched categories
  const unmapped = finalNominations.filter(n => !Object.values(CATEGORY_MAP).includes(n.category));
  if (unmapped.length > 0) {
    const uniqueUnmapped = [...new Set(unmapped.map(n => n.category))];
    console.log(`\n⚠ ${uniqueUnmapped.length} unmapped categories:`);
    uniqueUnmapped.forEach(c => console.log(`   - ${c}`));
  }

  // === POST-SCRAPE SUMMARY ===
  if (awardsData) {
    const gaps = [];
    const covered = [];
    const nomsByShow = new Map();
    for (const n of finalNominations) {
      nomsByShow.set(n.showId, (nomsByShow.get(n.showId) || 0) + 1);
    }

    for (const [id, show] of Object.entries(awardsData.shows)) {
      if (!show.tony || show.tony.nominations <= 0) continue;
      const actual = nomsByShow.get(id) || 0;
      if (actual > 0) {
        covered.push(id);
      } else {
        gaps.push({ showId: id, expected: show.tony.nominations, actual: 0 });
      }
    }

    console.log(`\n=== POST-SCRAPE SUMMARY ===`);
    console.log(`  Shows with data: ${covered.length}`);
    console.log(`  Shows with gaps (expected > 0, actual = 0): ${gaps.length}`);

    if (gaps.length > 10) {
      console.log(`  ⚠ WARNING: ${gaps.length} shows have zero data — likely scraping issues`);
    }

    if (gaps.length > 0) {
      console.log(`  Top gaps:`);
      gaps.sort((a, b) => b.expected - a.expected).slice(0, 10).forEach(g => {
        console.log(`    ${g.showId}: expected ${g.expected}`);
      });
    }

    // Write audit file
    const auditDir = path.join(__dirname, '..', 'data', 'audit');
    if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'tony-coverage-gaps.json'),
      JSON.stringify(gaps, null, 2)
    );
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
