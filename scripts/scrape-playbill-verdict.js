#!/usr/bin/env node
/**
 * Playbill Verdict Scraper
 *
 * Discovers new reviews from outlets not on DTLI/Show Score/BWW by scraping
 * Playbill's "The Verdict" review roundup articles.
 *
 * Strategy:
 * 1. Scrape https://playbill.com/category/the-verdict for all Verdict articles
 * 2. Match article titles to shows.json
 * 3. Fetch each matched article and extract review links
 * 4. Google fallback for shows not found on category page
 *
 * Output: Creates/updates review files in data/review-texts/{showId}/
 * Archives: Saves HTML to data/aggregator-archive/playbill-verdict/
 */

const fs = require('fs');
const path = require('path');
const { matchTitleToShow, loadShows, cleanExternalTitle } = require('./lib/show-matching');
const { normalizeOutlet, normalizeCritic, generateReviewFilename, findExistingReviewFile } = require('./lib/review-normalization');
const cheerio = require('cheerio');

// Paths
const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const archiveDir = path.join(__dirname, '../data/aggregator-archive/playbill-verdict');

// ScrapingBee for Google searches
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;
const BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_TOKEN;

// Stats
const stats = {
  articlesFound: 0,
  matchedShows: 0,
  articlesFetched: 0,
  reviewLinksExtracted: 0,
  newReviews: 0,
  updatedReviews: 0,
  skippedExisting: 0,
  skippedOffBroadway: 0,
  googleSearches: 0,
  errors: [],
};

const https = require('https');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// HTTP helper — fetch a page via ScrapingBee (no JS rendering needed for Playbill)
// ---------------------------------------------------------------------------

async function fetchHtmlSingle(url) {
  if (!SCRAPINGBEE_KEY) {
    throw new Error('SCRAPINGBEE_API_KEY required');
  }

  const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=false`;

  return new Promise((resolve, reject) => {
    const req = https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchHtml(url, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchHtmlSingle(url);
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        const delay = 3000 * (attempt + 1);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Google search via ScrapingBee Google Search API
// ---------------------------------------------------------------------------

async function googleSearch(query) {
  if (!SCRAPINGBEE_KEY) {
    console.log('  [WARN] No SCRAPINGBEE_API_KEY set, skipping Google search');
    return [];
  }

  const apiUrl = `https://app.scrapingbee.com/api/v1/store/google?api_key=${SCRAPINGBEE_KEY}&search=${encodeURIComponent(query)}&nb_results=5`;

  return new Promise((resolve, reject) => {
    const req = https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const results = JSON.parse(data);
            const urls = (results.organic_results || [])
              .map(r => r.url)
              .filter(url => url && url.includes('playbill.com/article/'));
            resolve(urls);
          } catch (e) {
            // Try extracting URLs from raw HTML fallback
            const urls = [];
            const linkPattern = /href="(https?:\/\/playbill\.com\/article\/[^"]+)"/gi;
            let match;
            while ((match = linkPattern.exec(data)) !== null) {
              urls.push(match[1]);
            }
            resolve(urls);
          }
        } else {
          reject(new Error(`Google search HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ---------------------------------------------------------------------------
// Parse Playbill Verdict category page (HTML or markdown format)
// ---------------------------------------------------------------------------

function extractArticlesFromCategoryPage(content) {
  const articles = [];
  const seen = new Set();

  // Pattern 1: HTML links - <a href="/article/...">Title</a>
  const htmlPattern = /<a[^>]*href="((?:https:\/\/playbill\.com)?\/article\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
  let match;
  while ((match = htmlPattern.exec(content)) !== null) {
    let url = match[1];
    if (url.startsWith('/')) url = `https://playbill.com${url}`;
    const title = match[2].trim();
    if (seen.has(url) || title.length < 5 || title.length > 200) continue;
    seen.add(url);
    articles.push({ url, title });
  }

  // Pattern 2: Markdown links - [Title](https://playbill.com/article/...)
  const mdPattern = /\[([^\]]+)\]\((https:\/\/playbill\.com\/article\/[^)]+)\)/gi;
  while ((match = mdPattern.exec(content)) !== null) {
    const title = match[1].trim();
    const url = match[2].trim();
    if (seen.has(url) || title.length < 5 || title.length > 200) continue;
    seen.add(url);
    articles.push({ url, title });
  }

  // Pattern 3: Bare Playbill article URLs
  const barePattern = /(https:\/\/playbill\.com\/article\/[a-z0-9-]+)/gi;
  while ((match = barePattern.exec(content)) !== null) {
    const url = match[1];
    if (seen.has(url)) continue;
    seen.add(url);
    // Extract title from URL slug
    const slug = url.split('/article/')[1] || '';
    const title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    articles.push({ url, title });
  }

  return articles;
}

