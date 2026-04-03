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
const { chromium } = require('playwright');

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
  // "03 April 2026" → "2026-04-03"
  if (!dateStr) return null;
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

    if (results.length === 0) {
      console.log('  No results found on Theatre Record');
      continue;
    }

    // Filter to results that match our show title (prevent "Wicked" matching "Wicked Witches")
    const normalizeTitle = t => t.toLowerCase().replace(/[^a-z0-9]/g, '');
    const ourTitle = normalizeTitle(show.title);
    const titleMatches = results.filter(r => {
      const trTitle = normalizeTitle(r.title);
      return trTitle === ourTitle || trTitle.startsWith(ourTitle) || ourTitle.startsWith(trTitle);
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

    if (isPDF) {
      console.log('  ⚠ PDF format (pre-2022) — skipping for now (HTML extraction only)');
      continue;
    }

    // Navigate to production page
    try {
      await page.goto(bestResult.link, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (e) {
      console.log(`  Failed to load page: ${e.message}`);
      continue;
    }
    await page.waitForTimeout(2000);

    // Extract reviews — text is in the DOM even when collapsed (hidden via CSS)
    // No need to click "See full review" — just read all <p> tags inside each article
    const reviews = await page.evaluate(() => {
      const articles = document.querySelectorAll('main article');
      const result = [];
      articles.forEach((a, i) => {
        if (i === 0) return; // skip production info
        const h2 = a.querySelector('h2');
        if (!h2) return;
        const meta = h2.nextElementSibling;
        // Get ALL paragraphs including hidden ones
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
