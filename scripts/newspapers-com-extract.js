#!/usr/bin/env node
/**
 * Newspapers.com Review Extraction — Search + OCR Pipeline
 *
 * Searches newspapers.com for Broadway reviews in scanned newspaper archives,
 * extracts OCR text via network interception, and creates review seed files.
 *
 * Requires a persistent browser profile with active newspapers.com login.
 * Run `node scripts/paywall-browser-login.js --site=newspapers` first.
 *
 * Usage:
 *   # Search + extract for a show (both Daily News and Newsday)
 *   node scripts/newspapers-com-extract.js --show=funny-girl-2022
 *
 *   # Search one paper only
 *   node scripts/newspapers-com-extract.js --show=funny-girl-2022 --paper=dailynews
 *   node scripts/newspapers-com-extract.js --show=funny-girl-2022 --paper=newsday
 *
 *   # Search only (don't extract OCR)
 *   node scripts/newspapers-com-extract.js --show=funny-girl-2022 --search-only
 *
 *   # Extract OCR from a known image ID
 *   node scripts/newspapers-com-extract.js --show=funny-girl-2022 --image=123456 --paper=dailynews --critic="Joe Dziemianowicz"
 *
 *   # Batch: process multiple shows from a file (one show ID per line)
 *   node scripts/newspapers-com-extract.js --shows-file=/tmp/shows.txt
 *
 *   # Wider date search (default is opening ± 3 days)
 *   node scripts/newspapers-com-extract.js --show=funny-girl-2022 --date-range=7
 */

const fs = require('fs');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────────────────

const PROFILE_DIR = '/tmp/newspapers-browser-profile';