// ---------------------------------------------------------------------------
// Filter to Broadway only
// ---------------------------------------------------------------------------

function isNotBroadway(title) {
  const lower = title.toLowerCase();
  return (
    lower.includes('off-broadway') ||
    lower.includes('off broadway') ||
    lower.includes('west end') ||
    lower.includes('opera') ||
    lower.includes('london') ||
    lower.includes('national tour') ||
    lower.includes('touring production') ||
    lower.includes('in chicago') ||
    lower.includes('world premiere') ||
    lower.includes('on screen') ||
    lower.includes('on film') ||
    lower.includes('movie') ||
    lower.includes('filmed version') ||
    // Specific venue mentions that indicate non-Broadway
    lower.includes('playhouse theatre') ||
    lower.includes('chicago shakespeare') ||
    // Off-Broadway / regional venues
    lower.includes('public theater') || lower.includes('at the public') ||
    lower.includes('old globe') || lower.includes('la jolla') ||
    lower.includes('hollywood bowl') || lower.includes('at the ahmanson') ||
    // TV specials and streaming
    (lower.includes(' live') && (lower.includes('nbc') || lower.includes('tv'))) ||
    lower.includes('tv series') || lower.includes('tv show') ||
    lower.includes('apple tv') || lower.includes('netflix') ||
    lower.includes('hulu') || lower.includes('disney+') ||
    lower.includes('streaming') || lower.includes('amazon prime')
  );
}

// ---------------------------------------------------------------------------
// Cross-show URL validation
// Prevents review links from being attributed to the wrong show
// (e.g., Bug reviews getting saved as All Out reviews)
// ---------------------------------------------------------------------------

/**
 * Check if a review URL clearly belongs to a different show.
 * Returns the detected wrong show slug if found, or null if URL is ok.
 */
