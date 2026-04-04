#!/usr/bin/env node
/**
 * Extract reviews from Theatre Record (theatrerecord.com)
 *
 * Logs in with subscriber credentials, searches for shows, extracts
 * full review text from HTML production pages (post-2022 content).
 *
 * Usage:
 *   node scripts/extract-theatre-record.js --show=les-miserables-west-end-2021
 *   node scripts/extract-theatre-record.js --open-we          # All open WE shows
 *   node scripts/extract-theatre-record.js --open-we --dry-run
 *   node scripts/extract-theatre-record.js --long-running      # Open WE, opened before 2025
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const { isLikelyWrongProduction, isLikelyTourReview } = require('./lib/review-guards');

// ─── PDF review parser ───
// Parses reviews from pdftotext output. Reviews follow pattern:
// OUTLET NAME (ALL CAPS) → date line → critic name → review text
// Date formats: "18 May 2021" (post-2019) or "21.12.17" (pre-2019)
const DATE_LONG = /^\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/;
const DATE_SHORT = /^\d{1,2}\.\d{2}\.\d{2,4}$/;
const isDateLine = (line) => DATE_LONG.test(line) || DATE_SHORT.test(line);

function parseShortDate(dateStr) {
  // "21.12.17" → "2017-12-21", "15.03.99" → "1999-03-15"
  const [d, m, y] = dateStr.split('.');
  const yearNum = parseInt(y, 10);
  const fullYear = yearNum >= 80 ? 1900 + yearNum : (yearNum > 30 ? 1900 + yearNum : 2000 + yearNum);
  return `${fullYear}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function parsePdfReviews(text, showTitle) {
  const lines = text.split('\n');
  const reviews = [];

  const titleUpper = showTitle.toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Step 1: Find the reviews section for THIS production
  // Pattern: "Reviews" right-aligned, then show title, then first outlet+date
  let reviewsStart = -1;
  let reviewsEnd = lines.length;

  for (let j = 0; j < lines.length; j++) {
    const trimmed = lines[j].trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (trimmed === titleUpper || trimmed === 'THE ' + titleUpper) {
      // Check if preceded by "Reviews" marker (within 5 lines)
      for (let k = Math.max(0, j - 5); k < j; k++) {
        if (lines[k].trim() === 'Reviews') {
          reviewsStart = j + 1;
          break;
        }
      }
      if (reviewsStart > -1) break;
    }
  }

  // Fallback: find first outlet+date pattern after "Reviews" text
  if (reviewsStart === -1) {
    for (let j = 0; j < lines.length; j++) {
      if (lines[j].trim() !== 'Reviews') continue;
      for (let k = j + 1; k < Math.min(j + 10, lines.length); k++) {
        const line = lines[k].trim();
        if (line === line.toUpperCase() && line.length > 3 && /^[A-Z]/.test(line)) {
          const nextLine = (lines[k + 1] || '').trim();
          if (isDateLine(nextLine)) {
            reviewsStart = k;
            break;
          }
        }
      }
      if (reviewsStart > -1) break;
    }
  }

  if (reviewsStart === -1) return [];

  // Step 2: Find end boundary — next production
  for (let j = reviewsStart; j < lines.length; j++) {
    const raw = lines[j];
    const trimmed = raw.trim();

    // Method A: Indented ALL CAPS title (works for -layout mode)
    if (raw.match(/^\s{20,}/) && trimmed.length > 3 && trimmed === trimmed.toUpperCase() &&
        /^[A-Z]/.test(trimmed) && trimmed !== 'Reviews' && trimmed !== 'Index' &&
        !trimmed.includes(titleUpper)) {
      reviewsEnd = j;
      break;
    }

    // Method B: Production metadata block (works for -raw mode)
    // Pattern: ALL CAPS title → "by AUTHOR" or venue+date-range within 5 lines
    if (trimmed === trimmed.toUpperCase() && trimmed.length > 3 && /^[A-Z]/.test(trimmed) &&
        trimmed !== 'Reviews' && trimmed !== 'Index' && !trimmed.includes(titleUpper) &&
        !isDateLine(trimmed)) {
      // Check if next few lines look like production metadata (not a review)
      const nextLines = [];
      for (let k = 1; k <= 5 && j + k < lines.length; k++) {
        nextLines.push(lines[j + k].trim());
      }
      const hasVenueDateRange = nextLines.some(l => /\d{1,2}\s+\w+\s+\d{4}\s*[–—-]\s*\d{1,2}\s+\w+\s+\d{4}/.test(l));
      const hasByAuthor = nextLines.some(l => /^(?:by |Revival |European |World |New |Musical |A play |A comedy |A drama )/i.test(l));
      const hasVenue = nextLines.some(l => /Theatre|Playhouse|Palace|Lyceum|Apollo|Donmar|Almeida|Old Vic|National|Barbican/i.test(l));

      if ((hasVenueDateRange || hasByAuthor) && hasVenue) {
        reviewsEnd = j;
        break;
      }
    }
  }

  // Step 3: Parse reviews within the bounded section
  let i = reviewsStart;
  while (i < reviewsEnd) {
    const line = lines[i].trim();

    // Detect outlet: ALL CAPS line followed by a date
    if (line === line.toUpperCase() && line.length > 3 && /^[A-Z]/.test(line) &&
        !line.includes('Cast & Creative') && line !== titleUpper && line !== 'THE ' + titleUpper) {
      const nextLine = (lines[i + 1] || '').trim();
      if (isDateLine(nextLine)) {
        const outlet = line;
        const date = nextLine;
        const critic = (lines[i + 2] || '').trim();
        i += 3;

        // Skip blank line after critic name
        while (i < reviewsEnd && lines[i].trim() === '') i++;

        // Collect review text until next outlet or section boundary
        const textLines = [];
        while (i < reviewsEnd) {
          const curr = lines[i].trim();
          const next = (lines[i + 1] || '').trim();

          // Stop at next outlet (ALL CAPS + date)
          if (curr === curr.toUpperCase() && curr.length > 3 && /^[A-Z]/.test(curr) && isDateLine(next)) {
            break;
          }

          textLines.push(lines[i]);
          i++;
        }

        let fullText = textLines.map(l => l.trim()).filter(l => l).join('\n');
        // Clean PDF artifacts
        fullText = fullText.replace(/\nIndex$/m, '').replace(/\nReviews$/m, '').replace(/\n\d+$/m, '').trim();
        if (fullText.length > 50) {
          // Convert outlet name to Title Case
          const outletTitle = outlet.split(/[\s.]+/)
            .map(w => w.charAt(0) + w.slice(1).toLowerCase())
            .join(' ')
            .replace(/\.Com$/i, '.com')
            .replace(/Thereviewshub\.com/i, 'The Reviews Hub');

          reviews.push({
            outlet: outletTitle,
            date,
            critic: critic || null,
            fullText
          });
        }
        continue;
      }
    }
    i++;
  }

  return reviews;
}

// For multi-column pre-2019 PDFs: extract ALL reviews, filter by show title mention
function parseRawPdfReviews(text, showTitle) {
  const lines = text.split('\n');
  const allReviews = [];
  const titleLower = showTitle.toLowerCase();
  // Also match with common title variations
  const titleWords = titleLower.split(/\s+/).filter(w => w.length > 3);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Detect outlet: ALL CAPS line followed by a date
    if (line === line.toUpperCase() && line.length > 3 && /^[A-Z]/.test(line) &&
        !line.includes('Cast & Creative') && line !== 'HAMILTON' && line !== 'Index' && line !== 'Reviews') {
      const nextLine = (lines[i + 1] || '').trim();
      if (isDateLine(nextLine)) {
        const outlet = line;
        const date = nextLine;
        const critic = (lines[i + 2] || '').trim();
        i += 3;
        while (i < lines.length && lines[i].trim() === '') i++;

        const textLines = [];
        while (i < lines.length) {
          const curr = lines[i].trim();
          const next = (lines[i + 1] || '').trim();
          if (curr === curr.toUpperCase() && curr.length > 3 && /^[A-Z]/.test(curr) && isDateLine(next)) break;
          textLines.push(lines[i]);
          i++;
        }

        let fullText = textLines.map(l => l.trim()).filter(l => l).join('\n');
        fullText = fullText.replace(/\nIndex$/m, '').replace(/\nReviews$/m, '').replace(/\n\d+$/m, '').trim();

        if (fullText.length > 200 && fullText.length < 15000) {
          // Cap at 15K chars — longer means multiple reviews concatenated
          allReviews.push({ outlet, date, critic, fullText });
        }
        continue;
      }
    }
    i++;
  }

  // Filter: keep only reviews that mention our show title
  // For short/common titles (Wicked, Six, Cats, Rent, Oliver, Chess), require
  // the title to appear as a standalone word near review-specific context
  const isCommonWord = titleLower.length <= 7 && /^[a-z]+$/.test(titleLower);

  const matched = allReviews.filter(r => {
    const textLower = r.fullText.toLowerCase();

    if (isCommonWord) {
      // For short common-word titles: require title as standalone word AND
      // at least one show-specific signal (venue, author, character name, "musical", "play")
      const titleRegex = new RegExp(`\\b${titleLower}\\b`, 'i');
      const titleCount = (textLower.match(titleRegex) || []).length;
      if (titleCount < 2) return false; // Must appear at least twice
      // Also check for theatrical context near the title
      const firstMention = textLower.indexOf(titleLower);
      const context = textLower.slice(Math.max(0, firstMention - 100), firstMention + 200);
      const hasTheatreContext = /musical|play|production|stage|theatre|theater|curtain|cast|director|choreograph/i.test(context);
      return hasTheatreContext;
    }

    // For multi-word titles: full title match or 70% of significant words
    if (textLower.includes(titleLower)) return true;
    const wordsFound = titleWords.filter(w => textLower.includes(w));
    return wordsFound.length >= Math.ceil(titleWords.length * 0.7);
  });

  // Convert outlet names to Title Case
  return matched.map(r => ({
    outlet: r.outlet.split(/[\s.]+/)
      .map(w => w.charAt(0) + w.slice(1).toLowerCase())
      .join(' ')
      .replace(/\.Com$/i, '.com')
      .replace(/Thereviewshub\.com/i, 'The Reviews Hub'),
    date: r.date,
    critic: r.critic || null,
    fullText: r.fullText
  }));
}

async function extractReviewsFromPDF(page, context, pdfUrl, show) {
  // Get session cookie from Playwright context
  const cookies = await context.cookies();
  const phpSession = cookies.find(c => c.name === 'PHPSESSID');
  if (!phpSession) {
    console.log('  No PHPSESSID cookie — cannot download PDF');
    return [];
  }

  // Download PDF to temp file
  const tmpFile = path.join('/tmp', `tr-${show.id}.pdf`);
  try {
    // Resolve any redirects first — /archive/volume/ redirects to /archive/issue/
    const resolvedUrl = pdfUrl.replace(/#.*$/, ''); // Strip fragment
    execSync(`curl -s -L -o "${tmpFile}" -b "PHPSESSID=${phpSession.value}" "${resolvedUrl}"`, { timeout: 30000 });
  } catch (e) {
    console.log(`  PDF download failed: ${e.message}`);
    return [];
  }

  // Verify it's actually a PDF
  const fileType = execSync(`file "${tmpFile}"`).toString();
  if (!fileType.includes('PDF')) {
    console.log(`  Downloaded file is not a PDF: ${fileType.trim()}`);
    fs.unlinkSync(tmpFile);
    return [];
  }

  // Try -layout first (works for 2019+ single-column PDFs with indentation boundaries)
  let text;
  try {
    text = execSync(`pdftotext -layout "${tmpFile}" -`, { maxBuffer: 10 * 1024 * 1024 }).toString();
  } catch (e) {
    console.log(`  pdftotext failed: ${e.message}`);
    fs.unlinkSync(tmpFile);
    return [];
  }

  let reviews = parsePdfReviews(text, show.title);
  if (reviews.length > 0) {
    console.log(`  Extracted ${reviews.length} reviews (-layout mode)`);
    fs.unlinkSync(tmpFile);
    return reviews;
  }

  // Fallback: -raw mode for multi-column pre-2019 PDFs
  // Raw mode can't reliably detect production boundaries, so we extract ALL
  // outlet+date+critic+text blocks and filter to reviews that mention our show
  try {
    text = execSync(`pdftotext -raw "${tmpFile}" -`, { maxBuffer: 10 * 1024 * 1024 }).toString();
  } catch (e) {
    console.log(`  pdftotext -raw failed: ${e.message}`);
    fs.unlinkSync(tmpFile);
    return [];
  }

  reviews = parseRawPdfReviews(text, show.title);
  if (reviews.length > 0) {
    console.log(`  Extracted ${reviews.length} reviews (-raw mode, title-matched)`);
  }

  fs.unlinkSync(tmpFile);
  return reviews;
}

const ROOT = path.resolve(__dirname, '..');
const SHOWS_FILE = path.join(ROOT, 'data', 'shows.json');
const REVIEWS_FILE = path.join(ROOT, 'data', 'reviews.json');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const OUTLET_REGISTRY = path.join(ROOT, 'data', 'outlet-registry.json');

// CLI args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const openWE = args.includes('--open-we');
const longRunning = args.includes('--long-running');
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10) || 0;

// Theatre Record credentials
const TR_EMAIL = process.env.TR_EMAIL || 'thomas.pryor@gmail.com';
const TR_PASSWORD = process.env.TR_PASSWORD || '';

// Theatre Record outlet name → our outlet ID mapping
const TR_OUTLET_MAP = {
  'The Guardian': 'guardian',
  'The Telegraph': 'telegraph',
  'The Times': 'times-uk',
  'The Standard': 'standard',
  'Evening Standard': 'standard',
  'The Stage': 'thestage',
  'Time Out': 'timeout-london',
  'Time Out London': 'timeout-london',
  'The Independent': 'independent',
  'Financial Times': 'financialtimes',
  'Daily Mail': 'daily-mail',
  'The i': 'i-paper',
  'i': 'i-paper',
  'WhatsOnStage': 'whatsonstage',
  'The Observer': 'observer',
  'The Arts Desk': 'artsdesk',
  'BroadwayWorld': 'broadwayworld',
  'London Theatre': 'london-theatre',
  'LondonTheatre1': 'londontheatre1',
  'The Reviews Hub': 'reviews-hub',
  'theatreCat': 'theatrecat',
  'Theatre Weekly': 'theatre-weekly',
  'Musical Theatre Review': 'musical-theatre-review',
  'Everything Theatre': 'everything-theatre',
  'West End Wilma': 'west-end-wilma',
  'The Spectator': 'spectator',
  'Radio Times': 'radio-times',
  'Metro': 'metro',
  'City A.M.': 'city-am',
  'Digital Spy': 'digital-spy',
  'The Sun': 'the-sun',
  'Daily Express': 'express-uk',
  'The Express': 'express-uk',
  'Mail on Sunday': 'daily-mail',
  'The Sunday Times': 'sunday-times',
  'Sunday Telegraph': 'sunday-telegraph',
  'The Scotsman': 'the-scotsman',
  'Hampstead & Highgate Express': 'hampstead-highgate-express',
  'The Spectator': 'the-spectator-uk',
  'London Box Office': 'london-box-office',
  'BBC News': 'bbc-news',
  'Culture Whisper': 'culture-whisper',
  'Londonist': 'londonist',
  'The Mirror': 'the-mirror',
  'A Younger Theatre': 'a-younger-theatre',
  'All That Dazzles': 'all-that-dazzles-uk',
  'West End Best Friend': 'west-end-best-friend',
  'Lost in Theatreland': 'lost-in-theatreland',
  'Shy Strange Manic': 'shy-strange-manic',
  'Theatre Bee': 'theatre-bee-uk',
  'Tim Talks Theatre': 'tim-talks-theatre-uk',
  'Variety': 'variety',
  'The New York Times': 'nytimes',
  'British Theatre Guide': 'british-theatre',
  'Gay Times': 'gay-times',
  'Attitude': 'attitude',
};

// Load data
const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
const outletRegistry = JSON.parse(fs.readFileSync(OUTLET_REGISTRY, 'utf8'));

function getOutletId(trName) {
  // Direct map first
  if (TR_OUTLET_MAP[trName]) return TR_OUTLET_MAP[trName];

  // Try matching against outlet registry aliases
  const normalized = trName.toLowerCase().trim();
  for (const [id, outlet] of Object.entries(outletRegistry.outlets || {})) {
    if (outlet.displayName?.toLowerCase() === normalized) return id;
    if (outlet.aliases?.some(a => a.toLowerCase() === normalized)) return id;
  }

  // Slugify as fallback
  return trName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function getOutletDisplayName(trName) {
  const id = getOutletId(trName);
  const outlet = outletRegistry.outlets?.[id];
  return outlet?.displayName || trName;
}

function slugifyCritic(name) {
  return name.toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function makeFilename(outletId, criticName) {
  const critic = criticName ? slugifyCritic(criticName) : 'unknown';
  return `${outletId}--${critic}.json`;
}

function parseDate(dateStr) {
  // "03 April 2026" → "2026-04-03" or "21.12.17" → "2017-12-21"
  if (!dateStr) return null;
  if (DATE_SHORT.test(dateStr)) return parseShortDate(dateStr);
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return d.toISOString().split('T')[0];
}

// Determine which shows to process
function getTargetShows() {
  let shows = showsData.shows;

  if (showFilter) {
    shows = shows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (shows.length === 0) {
      console.error(`Show not found: ${showFilter}`);
      process.exit(1);
    }
    return shows;
  }

  if (longRunning) {
    shows = shows.filter(s =>
      (s.category === 'west-end' || s.category === 'off-west-end') &&
      s.status === 'open' &&
      s.openingDate && new Date(s.openingDate) < new Date('2025-01-01')
    );
  } else if (openWE) {
    shows = shows.filter(s =>
      (s.category === 'west-end' || s.category === 'off-west-end') &&
      (s.status === 'open' || s.status === 'previews')
    );
  }

  // Sort by opening date (oldest first — biggest gaps)
  shows.sort((a, b) => new Date(a.openingDate || '2099') - new Date(b.openingDate || '2099'));

  if (limit > 0) shows = shows.slice(0, limit);
  return shows;
}

// WE venue name patterns that indicate the right production
const LONDON_VENUES = [
  'west end', 'london', 'palace', 'victoria palace', 'lyceum', 'apollo',
  'savoy', 'dominion', 'drury lane', 'gielgud', 'wyndham', 'garrick',
  'noel coward', 'harold pinter', 'duke of york', 'criterion', 'novello',
  'adelphi', 'cambridge', 'phoenix', 'prince edward', 'prince of wales',
  'sondheim', 'gillian lynne', 'troubadour', 'kit kat club', 'playhouse',
  "st martin", "her majesty", "his majesty", 'old vic', 'young vic',
  'national theatre', 'donmar', 'almeida', 'dorfman', 'olivier', 'lyttelton',
  'barbican', 'sadler', 'ambassadors', 'piccadilly', 'vaudeville',
  'fortune', 'duchess', 'trafalgar', 'theatre royal',
];

function isLondonVenue(venueText) {
  if (!venueText) return false;
  const lower = venueText.toLowerCase();
  return LONDON_VENUES.some(v => lower.includes(v));
}

async function main() {
  console.log('=== Theatre Record Review Extractor ===');

  const targets = getTargetShows();
  console.log(`Target shows: ${targets.length}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  if (targets.length === 0) {
    console.log('No shows to process.');
    return;
  }

  if (!TR_PASSWORD) {
    console.error('TR_PASSWORD environment variable required');
    process.exit(1);
  }

  // Launch browser
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
  });
  const page = await context.newPage();

  // Login
  console.log('Logging in to Theatre Record...');
  await page.goto('https://www.theatrerecord.com/login');
  await page.getByRole('textbox', { name: 'Email' }).fill(TR_EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(TR_PASSWORD);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.waitForTimeout(3000);

  // Verify login
  const loggedIn = await page.locator('text=Sign Out').count() > 0 ||
                   await page.locator('img[alt="Account"]').count() > 0;
  if (!loggedIn) {
    console.error('Login failed!');
    await browser.close();
    process.exit(1);
  }
  console.log('Login successful.\n');

  let totalNew = 0;
  let totalSkipped = 0;
  let totalShows = 0;

  for (const show of targets) {
    console.log(`\n--- ${show.title} (${show.id}) ---`);

    // Search Theatre Record
    const searchTitle = show.title
      .replace(/['']/g, "'")
      .replace(/&/g, 'and');
    const searchUrl = `https://www.theatrerecord.com/search?query=${encodeURIComponent('"' + searchTitle + '"')}&title=on&order=newest`;

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000);

    // Find production results
    const results = await page.evaluate(() => {
      const articles = document.querySelectorAll('article');
      const r = [];
      articles.forEach(a => {
        const h2 = a.querySelector('h2');
        const venue = a.querySelector('h3');
        // Find any link inside the article — could be /archive/ or production page
        const links = a.querySelectorAll('a');
        let link = null;
        for (const l of links) {
          if (l.href && l.href.includes('/archive/')) { link = l; break; }
        }
        if (!link) {
          // Try any link that's not a search link
          for (const l of links) {
            if (l.href && !l.href.includes('/search')) { link = l; break; }
          }
        }
        if (!h2 || !link) return;
        r.push({
          title: h2.textContent.trim(),
          venue: venue?.textContent?.trim() || '',
          link: link.href,
          linkText: link.textContent.trim()
        });
      });
      return r;
    });

    // If no results or no London venue match, retry with location filter
    if (results.length === 0 || !results.find(r => isLondonVenue(r.venue))) {
      // Retry search with location filter enabled
      const retryUrl = `https://www.theatrerecord.com/search?query=${encodeURIComponent('"' + searchTitle + '"')}&title=on&location=on&order=newest`;
      await page.goto(retryUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1000);

      const retryResults = await page.evaluate(() => {
        const articles = document.querySelectorAll('article');
        const r = [];
        articles.forEach(a => {
          const h2 = a.querySelector('h2');
          const venue = a.querySelector('h3');
          const links = a.querySelectorAll('a');
          let link = null;
          for (const l of links) {
            if (l.href && l.href.includes('/archive/')) { link = l; break; }
          }
          if (!link) {
            for (const l of links) {
              if (l.href && !l.href.includes('/search')) { link = l; break; }
            }
          }
          if (!h2 || !link) return;
          r.push({
            title: h2.textContent.trim(),
            venue: venue?.textContent?.trim() || '',
            link: link.href,
            linkText: link.textContent.trim()
          });
        });
        return r;
      });

      // Merge results, preferring London venues
      const seen = new Set(results.map(r => r.link));
      for (const r of retryResults) {
        if (!seen.has(r.link)) { results.push(r); seen.add(r.link); }
      }
    }

    if (results.length === 0) {
      console.log('  No results found on Theatre Record');
      continue;
    }

    // Filter to results that match our show title
    // Strict: normalized titles must be equal (no substring matching)
    const normalizeTitle = t => t.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
      .replace(/^the\s+/, '').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const ourTitle = normalizeTitle(show.title);
    const titleMatches = results.filter(r => {
      const trTitle = normalizeTitle(r.title);
      return trTitle === ourTitle;
    });

    if (titleMatches.length === 0) {
      console.log(`  No title match. TR results: ${results.map(r => `"${r.title}" @ ${r.venue}`).join('; ')}`);
      continue;
    }

    // Among title matches, find the London/WE production
    let bestResult = titleMatches.find(r => isLondonVenue(r.venue));
    if (!bestResult) {
      // Try matching by our show's venue
      const showVenue = show.venue?.toLowerCase() || '';
      if (showVenue) {
        bestResult = titleMatches.find(r =>
          r.venue.toLowerCase().includes(showVenue) ||
          showVenue.includes(r.venue.toLowerCase().replace(/,.*/, '').trim())
        );
      }
      if (!bestResult) bestResult = titleMatches[0]; // Take first title match
      if (!bestResult) continue;
    }

    console.log(`  Found: ${bestResult.title} @ ${bestResult.venue}`);
    console.log(`  Link: ${bestResult.link} (${bestResult.linkText})`);

    // Check if it's a PDF or HTML page
    // HTML pages: /archive/2026/4/37536-the-authenticator or contain "reviews" in linkText
    // PDF pages: /archive/volume/37/page/1340 or /archive/issue/483
    const isPDF = (bestResult.link.includes('/volume/') || bestResult.link.includes('/issue/'))
      && !bestResult.linkText.includes('reviews');

    let reviews;

    if (isPDF) {
      // ─── PDF extraction path (pre-2022 issues) ───
      console.log('  PDF format — downloading and extracting...');
      reviews = await extractReviewsFromPDF(page, context, bestResult.link, show);
    } else {
      // ─── HTML extraction path (post-2022) ───
      try {
        await page.goto(bestResult.link, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch (e) {
        console.log(`  Failed to load page: ${e.message}`);
        continue;
      }
      await page.waitForTimeout(2000);

      reviews = await page.evaluate(() => {
        const articles = document.querySelectorAll('main article');
        const result = [];
        articles.forEach((a, i) => {
          if (i === 0) return;
          const h2 = a.querySelector('h2');
          if (!h2) return;
          const meta = h2.nextElementSibling;
          const paras = [...a.querySelectorAll('p')];
          const fullText = paras.map(p => p.textContent.trim()).filter(t => t).join('\n\n');
          const criticLink = meta ? meta.querySelector('a') : null;
          const dateText = meta ? meta.textContent.replace(/\s*by\s.*/, '').trim() : '';
          result.push({
            outlet: h2.textContent.trim(),
            critic: criticLink ? criticLink.textContent.trim() : null,
            date: dateText,
            fullText
          });
        });
        return result;
      });
    }

    console.log(`  Found ${reviews.length} reviews`);
    totalShows++;

    // Ensure review-texts directory exists
    const showDir = path.join(REVIEW_TEXTS_DIR, show.id);
    if (!dryRun && !fs.existsSync(showDir)) {
      fs.mkdirSync(showDir, { recursive: true });
    }

    let newForShow = 0;
    for (const review of reviews) {
      if (!review.fullText || review.fullText.length < 100) {
        continue; // too short
      }

      // Skip Theatre Record's own editorial summary
      if (review.outlet.toLowerCase().includes('theatre record') ||
          review.outlet.toLowerCase().includes('summary') ||
          review.outlet.toLowerCase().includes('editor')) {
        continue;
      }

      const outletId = getOutletId(review.outlet);
      const outletDisplay = getOutletDisplayName(review.outlet);
      const filename = makeFilename(outletId, review.critic);
      const filepath = path.join(showDir, filename);

      // Skip if file already exists
      if (fs.existsSync(filepath)) {
        totalSkipped++;
        continue;
      }

      // ─── Production validation guards ───
      const text = review.fullText.toLowerCase();
      const pubDate = parseDate(review.date);
      const showEarliestDate = show.previewsStartDate || show.openingDate;
      let skipReason = null;

      // Guard 1: Wrong production by date (review >90 days before show)
      if (isLikelyWrongProduction(pubDate, showEarliestDate, 90)) {
        skipReason = `wrong-production-date (review ${pubDate} vs show ${showEarliestDate})`;
      }

      // Guard 2: Tour/regional detection in review text
      if (!skipReason) {
        const tourPatterns = [
          /\breview(?:ed)?\s+at\s+(?:the\s+)?(?:lowry|playhouse|hippodrome|opera house|new theatre|grand theatre|leeds|birmingham|manchester|bristol|cardiff|glasgow|edinburgh|sheffield|nottingham|southampton|brighton|bath|chichester|oxford|cambridge|salford|milton keynes)/i,
          /\btouring\s+(?:production|company|cast|show)\b/i,
          /\buk\s+tour\b/i,
          /\bnational\s+tour\b/i,
          /\bcurrent(?:ly)?\s+(?:on\s+)?tour\b/i,
        ];
        for (const pat of tourPatterns) {
          if (pat.test(review.fullText)) {
            skipReason = `tour-review (${pat.source.slice(0, 40)})`;
            break;
          }
        }
      }

      // Guard 3: Panto/wrong-show detection
      // Only flag as panto if it appears multiple times or in the first 200 chars
      // (passing mentions of panto in December reviews are normal)
      if (!skipReason) {
        const pantoMatches = (review.fullText.match(/\bpanto(?:s|mime)?\b/gi) || []).length;
        const pantoInOpening = /\bpanto(?:s|mime)?\b/i.test(review.fullText.slice(0, 200));
        if (pantoMatches >= 3 || pantoInOpening) {
          skipReason = 'panto (not the WE production)';
        }
      }

      // Guard 4: Film/TV review detection
      if (!skipReason) {
        const filmSignals = [/\b(?:in cinemas|on screen|film adaptation|movie version|streaming on)\b/i];
        for (const pat of filmSignals) {
          if (pat.test(review.fullText)) {
            skipReason = `film/TV review (${pat.source.slice(0, 40)})`;
            break;
          }
        }
      }

      if (skipReason) {
        console.log(`    SKIP: ${filename} — ${skipReason}`);
        totalSkipped++;
        continue;
      }

      const reviewData = {
        showId: show.id,
        outletId,
        outlet: outletDisplay,
        criticName: review.critic || 'Unknown',
        url: null, // Theatre Record doesn't provide original URLs
        publishDate: parseDate(review.date) || show.openingDate || null,
        fullText: review.fullText,
        isFullReview: true,
        contentTier: 'complete',
        contentTierReason: 'Full review text from Theatre Record',
        source: 'theatre-record',
        theatreRecordUrl: bestResult.link,
        addedAt: new Date().toISOString(),
        textWordCount: review.fullText.split(/\s+/).length
      };

      if (dryRun) {
        console.log(`    NEW: ${filename} (${review.fullText.length} chars, ${reviewData.textWordCount} words)`);
      } else {
        fs.writeFileSync(filepath, JSON.stringify(reviewData, null, 2));
        console.log(`    SAVED: ${filename} (${reviewData.textWordCount} words)`);
      }
      newForShow++;
      totalNew++;
    }

    if (newForShow === 0 && reviews.length > 0) {
      console.log('  All reviews already exist');
    }

    // Rate limit
    await page.waitForTimeout(2000);
  }

  await browser.close();

  console.log('\n=== Summary ===');
  console.log(`Shows processed: ${totalShows}`);
  console.log(`New reviews: ${totalNew}`);
  console.log(`Skipped (existing): ${totalSkipped}`);
  if (dryRun) console.log('(DRY RUN — nothing saved)');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