const PAPERS = {
  dailynews: {
    name: 'New York Daily News',
    outletId: 'nydailynews',
    outlet: 'New York Daily News',
    searchName: 'Daily News',
    resultName: 'Daily News',
    location: 'new york',
    critics: [
      { name: 'Chris Jones', years: [2017, 2026] },
      { name: 'Joe Dziemianowicz', years: [2005, 2017] },
      { name: 'Howard Kissel', years: [1985, 2005] },
      { name: 'Douglas Watt', years: [1970, 1985] },
    ],
  },
  newsday: {
    name: 'Newsday',
    outletId: 'newsday',
    outlet: 'Newsday',
    searchName: 'Newsday',
    resultName: 'Newsday',
    location: null, // Newsday name is unique enough
    critics: [
      { name: 'Barbara Schuler', years: [2015, 2026] },
      { name: 'Linda Winer', years: [1987, 2017] },
    ],
  },
  latimes: {
    name: 'Los Angeles Times',
    outletId: 'latimes',
    outlet: 'Los Angeles Times',
    searchName: 'Los Angeles Times',
    resultName: 'The Los Angeles Times',
    location: 'los angeles',
    critics: [
      { name: 'Charles McNulty', years: [2005, 2026] },
    ],
  },
  chicagotribune: {
    name: 'Chicago Tribune',
    outletId: 'chicagotribune',
    outlet: 'Chicago Tribune',
    searchName: 'Chicago Tribune',
    resultName: 'Chicago Tribune',
    location: 'chicago',
    critics: [
      { name: 'Chris Jones', years: [2002, 2026] },
    ],
  },
  philinquirer: {
    name: 'Philadelphia Inquirer',
    outletId: 'philadelphiainquirer',
    outlet: 'Philadelphia Inquirer',
    searchName: 'Philadelphia Inquirer',
    resultName: 'The Philadelphia Inquirer',
    location: 'philadelphia',
    critics: [
      { name: 'Howard Shapiro', years: [2000, 2015] },
    ],
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (prefix) => {
    const arg = args.find(a => a.startsWith(`--${prefix}=`));
    return arg ? arg.split('=').slice(1).join('=') : null;
  };
  return {
    show: get('show'),
    showsFile: get('shows-file'),
    paper: get('paper'),
    image: get('image'),
    critic: get('critic'),
    dateRange: parseInt(get('date-range') || '3', 10),
    searchOnly: args.includes('--search-only'),
    verbose: args.includes('--verbose'),
  };
}

function loadShow(showId) {
  const shows = JSON.parse(fs.readFileSync('data/shows.json', 'utf8')).shows;
  const show = shows.find(s => s.id === showId);
  if (!show) throw new Error(`Show not found: ${showId}`);
  if (!show.openingDate) throw new Error(`Show ${showId} has no opening date`);
  return show;
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function dateRange(openingDate, rangeDays) {
  const d = new Date(openingDate);
  // Reviews typically appear the day after opening, but search a range
  const start = new Date(d);
  start.setDate(start.getDate() - 1); // day before opening
  const end = new Date(d);
  end.setDate(end.getDate() + rangeDays);
  return { start: formatDate(start), end: formatDate(end) };
}

function likelyCritic(paper, year) {
  for (const c of paper.critics) {
    if (year >= c.years[0] && year <= c.years[1]) return c.name;
  }
  return null;
}

function makeSeedFilename(outletId, criticName) {
  const slug = (criticName || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-');
  return `${outletId}--${slug}-bway.json`;
}

/**
 * Parse a human-readable date string like "April 25, 2022" into "2022-04-25".
 */
function parseDateStr(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
  } catch {
    return null;
  }
}

/**
 * Quick relevance check: does the OCR text mention the show title?
 * OCR is garbled, so we check for individual words from the title.
 */
function isRelevantOcr(ocrText, showTitle) {
  if (!ocrText || !showTitle) return false;
  const words = showTitle.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const textLower = ocrText.toLowerCase();
  // At least half the significant title words should appear
  const matches = words.filter(w => textLower.includes(w));
  return matches.length >= Math.ceil(words.length / 2);
}

function seedFileExists(showId, outletId) {
  const dir = path.join('data', 'review-texts', showId);
  if (!fs.existsSync(dir)) return false;
  const files = fs.readdirSync(dir);
  return files.some(f => f.startsWith(`${outletId}--`) && f.endsWith('.json'));
}

// ─── OCR Extraction ──────────────────────────────────────────────────────────

/**
 * Extract OCR text from a newspapers.com image page by intercepting the /ocr/ API response.
 * Returns the raw OCR text (one word per line, may be garbled from multi-column layout).
 */
async function extractOcrFromImage(page, imageId, verbose) {
  return new Promise(async (resolve) => {
    let ocrText = '';
    let ocrReceived = false;

    const handler = async (response) => {
      const url = response.url();
      if (url.includes('/ocr/') && url.includes(String(imageId))) {
        try {
          const json = await response.json();
          ocrText = json.ocr || '';
          ocrReceived = true;
          if (verbose) console.log(`    OCR intercepted: ${ocrText.length} chars`);
        } catch (e) {
          if (verbose) console.log(`    OCR parse error: ${e.message}`);
        }
      }
    };

    page.on('response', handler);

    try {
      await page.goto(`https://www.newspapers.com/image/${imageId}/`, {
        timeout: 30000,
        waitUntil: 'domcontentloaded',
      });
    } catch (e) {
      console.log(`    Navigation error: ${e.message}`);
    }

    // Wait up to 12 seconds for OCR response
    for (let i = 0; i < 24; i++) {
      if (ocrReceived) break;
      await page.waitForTimeout(500);
    }

    page.off('response', handler);

    if (!ocrReceived) {
      // Try scrolling/clicking to trigger OCR load
      if (verbose) console.log('    No OCR intercepted, trying page interaction...');
      // Some pages need a click or scroll to trigger the OCR request
      await page.evaluate(() => window.scrollBy(0, 300));
      await page.waitForTimeout(3000);
    }

    resolve(ocrText);
  });
}

/**
 * Reconstruct raw OCR into readable paragraphs.
 * OCR from newspapers.com comes as one-word-per-line with column garbling.
 * This does basic cleanup; the LLM scorer handles the rest.
 */
function reconstructOcr(rawOcr) {
  if (!rawOcr) return '';

  // Join words that are on consecutive lines (likely same paragraph)
  const lines = rawOcr.split('\n');
  const paragraphs = [];
  let current = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current.length > 0) {
        paragraphs.push(current.join(' '));
        current = [];
      }
    } else {
      current.push(trimmed);
    }
  }
  if (current.length > 0) {
    paragraphs.push(current.join(' '));
  }

  return paragraphs.join('\n\n');
}

