#!/usr/bin/env node
/**
 * Image fetcher for Broadway Metascore
 * Run with: node scripts/fetch-images.js
 *
 * This script fetches show images from various sources and saves them locally.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SHOWS_DIR = path.join(__dirname, '..', 'public', 'images', 'shows');

// Ensure directory exists
if (!fs.existsSync(SHOWS_DIR)) {
  fs.mkdirSync(SHOWS_DIR, { recursive: true });
}

// Image sources to try for each show
const IMAGE_SOURCES = {
  'two-strangers': {
    // Wikipedia/Wikimedia Commons - usually has poster images
    poster: [
      'https://upload.wikimedia.org/wikipedia/en/a/a5/Two_Strangers_Musical_Poster.jpg',
    ],
    // Try multiple sources for hero images
    hero: [
      // Playbill CDN patterns
      'https://bfrm.io/api/fetch?url=https://playbill.imgix.net/images/production/two-strangers-carry-a-cake-across-new-york-broadway-longacre-theatre-2025.jpg?w=1920',
      'https://images.playbill.com/image/upload/ar_16:9,c_fill,g_faces,w_1920/v1/production/two-strangers-broadway-2025.jpg',
    ],
    thumbnail: [
      'https://upload.wikimedia.org/wikipedia/en/thumb/a/a5/Two_Strangers_Musical_Poster.jpg/400px-Two_Strangers_Musical_Poster.jpg',
    ]
  }
};

function fetchImage(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    };

    protocol.get(url, options, (response) => {
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        console.log(`  ↳ Redirecting to: ${response.headers.location}`);
        return fetchImage(response.headers.location).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      const contentType = response.headers['content-type'] || '';
      if (!contentType.includes('image')) {
        reject(new Error(`Not an image: ${contentType}`));
        return;
      }

      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

async function downloadImage(urls, outputPath) {
  for (const url of urls) {
    console.log(`  Trying: ${url.substring(0, 80)}...`);
    try {
      const data = await fetchImage(url);
      fs.writeFileSync(outputPath, data);
      console.log(`  ✓ Saved to ${outputPath} (${Math.round(data.length / 1024)}KB)`);
      return true;
    } catch (err) {
      console.log(`  ✗ Failed: ${err.message}`);
    }
  }
  return false;
}

async function main() {
  console.log('Broadway Metascore Image Fetcher\n');

  for (const [showSlug, sources] of Object.entries(IMAGE_SOURCES)) {
    console.log(`\n📽️  ${showSlug}`);

    for (const [imageType, urls] of Object.entries(sources)) {
      const ext = urls[0]?.match(/\.(jpg|jpeg|png|webp)/i)?.[1] || 'jpg';
      const outputPath = path.join(SHOWS_DIR, `${showSlug}-${imageType}.${ext}`);

      console.log(`\n  ${imageType}:`);

      if (fs.existsSync(outputPath)) {
        console.log(`  ⏭️  Already exists: ${outputPath}`);
        continue;
      }

      await downloadImage(urls, outputPath);
    }
  }

  console.log('\n\nDone! Check public/images/shows/ for downloaded images.');
  console.log('\nIf some images failed, you can manually download from:');
  console.log('  - https://playbill.com/production/two-strangers-carry-a-cake-across-new-york-broadway-longacre-theatre-2025');
  console.log('  - https://www.broadway.com/shows/two-strangers-carry-a-cake-across-new-york/');
  console.log('  - https://en.wikipedia.org/wiki/Two_Strangers_(Carry_a_Cake_Across_New_York)');
}

main().catch(console.error);
