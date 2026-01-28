#!/usr/bin/env node
/**
 * Archive show images locally
 *
 * Downloads poster, thumbnail, and hero images for all shows from CDN URLs.
 * Saves optimized WebP copies to public/images/shows/{show-id}/
 * Backs up original CDN URLs to data/image-sources.json
 * Updates shows.json to point to local paths
 *
 * Usage:
 *   node scripts/archive-show-images.js              # Archive all shows
 *   node scripts/archive-show-images.js --force       # Re-download even if local file exists
 *   node scripts/archive-show-images.js --show=hamilton-2015  # Archive specific show
 */

const fs = require('fs');
const path = require('path');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const OUTPUT_DIR = path.join(__dirname, '..', 'public', 'images', 'shows');
const SOURCES_PATH = path.join(__dirname, '..', 'data', 'image-sources.json');

const FORMATS = ['poster', 'thumbnail', 'hero'];

// Contentful transformation parameters for each format
const CONTENTFUL_PARAMS = {
  poster:    'w=720&h=1080&fit=fill&f=face&fm=webp&q=85',
  thumbnail: 'w=540&h=540&fit=fill&f=face&fm=webp&q=85',
  hero:      'w=1920&h=800&fit=fill&f=center&fm=webp&q=85',
};

function getDownloadUrl(url, format) {
  if (!url) return null;
  if (url.includes('images.ctfassets.net')) {
    const baseUrl = url.split('?')[0];
    return `${baseUrl}?${CONTENTFUL_PARAMS[format]}`;
  }
  return url;
}

function getLocalExtension(url) {
  if (url.includes('ctfassets.net')) return 'webp'; // Contentful serves WebP via fm=webp
  const match = url.match(/\.(webp|png|jpg|jpeg|gif)/i);
  return match ? match[1].toLowerCase() : 'webp';
}

async function downloadImage(url, filepath) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)' },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length < 1000) {
    throw new Error(`Suspiciously small file (${buffer.length} bytes)`);
  }

  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, buffer);
  return buffer.length;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];

  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));

  // Load or create image sources backup
  let imageSources = {};
  try {
    imageSources = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
  } catch {
    // File doesn't exist yet
  }

  let shows = showsData.shows;
  if (showFilter) {
    shows = shows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (shows.length === 0) {
      console.error(`Show not found: ${showFilter}`);
      process.exit(1);
    }
  }

  let totalDownloaded = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let totalBytes = 0;
  let showsUpdated = 0;

  console.log(`Archiving images for ${shows.length} shows...`);
  console.log(`Output: ${OUTPUT_DIR}`);
  console.log(`Force re-download: ${force}\n`);

  for (const show of shows) {
    if (!show.images) continue;

    // Save original CDN URLs before we overwrite them
    if (!imageSources[show.id]) {
      imageSources[show.id] = {};
    }

    let showDownloaded = 0;
    let showChanged = false;

    for (const format of FORMATS) {
      const url = show.images[format];
      if (!url) continue;

      // If URL is already local and we're not forcing, skip
      if (url.startsWith('/images/') && !force) {
        // Check that the local file actually exists
        const localPath = path.join(__dirname, '..', 'public', url);
        if (fs.existsSync(localPath)) {
          totalSkipped++;
          continue;
        }
        // Local path in shows.json but file is missing - try to re-download from source
        const sourceUrl = imageSources[show.id]?.[format];
        if (!sourceUrl) {
          console.warn(`  ⚠ ${show.title} ${format}: Local file missing and no source URL`);
          totalFailed++;
          continue;
        }
        // Re-download from source
        const ext = getLocalExtension(sourceUrl);
        const filepath = path.join(OUTPUT_DIR, show.id, `${format}.${ext}`);
        try {
          const dlUrl = getDownloadUrl(sourceUrl, format);
          const size = await downloadImage(dlUrl, filepath);
          show.images[format] = `/images/shows/${show.id}/${format}.${ext}`;
          showDownloaded++;
          totalDownloaded++;
          totalBytes += size;
          showChanged = true;
        } catch (e) {
          console.error(`  ✗ ${show.title} ${format}: ${e.message}`);
          totalFailed++;
        }
        await new Promise(r => setTimeout(r, 150));
        continue;
      }

      // Save original URL before overwriting
      if (!url.startsWith('/images/')) {
        imageSources[show.id][format] = url;
      }

      const ext = getLocalExtension(url);
      const filepath = path.join(OUTPUT_DIR, show.id, `${format}.${ext}`);

      // Skip if already downloaded (unless forcing)
      if (fs.existsSync(filepath) && !force) {
        // File exists - just update shows.json to use local path
        const localPath = `/images/shows/${show.id}/${format}.${ext}`;
        if (show.images[format] !== localPath) {
          show.images[format] = localPath;
          showChanged = true;
        }
        totalSkipped++;
        continue;
      }

      // Download the image
      const dlUrl = getDownloadUrl(url, format);
      if (!dlUrl) continue;

      try {
        const size = await downloadImage(dlUrl, filepath);
        show.images[format] = `/images/shows/${show.id}/${format}.${ext}`;
        showDownloaded++;
        totalDownloaded++;
        totalBytes += size;
        showChanged = true;
      } catch (e) {
        console.error(`  ✗ ${show.title} ${format}: ${e.message}`);
        totalFailed++;
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 150));
    }

    if (showChanged) showsUpdated++;
    if (showDownloaded > 0) {
      console.log(`✓ ${show.title}: ${showDownloaded} images downloaded`);
    }
  }

  // Save image sources backup
  fs.writeFileSync(SOURCES_PATH, JSON.stringify(imageSources, null, 2) + '\n');

  // Save updated shows.json with local paths
  fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsData, null, 2) + '\n');

  console.log(`\n--- Summary ---`);
  console.log(`Downloaded: ${totalDownloaded} images (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`Already cached: ${totalSkipped}`);
  console.log(`Failed: ${totalFailed}`);
  console.log(`Shows updated in shows.json: ${showsUpdated}`);
  console.log(`Image sources backed up to: ${SOURCES_PATH}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
