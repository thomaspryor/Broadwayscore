#!/usr/bin/env node
/**
 * Fetch Show Images with Multiple Source Fallbacks
 *
 * Tries multiple sources to find production photos for Broadway shows:
 * 1. TodayTix (primary, for open shows)
 * 2. Broadway Direct (has galleries for most shows)
 * 3. Playbill (extensive archive)
 * 4. BroadwayWorld (backup)
 *
 * Usage:
 *   node scripts/fetch-images-fallback.js                    # All shows missing images
 *   node scripts/fetch-images-fallback.js --show our-town    # Specific show
 *   node scripts/fetch-images-fallback.js --shows "our-town,the-roommate"  # Multiple shows
 *   node scripts/fetch-images-fallback.js --dry-run          # Preview without saving
 */

const fs = require('fs');
const path = require('path');

// Try to load scraper module, fall back to fetch if not available
let scraper;
try {
  scraper = require('./lib/scraper.js');
} catch (e) {
  scraper = null;
}

const SHOWS_FILE = path.join(__dirname, '../data/shows.json');

// Source configurations
const SOURCES = {
  todaytix: {
    name: 'TodayTix',
    searchUrl: (slug) => `https://www.todaytix.com/nyc/shows/${slug}`,
    // Only works for open shows
    forClosedShows: false,
  },
  broadwayDirect: {
    name: 'Broadway Direct',
    searchUrl: (title) => `https://broadwaydirect.com/?s=${encodeURIComponent(title)}+photos`,
    galleryPattern: /broadwaydirect\.com\/wp-content\/uploads\/\d{4}\/\d{2}\/[^"'\s]+\.jpg/gi,
    forClosedShows: true,
  },
  playbill: {
    name: 'Playbill',
    searchUrl: (title) => `https://playbill.com/searchpage?q=${encodeURIComponent(title)}&sort=Most+Recent`,
    forClosedShows: true,
  },
  broadwayWorld: {
    name: 'BroadwayWorld',
    searchUrl: (title) => `https://www.broadwayworld.com/search/?q=${encodeURIComponent(title)}&searchtype=photos`,
    forClosedShows: true,
  },
};

/**
 * Fetch URL content using available method
 */
async function fetchUrl(url) {
  // Use native fetch
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } catch (error) {
    console.error(`  Failed to fetch ${url}: ${error.message}`);
    return null;
  }
}

/**
 * Try to find images from Broadway Direct
 */
async function tryBroadwayDirect(show) {
  const searchTerms = [
    `${show.title} broadway photos`,
    `${show.title} first look`,
  ];

  for (const term of searchTerms) {
    const searchUrl = `https://broadwaydirect.com/?s=${encodeURIComponent(term)}`;
    console.log(`  Trying Broadway Direct: "${term}"`);

    const html = await fetchUrl(searchUrl);
    if (!html) continue;

    // Look for article links about this show
    const articlePattern = new RegExp(
      `href="(https://broadwaydirect\\.com/[^"]*${show.slug.replace(/-/g, '[^"]*')}[^"]*)"`,
      'gi'
    );
    const articleMatches = html.match(articlePattern);

    if (articleMatches && articleMatches.length > 0) {
      // Extract URL from href
      const urlMatch = articleMatches[0].match(/href="([^"]+)"/);
      if (urlMatch) {
        const articleUrl = urlMatch[1];
        console.log(`  Found article: ${articleUrl}`);

        // Fetch the article page
        const articleHtml = await fetchUrl(articleUrl);
        if (articleHtml) {
          // Extract image URLs from the article
          const imgPattern = /https:\/\/broadwaydirect\.com\/wp-content\/uploads\/\d{4}\/\d{2}\/[^"'\s>]+\.jpg/gi;
          const images = articleHtml.match(imgPattern);

          if (images && images.length > 0) {
            // Filter out tiny thumbnails, prefer larger images
            const goodImages = [...new Set(images)]
              .filter(url => !url.includes('-150x') && !url.includes('-100x'))
              .slice(0, 3);

            if (goodImages.length > 0) {
              console.log(`  Found ${goodImages.length} images from Broadway Direct`);
              return {
                source: 'Broadway Direct',
                hero: goodImages[0],
                thumbnail: goodImages[0],
                poster: goodImages.find(url => url.includes('683x1024') || url.includes('vertical')) || goodImages[0],
              };
            }
          }
        }
      }
    }
  }

  return null;
}

/**
 * Try to find images from Playbill
 */
