#!/usr/bin/env node
/**
 * London Box Office Review Roundups Scraper
 *
 * Discovers and extracts review data from londonboxoffice.co.uk roundup pages.
 * These roundups contain outlet name, star rating (★), critic name, excerpt,
 * and link to full review — all structured under <h4> headings.
 *
 * Strategy:
 * 1. Crawl /news-sitemap.xml for "review-round-up-" URLs
 * 2. Match roundup URLs to shows.json (West End category)
 * 3. Fetch HTML via ScrapingBee (static, no JS needed)
 * 4. Extract: outlet → ★ count → P0 score → critic → excerpt → review URL
 * 5. Dedup via findExistingReviewFile(), write review-text files
 *
 * Requires: SCRAPINGBEE_API_KEY
 *
 * Output: Updates/creates review files in data/review-texts/{showId}/
 * Archives: Saves HTML to data/aggregator-archive/lbo-roundups/
 *
 * Usage: node scripts/scrape-london-box-office-roundups.js [--shows=X,Y,Z] [--dry-run] [--force]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { serpQuery } = require('./lib/url-discovery');
const cheerio = require('cheerio');
const { matchTitleToShow, loadShows, titleWordsMatch } = require('./lib/show-matching');
const { isLondonMarket } = require('./lib/venue-classification');
const { createOrMergeReviewFile } = require('./lib/review-file-writer');
const { fetchPage, cleanup: cleanupScraper } = require('./lib/scraper');

// Paths
const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const archiveDir = path.join(__dirname, '../data/aggregator-archive/lbo-roundups');

const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

// Stats
const stats = {
  sitemapUrls: 0,
  matchedShows: 0,
  pagesFetched: 0,
  reviewsExtracted: 0,
  newReviews: 0,
  updatedReviews: 0,
  skippedExisting: 0,
  skippedArchived: 0,
  errors: [],
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// Fetch raw XML without proxy (sitemap is public, no bot protection)
function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        fetchRaw(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ---------------------------------------------------------------------------
// Sitemap discovery
// ---------------------------------------------------------------------------

async function discoverRoundupUrls() {
  console.log('Fetching LBO sitemap...');

  const xml = await fetchRaw('https://www.londonboxoffice.co.uk/news-sitemap.xml');
  const $ = cheerio.load(xml, { xmlMode: true });

  const roundups = [];
  const individual = [];
  $('url > loc').each((_, el) => {
    const loc = $(el).text().trim();
    // Match roundup URLs: "review-round-up-", "review-roundup-", etc.
    if (/review-round-?up[-:]|review-round-?up$/i.test(loc)) {
      roundups.push(loc);
    }
    // Match individual review URLs: ends with "-review" or starts with "/review-"
    // Excludes roundups (already matched above) and non-review articles
    else if (/\/news\/post\/review-.+/i.test(loc) || /\/news\/post\/.+-review$/i.test(loc)) {
      individual.push(loc);
    }
  });

  console.log(`Found ${roundups.length} roundup URLs + ${individual.length} individual review URLs in sitemap`);
  stats.sitemapUrls = roundups.length;
  stats.individualUrls = individual.length;
  return { roundups, individual };
}

// ---------------------------------------------------------------------------
// URL → show matching
// ---------------------------------------------------------------------------

function extractShowTitleFromUrl(url) {
  // URL pattern: /news/post/review-round-up-{show-name}-{theatre-name}
  // Also handles: /news/post/Review-Round-Up:-SHOW-NAME-at-the-Theatre
  const match = url.match(/review-round-?up[:-]+(.+)$/i);
  if (!match) return null;

  const slug = match[1];

  // Known theatre names to strip from the end
  const theatres = [
    'noel-coward-theatre', 'aldwych-theatre', 'apollo-theatre',
    'theatre-royal-haymarket', 'harold-pinter-theatre', 'duke-of-yorks-theatre',
    'duke-of-york-s-theatre', 'trafalgar-theatre', 'ambassadors-theatre',
    'bridge-theatre', 'savoy-theatre', 'wyndhams-theatre', 'wyndham-s-theatre',
    'donmar-warehouse', 'old-vic', 'the-old-vic', 'young-vic',
    'national-theatre', 'gielgud-theatre', 'lyceum-theatre',
    'london-palladium', 'phoenix-theatre', 'playhouse-theatre',
    'vaudeville-theatre', 'noël-coward-theatre', 'garrick-theatre',
    'criterion-theatre', 'duchess-theatre', 'fortune-theatre',
    'palace-theatre', 'piccadilly-theatre', 'prince-edward-theatre',
    'prince-of-wales-theatre', 'queens-theatre', 'savoy-theatre',
    'shaftesbury-theatre', 'st-james-theatre', 'st-martins-theatre',
    'gillian-lynne-theatre', 'barbican', 'soho-place',
    '@soho-place', 'at-the-ambassadors-theatre',
    'at-soho-place',
  ];

  let cleaned = slug;
  for (const theatre of theatres) {
    const suffix = new RegExp(`-${theatre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    if (suffix.test(cleaned)) {
      cleaned = cleaned.replace(suffix, '');
      break;
    }
  }

  // Convert hyphens to spaces, handle URL encoding
  return decodeURIComponent(cleaned).replace(/-/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Extract reviews from roundup HTML
// ---------------------------------------------------------------------------

function extractReviewsFromLBO(html, showId) {
  const $ = cheerio.load(html);
  const reviews = [];
  const seenOutlets = new Set();

  // LBO structure: <h4>Outlet Name</h4> followed by star rating, critic, excerpt
  // Stars are Unicode ★ characters
  // Critic line: "Reviewer: Name" (bold)
  // Review link: <a> within or after excerpt

  // Strategy: iterate through content elements, use h3/h4 as outlet markers
  // Some LBO pages use h3 for outlets (e.g., Hunger Games), others use h4
  const contentElements = $('h3, h4, p, blockquote').toArray();

  let currentOutlet = null;
  let currentStars = null;
  let currentCritic = null;
  let currentExcerpt = null;
  let currentUrl = null;

  function flushReview() {
    if (currentOutlet && (currentExcerpt || currentStars !== null)) {
      const key = currentOutlet.toLowerCase();
      if (!seenOutlets.has(key)) {
        seenOutlets.add(key);
        reviews.push({
          outlet: currentOutlet,
          stars: currentStars,
          score: currentStars !== null ? Math.round((currentStars / 5) * 100) : null,
          critic: currentCritic || 'Unknown',
          excerpt: currentExcerpt || '',
          url: currentUrl || '',
          showId,
        });
      }
    }
    currentOutlet = null;
    currentStars = null;
    currentCritic = null;
    currentExcerpt = null;
    currentUrl = null;
  }

  for (const el of contentElements) {
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().trim();

    if (tag === 'h3' || tag === 'h4') {
      // LBO puts star ratings in heading elements too — check for stars first
      const hStars = text.match(/^(★+)\s*$/);
      if (hStars && currentOutlet) {
        currentStars = hStars[1].length;
        continue;
      }

      // New outlet — flush previous
      flushReview();

      // Skip non-outlet headings (navigation, ads, etc.)
      if (text.length > 80 || text.length < 3) continue;
      if (/book tickets|buy tickets|related|share|newsletter|categories|connect with|latest news/i.test(text)) continue;
      // Skip pure star strings without a preceding outlet
      if (/^★+$/.test(text)) continue;

      currentOutlet = text;
      continue;
    }

    if (!currentOutlet) continue;

    // Skip LBO boilerplate / footer content
    if (/^100% Honest Reviews/i.test(text) || /^If you're interested in more/i.test(text)) continue;

    // Star rating line — Unicode ★ characters (in <p> elements)
    const starMatch = text.match(/^(★+)\s*$/);
    if (starMatch) {
      currentStars = starMatch[1].length;
      continue;
    }

    // Stars might be inline with other text
    const inlineStars = text.match(/(★+)/);
    if (inlineStars && text.length < 20) {
      currentStars = inlineStars[1].length;
      continue;
    }

    // Numeric rating like "4/5" or "4 out of 5"
    const numericRating = text.match(/^(\d(?:\.\d)?)\s*(?:\/|out of)\s*5\s*$/);
    if (numericRating) {
      currentStars = parseFloat(numericRating[1]);
      continue;
    }

    // Critic line: "Reviewer: Name" or just bold name
    const reviewerMatch = text.match(/^Reviewer:\s*(.+)/i);
    if (reviewerMatch) {
      currentCritic = reviewerMatch[1].trim();
      continue;
    }

    // Check for bold critic attribution
    const boldEl = $(el).find('strong, b').first();
    const boldText = boldEl.text().trim();
    if (boldText && /^Reviewer/i.test(boldText)) {
      const criticText = text.replace(boldText, '').trim().replace(/^:\s*/, '');
      if (criticText.length > 0 && criticText.length < 60) {
        currentCritic = criticText;
        continue;
      }
    }

    // Short "Read the review here" link paragraphs (LBO puts these in separate <p>)
    if (text.length <= 40 && /read the review|read more|full review/i.test(text)) {
      const link = $(el).find('a').first();
      const linkHref = link.length ? link.attr('href') : '';
      if (linkHref && linkHref.startsWith('http') && !linkHref.includes('londonboxoffice.co.uk')) {
        currentUrl = linkHref;
      }
      continue;
    }

    // Excerpt — longer paragraph text
    if (text.length > 40) {
      // Capture first link as review URL
      const link = $(el).find('a').first();
      if (link.length && link.attr('href')) {
        const href = link.attr('href');
        // Only capture external review links (not LBO internal or relative links)
        if (!href.includes('londonboxoffice.co.uk') && href.startsWith('http')) {
          currentUrl = href;
        }
      }

      // Also check for "Read the full review" style links
      const allLinks = $(el).find('a').toArray();
      for (const a of allLinks) {
        const href = $(a).attr('href') || '';
        const linkText = $(a).text().toLowerCase();
        if ((linkText.includes('full review') || linkText.includes('read more')) && !href.includes('londonboxoffice.co.uk')) {
          currentUrl = href;
          break;
        }
      }

      // Clean excerpt — remove "Read the full review" suffix
      let excerpt = text.replace(/\s*Read the full review\.?\s*$/i, '').trim();
      excerpt = excerpt.replace(/\s*Read more\.?\s*$/i, '').trim();

      if (excerpt.length > 30) {
        currentExcerpt = excerpt;

        // Fallback critic extraction from inline patterns like "Name called it..."
        // Only if no Reviewer: line was found for this review
        if (!currentCritic) {
          const inlineMatch = excerpt.match(/^[""\u201C]?.{0,5}(?:[""\u201D]\s*)?([A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:called|thought|was\s|said\s|wrote\s|praised\s|described\s|noted\s|found\s|felt\s|hailed\s|loved\s)/);
          if (inlineMatch) {
            const candidateCritic = inlineMatch[1];
            // Don't match outlet names (The Guardian, The Times, etc.)
            if (!/^The\s/i.test(candidateCritic) && candidateCritic.toLowerCase() !== currentOutlet.toLowerCase()) {
              currentCritic = candidateCritic;
            }
          }
        }
      }
    }
  }

  // Flush last review
  flushReview();

  // Also try: look for links that might be review URLs after excerpts
  // Some LBO pages put the review link as a separate <p><a>Read full review</a></p>
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().toLowerCase();
    if ((text.includes('full review') || text.includes('read more')) && !href.includes('londonboxoffice.co.uk')) {
      // Try to associate with nearest preceding review
      // (handled in main loop above, this is a backup)
    }
  });

  return reviews;
}

