#!/usr/bin/env node
/**
 * Submit URLs to IndexNow for faster search engine indexing
 *
 * IndexNow notifies: Bing, Yandex, Seznam, Naver, and others
 *
 * Usage:
 *   node scripts/submit-indexnow.js                    # Submit sitemap URLs
 *   node scripts/submit-indexnow.js --urls /show/hamilton,/show/wicked
 *   node scripts/submit-indexnow.js --shows hamilton-2015,wicked-2003
 *   node scripts/submit-indexnow.js --all              # Submit all pages
 */

const fs = require('fs');
const path = require('path');

const INDEXNOW_KEY = 'c98817f2581efaac8a239e3dbed189ba';
const SITE_HOST = 'broadwayscorecard.com';
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

// Parse command line arguments
const args = process.argv.slice(2);
let mode = 'sitemap'; // default: submit key pages from sitemap
let specificUrls = [];
let specificShows = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--urls' && args[i + 1]) {
    specificUrls = args[i + 1].split(',').map(u => u.trim());
    mode = 'urls';
    i++;
  } else if (args[i] === '--shows' && args[i + 1]) {
    specificShows = args[i + 1].split(',').map(s => s.trim());
    mode = 'shows';
    i++;
  } else if (args[i] === '--all') {
    mode = 'all';
  } else if (args[i] === '--help') {
    console.log(`
IndexNow URL Submission Script

Usage:
  node scripts/submit-indexnow.js                    Submit key pages (homepage, rankings)
  node scripts/submit-indexnow.js --urls /path1,/path2   Submit specific URLs
  node scripts/submit-indexnow.js --shows show-id-1,show-id-2   Submit show pages
  node scripts/submit-indexnow.js --all              Submit all pages from sitemap

Options:
  --urls <paths>    Comma-separated URL paths (e.g., /show/hamilton,/rankings)
  --shows <ids>     Comma-separated show IDs (e.g., hamilton-2015,wicked-2003)
  --all             Submit all pages from sitemap.xml
  --help            Show this help message
`);
    process.exit(0);
  }
}

async function getUrlsFromSitemap() {
  // Read the generated sitemap or build URL list from shows.json
  const showsPath = path.join(__dirname, '../data/shows.json');

  if (!fs.existsSync(showsPath)) {
    console.error('shows.json not found');
    return [];
  }

  const shows = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const urls = [];

  // Key static pages
  urls.push(
    `https://${SITE_HOST}/`,
    `https://${SITE_HOST}/rankings`,
    `https://${SITE_HOST}/methodology`,
    `https://${SITE_HOST}/lotteries`,
    `https://${SITE_HOST}/rush`,
    `https://${SITE_HOST}/best-value`,
    `https://${SITE_HOST}/audience-buzz`,
    `https://${SITE_HOST}/box-office`,
    `https://${SITE_HOST}/biz-buzz`
  );

  // All show pages
  for (const show of shows) {
    urls.push(`https://${SITE_HOST}/show/${show.slug}`);
  }

  // Browse pages
  const browsePages = [
    'broadway-musicals',
    'broadway-plays',
    'broadway-revivals',
    'new-broadway-shows',
    'broadway-shows-for-kids',
    'broadway-shows-for-date-night',
    'broadway-shows-for-tourists'
  ];
  for (const page of browsePages) {
    urls.push(`https://${SITE_HOST}/browse/${page}`);
  }

  // Best pages
  const bestPages = ['musicals', 'plays', 'new-shows', 'revivals', 'comedies', 'dramas', 'family'];
  for (const page of bestPages) {
    urls.push(`https://${SITE_HOST}/best/${page}`);
  }

  return urls;
}

async function submitToIndexNow(urls) {
  if (urls.length === 0) {
    console.log('No URLs to submit');
    return;
  }

  // IndexNow accepts up to 10,000 URLs per request
  const batchSize = 10000;
  const batches = [];

  for (let i = 0; i < urls.length; i += batchSize) {
    batches.push(urls.slice(i, i + batchSize));
  }

  console.log(`Submitting ${urls.length} URLs to IndexNow in ${batches.length} batch(es)...`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    const payload = {
      host: SITE_HOST,
      key: INDEXNOW_KEY,
      keyLocation: `https://${SITE_HOST}/${INDEXNOW_KEY}.txt`,
      urlList: batch
    };

    try {
      const response = await fetch(INDEXNOW_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(payload)
      });

      if (response.ok || response.status === 200 || response.status === 202) {
        console.log(`✓ Batch ${i + 1}/${batches.length}: Submitted ${batch.length} URLs successfully`);
      } else {
        const text = await response.text();
        console.error(`✗ Batch ${i + 1}/${batches.length}: HTTP ${response.status} - ${text}`);
      }
    } catch (error) {
      console.error(`✗ Batch ${i + 1}/${batches.length}: Error - ${error.message}`);
    }
  }

  console.log('\nIndexNow submission complete.');
  console.log('URLs will be crawled by: Bing, Yandex, Seznam, Naver, and other participating search engines.');
}

async function main() {
  let urls = [];

  switch (mode) {
    case 'urls':
      urls = specificUrls.map(u => {
        if (u.startsWith('http')) return u;
        return `https://${SITE_HOST}${u.startsWith('/') ? '' : '/'}${u}`;
      });
      break;

    case 'shows':
      urls = specificShows.map(s => `https://${SITE_HOST}/show/${s}`);
      // Also submit homepage since show listings may have changed
      urls.push(`https://${SITE_HOST}/`);
      break;

    case 'all':
      urls = await getUrlsFromSitemap();
      break;

    case 'sitemap':
    default:
      // Just submit key pages that change frequently
      urls = [
        `https://${SITE_HOST}/`,
        `https://${SITE_HOST}/rankings`,
        `https://${SITE_HOST}/lotteries`,
        `https://${SITE_HOST}/rush`,
        `https://${SITE_HOST}/best-value`,
        `https://${SITE_HOST}/audience-buzz`,
        `https://${SITE_HOST}/box-office`
      ];
      break;
  }

  console.log(`Mode: ${mode}`);
  console.log(`URLs to submit: ${urls.length}`);

  if (urls.length <= 20) {
    urls.forEach(u => console.log(`  - ${u}`));
  } else {
    urls.slice(0, 10).forEach(u => console.log(`  - ${u}`));
    console.log(`  ... and ${urls.length - 10} more`);
  }

  console.log('');
  await submitToIndexNow(urls);
}

main().catch(console.error);
