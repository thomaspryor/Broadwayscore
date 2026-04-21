#!/usr/bin/env node
/**
 * Dedicated BroadwayWorld Review Roundup Scraper
 *
 * Extracts reviews from BWW Review Roundup articles.
 * BWW compiles all reviews into a single article per show.
 * Archives pages for future reference.
 *
 * Usage:
 *   node scripts/scrape-bww-roundups.js --show=merrily-we-roll-along-2023
 *   node scripts/scrape-bww-roundups.js --shows=show1,show2,show3
 *   node scripts/scrape-bww-roundups.js --all-historical
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { serpQuery } = require('./lib/url-discovery');
const { fetchPage } = require('./lib/scraper');
const { validatePageMatchesShow } = require('./lib/page-validator');
const { normalizeOutletFull, slugify: canonicalSlugify } = require('./lib/review-normalization');
const { excerptMentionsWrongShow } = require('./lib/excerpt-validation');
const { createOrMergeReviewFile } = require('./lib/review-file-writer');

// Paths
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'aggregator-archive', 'bww-roundups');
const BWW_URLS_PATH = path.join(__dirname, '..', 'data', 'bww-roundup-urls.json');
const AGGREGATOR_SUMMARY_PATH = path.join(__dirname, '..', 'data', 'aggregator-summary.json');

// Load manual URL overrides (for shows with non-standard BWW URL patterns)
let bwwUrlOverrides = {};
if (fs.existsSync(BWW_URLS_PATH)) {
  bwwUrlOverrides = JSON.parse(fs.readFileSync(BWW_URLS_PATH, 'utf8'));
  delete bwwUrlOverrides._comment;
}

// Ensure archive directory exists
if (!fs.existsSync(ARCHIVE_DIR)) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

// Known Review Roundup URL patterns
// BWW uses various URL formats, we try multiple patterns
const BWW_URL_PATTERNS = [
  'https://www.broadwayworld.com/article/Review-Roundup-{TITLE}-Opens-on-Broadway',
  'https://www.broadwayworld.com/article/Read-All-the-Reviews-for-{TITLE}-on-Broadway',
  'https://www.broadwayworld.com/article/What-Do-Critics-Think-of-{TITLE}',
  'https://www.broadwayworld.com/article/{TITLE}-Reviews',
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Load aggregator summary data
 */
function loadAggregatorSummary() {
  if (fs.existsSync(AGGREGATOR_SUMMARY_PATH)) {
    return JSON.parse(fs.readFileSync(AGGREGATOR_SUMMARY_PATH, 'utf8'));
  }
  return {
    _meta: {
      lastUpdated: null,
      description: 'Show-level summary data from all aggregators (DTLI, BWW, Show Score)'
    },
    dtli: {},
    bww: {},
    showScore: {}
  };
}

/**
 * Save aggregator summary data
 */
function saveAggregatorSummary(data) {
  data._meta.lastUpdated = new Date().toISOString();
  fs.writeFileSync(AGGREGATOR_SUMMARY_PATH, JSON.stringify(data, null, 2));
}

/**
 * Save BWW summary for a show
 */
function saveBWWSummary(showId, reviewCount, bwwUrl) {
  const aggregatorData = loadAggregatorSummary();

  aggregatorData.bww[showId] = {
    totalReviews: reviewCount,
    bwwRoundupUrl: bwwUrl,
    lastUpdated: new Date().toISOString()
  };

  saveAggregatorSummary(aggregatorData);
  console.log(`    Saved BWW summary to aggregator-summary.json`);
}

function slugify(text) {
  return canonicalSlugify(text);
}

/**
 * Load shows data
 */
function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return data.shows || data;
}

/**
 * HTTP GET with redirect handling (fast path — used for URL pattern scanning).
 * Returns 403 often for BWW due to TLS fingerprinting; use httpGetUnblocked()
 * for known-good URLs where we must succeed.
 */
function httpGet(url, maxRedirects = 5) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode === 200) {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ found: true, html: data, finalUrl: url, status: 200 }));
      } else if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location;
        if (maxRedirects > 0) {
          const nextUrl = redirectUrl.startsWith('http') ? redirectUrl : `https://www.broadwayworld.com${redirectUrl}`;
          httpGet(nextUrl, maxRedirects - 1).then(resolve);
        } else {
          resolve({ found: false, tooManyRedirects: true, status: res.statusCode });
        }
      } else {
        resolve({ found: false, status: res.statusCode });
      }
    });
    req.on('error', (err) => resolve({ found: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ found: false, error: 'timeout' });
    });
  });
}

