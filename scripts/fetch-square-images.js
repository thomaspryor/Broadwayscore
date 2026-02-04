#!/usr/bin/env node
/**
 * fetch-square-images.js
 *
 * Fetches native square (1080x1080) promotional images from Google Images
 * for shows that are missing thumbnail images.
 *
 * Uses ScrapingBee Google Images API to find candidates, then downloads
 * the best square/near-square image from the source page.
 *
 * Usage:
 *   node scripts/fetch-square-images.js                  # All shows missing thumbnails
 *   node scripts/fetch-square-images.js --show=SLUG      # Specific show
 *   node scripts/fetch-square-images.js --limit=10       # Process N shows
 *   node scripts/fetch-square-images.js --dry-run        # Report only
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images', 'shows');
const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0') || 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Download a URL to a buffer
function downloadUrl(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { timeout: timeoutMs, headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
    }}, (response) => {
      // Follow redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadUrl(response.headers.location, timeoutMs).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Get image dimensions from a buffer using file/identify command
function getImageDimensions(buffer) {
  try {
    // Write to temp file and use sips (macOS) to get dimensions
    const tmpFile = `/tmp/broadway-img-check-${Date.now()}.tmp`;
    fs.writeFileSync(tmpFile, buffer);

    try {
      // Try sips (macOS)
      const output = execSync(`sips -g pixelWidth -g pixelHeight "${tmpFile}" 2>/dev/null`, { encoding: 'utf-8' });
      const width = parseInt(output.match(/pixelWidth:\s*(\d+)/)?.[1] || '0');
      const height = parseInt(output.match(/pixelHeight:\s*(\d+)/)?.[1] || '0');
      fs.unlinkSync(tmpFile);
      if (width > 0 && height > 0) return { width, height };
    } catch {
      // Try file command as fallback
      try {
        const output = execSync(`file "${tmpFile}" 2>/dev/null`, { encoding: 'utf-8' });
        const match = output.match(/(\d+)\s*x\s*(\d+)/);
        fs.unlinkSync(tmpFile);
        if (match) return { width: parseInt(match[1]), height: parseInt(match[2]) };
      } catch {
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Search Google Images via ScrapingBee
async function searchGoogleImages(query) {
  const url = `https://app.scrapingbee.com/api/v1/store/google?api_key=${SCRAPINGBEE_API_KEY}&search=${encodeURIComponent(query)}&search_type=images&nb_results=20`;

  const buffer = await downloadUrl(url, 30000);
  const data = JSON.parse(buffer.toString());
  return data.images || data.image_results || [];
}

// Try to get the original full-size image URL from a source page
async function getOriginalImageUrl(pageUrl, showTitle) {
  try {
    const url = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_API_KEY}&url=${encodeURIComponent(pageUrl)}&render_js=false&wait=1000`;
    const buffer = await downloadUrl(url, 20000);
    const html = buffer.toString();

    // Extract high-res image URLs from the page
    const imgPattern = /(?:src|href|content)=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp)[^"']*)/gi;
    const matches = [];
    let match;
    while ((match = imgPattern.exec(html)) !== null) {
      const imgUrl = match[1];
      // Skip tiny thumbnails and tracking pixels
      if (imgUrl.includes('1x1') || imgUrl.includes('pixel') || imgUrl.includes('favicon')) continue;
      // Prefer images that might be related to the show
      const normalTitle = showTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
      const normalUrl = imgUrl.toLowerCase().replace(/[^a-z0-9]/g, '');
      const isRelevant = normalUrl.includes(normalTitle.substring(0, 8));
      matches.push({ url: imgUrl, relevant: isRelevant });
    }

    // Sort by relevance
    matches.sort((a, b) => (b.relevant ? 1 : 0) - (a.relevant ? 1 : 0));
    return matches.slice(0, 10).map(m => m.url);
  } catch {
    return [];
  }
}

// Download image and check dimensions
async function tryDownloadImage(imageUrl, minSize = 400) {
  try {
    const buffer = await downloadUrl(imageUrl);
    if (buffer.length < 5000) return null; // Too small, probably not a real image

    const dims = getImageDimensions(buffer);
    if (!dims) return null;

    const ratio = Math.min(dims.width, dims.height) / Math.max(dims.width, dims.height);
    const isLargeEnough = dims.width >= minSize && dims.height >= minSize;

    if (isLargeEnough) {
      return { buffer, width: dims.width, height: dims.height, ratio, url: imageUrl, isSquare: ratio >= 0.85 };
    }
    return null;
  } catch {
    return null;
  }
}

// Center-crop and resize image to square JPEG using sips (macOS)
function resizeAndSave(inputBuffer, outputPath, size = 540, cropFirst = false) {
  const tmpInput = `/tmp/broadway-convert-${Date.now()}.tmp`;
  const tmpOutput = `/tmp/broadway-convert-${Date.now()}.jpg`;

  fs.writeFileSync(tmpInput, inputBuffer);

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  try {
    // If not square, center-crop to square first
    if (cropFirst) {
      const dims = getImageDimensions(inputBuffer);
      if (dims) {
        const cropSize = Math.min(dims.width, dims.height);
        execSync(`sips --cropToHeightWidth ${cropSize} ${cropSize} "${tmpInput}" 2>/dev/null`);
      }
    }
    // Resize to target size and save as JPEG (sips can't write WebP on macOS)
    execSync(`sips -z ${size} ${size} -s format jpeg -s formatOptions 85 "${tmpInput}" --out "${tmpOutput}" 2>/dev/null`);

    if (fs.existsSync(tmpOutput)) {
      const result = fs.readFileSync(tmpOutput);
      fs.writeFileSync(outputPath, result);
      fs.unlinkSync(tmpInput);
      fs.unlinkSync(tmpOutput);
      return true;
    }
  } catch (e) {
    // Fallback: save original resized via sips (keep original format)
    try {
      execSync(`sips -z ${size} ${size} "${tmpInput}" --out "${tmpOutput}" 2>/dev/null`);
      if (fs.existsSync(tmpOutput)) {
        fs.writeFileSync(outputPath, fs.readFileSync(tmpOutput));
        fs.unlinkSync(tmpInput);
        fs.unlinkSync(tmpOutput);
        return true;
      }
    } catch {}
  }

  // Last resort: save original unresized
  fs.writeFileSync(outputPath, inputBuffer);
  try { fs.unlinkSync(tmpInput); } catch {}
  try { fs.unlinkSync(tmpOutput); } catch {}
  return false;
}

async function processShow(show) {
  const showDir = path.join(IMAGES_DIR, show.id);
  const thumbPath = path.join(showDir, 'thumbnail.jpg');

  // Search Google Images — prefer square, but track best non-square as fallback
  const searchQueries = [
    `"${show.title}" broadway show square poster`,
    `"${show.title}" broadway musical 1080x1080`,
    `"${show.title}" broadway todaytix`,
    `"${show.title}" broadway show poster`,
  ];

  let bestFallback = null; // Best non-square image found

  for (const query of searchQueries) {
    console.log(`   Searching: ${query}`);

    try {
      const results = await searchGoogleImages(query);
      if (!results || results.length === 0) {
        console.log('   No results');
        continue;
      }

      console.log(`   Found ${results.length} image results`);

      // Try to find images from the source pages
      for (let i = 0; i < Math.min(results.length, 8); i++) {
        const result = results[i];
        const sourceUrl = result.url;

        // Skip eBay, Etsy (merchandise), Pinterest (low quality)
        if (/ebay|etsy|pinterest|redbubble|teepublic|amazon\.com\/dp/i.test(sourceUrl)) continue;

        // First try: decode the base64 thumbnail and check if it's square
        if (result.image && result.image.startsWith('data:image/')) {
          const base64Data = result.image.replace(/^data:image\/\w+;base64,/, '');
          const thumbBuffer = Buffer.from(base64Data, 'base64');
          const thumbDims = getImageDimensions(thumbBuffer);

          if (thumbDims) {
            const ratio = Math.min(thumbDims.width, thumbDims.height) / Math.max(thumbDims.width, thumbDims.height);
            if (ratio < 0.5) continue; // Way too narrow, skip entirely
          }
        }

        // Try to get full-size image from the source page
        console.log(`   Trying source: ${sourceUrl.substring(0, 60)}...`);
        const imageUrls = await getOriginalImageUrl(sourceUrl, show.title);

        for (const imgUrl of imageUrls) {
          const img = await tryDownloadImage(imgUrl, 400);
          if (!img) continue;

          if (img.isSquare) {
            console.log(`   ✅ Found square image: ${img.width}x${img.height} (ratio ${img.ratio.toFixed(2)})`);

            if (!dryRun) {
              resizeAndSave(img.buffer, thumbPath, 540);
              console.log(`   Saved: ${thumbPath}`);

              show.images = show.images || {};
              show.images.thumbnail = `/images/shows/${show.id}/thumbnail.jpg`;
            }
            return true;
          }

          // Track best non-square fallback (prefer larger, more square)
          if (!bestFallback || img.ratio > bestFallback.ratio ||
              (img.ratio === bestFallback.ratio && Math.min(img.width, img.height) > Math.min(bestFallback.width, bestFallback.height))) {
            bestFallback = img;
          }
        }

        await sleep(500); // Rate limit between source page fetches
      }
    } catch (err) {
      console.log(`   Error: ${err.message}`);
    }

    await sleep(1000); // Rate limit between searches
  }

  // Fallback: crop the best non-square image to square
  if (bestFallback) {
    console.log(`   🔲 Cropping non-square fallback: ${bestFallback.width}x${bestFallback.height} (ratio ${bestFallback.ratio.toFixed(2)})`);

    if (!dryRun) {
      resizeAndSave(bestFallback.buffer, thumbPath, 540, true);
      console.log(`   Saved (cropped): ${thumbPath}`);

      show.images = show.images || {};
      show.images.thumbnail = `/images/shows/${show.id}/thumbnail.jpg`;
    }
    return true;
  }

  console.log('   ❌ No image found');
  return false;
}

async function main() {
  if (!SCRAPINGBEE_API_KEY) {
    console.error('ERROR: Set SCRAPINGBEE_API_KEY environment variable');
    process.exit(1);
  }

  console.log(dryRun ? '=== DRY RUN ===' : '=== FETCHING SQUARE IMAGES ===');
  console.log();

  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf-8'));
  let shows = showsData.shows;

  // Filter to shows missing thumbnails
  if (showFilter) {
    shows = shows.filter(s => s.id === showFilter || s.slug === showFilter);
  } else {
    shows = shows.filter(s => {
      const thumb = s.images?.thumbnail;
      return !thumb || thumb === null;
    });
  }

  if (limit > 0) {
    shows = shows.slice(0, limit);
  }

  console.log(`Processing ${shows.length} shows missing thumbnails\n`);

  let success = 0;
  let failed = 0;

  for (const show of shows) {
    console.log(`\n📽️  ${show.title} (${show.id})`);
    const found = await processShow(show);
    if (found) success++;
    else failed++;
  }

  // Save updated shows.json
  if (!dryRun && success > 0) {
    fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsData, null, 2) + '\n');
  }

  console.log(`\n============================================================`);
  console.log(`SUMMARY`);
  console.log(`============================================================`);
  console.log(`✅ Found square images: ${success}`);
  console.log(`❌ No square image: ${failed}`);
  console.log(`Total processed: ${success + failed}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