async function tryPlaybill(show) {
  const searchUrl = `https://playbill.com/searchpage?q=${encodeURIComponent(show.title)}&sort=Most+Recent`;
  console.log(`  Trying Playbill search...`);

  const html = await fetchUrl(searchUrl);
  if (!html) return null;

  // Look for gallery links
  const galleryPattern = /href="(\/gallery\/[^"]+)"/gi;
  const galleryMatches = html.match(galleryPattern);

  if (galleryMatches && galleryMatches.length > 0) {
    const galleryPath = galleryMatches[0].match(/href="([^"]+)"/)[1];
    const galleryUrl = `https://playbill.com${galleryPath}`;
    console.log(`  Found gallery: ${galleryUrl}`);

    const galleryHtml = await fetchUrl(galleryUrl);
    if (galleryHtml) {
      // Extract Playbill image URLs
      const imgPattern = /https:\/\/bsp-static\.playbill\.com\/[^"'\s>]+\.(?:jpg|jpeg|png)/gi;
      const images = galleryHtml.match(imgPattern);

      if (images && images.length > 0) {
        const uniqueImages = [...new Set(images)].slice(0, 3);
        console.log(`  Found ${uniqueImages.length} images from Playbill`);
        return {
          source: 'Playbill',
          hero: uniqueImages[0],
          thumbnail: uniqueImages[0],
          poster: uniqueImages[0],
        };
      }
    }
  }

  return null;
}

/**
 * Try all sources to find images for a show
 */
async function findImagesForShow(show) {
  console.log(`\nSearching images for: ${show.title} (${show.slug})`);

  // Skip if show already has images
  if (show.images?.hero && show.images?.thumbnail) {
    console.log(`  Already has images, skipping`);
    return null;
  }

  // Try Broadway Direct first (works for all shows)
  let result = await tryBroadwayDirect(show);
  if (result) return result;

  // Try Playbill
  result = await tryPlaybill(show);
  if (result) return result;

  console.log(`  No images found from any source`);
  return null;
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  // Parse arguments
  let targetSlugs = null;
  const showIndex = args.indexOf('--show');
  const showsIndex = args.indexOf('--shows');

  if (showIndex !== -1 && args[showIndex + 1]) {
    targetSlugs = [args[showIndex + 1]];
  } else if (showsIndex !== -1 && args[showsIndex + 1]) {
    targetSlugs = args[showsIndex + 1].split(',').map(s => s.trim());
  }

  // Load shows data
  const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  const shows = showsData.shows;

  // Filter shows to process
  let showsToProcess;
  if (targetSlugs) {
    showsToProcess = shows.filter(s => targetSlugs.includes(s.slug));
    if (showsToProcess.length === 0) {
      console.error(`No shows found matching: ${targetSlugs.join(', ')}`);
      process.exit(1);
    }
  } else {
    // Find all shows missing images
    showsToProcess = shows.filter(s =>
      !s.images?.hero || !s.images?.thumbnail ||
      s.images.hero === null || s.images.thumbnail === null
    );
  }

  console.log(`\n=== Image Fetch with Fallbacks ===`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE'}`);
  console.log(`Shows to process: ${showsToProcess.length}`);
  console.log(`================================\n`);

  const results = {
    success: [],
    failed: [],
    skipped: [],
  };

  for (const show of showsToProcess) {
    try {
      const imageResult = await findImagesForShow(show);

      if (imageResult) {
        results.success.push({
          slug: show.slug,
          title: show.title,
          source: imageResult.source,
          images: imageResult,
        });

        if (!dryRun) {
          // Update the show in the array
          const showIndex = shows.findIndex(s => s.id === show.id);
          if (showIndex !== -1) {
            shows[showIndex].images = {
              poster: imageResult.poster,
              thumbnail: imageResult.thumbnail,
              hero: imageResult.hero,
            };
          }
        }
      } else if (show.images?.hero) {
        results.skipped.push({ slug: show.slug, reason: 'already has images' });
      } else {
        results.failed.push({ slug: show.slug, title: show.title });
      }

      // Small delay between requests
      await new Promise(r => setTimeout(r, 1000));

    } catch (error) {
      console.error(`  Error processing ${show.slug}: ${error.message}`);
      results.failed.push({ slug: show.slug, title: show.title, error: error.message });
    }
  }

  // Save updated shows data
  if (!dryRun && results.success.length > 0) {
    fs.writeFileSync(SHOWS_FILE, JSON.stringify(showsData, null, 2));
    console.log(`\nSaved updates to shows.json`);
  }

  // Print summary
  console.log(`\n=== SUMMARY ===`);
  console.log(`Success: ${results.success.length}`);
  for (const s of results.success) {
    console.log(`  ✓ ${s.title} (${s.source})`);
  }

  if (results.failed.length > 0) {
    console.log(`\nFailed: ${results.failed.length}`);
    for (const f of results.failed) {
      console.log(`  ✗ ${f.title || f.slug}`);
    }
  }

  if (results.skipped.length > 0) {
    console.log(`\nSkipped: ${results.skipped.length}`);
  }

  console.log(`\n================`);

  // Return results for CI/automation
  return results;
}

main().catch(console.error);
