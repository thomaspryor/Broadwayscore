#!/usr/bin/env node
/**
 * Scrape Tony Award nominee data from IBDB
 *
 * Extracts person-level Tony nominations/wins for all shows in awards.json.
 * Uses Playwright to handle Cloudflare protection on IBDB.
 *
 * Usage:
 *   node scripts/scrape-tony-nominees.js [--resume] [--test=N]
 *
 * Options:
 *   --resume  Resume from checkpoint (data/tony-nominations-checkpoint.json)
 *   --test=N  Only process first N shows (for testing)
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

async function scrapeShowAwards(page, ibdbUrl, showId, season) {
  const nominations = [];
  const url = ibdbUrl + '#Awards';

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

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
      console.log(`  No Tony Award section found for ${showId}`);
      return nominations;
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

  } catch (err) {
    console.error(`  Error scraping ${showId}: ${err.message}`);
  }

  return nominations;
}

async function main() {
  const args = process.argv.slice(2);
  const resume = args.includes('--resume');
  const testMatch = args.find(a => a.startsWith('--test='));
  const testLimit = testMatch ? parseInt(testMatch.split('=')[1]) : 0;

  // Load awards data
  const awardsData = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
  const showIds = Object.keys(awardsData.shows).filter(id => {
    const show = awardsData.shows[id];
    return show.tony && (show.tony.nominations > 0 || (show.tony.wins && show.tony.wins.length > 0));
  });

  console.log(`Found ${showIds.length} shows with Tony data`);

  // Load cast files to get IBDB URLs
  const castDir = path.join(__dirname, '..', 'data', 'cast');
  const showIbdbUrls = {};
  for (const id of showIds) {
    const castFile = path.join(castDir, id + '.json');
    if (fs.existsSync(castFile)) {
      const cast = JSON.parse(fs.readFileSync(castFile, 'utf8'));
      if (cast.ibdbUrl) {
        showIbdbUrls[id] = cast.ibdbUrl;
      }
    }
  }

  console.log(`${Object.keys(showIbdbUrls).length} shows have IBDB URLs`);

  // Load checkpoint if resuming
  let allNominations = [];
  let processedShows = new Set();

  if (resume && fs.existsSync(CHECKPOINT_FILE)) {
    const checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
    allNominations = checkpoint.nominations || [];
    processedShows = new Set(checkpoint.processedShows || []);
    console.log(`Resuming from checkpoint: ${processedShows.size} shows already processed, ${allNominations.length} nominations`);
  }

  // Filter to unprocessed shows
  let toProcess = showIds.filter(id => !processedShows.has(id) && showIbdbUrls[id]);

  if (testLimit > 0) {
    toProcess = toProcess.slice(0, testLimit);
    console.log(`Test mode: processing ${testLimit} shows`);
  }

  console.log(`${toProcess.length} shows to process`);

  if (toProcess.length === 0) {
    console.log('Nothing to do!');
    if (allNominations.length > 0) {
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

      console.log(`[${i + 1}/${toProcess.length}] ${showId}...`);

      const noms = await scrapeShowAwards(page, ibdbUrl, showId, season);

      if (noms.length > 0) {
        console.log(`  → ${noms.length} nominations (${noms.filter(n => n.won).length} wins)`);
        allNominations.push(...noms);
        consecutiveErrors = 0;
      } else {
        // Check if this show was expected to have nominations
        const expected = awardsData.shows[showId]?.tony?.nominations || 0;
        if (expected > 0) {
          console.log(`  ⚠ Expected ${expected} nominations but found 0`);
          consecutiveErrors++;
        } else {
          consecutiveErrors = 0;
        }
      }

      processedShows.add(showId);

      // Checkpoint every 50 shows
      if ((i + 1) % 50 === 0 || i === toProcess.length - 1) {
        saveCheckpoint(allNominations, processedShows);
        console.log(`  📁 Checkpoint saved (${processedShows.size} shows, ${allNominations.length} nominations)`);
      }

      // Stop if too many consecutive errors (likely rate-limited)
      if (consecutiveErrors >= 10) {
        console.error('⛔ 10 consecutive errors — likely rate-limited. Stopping. Run with --resume to continue.');
        saveCheckpoint(allNominations, processedShows);
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
  writeOutput(allNominations, showIds.length, processedShows.size);
}

function saveCheckpoint(nominations, processedShows) {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({
    nominations,
    processedShows: Array.from(processedShows),
    savedAt: new Date().toISOString(),
  }, null, 2));
}

function writeOutput(nominations, expectedShowCount, actualShowCount) {
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
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