// ─── Search ──────────────────────────────────────────────────────────────────

/**
 * Search newspapers.com for a show review in a specific paper.
 * Returns array of search result objects with image IDs and snippets.
 */
async function searchForReview(page, showTitle, paperConfig, dateStart, dateEnd, verbose) {
  // Clean show title for search:
  // - Remove year suffixes
  // - Remove subtitles after colon (search for main title only)
  // - Clean special characters
  let searchTitle = showTitle
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"');

  // For titles with colons/subtitles, use just the main title (before colon)
  // "Pretty Woman: The Musical" → "Pretty Woman"
  // "Tina: The Tina Turner Musical" → "Tina Turner" (handled below)
  if (searchTitle.includes(':')) {
    searchTitle = searchTitle.split(':')[0].trim();
  }

  // For very short or generic titles, add "musical" or "Broadway" outside quotes
  // to disambiguate. e.g., "Tina" → search for "Tina" + musical
  const isShortTitle = searchTitle.length <= 6;

  // newspapers.com URL format: /search/results/ with keyword=, date-start=, date-end= (hyphens)
  // p_title= filter is UNRELIABLE — instead, include paper name in keyword to surface results
  // from that paper. Without this, max-10 results get crowded out by other papers.
  const extra = isShortTitle ? ' musical' : '';
  const keyword = encodeURIComponent(`"${searchTitle}"${extra} "${paperConfig.searchName}"`);
  const url = `https://www.newspapers.com/search/results/?keyword=${keyword}&date-start=${dateStart}&date-end=${dateEnd}`;

  console.log(`  Searching: ${searchTitle} in ${paperConfig.name} (${dateStart} to ${dateEnd})`);
  if (verbose) console.log(`  URL: ${url}`);

  try {
    await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });
  } catch (e) {
    console.log(`  Navigation error: ${e.message}`);
    return [];
  }

  // Wait for search results to load
  await page.waitForTimeout(6000);

  // Check if logged in (search without login shows "0 matches" or login prompt)
  const needsLogin = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    return text.includes('Sign in') && text.includes('newspapers.com account')
      || text.includes('0 results');
  });

  if (needsLogin) {
    console.log('  WARNING: May not be logged in. Run paywall-browser-login.js --site=newspapers first.');
  }

  // Extract search results using newspapers.com's specific DOM structure
  const results = await page.evaluate(() => {
    const items = [];
    // Each result is a div with class containing "ArticleResult" and id = imageId
    const resultDivs = document.querySelectorAll('[class*="ArticleResult"]');

    for (const div of resultDivs) {
      const imageId = div.id;
      if (!imageId || !/^\d+$/.test(imageId)) continue;

      // The details link has class containing "NewspageDetails"
      // Format: "Paper Name • Page X DayOfWeek, Month DD, YYYYCity, State"
      const detailsLink = div.querySelector('[class*="NewspageDetails"]');
      const detailsText = detailsLink ? detailsLink.textContent.trim() : '';

      // Parse paper name (before •)
      const parts = detailsText.split('•');
      const paper = parts[0] ? parts[0].trim() : '';
      const rest = parts[1] ? parts[1].trim() : '';

      // Extract page number
      const pageMatch = rest.match(/Page\s+([A-Z]?\d+)/i);
      const pageNum = pageMatch ? pageMatch[1] : '';

      // Extract date (format: "DayOfWeek, Month DD, YYYY")
      const dateMatch = rest.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+(\w+\s+\d+,\s+\d{4})/);
      const dateStr = dateMatch ? dateMatch[1] : '';

      // Extract location — appears after the date: "...April 25, 2022New York, New York"
      const locationMatch = detailsText.match(/\d{4}([A-Z][\w\s]+,\s*[\w\s]+?)(?:\d|$)/);
      const location = locationMatch ? locationMatch[1].trim() : '';

      items.push({ imageId, paper, pageNum, dateStr, location, fullDetails: detailsText });
    }

    return items;
  });

  // Filter results to match the target paper by result name + location
  // Generic names like "Daily News" appear in many papers (Naples, Beauregard, etc.)
  const filtered = results.filter(r => {
    if (!r.paper) return true;
    const paperLower = r.paper.toLowerCase();
    const locationLower = (r.location || '').toLowerCase();

    // Check paper name matches
    const nameMatch = paperLower.includes(paperConfig.resultName.toLowerCase())
      || paperConfig.resultName.toLowerCase().includes(paperLower);

    if (!nameMatch) return false;

    // If a location filter is configured, verify it too (handles "Naples Daily News" etc.)
    if (paperConfig.location) {
      return locationLower.includes(paperConfig.location);
    }
    return true;
  });

  if (filtered.length < results.length) {
    console.log(`  Filtered: ${results.length} total → ${filtered.length} matching ${paperConfig.name}`);
    if (verbose) {
      const excluded = results.filter(r => !filtered.includes(r));
      for (const r of excluded.slice(0, 5)) {
        console.log(`    Excluded: Image ${r.imageId} from "${r.paper}" (${r.location || '?'}, ${r.dateStr})`);
      }
    }
  }

  if (filtered.length === 0 && results.length > 0) {
    const papers = [...new Set(results.map(r => `${r.paper} (${r.location || '?'})`))].join(', ');
    console.log(`  No results matching ${paperConfig.name} from New York — found: ${papers}`);
  }

  const finalResults = filtered.length > 0 ? filtered : [];

  console.log(`  Found ${finalResults.length} search results`);
  return finalResults;
}