// ---------------------------------------------------------------------------
// Extract from individual review page (single critic, no star rating)
// ---------------------------------------------------------------------------

function extractIndividualReviewFromLBO(html, showId) {
  const $ = cheerio.load(html);

  // Author from JSON-LD structured data
  let critic = 'Unknown';
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const ld = JSON.parse($(el).text());
      if (ld.author) {
        const name = Array.isArray(ld.author)
          ? (ld.author[0]?.name || '')
          : (ld.author.name || ld.author);
        if (typeof name === 'string' && name.length > 1 && name.length < 60) {
          critic = name.trim();
        }
      }
    } catch (e) {}
  });

  // Fallback: look for byline patterns in the page
  if (critic === 'Unknown') {
    const byline = $('[class*="author"], [class*="byline"], [rel="author"]').first().text().trim();
    if (byline && byline.length > 1 && byline.length < 60) {
      critic = byline;
    }
  }

  // Extract first 500 chars of body text as excerpt
  const paragraphs = [];
  $('article p, .post-content p, .entry-content p').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 30) paragraphs.push(text);
  });
  const excerpt = paragraphs.slice(0, 3).join(' ').substring(0, 500);

  return {
    outlet: 'London Box Office',
    stars: null,
    score: null,
    critic,
    excerpt: excerpt || '',
    url: '', // will be set to the LBO page URL itself
    showId,
    isIndividual: true,
  };
}

