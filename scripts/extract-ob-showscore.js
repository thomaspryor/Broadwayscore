const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { resolveOutletFromCritic, resolveOutletFromUrl } = require('./lib/review-normalization');
// Shared JSON-LD reader — handles schema.org @graph, which a hand-rolled
// `Array.isArray(x) ? x : [x]` silently misses (scripts/lib/jsonld.js).
const { parseJsonLd } = require('./lib/jsonld');

const archivePath = 'data/aggregator-archive/show-score';
const urlsData = JSON.parse(fs.readFileSync('data/show-score-urls.json', 'utf8'));
const showsData = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
const obIds = new Set(showsData.shows.filter(s => s.category === 'off-broadway').map(s => s.id));

const outputPath = 'data/show-score.json';
let output = {};
try { output = JSON.parse(fs.readFileSync(outputPath, 'utf8')); } catch {}
if (!output.shows) output.shows = {};

let processed = 0, extracted = 0, criticTotal = 0;
for (const [showId, url] of Object.entries(urlsData.shows)) {
  if (!obIds.has(showId)) continue;
  const archiveFile = path.join(archivePath, showId + '.html');
  if (!fs.existsSync(archiveFile)) continue;

  const html = fs.readFileSync(archiveFile, 'utf8');
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  processed++;

  let audienceScore = null, audienceReviewCount = null;
  const jsonLd = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const el of jsonLd) {
    try {
      for (const data of parseJsonLd(el.textContent)) {
        if (!data.aggregateRating) continue;
        audienceScore = data.aggregateRating.ratingValue;
        audienceReviewCount = data.aggregateRating.reviewCount;
      }
    } catch {}
  }

  const criticReviews = [];
  const tiles = doc.querySelectorAll('.review-tile-v2.-critic');
  for (const tile of tiles) {
    let outlet = tile.querySelector('.user-avatar-v2 img')?.getAttribute('alt') || null;
    const date = tile.querySelector('.review-tile-v2__date')?.textContent?.trim() || '';
    const author = tile.querySelector('.review-tile-v2__authors a')?.textContent?.trim() || '';
    const excerpt = tile.querySelector('.review-tile-v2__review p')?.textContent?.replace(/Read more$/i, '').trim() || '';
    const reviewUrl = tile.querySelector('a[href]')?.getAttribute('href') || '';

    // Resolve null outlet from critic registry or review URL
    if (!outlet && author) {
      const resolved = resolveOutletFromCritic(author);
      if (resolved) {
        outlet = resolved.displayName;
      }
    }
    if (!outlet && reviewUrl) {
      const urlResolved = resolveOutletFromUrl(reviewUrl);
      if (urlResolved) {
        outlet = urlResolved.displayName;
      }
    }
    if (!outlet) {
      if (author) {
        console.warn(`  WARNING: Could not resolve outlet for critic "${author}" in ${showId}`);
      }
      outlet = 'Unknown';
    }

    if (excerpt) {
      criticReviews.push({ outlet, date, author, excerpt, url: reviewUrl });
    }
  }

  output.shows[showId] = {
    showScoreUrl: url,
    category: 'off-broadway',
    audienceScore,
    audienceReviewCount,
    criticReviewCount: criticReviews.length,
    criticReviews,
    lastFetched: new Date().toISOString().split('T')[0],
  };
  extracted++;
  criticTotal += criticReviews.length;

  dom.window.close();
  if (processed % 10 === 0) process.stdout.write('.');
}

output._meta = { ...(output._meta || {}), lastOBExtraction: new Date().toISOString() };
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
console.log(`\nDone. OB shows processed: ${processed}, extracted: ${extracted}, critic reviews: ${criticTotal}`);
