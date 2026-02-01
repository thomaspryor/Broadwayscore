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
const { normalizeOutlet, normalizeCritic, generateReviewFilename } = require('./lib/review-normalization');
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

async function fetchHtml(url) {
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

function isOffBroadway(title) {
  const lower = title.toLowerCase();
  return (
    lower.includes('off-broadway') ||
    lower.includes('off broadway') ||
    lower.includes('west end') ||
    lower.includes('opera') ||
    lower.includes('london') ||
    lower.includes('national tour') ||
    lower.includes('touring production')
  );
}

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

  // Normalize outlet
  const outletId = normalizeOutlet(reviewInfo.outlet) || normalizeOutlet(reviewInfo.outletDomain) || reviewInfo.outletDomain;
  if (!outletId) return 'skipped';

  // Generate filename
  const criticSlug = reviewInfo.critic
    ? normalizeCritic(reviewInfo.critic) || reviewInfo.critic.toLowerCase().replace(/\s+/g, '-')
    : 'unknown';
  const filename = `${outletId}--${criticSlug}.json`;
  const filepath = path.join(showDir, filename);

  if (fs.existsSync(filepath)) {
    // Add playbillVerdictUrl if not already present
    const existing = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    if (!existing.playbillVerdictUrl) {
      existing.playbillVerdictUrl = reviewInfo.url;
      const sources = new Set(existing.sources || [existing.source || '']);
      sources.add('playbill-verdict');
      existing.sources = Array.from(sources).filter(Boolean);
      fs.writeFileSync(filepath, JSON.stringify(existing, null, 2) + '\n');
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
    outlet: reviewInfo.outlet || reviewInfo.outletDomain,
    criticName: reviewInfo.critic || 'Unknown',
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
// Main
// ---------------------------------------------------------------------------

async function scrapePlaybillVerdict() {
  console.log('=== Playbill Verdict Scraper ===\n');

  // Ensure archive directory exists
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const shows = loadShows();
  console.log(`Loaded ${shows.length} shows from shows.json\n`);

  // Step 1: Scrape category page
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
  const unmatchedShows = new Set(shows.map(s => s.slug || s.id));

  for (const article of uniqueArticles) {
    if (isOffBroadway(article.title)) {
      stats.skippedOffBroadway++;
      continue;
    }

    const match = matchTitleToShow(article.title, shows);
    if (match) {
      const showId = match.show.slug || match.show.id;
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

    // Check if already archived
    let html;
    if (fs.existsSync(archivePath)) {
      html = fs.readFileSync(archivePath, 'utf8');
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

    // Extract review links
    const reviewLinks = extractReviewLinksFromArticle(html, article.showId);
    stats.reviewLinksExtracted += reviewLinks.length;

    for (const link of reviewLinks) {
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
    const showId = s.slug || s.id;
    const archivePath = path.join(archiveDir, `${showId}.html`);
    return unmatchedShows.has(showId) && !fs.existsSync(archivePath);
  });

  console.log(`Shows needing Google search: ${showsNeedingSearch.length}`);

  for (const show of showsNeedingSearch.slice(0, 20)) { // Limit to 20 searches
    const showId = show.slug || show.id;
    const query = `site:playbill.com/article "what are the reviews" OR "the verdict" OR "critics think" "${show.title}" broadway`;

    try {
      stats.googleSearches++;
      const urls = await googleSearch(query);

      // Filter to likely verdict/review articles
      const verdictUrls = urls.filter(u => {
        const slug = u.split('/article/')[1] || '';
        return slug.includes('review') || slug.includes('verdict') || slug.includes('critics') || slug.includes('what-are');
      });

      if (verdictUrls.length > 0) {
        const articleUrl = verdictUrls[0];
        console.log(`  [GOOGLE] ${showId}: Found ${articleUrl}`);

        const html = await fetchHtml(articleUrl);
        if (html) {
          const archivePath = path.join(archiveDir, `${showId}.html`);
          fs.writeFileSync(archivePath, html);

          const reviewLinks = extractReviewLinksFromArticle(html, showId);
          stats.reviewLinksExtracted += reviewLinks.length;

          for (const link of reviewLinks) {
            const result = saveReviewFromPlaybill(showId, link);
            if (result === 'new') {
              console.log(`    [NEW] ${link.outletDomain}: ${link.critic || 'unknown'}`);
            }
          }
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

  // Print summary
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

  return stats;
}

// Run
scrapePlaybillVerdict().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