/**
 * Extract show title from an individual review URL.
 * Patterns: /review-{show-name}-{theatre} or /{show-name}-{theatre}-review
 */
function extractShowTitleFromIndividualUrl(url) {
  // Pattern 1: /review-{show}-{theatre}
  const prefixMatch = url.match(/\/news\/post\/review-(.+)$/i);
  if (prefixMatch) {
    const slug = prefixMatch[1];
    return stripTheatreFromSlug(slug);
  }

  // Pattern 2: /{show}-{theatre}-review
  const suffixMatch = url.match(/\/news\/post\/(.+)-review$/i);
  if (suffixMatch) {
    const slug = suffixMatch[1];
    return stripTheatreFromSlug(slug);
  }

  return null;
}

function stripTheatreFromSlug(slug) {
  // Known theatre names to strip (reuse same list as roundup extraction)
  const theatres = [
    'noel-coward-theatre', 'aldwych-theatre', 'apollo-theatre',
    'theatre-royal-haymarket', 'harold-pinter-theatre', 'duke-of-yorks-theatre',
    'duke-of-york-s-theatre', 'trafalgar-theatre', 'ambassadors-theatre',
    'bridge-theatre', 'savoy-theatre', 'wyndhams-theatre', 'wyndham-s-theatre',
    'donmar-warehouse', 'old-vic', 'the-old-vic', 'young-vic',
    'national-theatre', 'gielgud-theatre', 'lyceum-theatre',
    'london-palladium', 'phoenix-theatre', 'playhouse-theatre',
    'vaudeville-theatre', 'noël-coward-theatre', 'garrick-theatre',
    'criterion-theatre', 'duchess-theatre', 'fortune-theatre',
    'palace-theatre', 'piccadilly-theatre', 'prince-edward-theatre',
    'prince-of-wales-theatre', 'queens-theatre', 'savoy-theatre',
    'shaftesbury-theatre', 'st-james-theatre', 'st-martins-theatre',
    'gillian-lynne-theatre', 'barbican', 'soho-place',
    '@soho-place', 'at-soho-place',
    'dorfman-theatre', 'lyttelton-theatre', 'olivier-theatre',
    'harold-pinter', 'sadlers-wells', 'sadlers-wells-east',
    'london-coliseum', 'bush-theatre', 'park-theatre',
    'omnibus-theatre', 'arcola-theatre', 'drury-lane',
    'jermyn-street-theatre', 'waterloo-east',
  ];

  let cleaned = slug;
  for (const theatre of theatres) {
    // Strip "-at-the-{theatre}" or just "-{theatre}" from end
    const atPattern = new RegExp(`-at-(?:the-)?${theatre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const directPattern = new RegExp(`-${theatre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    if (atPattern.test(cleaned)) {
      cleaned = cleaned.replace(atPattern, '');
      break;
    }
    if (directPattern.test(cleaned)) {
      cleaned = cleaned.replace(directPattern, '');
      break;
    }
  }

  return decodeURIComponent(cleaned).replace(/-/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Save review data
// ---------------------------------------------------------------------------

function saveLBOReview(showId, reviewInfo) {
  const sourceName = reviewInfo.isIndividual ? 'lbo-individual' : 'lbo-roundup';

  // Build score fields — aggregator score, store as metadata only
  const scoreFields = {};
  if (reviewInfo.score !== null && reviewInfo.score !== undefined) {
    scoreFields.aggregatorStars = reviewInfo.score;
    scoreFields.scoreSource = 'lbo-star-rating';
  }

  const result = createOrMergeReviewFile(showId, {
    outlet: reviewInfo.outlet,
    criticName: reviewInfo.critic,
    url: reviewInfo.url,
    source: sourceName,
    fields: {
      lboRoundupExcerpt: reviewInfo.excerpt || undefined,
      ...scoreFields,
    },
  }, {
    dryRun: DRY_RUN,
    onMerge(existing) {
      // Upgrade critic name if incoming has one and existing is 'Unknown'
      if (reviewInfo.critic !== 'Unknown' && (!existing.criticName || existing.criticName === 'Unknown')) {
        existing.criticName = reviewInfo.critic;
      }
    },
  });

  if (result.action === 'new') stats.newReviews++;
  else if (result.action === 'updated') stats.updatedReviews++;
  else if (result.reason?.startsWith('domain-mismatch')) stats.skippedDomainMismatch = (stats.skippedDomainMismatch || 0) + 1;
  else stats.skippedExisting++;

  return result.action === 'skipped' ? 'skipped' : result.action;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function scrapeLBORoundups() {
  console.log('=== London Box Office Review Roundups Scraper ===\n');

  // Parse CLI flags
  const args = process.argv.slice(2);
  const showsArg = args.find(a => a.startsWith('--shows='));
  const targetShowIds = showsArg ? showsArg.replace('--shows=', '').split(',').map(s => s.trim()).filter(Boolean) : null;

  if (targetShowIds) {
    console.log(`Targeted mode: ${targetShowIds.length} show(s): ${targetShowIds.join(', ')}`);
  }
  if (DRY_RUN) console.log('[DRY RUN] No files will be written\n');

  // Ensure archive directory exists
  if (!DRY_RUN && !fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const shows = loadShows();
  // Filter to West End shows only
  const weShows = shows.filter(s => isLondonMarket(s.category));
  console.log(`Loaded ${weShows.length} West End shows from shows.json\n`);

  // Step 1: Check curated roundup URL map first (most reliable)
  const matchedRoundups = [];
  const curatedMapPath = path.join(__dirname, '../data/lbo-roundup-urls.json');
  let curatedMap = {};
  try {
    const mapData = JSON.parse(fs.readFileSync(curatedMapPath, 'utf8'));
    curatedMap = mapData.shows || {};
    console.log(`Loaded ${Object.keys(curatedMap).length} curated LBO roundup URLs`);
  } catch (e) {
    console.log('No curated LBO roundup map found — will use sitemap discovery');
  }

  // Match curated URLs to target shows
  const curatedMatchedIds = new Set();
  for (const [showId, url] of Object.entries(curatedMap)) {
    if (targetShowIds && !targetShowIds.includes(showId)) continue;
    const show = weShows.find(s => s.id === showId);
    if (show) {
      matchedRoundups.push({ url, show, extractedTitle: show.title });
      curatedMatchedIds.add(showId);
      console.log(`  [CURATED] ${show.title} → ${url}`);
    }
  }

  // Step 2: Discover additional roundup + individual review URLs from sitemap
  let roundupUrls = [];
  let individualUrls = [];
  try {
    const discovered = await discoverRoundupUrls();
    roundupUrls = discovered.roundups;
    individualUrls = discovered.individual;
  } catch (err) {
    console.error(`Failed to fetch sitemap: ${err.message}`);
    console.log('Falling back to targeted shows with Google SERP...');
  }

  // Match sitemap roundup URLs to shows (skip already-curated ones)
  for (const url of roundupUrls) {
    const extractedTitle = extractShowTitleFromUrl(url);
    if (!extractedTitle) continue;

    const match = matchTitleToShow(extractedTitle, weShows, { market: 'west-end' });
    if (match && match.show) {
      if (curatedMatchedIds.has(match.show.id)) continue; // Already have curated URL
      if (targetShowIds && !targetShowIds.includes(match.show.id)) continue;
      matchedRoundups.push({ url, show: match.show, extractedTitle });
    }
  }

  // Match individual review URLs to shows
  const matchedIndividual = [];

  for (const url of individualUrls) {
    const extractedTitle = extractShowTitleFromIndividualUrl(url);
    if (!extractedTitle) continue;

    const match = matchTitleToShow(extractedTitle, weShows, { market: 'west-end' });
    if (match && match.show) {
      if (targetShowIds && !targetShowIds.includes(match.show.id)) continue;
      matchedIndividual.push({ url, show: match.show, extractedTitle });
    }
  }

  stats.matchedShows = matchedRoundups.length;
  stats.matchedIndividual = matchedIndividual.length;
  console.log(`\nMatched ${matchedRoundups.length} roundups + ${matchedIndividual.length} individual reviews to West End shows\n`);

  // If targeted mode and some shows weren't matched via sitemap, try SERP fallback
  if (targetShowIds && SCRAPINGBEE_KEY) {
    const matchedIds = new Set(matchedRoundups.map(r => r.show.id));
    const unmatchedTargets = targetShowIds.filter(id => !matchedIds.has(id));

    for (const showId of unmatchedTargets) {
      const show = weShows.find(s => s.id === showId);
      if (!show) {
        console.log(`[WARN] Show ${showId} not found in West End shows`);
        continue;
      }

      console.log(`[SERP] Searching for ${show.title} roundup...`);
      try {
        const query = `site:londonboxoffice.co.uk "review round up" "${show.title}"`;
        const results = await serpQuery(query, { nbResults: 5 });
        const searchResult = results
          ? (results.map(r => r.url).filter(u => u && u.includes('londonboxoffice.co.uk') && /review-round-?up/i.test(u))[0] || null)
          : null;

        if (searchResult) {
          console.log(`  Found via SERP: ${searchResult}`);
          matchedRoundups.push({ url: searchResult, show, extractedTitle: show.title });
          stats.matchedShows++;
        } else {
          console.log(`  No LBO roundup found for ${show.title}`);
        }
        await sleep(2000);
      } catch (err) {
        console.log(`  SERP error: ${err.message}`);
      }
    }
  }

  // Process each matched roundup
  for (const { url, show } of matchedRoundups) {
    const showId = show.id;
    const archivePath = path.join(archiveDir, `${showId}.html`);

    // Check cached archive (fresh < 14 days)
    const archiveFresh = !FORCE && fs.existsSync(archivePath) &&
      (Date.now() - fs.statSync(archivePath).mtimeMs) / (1000 * 60 * 60 * 24) < 14;

    let html;
    if (archiveFresh) {
      console.log(`[CACHE] ${showId}: Using archived HTML`);
      html = fs.readFileSync(archivePath, 'utf8');
      stats.skippedArchived++;
    } else {
      console.log(`[FETCH] ${showId}: ${url}`);
      try {
        const result = await fetchPage(url);
        html = result ? result.content : null;
        if (!html || html.length < 500) {
          console.log(`  Empty or too short page, skipping`);
          continue;
        }
        if (!DRY_RUN) {
          // Archive with source URL header
          fs.writeFileSync(archivePath, `<!-- Source: ${url} -->\n${html}`);
        }
        stats.pagesFetched++;
        await sleep(1500); // Rate limit
      } catch (err) {
        console.error(`  [ERROR] ${showId}: ${err.message}`);
        stats.errors.push(`${showId}: ${err.message}`);
        continue;
      }
    }

    // Validate: page title should mention the show we matched to
    // Prevents misassignment when matchTitleToShow fuzzy-matches the wrong show
    const pageTitleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (pageTitleMatch) {
      const pageTitle = pageTitleMatch[1].toLowerCase();
      const showWords = show.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
      const matchingWords = showWords.filter(w => pageTitle.includes(w));
      if (matchingWords.length < Math.min(2, showWords.length)) {
        console.log(`  [SKIP] Page title "${pageTitleMatch[1].substring(0, 60)}" doesn't match show "${show.title}" — misassignment`);
        stats.skippedMismatch = (stats.skippedMismatch || 0) + 1;
        continue;
      }
    }

    // Extract reviews
    const reviews = extractReviewsFromLBO(html, showId);
    stats.reviewsExtracted += reviews.length;
    console.log(`  Found ${reviews.length} reviews`);

    for (const review of reviews) {
      const result = saveLBOReview(showId, review);
      const starStr = review.stars !== null ? ` (${review.stars}★ → ${review.score})` : '';
      if (result === 'new') {
        console.log(`    [NEW] ${review.outlet}${starStr} — ${review.critic}`);
      } else if (result === 'updated') {
        console.log(`    [UPD] ${review.outlet}${starStr}`);
      }
    }
  }

  // Process individual reviews
  if (matchedIndividual.length > 0) {
    console.log(`\n--- Individual LBO Reviews (${matchedIndividual.length}) ---`);
    const individualArchiveDir = path.join(archiveDir, 'individual');
    if (!DRY_RUN && !fs.existsSync(individualArchiveDir)) {
      fs.mkdirSync(individualArchiveDir, { recursive: true });
    }

    for (const { url, show } of matchedIndividual) {
      const showId = show.id;
      const archiveName = url.split('/').pop() + '.html';
      const archivePath = path.join(individualArchiveDir, archiveName);

      // Check cached archive
      const archiveFresh = !FORCE && fs.existsSync(archivePath) &&
        (Date.now() - fs.statSync(archivePath).mtimeMs) / (1000 * 60 * 60 * 24) < 14;

      let html;
      if (archiveFresh) {
        console.log(`[CACHE] ${showId}: Using archived individual review`);
        html = fs.readFileSync(archivePath, 'utf8');
      } else {
        console.log(`[FETCH] ${showId}: ${url}`);
        try {
          const result = await fetchPage(url);
          html = result ? result.content : null;
          if (!html || html.length < 500) {
            console.log(`  Empty or too short page, skipping`);
            continue;
          }
          if (!DRY_RUN) {
            fs.writeFileSync(archivePath, `<!-- Source: ${url} -->\n${html}`);
          }
          stats.pagesFetched++;
          await sleep(1500);
        } catch (err) {
          console.error(`  [ERROR] ${showId}: ${err.message}`);
          stats.errors.push(`${showId} (individual): ${err.message}`);
          continue;
        }
      }

      // Extract single review
      const review = extractIndividualReviewFromLBO(html, showId);
      review.url = url; // The LBO page IS the review
      stats.reviewsExtracted++;

      const result = saveLBOReview(showId, review);
      if (result === 'new') {
        console.log(`    [NEW] London Box Office — ${review.critic}`);
        stats.individualNew = (stats.individualNew || 0) + 1;
      } else if (result === 'updated') {
        console.log(`    [UPD] London Box Office — ${review.critic}`);
      }
    }
  }

  // Print summary
  console.log('\n=== LBO Summary ===');
  console.log(`Sitemap: ${stats.sitemapUrls} roundups + ${stats.individualUrls || 0} individual reviews`);
  console.log(`Matched roundups: ${stats.matchedShows} | Matched individual: ${stats.matchedIndividual || 0}`);
  console.log(`Pages fetched: ${stats.pagesFetched}`);
  console.log(`Used cached archives: ${stats.skippedArchived}`);
  console.log(`Total reviews extracted: ${stats.reviewsExtracted}`);
  console.log(`New reviews: ${stats.newReviews} (${stats.individualNew || 0} individual)`);
  console.log(`Updated reviews: ${stats.updatedReviews}`);
  console.log(`Skipped (already have excerpt): ${stats.skippedExisting}`);
  if (stats.errors.length > 0) {
    console.log(`Errors: ${stats.errors.length}`);
    stats.errors.forEach(e => console.log(`  - ${e}`));
  }
  if (DRY_RUN) console.log('\n[DRY RUN] No files were written');

  await cleanupScraper();
  return stats;
}

// Export extraction function for use by gather-reviews.js
module.exports = { extractReviewsFromLBO };

// Run if called directly
if (require.main === module) {
  scrapeLBORoundups().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