function urlBelongsToDifferentShow(url, targetShowId, targetSlug, shows) {
  if (!url) return null;

  let urlPath;
  try {
    urlPath = new URL(url).pathname.toLowerCase();
  } catch (e) {
    return null;
  }

  // Strip common URL prefixes that aren't show-specific
  const pathSlug = urlPath
    .replace(/^\//, '')
    .replace(/\.(html?|php|asp)$/i, '');

  // Build a list of show slugs to check against (exclude the target show)
  // Only check shows with slugs that are 3+ chars to avoid false positives
  // (2-char slugs like "mj" would match too broadly in URLs)
  for (const show of shows) {
    if (show.id === targetShowId) continue;
    if (!show.slug || show.slug.length < 3) continue;

    // Check if URL path contains another show's slug as a distinct segment
    // Use word-boundary-like matching to avoid partial matches
    // e.g., "bug-broadway-review" matches "bug" but "debugging" should not
    const slug = show.slug.toLowerCase();
    const slugPattern = new RegExp(`(?:^|[/-])${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[/-])`, 'i');

    if (slugPattern.test(pathSlug)) {
      // Also verify the target show's slug is NOT in the URL
      // (if both are present, it might be a legitimate comparison article)
      const targetPattern = new RegExp(`(?:^|[/-])${targetSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[/-])`, 'i');
      if (!targetPattern.test(pathSlug)) {
        return show.slug;
      }
    }
  }

  return null;
}

// Map domains to recognizable outlet names so normalizeOutlet() can match them
const DOMAIN_TO_OUTLET = {
  'nytimes.com': 'New York Times',
  'chicagotribune.com': 'Chicago Tribune',
  'hollywoodreporter.com': 'Hollywood Reporter',
  'theguardian.com': 'The Guardian',
  'vulture.com': 'Vulture',
  'ew.com': 'Entertainment Weekly',
  'nypost.com': 'New York Post',
  'nydailynews.com': 'New York Daily News',
  'wsj.com': 'Wall Street Journal',
  'usatoday.com': 'USA Today',
  'washingtonpost.com': 'Washington Post',
  'thedailybeast.com': 'The Daily Beast',
  'observer.com': 'Observer',
  'newyorktheater.me': 'New York Theater',
  'newyorktheatreguide.com': 'New York Theatre Guide',
  'nystagereview.com': 'New York Stage Review',
  'nysun.com': 'New York Sun',
  'theatermania.com': 'TheaterMania',
  'theatrely.com': 'Theatrely',
  'theaterpizzazz.com': 'Theater Pizzazz',
  'timeout.com': 'Time Out',
  'deadline.com': 'Deadline',
  'variety.com': 'Variety',
  'thewrap.com': 'The Wrap',
  'broadwaynews.com': 'Broadway News',
  'cititour.com': 'Cititour',
  'culturesauce.com': 'Culture Sauce',
  'slantmagazine.com': 'Slant Magazine',
  'digitaljournal.com': 'Digital Journal',
  'queerty.com': 'Queerty',
  'exeuntnyc.com': 'Exeunt NYC',
  'slashfilm.com': 'SlashFilm',
  'thestage.co.uk': 'The Stage',
  'independent.co.uk': 'The Independent',
  'dailymail.co.uk': 'The Daily Mail',
  'telegraph.co.uk': 'The Telegraph',
  'thetimes.com': 'The Times',
  'standard.co.uk': 'Evening Standard',
  'whatsonstage.com': 'WhatsOnStage',
  'inews.co.uk': 'iNews',
  'londontheatre.co.uk': 'London Theatre',
  'talkinbroadway.com': 'Talkin Broadway',
  'dctheaterarts.org': 'DC Theater Arts',
  'thefrontrowcenter.com': 'Front Row Center',
  'newyorker.com': 'The New Yorker',
};

// Known NYSR critics — when Playbill lists just the critic name as the "outlet",
// we should detect this and use "nysr" as the outlet instead
const NYSR_CRITICS = [
  'frank scheck', 'melissa rose bernardo', 'david finkle', 'roma torre',
  'bob verini', 'michael sommers', 'sandy macdonald', 'steven suskin',
  'elysa gardner'
];

// ---------------------------------------------------------------------------
// Extract review links from a Verdict article
// ---------------------------------------------------------------------------

function extractReviewLinksFromArticle(html, showId) {
  const reviews = [];
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);

  // Playbill Verdict articles typically list reviews as links with outlet/critic info
  // Pattern: <a href="review-url">Outlet Name</a> or embedded in text

  // Find all links in the article body
  const articleContent = $('article, .article-content, .article-body, .entry-content, main').first();
  const container = articleContent.length ? articleContent : $.root();

  container.find('a').each((_, el) => {
    const href = $(el).attr('href');
    const linkText = $(el).text().trim();

    if (!href || !linkText) return;

    // Skip non-review links: internal playbill, social media, ads, stores, platforms
    if (href.includes('playbill.com') || href.includes('playbillder.com') ||
        href.includes('playbillstore.com') || href.includes('playbilltravel.com')) return;
    if (href.includes('facebook.com') || href.includes('twitter.com') ||
        href.includes('instagram.com') || href.includes('youtube.com') ||
        href.includes('tiktok.com') || href.includes('threads.net')) return;
    if (href.includes('ticketmaster') || href.includes('telecharge') ||
        href.includes('todaytix') || href.includes('seatgeek')) return;
    if (href.includes('.ffm.to') || href.includes('spotify.com') ||
        href.includes('apple.com') || href.includes('amazon.com')) return;
    if (href.includes('americanrepertorytheater.org') || href.includes('americantheatrewing.org')) return;
    if (href.includes('wikipedia.org') || href.includes('google.com')) return;
    // Internal Playbill links and theater venue websites
    if (href.includes('playbillvault.com')) return;
    if (href.includes('eugeneoneillbroadway.com') || href.includes('2st.com') ||
        href.includes('roundabouttheatre.org') || href.includes('broadwayinhollywood.com') ||
        href.includes('minskoffbroadway.com') || href.includes('shubert.nyc')) return;
    // Ticketing, aggregator, and affiliate sites (not review sources)
    if (href.includes('criterionticketing.com') || href.includes('didtheylikeit.com') ||
        href.includes('broadwaybox.com') || href.includes('nbc.com') ||
        href.includes('yahoo.com') || href.includes('people.com')) return;
    if (href.includes('tidd.ly') || href.includes('bit.ly') || href.includes('tinyurl.com') ||
        href.includes('stubhub') || href.includes('vividseat') ||
        href.includes('broadwaydirect.com') || href.includes('luckyseat.com') ||
        href.includes('rush.todaytix.com') || href.includes('lottery.broadwaydirect.com')) return;
    if (href.length < 20) return;

    // Must look like a review URL (contains a path, not just a domain)
    try {
      const urlObj = new URL(href);
      if (urlObj.pathname === '/' || urlObj.pathname === '') return;
    } catch (e) {
      return;
    }

    // This looks like a review link — extract outlet info from link text or surrounding text
    const parentText = $(el).parent().text().trim().slice(0, 300);

    // Try to identify outlet from the URL domain
    let outlet = '';
    try {
      const domain = new URL(href).hostname.replace('www.', '');
      outlet = domain;
    } catch (e) {
      // Invalid URL
      return;
    }

    // Try to extract critic name from text near the link
    // Common patterns: "Outlet (Critic Name)", "Critic Name, Outlet"
    let critic = '';
    const parenMatch = parentText.match(/\(([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\)/);
    if (parenMatch) {
      critic = parenMatch[1];
    }

    reviews.push({
      url: href,
      outlet: linkText || outlet,
      outletDomain: outlet,
      critic,
      showId,
    });
  });

  return reviews;
}

// ---------------------------------------------------------------------------
// Save review data
// ---------------------------------------------------------------------------

function saveReviewFromPlaybill(showId, reviewInfo) {
  const showDir = path.join(reviewTextsDir, showId);

  // Resolve domain to human-readable outlet name first
  let outletName = DOMAIN_TO_OUTLET[reviewInfo.outletDomain] || reviewInfo.outlet || reviewInfo.outletDomain;
  let criticName = reviewInfo.critic || '';
  if (NYSR_CRITICS.some(c => outletName.toLowerCase().includes(c))) {
    criticName = outletName; // The "outlet" is actually the critic name
    outletName = 'New York Stage Review';
  }

  // Normalize outlet using the shared normalization system
  const outletId = normalizeOutlet(outletName) || normalizeOutlet(reviewInfo.outletDomain) || reviewInfo.outletDomain;
  if (!outletId) return 'skipped';

  // Normalize critic
  const criticSlug = criticName
    ? normalizeCritic(criticName)
    : 'unknown';

  // Check for existing file BEFORE creating — use cross-scraper dedup
  const existing = findExistingReviewFile(showDir, outletName, criticName || null);
  if (existing && existing.data) {
    // File exists for this outlet (+critic) — just add playbillVerdictUrl
    if (!existing.data.playbillVerdictUrl) {
      existing.data.playbillVerdictUrl = reviewInfo.url;
      if (!existing.data.url && reviewInfo.url) {
        existing.data.url = reviewInfo.url;
      }
      const sources = new Set(existing.data.sources || [existing.data.source || '']);
      sources.add('playbill-verdict');
      existing.data.sources = Array.from(sources).filter(Boolean);
      fs.writeFileSync(existing.path, JSON.stringify(existing.data, null, 2) + '\n');
      stats.updatedReviews++;
      return 'updated';
    }
    stats.skippedExisting++;
    return 'skipped';
  }

  // Also check exact filename match (belt and suspenders)
  const filename = `${outletId}--${criticSlug}.json`;
  const filepath = path.join(showDir, filename);
  if (fs.existsSync(filepath)) {
    const existingData = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    if (!existingData.playbillVerdictUrl) {
      existingData.playbillVerdictUrl = reviewInfo.url;
      if (!existingData.url && reviewInfo.url) {
        existingData.url = reviewInfo.url;
      }
      const sources = new Set(existingData.sources || [existingData.source || '']);
      sources.add('playbill-verdict');
      existingData.sources = Array.from(sources).filter(Boolean);
      fs.writeFileSync(filepath, JSON.stringify(existingData, null, 2) + '\n');
      stats.updatedReviews++;
      return 'updated';
    }
    stats.skippedExisting++;
    return 'skipped';
  }

  // Create new minimal review file
  if (!fs.existsSync(showDir)) {
    fs.mkdirSync(showDir, { recursive: true });
  }

  const reviewData = {
    showId,
    outletId,
    outlet: outletName,
    criticName: criticName || 'Unknown',
    url: reviewInfo.url,
    playbillVerdictUrl: reviewInfo.url,
    source: 'playbill-verdict',
    sources: ['playbill-verdict'],
  };

  fs.writeFileSync(filepath, JSON.stringify(reviewData, null, 2) + '\n');
  stats.newReviews++;
  return 'new';
}

// ---------------------------------------------------------------------------
// Per-show Google search (used by both targeted and batch modes)
// ---------------------------------------------------------------------------

async function processShowViaGoogle(show, showId, shows) {
  const existingArchive = path.join(archiveDir, `${showId}.html`);
  // Also check slug-based archive from older runs
  const slugArchive = show.slug && show.slug !== show.id
    ? path.join(archiveDir, `${show.slug}.html`) : null;
  const effectiveArchive = fs.existsSync(existingArchive) ? existingArchive
    : (slugArchive && fs.existsSync(slugArchive) ? slugArchive : existingArchive);
  if (fs.existsSync(effectiveArchive)) {
    console.log(`  [CACHE] ${showId}: Using archived HTML`);
    const html = fs.readFileSync(effectiveArchive, 'utf8');
    const reviewLinks = extractReviewLinksFromArticle(html, showId);
    stats.reviewLinksExtracted += reviewLinks.length;
    for (const link of reviewLinks) {
      const result = saveReviewFromPlaybill(showId, link);
      if (result === 'new') {
        console.log(`    [NEW] ${link.outletDomain}: ${link.critic || 'unknown'}`);
      }
    }
    return;
  }

  // Simplify title for search: strip venue qualifiers and subtitles
  let searchTitle = show.title;
  searchTitle = searchTitle.replace(/\s+at\s+the\s+.+$/i, ''); // "Cabaret at the Kit Kat Club" → "Cabaret"
  searchTitle = searchTitle.replace(/:\s+.+$/, '');              // "Title: Subtitle" → "Title"
  searchTitle = searchTitle.replace(/\s+[–—]\s+.+$/, '');        // "Title — Subtitle" → "Title"

  const query = `site:playbill.com/article (reviews OR verdict OR critics) "${searchTitle}" broadway`;

  try {
    stats.googleSearches++;
    const urls = await googleSearch(query);

    const verdictUrls = urls.filter(u => {
      const slug = u.split('/article/')[1] || '';
      return slug.includes('review') || slug.includes('verdict') || slug.includes('critics') || slug.includes('what-are') || slug.includes('what-do');
    });

    // Prefer URLs with "broadway" in slug (more likely to be the right production)
    verdictUrls.sort((a, b) => {
      const aSlug = (a.split('/article/')[1] || '').toLowerCase();
      const bSlug = (b.split('/article/')[1] || '').toLowerCase();
      const aHasBway = aSlug.includes('broadway') ? 0 : 1;
      const bHasBway = bSlug.includes('broadway') ? 0 : 1;
      return aHasBway - bHasBway;
    });

    if (verdictUrls.length > 0) {
      // Look up show opening date for URL year validation (shared across candidates)
      const showEntry = shows.find(s => s.id === showId);
      const showOpeningYear = showEntry && showEntry.openingDate
        ? new Date(showEntry.openingDate).getFullYear() : null;
      const showClosingYear = showEntry && showEntry.closingDate
        ? new Date(showEntry.closingDate).getFullYear() : new Date().getFullYear();
      const showUpperBound = showOpeningYear ? Math.max(showOpeningYear + 2, showClosingYear + 1) : null;

      const GENERIC_WORDS = new Set(['the', 'a', 'an', 'new', 'musical', 'play', 'broadway', 'show', 'revival', 'comedy', 'drama', 'about', 'and', 'of', 'in', 'on', 'at', 'for']);
      const showTitleLower = show.title.toLowerCase()
        .replace(/^the\s+/, '').replace(/\s*[:(].*$/, '').trim();
      const showSlugWords = showTitleLower.split(/[\s,]+/)
        .filter(w => w.length > 2 && !GENERIC_WORDS.has(w));
      const firstWord = showSlugWords[0] || showTitleLower.split(/[\s,]+/)[0];

      // Try each candidate URL — skip non-Broadway/non-matching, use first good one
      let found = false;
      for (const articleUrl of verdictUrls) {
        console.log(`  [GOOGLE] ${showId}: Trying ${articleUrl}`);

        let html;
        try {
          html = await fetchHtml(articleUrl);
        } catch (fetchErr) {
          console.log(`    [WARN] Fetch failed for ${articleUrl}: ${fetchErr.message.slice(0, 80)}`);
          continue;
        }
        if (!html) continue;

        const $ = cheerio.load(html);
        const pageTitle = $('title').text() + ' ' + $('h1').text();
        if (isNotBroadway(pageTitle)) {
          console.log(`    [SKIP] Article is not about Broadway: "${pageTitle.slice(0, 80)}"`);
          continue;
        }

        const pageTitleLower = pageTitle.toLowerCase();
        const articleSlug = (articleUrl.split('/article/')[1] || '').toLowerCase();
        const titleHasFirstWord = firstWord && pageTitleLower.includes(firstWord);
        const urlHasFirstWord = firstWord && articleSlug.includes(firstWord);
        if (!titleHasFirstWord && !urlHasFirstWord) {
          console.log(`    [SKIP] Article doesn't match show "${show.title}": "${pageTitle.slice(0, 80)}"`);
          continue;
        }

        fs.writeFileSync(existingArchive, html);

        const reviewLinks = extractReviewLinksFromArticle(html, showId);
        stats.reviewLinksExtracted += reviewLinks.length;

        for (const link of reviewLinks) {
          // Cross-show URL validation: skip if URL clearly belongs to a different show
          const wrongShow = urlBelongsToDifferentShow(link.url, showId, show.slug || '', shows);
          if (wrongShow) {
            console.log(`    [SKIP] ${link.outletDomain}: URL belongs to "${wrongShow}", not "${showId}"`);
            stats.skippedOffBroadway++;
            continue;
          }

          // URL year validation
          if (showOpeningYear && showUpperBound && link.url) {
            const urlYearMatch = link.url.match(/\/((?:19|20)\d{2})\//);
            if (urlYearMatch) {
              const urlYear = parseInt(urlYearMatch[1]);
              if (urlYear < showOpeningYear - 3 || urlYear > showUpperBound) {
                console.log(`    [SKIP] ${link.outletDomain}: URL year ${urlYear} outside ${showOpeningYear - 3}–${showUpperBound}`);
                stats.skippedOffBroadway++;
                continue;
              }
            }
          }

          const result = saveReviewFromPlaybill(showId, link);
          if (result === 'new') {
            console.log(`    [NEW] ${link.outletDomain}: ${link.critic || 'unknown'}`);
          }
        }
        found = true;
        break; // Successfully processed an article
      }
      if (!found) {
        console.log(`  [GOOGLE] ${showId}: No matching Broadway article found`);
      }
    } else {
      console.log(`  [GOOGLE] ${showId}: No results`);
    }

    await sleep(2000);
  } catch (err) {
    console.error(`  [ERROR] Google search for ${showId}: ${err.message}`);
    stats.errors.push(`Google: ${showId}: ${err.message}`);
  }
}

function printSummary() {
  console.log('\n=== Playbill Verdict Summary ===');
  console.log(`Articles found: ${stats.articlesFound}`);
  console.log(`Matched to shows: ${stats.matchedShows}`);
  console.log(`Articles fetched: ${stats.articlesFetched}`);
  console.log(`Review links extracted: ${stats.reviewLinksExtracted}`);
  console.log(`New reviews created: ${stats.newReviews}`);
  console.log(`Existing reviews updated: ${stats.updatedReviews}`);
  console.log(`Skipped (existing): ${stats.skippedExisting}`);
  console.log(`Skipped (off-Broadway): ${stats.skippedOffBroadway}`);
  console.log(`Google searches: ${stats.googleSearches}`);
  if (stats.errors.length > 0) {
    console.log(`Errors: ${stats.errors.length}`);
    stats.errors.forEach(e => console.log(`  - ${e}`));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function scrapePlaybillVerdict() {
  console.log('=== Playbill Verdict Scraper ===\n');

  // Parse CLI flags
  const args = process.argv.slice(2);
  const showsArg = args.find(a => a.startsWith('--shows='));
  const targetShowIds = showsArg ? showsArg.replace('--shows=', '').split(',').map(s => s.trim()).filter(Boolean) : null;
  const noDateFilter = args.includes('--no-date-filter');

  if (targetShowIds) {
    console.log(`Targeted mode: ${targetShowIds.length} show(s): ${targetShowIds.join(', ')}`);
    if (noDateFilter) console.log('Date filter disabled (--no-date-filter)');
  }

  // Ensure archive directory exists
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const shows = loadShows();
  console.log(`Loaded ${shows.length} shows from shows.json\n`);

  // In targeted mode, skip category page scan and go directly to Google fallback
  if (targetShowIds) {
    let targetShows = shows.filter(s => targetShowIds.includes(s.id) || targetShowIds.includes(s.slug));
    if (!noDateFilter) {
      targetShows = targetShows.filter(s => new Date(s.openingDate) >= new Date('2023-01-01'));
    }
    console.log(`Processing ${targetShows.length} targeted show(s) via Google search...\n`);

    for (const show of targetShows) {
      const showId = show.id;
      await processShowViaGoogle(show, showId, shows);
    }

    printSummary();
    return stats;
  }

  // Step 1: Scrape category page (batch mode only)
  console.log('Fetching Playbill Verdict category page...');
  const allArticles = [];

  try {
    const html = await fetchHtml('https://playbill.com/category/the-verdict');
    if (html && html.length > 500) {
      fs.writeFileSync(path.join(archiveDir, 'category-page-1.html'), html);
      const articles = extractArticlesFromCategoryPage(html);
      allArticles.push(...articles);
      console.log(`  Category page: Found ${articles.length} articles`);
    } else {
      console.log('  Category page returned no content.');
    }
  } catch (err) {
    console.error(`  Error fetching category page: ${err.message}`);
    stats.errors.push(`Category page: ${err.message}`);
  }

  // Deduplicate
  const uniqueArticles = [];
  const seenUrls = new Set();
  for (const article of allArticles) {
    if (!seenUrls.has(article.url)) {
      seenUrls.add(article.url);
      uniqueArticles.push(article);
    }
  }

  stats.articlesFound = uniqueArticles.length;
  console.log(`\nTotal unique articles found: ${uniqueArticles.length}\n`);

  // Step 2: Match articles to shows
  const matchedArticles = [];
  const unmatchedShows = new Set(shows.map(s => s.id));

  for (const article of uniqueArticles) {
    if (isNotBroadway(article.title)) {
      stats.skippedOffBroadway++;
      continue;
    }

    const match = matchTitleToShow(article.title, shows);
    if (match) {
      const showId = match.show.id;
      matchedArticles.push({ ...article, showId, confidence: match.confidence });
      unmatchedShows.delete(showId);
      stats.matchedShows++;
    }
  }

  console.log(`Matched ${matchedArticles.length} articles to shows`);
  console.log(`Skipped ${stats.skippedOffBroadway} off-Broadway articles\n`);

  // Step 3: Fetch each matched article and extract review links
  for (const article of matchedArticles) {
    const archivePath = path.join(archiveDir, `${article.showId}.html`);
    // Also check slug-based archive from older runs
    const matchedShow = shows.find(s => s.id === article.showId);
    const slugArchive = matchedShow && matchedShow.slug && matchedShow.slug !== matchedShow.id
      ? path.join(archiveDir, `${matchedShow.slug}.html`) : null;
    const effectiveArchive = fs.existsSync(archivePath) ? archivePath
      : (slugArchive && fs.existsSync(slugArchive) ? slugArchive : archivePath);

    // Use cached archive if fresh (<14 days), otherwise re-fetch
    let html;
    const archiveFresh = fs.existsSync(effectiveArchive) &&
      (Date.now() - fs.statSync(effectiveArchive).mtimeMs) / (1000 * 60 * 60 * 24) < 14;
    if (archiveFresh) {
      html = fs.readFileSync(effectiveArchive, 'utf8');
      console.log(`  [CACHE] ${article.showId}: Using archived HTML`);
    } else {
      try {
        html = await fetchHtml(article.url);
        if (html) {
          fs.writeFileSync(archivePath, html);
          stats.articlesFetched++;
          console.log(`  [FETCH] ${article.showId}: ${article.title.slice(0, 60)}`);
        }
        await sleep(2000);
      } catch (err) {
        console.error(`  [ERROR] ${article.showId}: ${err.message}`);
        stats.errors.push(`${article.showId}: ${err.message}`);
        continue;
      }
    }

    if (!html) continue;

    // Validate the fetched article is about Broadway (not London, Chicago, film, etc.)
    const $article = cheerio.load(html);
    const articlePageTitle = $article('title').text() + ' ' + $article('h1').text();
    if (isNotBroadway(articlePageTitle)) {
      console.log(`    [SKIP] Article is not about Broadway: "${articlePageTitle.slice(0, 80)}"`);
      continue;
    }

    // Extract review links
    const reviewLinks = extractReviewLinksFromArticle(html, article.showId);
    stats.reviewLinksExtracted += reviewLinks.length;

    // Look up show opening date for URL year validation
    const showEntry = shows.find(s => s.id === article.showId);
    const showOpeningYear = showEntry && showEntry.openingDate
      ? new Date(showEntry.openingDate).getFullYear() : null;
    const showClosingYear = showEntry && showEntry.closingDate
      ? new Date(showEntry.closingDate).getFullYear() : new Date().getFullYear();
    const showUpperBound = showOpeningYear ? Math.max(showOpeningYear + 2, showClosingYear + 1) : null;

    for (const link of reviewLinks) {
      // Cross-show URL validation: skip if URL clearly belongs to a different show
      const wrongShow = urlBelongsToDifferentShow(link.url, article.showId, showEntry?.slug || '', shows);
      if (wrongShow) {
        console.log(`    [SKIP] ${link.outletDomain}: URL belongs to "${wrongShow}", not "${article.showId}"`);
        stats.skippedOffBroadway++;
        continue;
      }

      // Check for URL year mismatch (catches TV reviews, wrong productions)
      // Upper bound adapts to show run length (long-running shows get wider window)
      if (showOpeningYear && showUpperBound && link.url) {
        const urlYearMatch = link.url.match(/\/((?:19|20)\d{2})\//);
        if (urlYearMatch) {
          const urlYear = parseInt(urlYearMatch[1]);
          if (urlYear < showOpeningYear - 3 || urlYear > showUpperBound) {
            console.log(`    [SKIP] ${link.outletDomain}: URL year ${urlYear} outside ${showOpeningYear - 3}–${showUpperBound} (${Math.abs(urlYear - showOpeningYear)}yr from opening)`);
            stats.skippedOffBroadway++;
            continue;
          }
        }
      }

      const result = saveReviewFromPlaybill(article.showId, link);
      if (result === 'new') {
        console.log(`    [NEW] ${link.outletDomain}: ${link.critic || 'unknown'}`);
      }
    }
  }

  // Step 4: Google fallback for unmatched shows (recent shows only)
  console.log('\n--- Google Fallback ---');
  const recentShows = shows.filter(s => {
    const opening = new Date(s.openingDate);
    return opening >= new Date('2023-01-01');
  });

  const showsNeedingSearch = recentShows.filter(s => {
    const showId = s.id;
    const ap = path.join(archiveDir, `${showId}.html`);
    if (!unmatchedShows.has(showId)) return false;
    if (!fs.existsSync(ap)) return true;
    return (Date.now() - fs.statSync(ap).mtimeMs) / (1000 * 60 * 60 * 24) >= 14;
  });

  console.log(`Shows needing Google search: ${showsNeedingSearch.length}`);

  for (const show of showsNeedingSearch) {
    const showId = show.id;
    await processShowViaGoogle(show, showId, shows);
  }

  printSummary();
  return stats;
}

// Run
scrapePlaybillVerdict().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
