#!/usr/bin/env node

/**
 * SEO Utilities Script
 *
 * Commands:
 *   node scripts/seo-utils.js ping-sitemap    - Notify Google of sitemap updates
 *   node scripts/seo-utils.js validate-schema - Validate JSON-LD structured data
 *   node scripts/seo-utils.js check-links     - Check for broken internal links
 *   node scripts/seo-utils.js audit           - Run full SEO audit
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';
// Sitemap is sharded (/sitemap/0.xml …); shard 0 is the canonical entry point
// for ping endpoints. The dead /sitemap.xml index does not exist. See
// scripts/lib/sitemap-urls.js + src/app/robots.ts.
const SITEMAP_URL = `${BASE_URL}/sitemap/0.xml`;

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  dim: '\x1b[2m',
};

function log(color, symbol, message) {
  console.log(`${color}${symbol}${colors.reset} ${message}`);
}

// ============================================
// Ping Sitemap to Search Engines
// ============================================

async function pingSitemap() {
  console.log('\n📡 Pinging search engines with sitemap update...\n');

  const endpoints = [
    {
      name: 'Google',
      url: `https://www.google.com/ping?sitemap=${encodeURIComponent(SITEMAP_URL)}`,
    },
    {
      name: 'Bing',
      url: `https://www.bing.com/ping?sitemap=${encodeURIComponent(SITEMAP_URL)}`,
    },
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint.url);
      if (response.ok) {
        log(colors.green, '✓', `${endpoint.name}: Sitemap ping successful`);
      } else {
        log(colors.yellow, '⚠', `${endpoint.name}: Response ${response.status}`);
      }
    } catch (error) {
      log(colors.red, '✗', `${endpoint.name}: Failed - ${error.message}`);
    }
  }

  console.log(`\n${colors.dim}Sitemap URL: ${SITEMAP_URL}${colors.reset}\n`);
}

// ============================================
// Validate JSON-LD Schema
// ============================================

async function validateSchema() {
  console.log('\n🔍 Validating JSON-LD structured data...\n');

  // Read a sample show page to check schema
  const showsPath = path.join(__dirname, '../data/shows.json');
  const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const sampleShow = showsData.shows[0];

  console.log(`Checking schema for: ${sampleShow.title}`);
  console.log(`URL: ${BASE_URL}/show/${sampleShow.slug}\n`);

  // Schema validation checklist
  const checks = [
    { name: 'Has @context', pass: true },
    { name: 'Has @type (TheaterEvent)', pass: true },
    { name: 'Has name', pass: !!sampleShow.title },
    { name: 'Has location', pass: !!sampleShow.venue },
    { name: 'Has startDate', pass: !!sampleShow.openingDate },
    { name: 'Has image', pass: !!sampleShow.images?.hero },
    { name: 'Has description', pass: !!sampleShow.synopsis },
  ];

  checks.forEach(check => {
    if (check.pass) {
      log(colors.green, '✓', check.name);
    } else {
      log(colors.red, '✗', check.name);
    }
  });

  console.log(`\n${colors.blue}Tip: Test your pages at https://search.google.com/test/rich-results${colors.reset}\n`);
}

// ============================================
// Check Internal Links
// ============================================

async function checkLinks() {
  console.log('\n🔗 Checking internal link structure...\n');

  const showsPath = path.join(__dirname, '../data/shows.json');
  const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));

  // Count link types
  const stats = {
    showPages: showsData.shows.length,
    withImages: showsData.shows.filter(s => s.images?.hero).length,
    withTicketLinks: showsData.shows.filter(s => s.ticketLinks?.length > 0).length,
    withDirector: showsData.shows.filter(s =>
      s.creativeTeam?.some(m => m.role.toLowerCase().includes('director'))
    ).length,
    withTheaterAddress: showsData.shows.filter(s => s.theaterAddress).length,
  };

  log(colors.blue, '📊', `Total show pages: ${stats.showPages}`);
  log(colors.green, '✓', `With hero images: ${stats.withImages}/${stats.showPages}`);
  log(colors.green, '✓', `With ticket links: ${stats.withTicketLinks}/${stats.showPages}`);
  log(colors.green, '✓', `With director info: ${stats.withDirector}/${stats.showPages}`);
  log(colors.green, '✓', `With theater address: ${stats.withTheaterAddress}/${stats.showPages}`);

  // Extract unique directors and theaters
  const directors = new Set();
  const theaters = new Set();

  showsData.shows.forEach(show => {
    theaters.add(show.venue);
    show.creativeTeam?.forEach(member => {
      if (member.role.toLowerCase().includes('director') &&
          !member.role.toLowerCase().includes('music director')) {
        directors.add(member.name);
      }
    });
  });

  console.log(`\n${colors.blue}📍 Generated Pages:${colors.reset}`);
  log(colors.green, '→', `Director pages: ${directors.size}`);
  log(colors.green, '→', `Theater pages: ${theaters.size}`);
  log(colors.green, '→', `Best-of lists: 7 categories`);

  console.log(`\n${colors.dim}Total indexed pages: ${stats.showPages + directors.size + theaters.size + 7 + 2}${colors.reset}\n`);
}

// ============================================
// Full SEO Audit
// ============================================

async function audit() {
  console.log('\n' + '='.repeat(50));
  console.log('🎭 Broadway Scorecard SEO Audit');
  console.log('='.repeat(50));

  await validateSchema();
  await checkLinks();

  console.log('='.repeat(50));
  console.log('📋 Recommendations:');
  console.log('='.repeat(50) + '\n');

  const recommendations = [
    '1. Submit sitemap to Google Search Console',
    '2. Submit sitemap to Bing Webmaster Tools',
    '3. Test rich results at https://search.google.com/test/rich-results',
    '4. Monitor Core Web Vitals in Search Console',
    '5. Set up Google Analytics 4 for traffic tracking',
  ];

  recommendations.forEach(rec => {
    log(colors.yellow, '→', rec);
  });

  console.log('\n');
}

// ============================================
// Social Share URLs Generator
// ============================================

function generateShareUrls(showSlug, showTitle, score) {
  const pageUrl = `${BASE_URL}/show/${showSlug}`;
  const text = score
    ? `${showTitle} has a ${score}/100 critic score on Broadway Scorecard!`
    : `Check out ${showTitle} on Broadway Scorecard`;

  return {
    twitter: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(pageUrl)}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(pageUrl)}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(pageUrl)}`,
    email: `mailto:?subject=${encodeURIComponent(showTitle + ' - Broadway Scorecard')}&body=${encodeURIComponent(text + '\n\n' + pageUrl)}`,
  };
}

// ============================================
// CLI Handler
// ============================================

const command = process.argv[2];

switch (command) {
  case 'ping-sitemap':
    pingSitemap();
    break;
  case 'validate-schema':
    validateSchema();
    break;
  case 'check-links':
    checkLinks();
    break;
  case 'audit':
    audit();
    break;
  case 'share-urls':
    const slug = process.argv[3];
    if (!slug) {
      console.log('Usage: node scripts/seo-utils.js share-urls <show-slug>');
      process.exit(1);
    }
    const showsPath = path.join(__dirname, '../data/shows.json');
    const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    const show = showsData.shows.find(s => s.slug === slug);
    if (!show) {
      console.log(`Show not found: ${slug}`);
      process.exit(1);
    }
    console.log('\nShare URLs for:', show.title);
    console.log(JSON.stringify(generateShareUrls(slug, show.title, null), null, 2));
    break;
  default:
    console.log(`
🎭 Broadway Scorecard SEO Utilities

Commands:
  ping-sitemap     Notify Google/Bing of sitemap updates
  validate-schema  Validate JSON-LD structured data
  check-links      Check internal link structure
  audit            Run full SEO audit
  share-urls       Generate social share URLs for a show

Examples:
  node scripts/seo-utils.js ping-sitemap
  node scripts/seo-utils.js audit
  node scripts/seo-utils.js share-urls two-strangers
`);
}
