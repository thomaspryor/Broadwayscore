#!/usr/bin/env node
/**
 * Enrich shows.json with SeatPlan ticket links for open WE shows.
 *
 * SeatPlan URLs follow a predictable pattern: seatplan.com/london/{slug}-tickets/
 * We construct candidate slugs, verify via HTTP, and add to ticketLinks.
 *
 * Usage:
 *   node scripts/enrich-seatplan-links.js [--dry-run] [--show SLUG]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { buildLondonSlugVariants } = require('./lib/show-matching');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');
const SINGLE_SHOW = (() => {
  const idx = process.argv.indexOf('--show');
  return idx >= 0 ? process.argv[idx + 1] : null;
})();

// Manual overrides for shows whose SeatPlan slug doesn't match titleToSlug()
const SEATPLAN_OVERRIDES = {
  'Paddington The Musical': 'paddington-musical',
  'Cabaret at the Kit Kat Club': 'cabaret',
  'The Hunger Games On Stage': 'hunger-games-on-stage',
  'SIX the Musical': 'six',
  'Harry Potter And The Cursed Child: Both Parts': 'harry-potter-and-the-cursed-child',
};

function titleToSlug(title) {
  return title
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function buildSeatplanUrls(title) {
  if (SEATPLAN_OVERRIDES[title]) {
    return [`https://seatplan.com/london/${SEATPLAN_OVERRIDES[title]}-tickets/`];
  }
  return buildLondonSlugVariants(title, titleToSlug)
    .map(s => `https://seatplan.com/london/${s}-tickets/`);
}

function checkUrl(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      timeout: 10000,
    }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

function isLondonMarket(category) {
  return category === 'west-end' || category === 'off-west-end';
}

async function main() {
  console.log(`SeatPlan Link Enrichment ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log('='.repeat(60));

  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows;

  let candidates;
  if (SINGLE_SHOW) {
    const show = shows.find(s => s.id === SINGLE_SHOW || s.slug === SINGLE_SHOW);
    if (!show) { console.error(`Show not found: ${SINGLE_SHOW}`); process.exit(1); }
    candidates = [show];
  } else {
    candidates = shows.filter(s =>
      (s.status === 'open' || s.status === 'previews') &&
      isLondonMarket(s.category) &&
      !(s.ticketLinks || []).some(l => l.platform === 'SeatPlan')
    );
  }

  console.log(`Candidates: ${candidates.length} WE shows without SeatPlan link\n`);

  let added = 0, notFound = 0;

  for (const show of candidates) {
    const urls = buildSeatplanUrls(show.title);
    let foundUrl = null;

    for (const url of urls) {
      const status = await checkUrl(url);
      if (status === 200) {
        foundUrl = url;
        break;
      }
    }

    if (foundUrl) {
      console.log(`  ADD: ${show.title} → ${foundUrl}`);
      if (!DRY_RUN) {
        if (!show.ticketLinks) show.ticketLinks = [];
        show.ticketLinks.push({ platform: 'SeatPlan', url: foundUrl });
      }
      added++;
    } else {
      console.log(`  MISS: ${show.title} (tried ${urls.length} slug variants)`);
      notFound++;
    }

    // Small delay to be polite
    await new Promise(r => setTimeout(r, 200));
  }

  if (!DRY_RUN && added > 0) {
    fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsData, null, 2) + '\n');
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Added: ${added} | Not found: ${notFound}`);
  if (DRY_RUN) console.log('(DRY RUN — nothing saved)');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
