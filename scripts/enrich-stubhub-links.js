#!/usr/bin/env node
/**
 * Enrich shows.json with StubHub ticket links for open Broadway shows.
 *
 * StubHub uses Cloudflare bot protection, so we discover URLs via SERP only
 * (no HTTP verification). We filter for /performer/ URLs which are persistent
 * show-level pages, not date-specific /event/ URLs that expire.
 *
 * Usage:
 *   node scripts/enrich-stubhub-links.js [--dry-run] [--limit N] [--show SLUG]
 *
 * Options:
 *   --dry-run   Print what would be added without modifying shows.json
 *   --limit N   Only process the first N shows (default: all open Broadway)
 *   --show SLUG Process a single show by slug
 */

const fs = require('fs');
const path = require('path');
const { serpQuery } = require('./lib/url-discovery');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : Infinity;
})();
const SINGLE_SHOW = (() => {
  const idx = process.argv.indexOf('--show');
  return idx >= 0 ? process.argv[idx + 1] : null;
})();

// ============================================================================
// StubHub SERP discovery
// ============================================================================

function normalizeTitle(title) {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

/**
 * Search for a show's StubHub performer page via SERP.
 * Only accepts /performer/ URLs (persistent) — rejects /event/ URLs (date-specific, expire).
 */
async function discoverStubhubUrl(showTitle, market = 'broadway') {
  const marketTerm = market === 'broadway' ? 'broadway' : 'london';
  const cleanTitle = showTitle
    .replace(/\s*\([^)]{5,}\)\s*$/, '')   // strip parenthetical venue
    .replace(/\s*[-–—]\s*(?:Globe|Donmar|Almeida)$/i, '') // strip venue suffix
    .replace(/['']/g, "'");
  const query = `site:stubhub.com "${cleanTitle}" ${marketTerm} tickets`;
  const results = await serpQuery(query);

  if (!results || results.length === 0) {
    console.log(`  No SERP results`);
    return null;
  }

  const showNorm = normalizeTitle(showTitle);
  const showWords = showNorm.split(' ').filter(w => w.length > 2);

  for (const r of results) {
    let url = r.url;
    if (!url || !url.includes('stubhub.com')) continue;

    // Only accept persistent show-level URLs (/performer/ or /category/)
    // Reject date-specific /event/ URLs that expire after the performance
    if (!url.includes('/performer/') && !url.includes('/category/')) continue;
    if (url.includes('/event/')) continue;

    // Skip search/discover pages and parking passes
    if (url.includes('/search') || url.includes('/discover')) continue;
    if (url.includes('parking-passes') || url.toLowerCase().includes('parking')) continue;
    // Only accept www.stubhub.com (skip regional hostnames: za., ec., pe., etc.)
    if (!url.includes('www.stubhub.com')) continue;
    // Strip regional path prefixes (/cl/, /za/, /ec/, /pe/, etc.)
    const regionalMatch = url.match(/stubhub\.com\/([a-z]{2})\//);
    if (regionalMatch && regionalMatch[1] !== 'en') {
      url = url.replace(`/${regionalMatch[1]}/`, '/');
    }

    // Verify title match — at least 50% of significant words must appear in SERP title
    const serpTitle = normalizeTitle(r.title || '');
    if (showWords.length > 0) {
      const matchCount = showWords.filter(w => serpTitle.includes(w)).length;
      if (matchCount < Math.ceil(showWords.length * 0.5)) continue;
    }

    // Check the show-name portion of the URL slug (before /performer/ and /city/)
    const slugPart = url.toLowerCase().split('/performer/')[0].split('/').pop() || '';
    const slugMatchCount = showWords.filter(w => slugPart.includes(w)).length;
    if (showWords.length > 0 && slugMatchCount < Math.ceil(showWords.length * 0.4)) continue;

    // For London shows, prefer /london-city/ URLs; reject obviously wrong cities
    if (marketTerm === 'london') {
      const urlLower = url.toLowerCase();
      if (urlLower.includes('-city/') && !urlLower.includes('london-city/')) continue;
    }

    return url.replace(/^http:/, 'https:');
  }

  console.log(`  No matching /performer/ URL in ${results.length} results`);
  return null;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log(`StubHub Link Enrichment ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log('='.repeat(60));

  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows;

  let candidates;

  if (SINGLE_SHOW) {
    const show = shows.find(s => s.slug === SINGLE_SHOW);
    if (!show) {
      console.error(`Show not found: ${SINGLE_SHOW}`);
      process.exit(1);
    }
    candidates = [show];
  } else {
    // Open/preview Broadway shows without StubHub link
    candidates = shows.filter(s =>
      (s.status === 'open' || s.status === 'previews') &&
      ['broadway', 'west-end', 'off-west-end', undefined].includes(s.category || undefined) &&
      !(s.ticketLinks || []).some(l => l.platform === 'StubHub')
    );
  }

  if (LIMIT < candidates.length) {
    candidates = candidates.slice(0, LIMIT);
  }

  console.log(`Candidates: ${candidates.length}\n`);

  let added = 0;
  let notFound = 0;

  for (const show of candidates) {
    console.log(`${show.id}: "${show.title}"`);

    const market = (show.category === 'west-end' || show.category === 'off-west-end') ? 'london' : 'broadway';
    const url = await discoverStubhubUrl(show.title, market);

    if (url) {
      console.log(`  Found: ${url}`);
      added++;

      if (!DRY_RUN) {
        if (!show.ticketLinks) show.ticketLinks = [];
        // Append at end — sortTicketLinks() handles display order
        show.ticketLinks.push({ platform: 'StubHub', url, priceFrom: null });
      }
    } else {
      console.log(`  Not found`);
      notFound++;
    }

    // Rate limit SERP calls
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!DRY_RUN && added > 0) {
    fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsData, null, 2) + '\n');
    console.log(`\nWrote ${added} StubHub links to shows.json`);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results:`);
  console.log(`  StubHub added: ${added}`);
  console.log(`  Not found: ${notFound}`);
  console.log(`  Total processed: ${candidates.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
