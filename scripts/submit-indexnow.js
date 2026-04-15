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
let dryRun = false;

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
  } else if (args[i] === '--dry-run') {
    dryRun = true;
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
  --all             Submit all pages from sitemap.xml (recurses sitemap-index)
  --dry-run         Print URL count + first 10 URLs but do not POST to IndexNow
  --help            Show this help message
`);
    process.exit(0);
  }
}

function extractLocs(xml) {
  const urls = [];
  const locRegex = /<loc>([^<]+)<\/loc>/g;
  let match;
  while ((match = locRegex.exec(xml)) !== null) urls.push(match[1]);
  return urls;
}

async function fetchSitemapXml(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function getUrlsFromLiveSitemap() {
  // Fetch the production sitemap-index. If it's a <sitemapindex>, recurse into
  // each sub-sitemap and union all <loc>. If it's a <urlset>, return URLs directly.
  const indexXml = await fetchSitemapXml(`https://${SITE_HOST}/sitemap.xml`);
  if (!indexXml) return null;

  if (indexXml.includes('<sitemapindex')) {
    const subSitemapUrls = extractLocs(indexXml);
    console.log(`Sitemap index found with ${subSitemapUrls.length} sub-sitemaps; fetching each...`);
    const allUrls = [];
    for (const subUrl of subSitemapUrls) {
      const subXml = await fetchSitemapXml(subUrl);
      if (subXml) {
        const subLocs = extractLocs(subXml);
        console.log(`  ${subUrl.split('/').pop()}: ${subLocs.length} URLs`);
        allUrls.push(...subLocs);
      } else {
        console.warn(`  failed to fetch ${subUrl}`);
      }
    }
    return allUrls.length > 0 ? allUrls : null;
  }

  // Legacy single-sitemap case
  return extractLocs(indexXml);
}

async function getUrlsFromBuildSitemap() {
  // Legacy: read URLs from a static-export build output (out/sitemap.xml).
  // No longer used in CI (Vercel SSR doesn't produce out/), kept for back-compat.
  const sitemapPath = path.join(__dirname, '../out/sitemap.xml');
  if (!fs.existsSync(sitemapPath)) return null;
  const xml = fs.readFileSync(sitemapPath, 'utf8');
  return extractLocs(xml);
}

async function getUrlsFromSitemap() {
  // Prefer live production sitemap — always reflects what crawlers actually see.
  const liveUrls = await getUrlsFromLiveSitemap();
  if (liveUrls && liveUrls.length > 0) {
    console.log(`Read ${liveUrls.length} URLs from live sitemap (https://${SITE_HOST}/sitemap.xml)`);
    return liveUrls;
  }

  // Fallback 1: legacy static-export build output
  const buildUrls = await getUrlsFromBuildSitemap();
  if (buildUrls && buildUrls.length > 0) {
    console.log(`Read ${buildUrls.length} URLs from build sitemap (out/sitemap.xml)`);
    return buildUrls;
  }

  console.log('Live and build sitemaps unavailable, falling back to data-driven URL generation');

  // Fallback: build URL list from shows.json + hardcoded page types
  const showsPath = path.join(__dirname, '../data/shows.json');

  if (!fs.existsSync(showsPath)) {
    console.error('shows.json not found');
    return [];
  }

  const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const shows = showsData.shows || showsData;
  const urls = [];

  // Key static pages
  urls.push(
    `https://${SITE_HOST}/`,
    `https://${SITE_HOST}/rankings`,
    `https://${SITE_HOST}/methodology`,
    `https://${SITE_HOST}/tony-awards`,
    `https://${SITE_HOST}/broadway-theaters-map`,
    `https://${SITE_HOST}/lotteries`,
    `https://${SITE_HOST}/rush`,
    `https://${SITE_HOST}/standing-room`,
    `https://${SITE_HOST}/best-value`,
    `https://${SITE_HOST}/audience-buzz`,
    `https://${SITE_HOST}/box-office`,
    `https://${SITE_HOST}/biz`,
    `https://${SITE_HOST}/critics`,
    `https://${SITE_HOST}/critics/outlets`,
    `https://${SITE_HOST}/guides`,
    `https://${SITE_HOST}/lists`,
    `https://${SITE_HOST}/compare`,
    `https://${SITE_HOST}/theater`
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

  // Guide pages
  const guidePages = [
    'best-broadway-shows', 'best-broadway-musicals', 'best-broadway-plays',
    'broadway-shows-closing-soon', 'best-broadway-shows-for-kids',
    'best-broadway-shows-for-date-night', 'cheap-broadway-tickets'
  ];
  for (const page of guidePages) {
    urls.push(`https://${SITE_HOST}/guides/${page}`);
  }

  // Creative index pages
  const creativeIndexes = ['directors', 'playwrights', 'composers', 'lyricists'];
  for (const page of creativeIndexes) {
    urls.push(`https://${SITE_HOST}/${page}`);
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

  if (dryRun) {
    console.log(`[DRY RUN] Would submit ${urls.length} URLs in ${batches.length} batch(es). First 10:`);
    urls.slice(0, 10).forEach(u => console.log(`  - ${u}`));
    console.log(`[DRY RUN] No POST sent to ${INDEXNOW_ENDPOINT}.`);
    return;
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

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