/**
 * Use the scraper fallback chain (Bright Data → ScrapingBee → Playwright).
 * Use this for known-good URLs (manual override, SERP result) where a 403
 * from httpGet would leave us stuck. Schmig 2026-04-20 revealed that plain
 * https.get() returns 403 for BWW article pages even when the URL is valid.
 */
async function httpGetUnblocked(url) {
  try {
    const result = await fetchPage(url, { skipVerify: true });
    if (result && result.content) {
      return { found: true, html: result.content, finalUrl: url, status: 200 };
    }
    return { found: false, status: 0, error: 'fetchPage returned no content' };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

/**
 * Search BWW for review roundup article
 */
async function searchBWWRoundup(show) {
  // Check for manual URL override first (for shows with non-standard URLs)
  if (bwwUrlOverrides[show.id]) {
    const url = bwwUrlOverrides[show.id];
    console.log(`  Using manual URL override: ${url}`);
    const result = await httpGetUnblocked(url);
    if (result.found && result.html) {
      const validation = await validatePageMatchesShow(result.html, show.title, {
        openingYear: show.openingDate ? new Date(show.openingDate).getFullYear() : null,
        pageUrl: url,
      });
      if (validation.valid) {
        return { url, html: result.html };
      }
      console.log(`  ✗ Manual URL override page doesn't match: ${validation.reason}`);
    } else {
      console.log(`  ✗ Manual URL override failed (status: ${result.status})`);
    }
  }

  const openingDate = new Date(show.openingDate);
  const year = openingDate.getFullYear();
  const month = String(openingDate.getMonth() + 1).padStart(2, '0');
  const day = String(openingDate.getDate()).padStart(2, '0');
  const dateStr = `${year}${month}${day}`;

  // Generate title variations for URL
  const titleVariations = [
    show.title.toUpperCase().replace(/[^A-Z0-9\s]+/g, '').replace(/\s+/g, '-'),
    show.title.replace(/[^a-zA-Z0-9\s]+/g, '').replace(/\s+/g, '-'),
    show.title.replace(/'/g, '').replace(/[^a-zA-Z0-9\s]+/g, '').replace(/\s+/g, '-'),
    slugify(show.title).toUpperCase().replace(/-/g, '-'),
  ];

  // Try URL patterns

  // BWW URL patterns (with full date suffix YYYYMMDD)
  const searchUrls = [];

  for (const title of titleVariations) {
    // Most common patterns with full date
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-Revival-Officially-Opens-What-Did-the-Critics-Think-${dateStr}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-Officially-Opens-on-Broadway-What-Did-the-Critics-Think-${dateStr}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-Opens-on-Broadway-Updating-LIVE-${dateStr}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-Opens-on-Broadway-${dateStr}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-What-Did-the-Critics-Think-of-${title}-${dateStr}`);

    // Patterns with just year (legacy)
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-Opens-on-Broadway-Updating-LIVE-${year}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-Opens-on-Broadway-${year}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-${year}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Reviews-${title}-on-Broadway-${year}`);
  }

  console.log(`  Trying ${searchUrls.length} BWW URL patterns...`);

  for (const url of searchUrls) {
    const result = await httpGet(url);
    if (result.found && result.html) {
      // Reject BWW homepage / soft 404s (generic pages without article content)
      const pageTitle = (result.html.match(/<title>([^<]+)<\/title>/i) || ['', ''])[1];
      if (pageTitle.includes('BroadwayWorld:') && !pageTitle.includes('Review Roundup')) {
        continue; // This is the BWW homepage, not an article
      }

      // Verify it's a Broadway roundup (not Off-Broadway)
      const isBroadway = result.html.includes('Broadway') &&
        !result.html.includes('Off-Broadway') &&
        !result.html.includes('New York Theatre Workshop');

      // For revivals, also check if it's about the right production
      const isRightYear = result.html.includes(String(year));

      if (result.html.includes('Review Roundup') && (isBroadway || isRightYear)) {
        // Validate page matches target show (LLM tiebreaker for edge cases)
        const validation = await validatePageMatchesShow(result.html, show.title, {
        openingYear: show.openingDate ? new Date(show.openingDate).getFullYear() : null,
        pageUrl: url,
      });
        if (validation.valid) {
          console.log(`  ✓ Found at: ${url}`);
          return { url, html: result.html };
        }
      }
    }
    await sleep(200);
  }

  console.log(`  ✗ Not found via URL patterns, trying web search...`);

  // Fallback: Use web search to find the BWW Review Roundup
  const searchResult = await searchWebForBWWRoundup(show);
  if (searchResult) {
    return searchResult;
  }

  console.log(`  ✗ Not found via web search either`);
  return null;
}

/**
 * Search the web for BWW Review Roundup article
 * Uses shared SERP provider chain (Bright Data first → ScrapingBee fallback)
 */
async function searchWebForBWWRoundup(show) {
  console.log(`  Searching Google for BWW roundup: ${show.title}...`);
  const searchQuery = `site:broadwayworld.com "Review Roundup" "${show.title}" Broadway`;

  try {
    const results = await serpQuery(searchQuery, { nbResults: 5 });
    if (!results) return null;

    for (const result of results) {
      const url = result.url;
      if (url && url.includes('broadwayworld.com/article/') && url.toLowerCase().includes('review-roundup')) {
        console.log(`  Trying search result: ${url}`);
        const pageResult = await httpGetUnblocked(url);

        if (pageResult.found && pageResult.html && pageResult.html.includes('Review Roundup')) {
          // Validate page matches target show (LLM tiebreaker for edge cases)
          const validation = await validatePageMatchesShow(pageResult.html, show.title, {
            openingYear: show.openingDate ? new Date(show.openingDate).getFullYear() : null,
            pageUrl: url,
          });
          if (validation.valid) {
            console.log(`  ✓ Found via Google search: ${url}`);
            saveUrlOverride(show.id, url);
            return { url, html: pageResult.html };
          }
        }
        await sleep(300);
      }
    }
  } catch (e) {
    console.log(`  Google search error: ${e.message}`);
  }

  return null;
}

/**
 * Save discovered URL to overrides file for future runs
 */
function saveUrlOverride(showId, url) {
  try {
    let overrides = {};
    if (fs.existsSync(BWW_URLS_PATH)) {
      overrides = JSON.parse(fs.readFileSync(BWW_URLS_PATH, 'utf8'));
    }

    if (!overrides[showId]) {
      overrides[showId] = url;
      const final = { _comment: "Manual and auto-discovered URL overrides for BWW Review Roundups with non-standard URL patterns" };
      Object.keys(overrides).sort().forEach(k => {
        if (k !== '_comment') final[k] = overrides[k];
      });

      fs.writeFileSync(BWW_URLS_PATH, JSON.stringify(final, null, 2));
      console.log(`  📝 Saved URL to bww-roundup-urls.json for future runs`);
    }
  } catch (e) {
    console.log(`  Warning: Could not save URL override: ${e.message}`);
  }
}

/**
 * Extract reviews from BWW Review Roundup HTML
 *
 * BWW roundup pages have reviews in this format:
 * <p><img ... alt="Thumbs Up/Sideways" > Critic Name, <a href="URL">Outlet:</a> Excerpt</p>
 *
 * This is the primary extraction method as it includes URLs directly.
 * JSON-LD liveBlogUpdate is used as a fallback (has excerpt but no URLs).
 */
function extractBWWReviews(html, showId, bwwUrl) {
  const reviews = [];
  const foundOutlets = new Set();

  // ============================================================================
  // PRIMARY: Extract from HTML structure - this has URLs!
  // Pattern: <p><img ...> Critic, <a href="URL">Outlet:</a> excerpt</p>
  // BWW uses two ways to indicate thumbs:
  //   1. alt="Thumbs Up" attribute (second alt in tag)
  //   2. Image URL: like-button-icon.png (Up), midlike-button-icon.png (Meh), dislike-button-icon.png (Down)
  // ============================================================================

  // Match <p> tags containing review structure: img + critic + link + excerpt
  // Capture the full img tag so we can parse attributes separately
  const reviewBlockRegex = /<p[^>]*>\s*(<img[^>]*>)?\s*\n?\s*([^<,]+),\s*<a[^>]*href="([^"]+)"[^>]*>([^<:]+):?\s*<\/a>\s*([\s\S]*?)<\/p>/gi;

  let match;
  while ((match = reviewBlockRegex.exec(html)) !== null) {
    const [, imgTag, criticName, url, outletName, excerpt] = match;

    // Clean up the extracted values
    const cleanCritic = (criticName || '').trim();
    const cleanOutlet = (outletName || '').replace(/:$/, '').trim();
    const cleanExcerpt = (excerpt || '').replace(/<[^>]+>/g, '').trim();
    const cleanUrl = (url || '').trim();

    // Skip if no meaningful content
    if (!cleanOutlet || cleanExcerpt.length < 30) continue;

    // Skip BWW internal links and relative paths (e.g. /people/Ben-Brantley/)
    if (cleanUrl.includes('broadwayworld.com')) continue;
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) continue;

    const outletInfo = mapOutlet(cleanOutlet);
    if (!outletInfo) continue;

    // Check for duplicates
    const dedupKey = `${outletInfo.outletId}-${slugify(cleanCritic)}`;
    if (foundOutlets.has(dedupKey)) continue;
    foundOutlets.add(dedupKey);

    // Determine thumb from image tag (if present)
    let bwwThumb = null;
    if (imgTag) {
      // Extract all alt attributes (BWW sometimes has two: first is generic, second has thumb)
      const altMatches = imgTag.match(/alt="([^"]*)"/gi);
      const srcMatch = imgTag.match(/src="([^"]*)"/i);

      // Check alt attributes for "Thumbs Up/Down/Sideways"
      if (altMatches) {
        for (const altMatch of altMatches) {
          const altValue = altMatch.match(/alt="([^"]*)"/i)?.[1] || '';
          const altLower = altValue.toLowerCase();
          if (altLower.includes('thumbs up')) {
            bwwThumb = 'Up';
            break;
          } else if (altLower.includes('thumbs sideways') || altLower.includes('thumbs mid')) {
            bwwThumb = 'Meh';
            break;
          } else if (altLower.includes('thumbs down')) {
            bwwThumb = 'Down';
            break;
          }
        }
      }

      // If no thumb from alt, check src URL for like/midlike/dislike-button-icon.png
      if (!bwwThumb && srcMatch) {
        const srcLower = srcMatch[1].toLowerCase();
        if (srcLower.includes('dislike-button-icon')) {
          bwwThumb = 'Down';
        } else if (srcLower.includes('midlike-button-icon')) {
          bwwThumb = 'Meh';
        } else if (srcLower.includes('like-button-icon')) {
          bwwThumb = 'Up';
        }
      }
    }

    reviews.push({
      showId,
      outletId: outletInfo.outletId,
      outlet: outletInfo.outlet,
      criticName: cleanCritic || 'Unknown',
      url: cleanUrl || null,
      publishDate: null,
      bwwExcerpt: cleanExcerpt.substring(0, 500),
      bwwRoundupUrl: bwwUrl,
      bwwThumb,
      source: 'bww-roundup',
    });
  }

  if (reviews.length > 0) {
    console.log(`    Extracted ${reviews.length} reviews from HTML structure (with URLs)`);
    const withUrls = reviews.filter(r => r.url).length;
    console.log(`    ${withUrls}/${reviews.length} have direct review URLs`);
  }

  // ============================================================================
  // FALLBACK: Extract from JSON-LD liveBlogUpdate (no URLs, but good excerpts)
  // ============================================================================
  if (reviews.length === 0) {
    const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (jsonLdMatch) {
      try {
        const jsonLd = JSON.parse(jsonLdMatch[1]);
        const articleBody = jsonLd.articleBody || '';

        // Look for liveBlogUpdate in the articleBody (it's embedded as JSON string)
        const liveBlogMatch = articleBody.match(/"liveBlogUpdate":\s*\[([\s\S]*?)\]\s*\}/);

        // Alternative: extract from HTML which has the JSON embedded
        const liveBlogHtmlMatch = html.match(/"liveBlogUpdate":\s*\[([\s\S]*?)\]\s*\}/);

        let liveBlogData = null;
        if (liveBlogMatch || liveBlogHtmlMatch) {
          const matchStr = liveBlogMatch ? liveBlogMatch[0] : liveBlogHtmlMatch[0];
          try {
            const wrapper = JSON.parse('{' + matchStr + '}');
            liveBlogData = wrapper.liveBlogUpdate;
          } catch (e) {
            // Try individual parsing
          }
        }

        if (liveBlogData && Array.isArray(liveBlogData)) {
          console.log(`    Found ${liveBlogData.length} reviews in liveBlogUpdate (fallback)`);

          for (const blogPost of liveBlogData) {
            const headline = blogPost.headline || '';
            const excerpt = blogPost.articleBody || '';
            const datePublished = blogPost.datePublished || null;

            // Parse outlet from headline: "Outlet Name - Review Title"
            const headlineParts = headline.split(' - ');
            if (headlineParts.length >= 1) {
              const outletRaw = headlineParts[0].trim();
              const outletInfo = mapOutlet(outletRaw);

              if (outletInfo && !foundOutlets.has(outletInfo.outletId)) {
                foundOutlets.add(outletInfo.outletId);

                reviews.push({
                  showId,
                  outletId: outletInfo.outletId,
                  outlet: outletInfo.outlet,
                  criticName: 'Unknown',
                  url: null, // JSON-LD doesn't have URLs
                  publishDate: datePublished ? new Date(datePublished).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : null,
                  bwwExcerpt: excerpt.substring(0, 500),
                  bwwRoundupUrl: bwwUrl,
                  source: 'bww-roundup',
                });
              }
            }
          }
        }

        // Also parse articleBody for critic names using pattern matching
        if (articleBody) {
          // Generic pattern: "Critic Name, Outlet: excerpt"
          const genericPattern = /([A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]+)+),\s*((?:The\s+)?[A-Z][A-Za-z\s'\-]+?):\s*([\s\S]*?)(?=\s{2,}[A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]+)+,|\n\n|$)/g;

          let genericMatch;
          while ((genericMatch = genericPattern.exec(articleBody)) !== null) {
            const [, criticName, outletName, excerpt] = genericMatch;
            if (criticName && outletName && excerpt && excerpt.length > 30) {
              const critic = criticName.trim();
              const outletInfo = mapOutlet(outletName.trim());

              if (outletInfo) {
                // Find matching review and add critic name
                const matchingReview = reviews.find(r => r.outletId === outletInfo.outletId);
                if (matchingReview && matchingReview.criticName === 'Unknown') {
                  matchingReview.criticName = critic;
                } else if (!foundOutlets.has(outletInfo.outletId)) {
                  // Add new review if not found via liveBlogUpdate
                  foundOutlets.add(outletInfo.outletId);
                  reviews.push({
                    showId,
                    outletId: outletInfo.outletId,
                    outlet: outletInfo.outlet,
                    criticName: critic,
                    url: null,
                    bwwExcerpt: excerpt.trim().substring(0, 500),
                    bwwRoundupUrl: bwwUrl,
                    source: 'bww-roundup',
                  });
                }
              }
            }
          }
        }

        if (reviews.length > 0) {
          console.log(`    Extracted ${reviews.length} reviews from BWW JSON-LD`);
        }

      } catch (e) {
        console.log(`    Error parsing BWW JSON-LD: ${e.message}`);
      }
    }
  }

  // ============================================================================
  // SECONDARY FALLBACK: HTML structure with strong/b tags
  // ============================================================================
  if (reviews.length === 0) {
    const reviewSections = html.match(/<p[^>]*>.*?(?:<strong>|<b>).*?(?:<\/strong>|<\/b>).*?<\/p>/gi) || [];

    for (const section of reviewSections) {
      const criticOutletMatch = section.match(/(?:<strong>|<b>)([^<]+)(?:<\/strong>|<\/b>)[\s,]*(?:(?:<i>)?([^<:]+)(?:<\/i>)?)?/i);
      if (criticOutletMatch) {
        let [, criticPart, outletPart] = criticOutletMatch;
        criticPart = (criticPart || '').replace(/<[^>]+>/g, '').trim();
        outletPart = (outletPart || '').replace(/<[^>]+>/g, '').trim();

        let criticName = criticPart;
        let outlet = outletPart;

        const commaMatch = criticPart.match(/([^,]+),\s*(.+)/);
        if (commaMatch) {
          criticName = commaMatch[1].trim();
          outlet = commaMatch[2].trim();
        }

        if (foundOutlets.has(slugify(criticName))) continue;
        foundOutlets.add(slugify(criticName));

        const outletInfo = mapOutlet(outlet || criticName);
        if (outletInfo) {
          const excerptMatch = section.match(/(?:<\/strong>|<\/b>)[^<]*:?\s*["']?([\s\S]*?)["']?(?:<\/p>|$)/i);
          const excerpt = excerptMatch ? excerptMatch[1].replace(/<[^>]+>/g, '').trim() : null;

          if (excerpt && excerpt.length > 50) {
            reviews.push({
              showId,
              outletId: outletInfo.outletId,
              outlet: outletInfo.outlet,
              criticName: criticName || 'Unknown',
              url: null,
              bwwExcerpt: excerpt.substring(0, 500),
              bwwRoundupUrl: bwwUrl,
              source: 'bww-roundup',
            });
          }
        }
      }
    }

    console.log(`    Extracted ${reviews.length} reviews from HTML fallback (strong/b tags)`);
  }

  // ============================================================================
  // ENHANCEMENT: Try to match any remaining URLs to reviews that don't have them
  // ============================================================================
  const urlPatterns = [
    { pattern: /nytimes\.com/i, outletIds: ['nytimes', 'nyt', 'new-york-times'] },
    { pattern: /vulture\.com/i, outletIds: ['vulture'] },
    { pattern: /variety\.com/i, outletIds: ['variety'] },
    { pattern: /hollywoodreporter\.com/i, outletIds: ['thr', 'hollywood-reporter', 'the-hollywood-reporter'] },
    { pattern: /nypost\.com/i, outletIds: ['nyp', 'nypost', 'new-york-post'] },
    { pattern: /deadline\.com/i, outletIds: ['deadline'] },
    { pattern: /timeout\.com/i, outletIds: ['time-out-new-york', 'timeout', 'time-out'] },
    { pattern: /theatermania\.com/i, outletIds: ['theatermania'] },
    { pattern: /theatrely\.com/i, outletIds: ['theatrely'] },
    { pattern: /thewrap\.com/i, outletIds: ['the-wrap', 'thewrap', 'wrap'] },
    { pattern: /ew\.com/i, outletIds: ['ew', 'entertainment-weekly'] },
    { pattern: /wsj\.com/i, outletIds: ['wsj', 'wall-street-journal'] },
    { pattern: /newyorker\.com/i, outletIds: ['new-yorker', 'newyorker', 'the-new-yorker'] },
    { pattern: /theguardian\.com/i, outletIds: ['guardian', 'the-guardian'] },
    { pattern: /washingtonpost\.com/i, outletIds: ['wapo', 'washington-post', 'the-washington-post'] },
    { pattern: /nydailynews\.com/i, outletIds: ['nydn', 'ny-daily-news', 'new-york-daily-news'] },
    { pattern: /observer\.com/i, outletIds: ['observer'] },
    { pattern: /thestage\.co\.uk/i, outletIds: ['the-stage', 'stage'] },
    { pattern: /cititour\.com/i, outletIds: ['cititour'] },
    { pattern: /newyorktheater\.me/i, outletIds: ['nyt-theater', 'new-york-theater'] },
    { pattern: /newyorktheatreguide\.com/i, outletIds: ['nytg', 'new-york-theatre-guide'] },
    { pattern: /nystagereview\.com/i, outletIds: ['nysr', 'new-york-stage-review'] },
  ];

  // Find all external URLs in the HTML that we haven't matched yet
  const urlRegex = /href="(https?:\/\/[^"]+)"/gi;
  let urlMatch;
  while ((urlMatch = urlRegex.exec(html)) !== null) {
    const url = urlMatch[1];
    // Skip BWW internal links and social media
    if (url.includes('broadwayworld.com') || url.includes('twitter.com') ||
        url.includes('facebook.com') || url.includes('instagram.com') ||
        url.includes('x.com') || url.includes('tiktok.com')) {
      continue;
    }

    // Try to match URL to an outlet
    for (const { pattern, outletIds } of urlPatterns) {
      if (pattern.test(url)) {
        // Find any review with matching outletId that doesn't have a URL
        const matchingReview = reviews.find(r => outletIds.includes(r.outletId) && !r.url);
        if (matchingReview) {
          matchingReview.url = url;
          console.log(`    Matched URL for ${matchingReview.outletId}: ${url.substring(0, 60)}...`);
        }
        break;
      }
    }
  }

  return reviews;
}