// ─── Save ────────────────────────────────────────────────────────────────────

function saveSeedFile(showId, paperConfig, criticName, imageId, publishDate, rawOcr, reconstructedText) {
  const dir = path.join('data', 'review-texts', showId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const filename = makeSeedFilename(paperConfig.outletId, criticName);
  const filepath = path.join(dir, filename);

  // Don't overwrite existing files with text
  if (fs.existsSync(filepath)) {
    const existing = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    if (existing.fullText && existing.fullText.length > 100) {
      console.log(`  File already exists with text: ${filepath}`);
      return filepath;
    }
  }

  const seed = {
    showId,
    outletId: paperConfig.outletId,
    outlet: paperConfig.outlet,
    criticName: criticName || 'Unknown',
    url: `https://www.newspapers.com/image/${imageId}/`,
    publishDate: publishDate || null,
    fullText: reconstructedText,
    isFullReview: true,
    source: 'newspapers-com-ocr',
    productionNote: `OCR extracted from scanned ${paperConfig.name} page via newspapers.com.`,
    title: null,
    fetchMethod: 'newspapers-com-extract',
    textFetchedAt: new Date().toISOString(),
    ocrRawLength: rawOcr.length,
    ocrReconstructedLength: reconstructedText.length,
    newspapersComImageId: imageId,
  };

  fs.writeFileSync(filepath, JSON.stringify(seed, null, 2) + '\n');
  console.log(`  Saved: ${filepath} (${reconstructedText.length} chars)`);
  return filepath;
}

// ─── Main Pipeline ───────────────────────────────────────────────────────────

async function processShow(page, showId, opts) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing: ${showId}`);
  console.log('='.repeat(60));

  // Load show data
  let show;
  try {
    show = loadShow(showId);
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
    return { showId, status: 'error', error: e.message };
  }

  const openYear = new Date(show.openingDate).getFullYear();
  const { start, end } = dateRange(show.openingDate, opts.dateRange);

  console.log(`  Title: ${show.title}`);
  console.log(`  Opening: ${show.openingDate}`);
  console.log(`  Search range: ${start} to ${end}`);

  // Determine which papers to search
  const papersToSearch = opts.paper
    ? [PAPERS[opts.paper]].filter(Boolean)
    : Object.values(PAPERS);

  if (opts.paper && !PAPERS[opts.paper]) {
    console.log(`ERROR: Unknown paper "${opts.paper}". Options: ${Object.keys(PAPERS).join(', ')}`);
    return { showId, status: 'error', error: `Unknown paper: ${opts.paper}` };
  }

  const results = { showId, papers: {} };

  for (const paper of papersToSearch) {
    console.log(`\n--- ${paper.name} ---`);

    // Check if we already have a review from this outlet
    if (seedFileExists(showId, paper.outletId)) {
      console.log(`  Already have a review file for ${paper.outletId} — skipping`);
      results.papers[paper.outletId] = { status: 'skipped', reason: 'exists' };
      continue;
    }

    // If a specific image ID was provided, extract directly
    if (opts.image && opts.paper) {
      console.log(`  Extracting OCR from image ${opts.image}...`);
      const rawOcr = await extractOcrFromImage(page, opts.image, opts.verbose);

      if (!rawOcr) {
        console.log('  No OCR text received. Image may be blank or session expired.');
        results.papers[paper.outletId] = { status: 'no-ocr' };
        continue;
      }

      const text = reconstructOcr(rawOcr);
      console.log(`  OCR: ${rawOcr.length} raw chars -> ${text.length} reconstructed chars`);
      console.log(`  Preview: ${text.slice(0, 200).replace(/\n/g, ' ')}...`);

      const criticName = opts.critic || likelyCritic(paper, openYear) || 'Unknown';
      saveSeedFile(showId, paper, criticName, opts.image, null, rawOcr, text);
      results.papers[paper.outletId] = { status: 'extracted', imageId: opts.image, chars: text.length };
      continue;
    }

    // Search for the review
    const searchResults = await searchForReview(page, show.title, paper, start, end, opts.verbose);

    if (searchResults.length === 0) {
      console.log(`  No results found for ${show.title} in ${paper.name}`);
      results.papers[paper.outletId] = { status: 'not-found' };
      continue;
    }

    // Display search results
    console.log(`\n  Search results:`);
    for (let i = 0; i < searchResults.length; i++) {
      const r = searchResults[i];
      const info = [r.paper, r.pageNum ? `p.${r.pageNum}` : '', r.dateStr].filter(Boolean).join(', ');
      console.log(`    [${i}] Image ${r.imageId} — ${info || r.fullDetails.slice(0, 100)}`);
    }

    if (opts.searchOnly) {
      results.papers[paper.outletId] = { status: 'search-only', count: searchResults.length };
      continue;
    }

    // Try each search result until we find a relevant one
    let extracted = false;
    for (let ri = 0; ri < Math.min(searchResults.length, 3); ri++) {
      const candidate = searchResults[ri];
      console.log(`\n  Trying result [${ri}]: Image ${candidate.imageId} (${candidate.paper || '?'}, ${candidate.dateStr || '?'})...`);
      const rawOcr = await extractOcrFromImage(page, candidate.imageId, opts.verbose);

      if (!rawOcr) {
        console.log('    No OCR text received.');
        continue;
      }

      const text = reconstructOcr(rawOcr);
      console.log(`    OCR: ${rawOcr.length} raw → ${text.length} reconstructed chars`);

      // Quality checks
      if (text.length < 100) {
        console.log(`    Too short (${text.length} chars) — skipping`);
        continue;
      }

      // Relevance check: does it mention the show?
      if (!isRelevantOcr(text, show.title)) {
        console.log(`    Not relevant (no mention of "${show.title}") — skipping`);
        console.log(`    Preview: ${text.slice(0, 150).replace(/\n/g, ' ')}...`);
        continue;
      }

      console.log(`    Relevant: mentions "${show.title}"`);
      console.log(`    Preview: ${text.slice(0, 200).replace(/\n/g, ' ')}...`);

      const criticName = opts.critic || likelyCritic(paper, openYear) || 'Unknown';
      const publishDate = parseDateStr(candidate.dateStr);
      saveSeedFile(showId, paper, criticName, candidate.imageId, publishDate, rawOcr, text);
      results.papers[paper.outletId] = { status: 'extracted', imageId: candidate.imageId, chars: text.length };
      extracted = true;
      break;
    }

    if (!extracted) {
      console.log(`  Could not find a relevant review in ${searchResults.length} results`);
      results.papers[paper.outletId] = { status: 'not-relevant', tried: Math.min(searchResults.length, 3) };
    }

    // Delay between papers to avoid rate limiting
    await page.waitForTimeout(3000);
  }

  return results;
}

async function main() {
  const opts = parseArgs();

  if (!opts.show && !opts.showsFile && !opts.image) {
    console.error('Newspapers.com Review Extraction Pipeline');
    console.error('');
    console.error('Usage:');
    console.error('  node scripts/newspapers-com-extract.js --show=SHOW_ID [options]');
    console.error('');
    console.error('Options:');
    console.error('  --show=ID          Show ID from shows.json');
    console.error('  --shows-file=FILE  File with one show ID per line');
    console.error('  --paper=NAME       Paper: dailynews, newsday (default: both)');
    console.error('  --image=ID         Extract specific newspapers.com image ID');
    console.error('  --critic=NAME      Override critic name');
    console.error('  --date-range=N     Days after opening to search (default: 3)');
    console.error('  --search-only      Search only, don\'t extract OCR');
    console.error('  --verbose          Extra debug output');
    console.error('');
    console.error('Prerequisites:');
    console.error('  node scripts/paywall-browser-login.js --site=newspapers');
    process.exit(1);
  }

  // Check profile exists
  if (!fs.existsSync(PROFILE_DIR)) {
    console.error(`No browser profile at ${PROFILE_DIR}`);
    console.error('Run first: node scripts/paywall-browser-login.js --site=newspapers');
    process.exit(1);
  }

  // Collect show IDs to process
  let showIds = [];
  if (opts.show) {
    showIds = [opts.show];
  } else if (opts.showsFile) {
    showIds = fs.readFileSync(opts.showsFile, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
    console.log(`Loaded ${showIds.length} shows from ${opts.showsFile}`);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('Newspapers.com Review Extraction Pipeline');
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log(`Shows: ${showIds.length}`);
  console.log(`Papers: ${opts.paper || 'all (' + Object.values(PAPERS).map(p => p.name).join(', ') + ')'}`);
  console.log(`Mode: ${opts.searchOnly ? 'search only' : 'search + extract'}`);
  console.log('='.repeat(60));

  const { chromium } = require('playwright');

  console.log('\nLaunching browser (headed — required for newspapers.com)...');
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1200, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  const page = context.pages()[0] || await context.newPage();

  // Quick login check
  console.log('Verifying login...');
  await page.goto('https://www.newspapers.com/', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const loggedIn = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    return text.includes('My Account') || text.includes('account') || !text.includes('Sign In');
  });
  if (!loggedIn) {
    console.log('WARNING: May not be logged in. Results may be empty.');
  } else {
    console.log('Login verified.');
  }

  // Process each show
  const allResults = [];
  for (let i = 0; i < showIds.length; i++) {
    if (showIds.length > 1) {
      console.log(`\n[${'='.repeat(20)} ${i + 1}/${showIds.length} ${'='.repeat(20)}]`);
    }

    const result = await processShow(page, showIds[i], opts);
    allResults.push(result);

    // Save progress after each show
    fs.writeFileSync('/tmp/newspapers-extract-progress.json', JSON.stringify(allResults, null, 2));

    // Delay between shows
    if (i < showIds.length - 1) {
      await page.waitForTimeout(5000);
    }
  }

  // ─── Summary ─────────────────────────────────────────────────────────────

  console.log(`\n${'='.repeat(60)}`);
  console.log('EXTRACTION SUMMARY');
  console.log('='.repeat(60));

  let totalExtracted = 0;
  let totalNotFound = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const r of allResults) {
    const statuses = Object.values(r.papers || {});
    const extracted = statuses.filter(s => s.status === 'extracted' || s.status === 'extracted-fallback').length;
    const notFound = statuses.filter(s => s.status === 'not-found' || s.status === 'no-ocr' || s.status === 'too-short').length;
    const skipped = statuses.filter(s => s.status === 'skipped').length;

    totalExtracted += extracted;
    totalNotFound += notFound;
    totalSkipped += skipped;
    if (r.status === 'error') totalErrors++;

    const statusStr = Object.entries(r.papers || {})
      .map(([outlet, s]) => `${outlet}: ${s.status}${s.chars ? ` (${s.chars} chars)` : ''}`)
      .join(', ');
    console.log(`  ${r.showId}: ${statusStr || r.error || 'no papers processed'}`);
  }

  console.log(`\nTotals: ${totalExtracted} extracted, ${totalNotFound} not found, ${totalSkipped} skipped, ${totalErrors} errors`);
  console.log(`Progress saved to /tmp/newspapers-extract-progress.json`);

  await context.close();
  console.log('\nDone. Browser closed.');
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
