#!/usr/bin/env node
/**
 * Broadway Metascore Image Fetcher
 * Run with: node scripts/fetch-images.js
 *
 * This script fetches show images from TodayTix and saves them locally,
 * or outputs the CDN URLs for use in shows.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const SHOWS_DIR = path.join(__dirname, '..', 'public', 'images', 'shows');

// Ensure directory exists
if (!fs.existsSync(SHOWS_DIR)) {
  fs.mkdirSync(SHOWS_DIR, { recursive: true });
}

// TodayTix show IDs for Broadway shows
const TODAYTIX_SHOWS = {
  'wicked': { id: 1, slug: 'wicked' },
  'chicago': { id: 22, slug: 'chicago' },
  'the-lion-king': { id: 42, slug: 'the-lion-king-on-broadway' },
  'aladdin': { id: 105, slug: 'aladdin-on-broadway' },
  'book-of-mormon': { id: 127, slug: 'the-book-of-mormon' },
  'hamilton': { id: 384, slug: 'hamilton' },
  'hadestown': { id: 14748, slug: 'hadestown' },
  'moulin-rouge': { id: 15911, slug: 'moulin-rouge-the-musical' },
  'six': { id: 20737, slug: 'six-on-broadway' },
  'mj': { id: 23379, slug: 'mj-the-musical-on-broadway' },
  'and-juliet': { id: 25598, slug: 'and-juliet-on-broadway' },
  'the-outsiders': { id: 34093, slug: 'the-outsiders' },
  'hells-kitchen': { id: 37579, slug: 'hells-kitchen-broadway' },
  'the-great-gatsby': { id: 38749, slug: 'the-great-gatsby-on-broadway' },
  'maybe-happy-ending': { id: 41018, slug: 'maybe-happy-ending-on-broadway' },
  'two-strangers': { id: 45002, slug: 'two-strangers-carry-a-cake-across-new-york' },
  'oh-mary': { id: 38371, slug: 'oh-mary' },
  'operation-mincemeat': { id: 42680, slug: 'operation-mincemeat' },
  'bug': { id: 44892, slug: 'bug' },
  'harry-potter': { id: 1377, slug: 'harry-potter-and-the-cursed-child' },
  'mamma-mia': { id: 42850, slug: 'mamma-mia' },
  'stranger-things': { id: 40958, slug: 'stranger-things-the-first-shadow' },
};

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    };

    https.get(url, options, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return fetchPage(response.headers.location).then(resolve).catch(reject);
      }

      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve(data));
      response.on('error', reject);
    }).on('error', reject);
  });
}

function extractImageUrl(html) {
  // Look for og:image meta tag
  const ogMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);
  if (ogMatch) return ogMatch[1];

  // Look for Contentful image URLs
  const ctfMatch = html.match(/https:\/\/images\.ctfassets\.net\/[^"'\s]+/);
  if (ctfMatch) return ctfMatch[0];

  return null;
}

function downloadImage(url, outputPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : require('http');

    protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return downloadImage(response.headers.location, outputPath).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      const file = fs.createWriteStream(outputPath);
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(outputPath);
      });
    }).on('error', reject);
  });
}

async function fetchShowImage(showSlug, showInfo) {
  const url = `https://www.todaytix.com/nyc/shows/${showInfo.id}-${showInfo.slug}`;
  console.log(`\n📽️  ${showSlug}`);
  console.log(`   URL: ${url}`);

  try {
    const html = await fetchPage(url);
    const imageUrl = extractImageUrl(html);

    if (imageUrl) {
      console.log(`   ✓ Found image: ${imageUrl.substring(0, 80)}...`);

      // Generate different sizes using Contentful params if it's a ctfassets URL
      if (imageUrl.includes('ctfassets.net')) {
        const baseUrl = imageUrl.split('?')[0];
        return {
          hero: `${baseUrl}?w=1920&h=1080&fit=fill&q=90`,
          thumbnail: `${baseUrl}?w=400&h=400&fit=fill&q=80`,
          poster: `${baseUrl}?w=600&h=900&fit=fill&q=85`,
        };
      }

      return { hero: imageUrl, thumbnail: imageUrl, poster: imageUrl };
    } else {
      console.log(`   ✗ No image found`);
      return null;
    }
  } catch (err) {
    console.log(`   ✗ Error: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log('Broadway Metascore Image Fetcher');
  console.log('================================\n');

  const results = {};

  for (const [showSlug, showInfo] of Object.entries(TODAYTIX_SHOWS)) {
    const images = await fetchShowImage(showSlug, showInfo);
    if (images) {
      results[showSlug] = images;
    }

    // Rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n\n================================');
  console.log('Results (copy to shows.json):');
  console.log('================================\n');

  console.log(JSON.stringify(results, null, 2));

  // Save results to file
  const outputPath = path.join(__dirname, 'image-urls.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n\nSaved to: ${outputPath}`);
}

// Alternative: Just output the TodayTix URLs for manual checking
function listShowUrls() {
  console.log('TodayTix Show URLs:');
  console.log('==================\n');

  for (const [showSlug, showInfo] of Object.entries(TODAYTIX_SHOWS)) {
    console.log(`${showSlug}: https://www.todaytix.com/nyc/shows/${showInfo.id}-${showInfo.slug}`);
  }
}

// Run
if (process.argv.includes('--list')) {
  listShowUrls();
} else {
  main().catch(console.error);
}
