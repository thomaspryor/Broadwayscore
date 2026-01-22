#!/usr/bin/env node
/**
 * Test image fetching for a single show
 * Usage: node scripts/test-image-fetch.js <show-id> <show-slug>
 * Example: node scripts/test-image-fetch.js 41018 maybe-happy-ending-on-broadway
 */

const https = require('https');

const showId = process.argv[2] || '41018';
const showSlug = process.argv[3] || 'maybe-happy-ending-on-broadway';

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      timeout: 15000,
    };

    https.get(url, options, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function main() {
  const url = `https://www.todaytix.com/nyc/shows/${showId}-${showSlug}`;
  console.log(`Fetching: ${url}\n`);

  try {
    const html = await fetchPage(url);

    // Extract all ctfassets image URLs
    const imageMatches = html.match(/https:\/\/images\.ctfassets\.net\/[^"'< ]+\.(jpg|jpeg|png|webp)/gi);

    if (!imageMatches) {
      console.log('No images found');
      return;
    }

    // Remove duplicates and sort by URL
    const uniqueImages = [...new Set(imageMatches)].sort();

    console.log(`Found ${uniqueImages.length} unique images:\n`);

    // Group by dimensions found in filename
    const square = [];
    const portrait = [];
    const landscape = [];
    const other = [];

    for (const url of uniqueImages) {
      const filename = url.split('/').pop().split('?')[0];
      console.log(`- ${filename}`);

      if (filename.match(/1080x1080|1000x1000|square/i)) {
        square.push(url);
      } else if (filename.match(/480x720|600x900|poster/i)) {
        portrait.push(url);
      } else if (filename.match(/1440x580|1920x1080|hero|banner/i)) {
        landscape.push(url);
      } else {
        other.push(url);
      }
    }

    console.log(`\n--- Square (${square.length}) ---`);
    square.forEach(u => console.log(u));

    console.log(`\n--- Portrait (${portrait.length}) ---`);
    portrait.forEach(u => console.log(u));

    console.log(`\n--- Landscape (${landscape.length}) ---`);
    landscape.forEach(u => console.log(u));

    console.log(`\n--- Other (${other.length}) ---`);
    other.forEach(u => console.log(u));

  } catch (err) {
    console.error(`Error: ${err.message}`);
  }
}

main();