/**
 * Map outlet name to standardized outlet info using canonical normalizer.
 * Returns { outlet: displayName, outletId: canonicalId }.
 */
function mapOutlet(outletName) {
  const { name, outletId } = normalizeOutletFull(outletName);
  return { outlet: name, outletId };
}

/**
 * Archive BWW page
 */
function archiveBWWPage(showId, url, html) {
  const archivePath = path.join(ARCHIVE_DIR, `${showId}.html`);
  const header = `<!--
  Archived: ${new Date().toISOString()}
  Source: ${url}
  Status: 200
-->\n`;

  fs.writeFileSync(archivePath, header + html);
  console.log(`    Archived to ${archivePath}`);
}

/**
 * Save review to review-texts directory
 */
function saveReview(review) {
  const result = createOrMergeReviewFile(review.showId, {
    outlet: review.outlet,
    outletId: review.outletId,
    criticName: review.criticName,
    url: review.url,
    source: 'bww-roundup',
    fields: {
      bwwExcerpt: review.bwwExcerpt,
      bwwRoundupUrl: review.bwwRoundupUrl,
      bwwThumb: review.bwwThumb || null,
      publishDate: review.publishDate || null,
    },
  }, {
    onMerge(existing, input) {
      const incoming = input.fields || {};

      // Excerpt word-overlap validation: skip excerpt if it doesn't match fullText
      if (!existing.bwwExcerpt && incoming.bwwExcerpt) {
        if (existing.fullText && existing.fullText.length >= 200) {
          const excerptWords = (incoming.bwwExcerpt.toLowerCase().match(/\b[a-z]{5,}\b/g) || []);
          const ftWords = new Set(existing.fullText.toLowerCase().match(/\b[a-z]{5,}\b/g) || []);
          const matchCount = excerptWords.filter(w => ftWords.has(w)).length;
          const matchRate = excerptWords.length > 0 ? matchCount / excerptWords.length : 0;
          if (matchRate < 0.3 && excerptWords.length >= 5) {
            console.log(`      ⚠️  BWW excerpt doesn't match fullText (${(matchRate * 100).toFixed(0)}% overlap) — skipping excerpt`);
            delete existing.bwwExcerpt; // Undo default merge
          }
        }
      }

      // Always use freshly extracted BWW thumb (authoritative from HTML)
      if (incoming.bwwThumb && existing.bwwThumb !== incoming.bwwThumb) {
        if (existing.bwwThumb) {
          console.log(`      Corrected bwwThumb: ${existing.bwwThumb} → ${incoming.bwwThumb}`);
        }
        existing.bwwThumb = incoming.bwwThumb;
      }
    },
  });

  return {
    created: result.action === 'new',
    updated: result.action === 'updated',
    urlAdded: false, // URL tracking not needed for stats
  };
}

/**
 * Process a single show
 */
async function processShow(show) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing: ${show.title} (${show.id})`);
  console.log('='.repeat(60));

  // Check if we have an archive
  const archivePath = path.join(ARCHIVE_DIR, `${show.id}.html`);
  let html = null;
  let bwwUrl = null;

  if (fs.existsSync(archivePath)) {
    console.log(`  Using archived page...`);
    const archiveContent = fs.readFileSync(archivePath, 'utf8');
    // Extract URL from archive header before validation so URL-date check
    // can catch wrong-year contamination (e.g., a cached Big Fish 2013
    // roundup mistakenly written to a Bigfoot 2026 archive slot).
    const urlMatch = archiveContent.match(/Source:\s*(https?:\/\/[^\n]+)/);
    const archivedUrl = urlMatch ? urlMatch[1].trim() : null;
    // Validate cached page is about the right show
    const cacheValidation = await validatePageMatchesShow(archiveContent, show.title, {
      skipLlm: !!process.env.SKIP_LLM,
      openingYear: show.openingDate ? new Date(show.openingDate).getFullYear() : null,
      pageUrl: archivedUrl,
    });
    if (!cacheValidation.valid) {
      console.log(`  [CACHE] Cached page is WRONG show — ${cacheValidation.reason}. Deleting cache.`);
      fs.unlinkSync(archivePath);
      // Fall through to re-fetch below
    } else {
      bwwUrl = archivedUrl;
      html = archiveContent;
    }
  }

  if (!html) {
    // Search for roundup article
    const result = await searchBWWRoundup(show);
    if (!result) {
      return { success: false, error: 'Not found on BWW' };
    }
    html = result.html;
    bwwUrl = result.url;

    // Archive the page
    archiveBWWPage(show.id, bwwUrl, html);
  }

  // Extract reviews
  const allReviews = extractBWWReviews(html, show.id, bwwUrl);

  // Cross-show excerpt validation: warn (but don't filter) when excerpts mention
  // a different show's title. Too many false positives from comparisons ("reminds
  // me of Hamilton") to use as a hard filter. The word-overlap check in saveReview()
  // is the reliable gate for wrong-critic excerpts.
  const reviews = allReviews;
  let crossShowWarnings = 0;
  for (const review of reviews) {
    if (!review.bwwExcerpt) continue;
    const check = excerptMentionsWrongShow(review.bwwExcerpt, show.id, show.title);
    if (check.isWrongShow) {
      console.log(`    [CROSS-SHOW WARNING] ${review.outletId}/${review.criticName}: excerpt mentions "${check.mentionedTitle}" — may be comparison, keeping`);
      crossShowWarnings++;
    }
  }
  if (crossShowWarnings > 0) {
    console.log(`    ${crossShowWarnings} excerpt(s) mention other shows (logged, not filtered)`);
  }

  // Save BWW summary to aggregator-summary.json
  if (reviews.length > 0) {
    saveBWWSummary(show.id, reviews.length, bwwUrl);
  }

  // Save reviews
  let created = 0;
  let updated = 0;
  let urlsAdded = 0;
  const reviewsWithUrls = reviews.filter(r => r.url).length;

  for (const review of reviews) {
    const result = saveReview(review);
    if (result.created) created++;
    if (result.updated) updated++;
    if (result.urlAdded) urlsAdded++;
  }

  console.log(`\n  Summary: ${reviews.length} reviews found, ${created} created, ${updated} updated`);
  console.log(`  URLs: ${reviewsWithUrls}/${reviews.length} extracted, ${urlsAdded} added to existing files`);

  return {
    success: true,
    showId: show.id,
    reviewsFound: reviews.length,
    reviewsWithUrls,
    created,
    updated,
    urlsAdded,
  };
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  const showArg = args.find(a => a.startsWith('--show='));
  const showsArg = args.find(a => a.startsWith('--shows='));
  const allHistorical = args.includes('--all-historical');

  const shows = loadShows();
  let showsToProcess = [];

  if (showArg) {
    const showId = showArg.replace('--show=', '');
    const show = shows.find(s => s.id === showId);
    if (!show) {
      console.error(`Show not found: ${showId}`);
      process.exit(1);
    }
    showsToProcess = [show];
  } else if (showsArg) {
    const showIds = showsArg.replace('--shows=', '').split(',').map(s => s.trim());
    for (const showId of showIds) {
      const show = shows.find(s => s.id === showId);
      if (show) {
        showsToProcess.push(show);
      } else {
        console.warn(`Warning: Show not found: ${showId}`);
      }
    }
  } else if (allHistorical) {
    showsToProcess = shows.filter(s => s.tags?.includes('historical') || s.status === 'closed');
  } else {
    console.log('Usage:');
    console.log('  node scripts/scrape-bww-roundups.js --show=show-id');
    console.log('  node scripts/scrape-bww-roundups.js --shows=show1,show2,show3');
    console.log('  node scripts/scrape-bww-roundups.js --all-historical');
    process.exit(1);
  }

  console.log('========================================');
  console.log('BWW Review Roundup Scraper');
  console.log('========================================');
  console.log(`Shows to process: ${showsToProcess.length}`);

  const results = [];

  for (const show of showsToProcess) {
    const result = await processShow(show);
    results.push(result);
    await sleep(1000); // Rate limiting
  }

  // Final summary
  console.log('\n========================================');
  console.log('FINAL SUMMARY');
  console.log('========================================');

  let totalFound = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalUrlsExtracted = 0;
  let totalUrlsAdded = 0;
  let notFound = 0;

  for (const r of results) {
    if (r.success) {
      console.log(`✓ ${r.showId}: ${r.reviewsFound} reviews (${r.created} new, ${r.updated} updated, ${r.urlsAdded || 0} URLs added)`);
      totalFound += r.reviewsFound;
      totalCreated += r.created;
      totalUpdated += r.updated;
      totalUrlsExtracted += r.reviewsWithUrls || 0;
      totalUrlsAdded += r.urlsAdded || 0;
    } else {
      console.log(`✗ ${r.showId || 'unknown'}: ${r.error}`);
      notFound++;
    }
  }

  console.log(`\nTotal: ${totalFound} reviews found, ${totalCreated} created, ${totalUpdated} updated`);
  console.log(`URLs: ${totalUrlsExtracted} extracted from BWW pages, ${totalUrlsAdded} added to existing review files`);
  console.log(`Shows not found on BWW: ${notFound}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
