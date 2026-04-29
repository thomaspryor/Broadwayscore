#!/usr/bin/env node
/**
 * Extract critic reviews and audience data from archived Show Score HTML pages
 *
 * Usage: node scripts/extract-show-score-reviews.js
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { resolveOutletFromCritic, resolveOutletFromUrl } = require('./lib/review-normalization');
const { isLondonMarket } = require('./lib/venue-classification');

const archivePath = path.join(__dirname, '../data/aggregator-archive/show-score');
const urlsPath = path.join(__dirname, '../data/show-score-urls.json');
const outputPath = path.join(__dirname, '../data/show-score.json');

// Load URL mapping and shows data for category detection
const urlData = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
const showUrls = urlData.shows;
const showsPath = path.join(__dirname, '../data/shows.json');
const showsRaw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const showsList = showsRaw.shows || showsRaw;
const showsArray = Array.isArray(showsList) ? showsList : Object.values(showsList);
const showsById = {};
for (const s of showsArray) if (s.id) showsById[s.id] = s;

function detectCategory(html, showId) {
  // Use shows.json category if available
  const show = showsById[showId];
  if (show?.category === 'off-broadway') return 'off-broadway';
  if (isLondonMarket(show?.category)) return show.category;
  if (showId && showId.includes('off-west-end')) return 'off-west-end';
  if (showId && showId.includes('west-end')) return 'west-end';

  // Fall back to page content detection
  const canonicalMatch = html.match(/<link rel="canonical" href="([^"]+)"/);
  const canonicalUrl = canonicalMatch ? canonicalMatch[1] : '';
  if (canonicalUrl.includes('/off-broadway-shows/')) return 'off-broadway';
  if (canonicalUrl.includes('/uk/') || canonicalUrl.includes('west-end-shows')) return 'west-end';
  return 'broadway';
}

// Build a relevance probe from a show ID — strips year suffixes and market
// markers so that "kenrex-off-broadway-2026" probes for "kenrex" against
// extracted URLs and excerpts. Used to guard against cross-show contamination
// (Show Score's "Recent Reviews" sidebar leaking into the show's tile list
// when the show is in their content-pipeline upgrade state).
//
// Edge case: numeric-title shows like "1776-2022" — naively stripping the
// year suffix leaves "" with no tokens, which short-circuits the contamination
// check (returns true unconditionally). When the year IS the title, keep it
// as a token. Detected by checking whether stripping year-suffix removes
// the only meaningful content.
function _showProbeTokens(showId) {
  const yearStripped = showId.replace(/-(\d{4})$/, '');
  const yearToken = (showId.match(/-(\d{4})$/) || [])[1];
  const fullyStripped = yearStripped
    .replace(/-(broadway|off-broadway|west-end|off-west-end|the-musical)$/g, '')
    .replace(/-the-musical-(broadway|off-broadway|west-end|off-west-end)$/, '')
    .replace(/-(broadway|off-broadway|west-end|off-west-end)$/g, '');
  const parts = fullyStripped.split('-').filter(t => t.length >= 3);
  // If stripping market-suffixes left no meaningful tokens AND the year IS
  // the title (e.g. "1776"), retain the year as a probe token. Without this,
  // numeric-titled revivals get a no-op contamination check.
  if (parts.length === 0 && yearToken) return [yearToken];
  return parts.slice(0, 3);
}

// Reject extracted critic URLs that don't mention the show's title in the URL
// path. Show Score's mid-upgrade pages serve cross-show content in the show's
// own carousel container; this guard prevents propagating Lost Boys reviews
// into KENREX's record (KENREX 2026-04-28 root cause).
function _criticUrlMatchesShow(url, showProbeTokens) {
  if (!url || showProbeTokens.length === 0) return true; // can't probe → don't block
  const lc = url.toLowerCase();
  // Match any one of the show's distinctive tokens in the URL path
  return showProbeTokens.some(tok => lc.includes(tok));
}

function extractShowData(html, showId, sourceUrl) {
  const $ = cheerio.load(html);

  const category = detectCategory(html, showId);
  const result = {
    showScoreUrl: sourceUrl,
    category,
    audienceScore: null,
    audienceReviewCount: null,
    criticReviewCount: 0,
    criticReviews: [],
    rejectedCriticUrls: [], // populated when cross-show contamination is detected
    lastFetched: new Date().toISOString().split('T')[0]
  };

  // Check page title to confirm we have the right page
  const title = $('title').text() || '';

  if (!title.includes('Show Score') || title.includes('NYC Theatre Reviews and Tickets')) {
    // Louder than console.log so misconfigured slugs in data/show-score-urls.json
    // are visible in CI output. Common case: URL silently redirects to the generic
    // /shows/all listing page (title "Show Score | NYC Theatre Reviews and Tickets").
    // scripts/audit-show-score-urls.js will flag these on cron so the URL gets fixed.
    console.warn(`  ⚠️  SS-REDIRECT ${showId} — page title "${title.slice(0, 80)}" suggests the stored URL redirected to the generic listing. Fix data/show-score-urls.json.`);
    return null;
  }

  // Extract audience score from JSON-LD
  $('script[type="application/ld+json"]').each(function () {
    try {
      const data = JSON.parse($(this).html());
      if (data.aggregateRating) {
        result.audienceScore = data.aggregateRating.ratingValue;
        result.audienceReviewCount = data.aggregateRating.reviewCount;
        return false; // break
      }
    } catch (e) {
      // Skip invalid JSON-LD
    }
  });

  // Extract critic review count from heading
  const criticHeadingMatch = html.match(/Critic Reviews\s*\((\d+)\)/);
  if (criticHeadingMatch) {
    result.criticReviewCount = parseInt(criticHeadingMatch[1], 10);
  }

  // Extract individual critic reviews
  $('.review-tile-v2.-critic').each(function () {
    const tile = $(this);
    const review = {};

    // Get outlet name from image alt text
    const outletImg = tile.find('.user-avatar-v2 img');
    if (outletImg.length) {
      review.outlet = outletImg.attr('alt') || null;
    }

    // Get date
    const dateEl = tile.find('.review-tile-v2__date');
    if (dateEl.length) {
      review.date = dateEl.text().trim();
    }

    // Get author
    const authorEl = tile.find('.review-tile-v2__authors a');
    if (authorEl.length) {
      review.author = authorEl.text().trim();
    }

    // Get star rating from CSS variable --rating on .review-tile-v2__stars
    // --rating is the star count (1-5 scale) or percentage (>5 = 0-100 scale)
    // --gaps is a CSS rendering variable that matches --rating, NOT the max
    const starsEl = tile.find('.review-tile-v2__stars');
    if (starsEl.length) {
      const style = starsEl.attr('style') || '';
      const ratingMatch = style.match(/--rating:\s*([\d.]+)/);
      if (ratingMatch) {
        review.starRating = parseFloat(ratingMatch[1]);
        review.starMax = review.starRating > 5 ? 100 : 5;
      }
    }

    // Get excerpt
    const excerptEl = tile.find('.review-tile-v2__review p');
    if (excerptEl.length) {
      let excerpt = excerptEl.text().trim();
      excerpt = excerpt.replace(/Read more\s*$/i, '').trim();
      review.excerpt = excerpt || null;
    }

    // Get review URL
    const reviewLink = tile.find('.review-tile-v2__review a[href*="http"]');
    if (reviewLink.length) {
      review.url = reviewLink.attr('href');
    }

    // Resolve null outlet from critic registry or review URL
    if (!review.outlet && review.author) {
      const resolved = resolveOutletFromCritic(review.author);
      if (resolved) {
        review.outlet = resolved.displayName;
        review._outletResolvedFrom = 'critic-registry';
      }
    }
    if (!review.outlet && review.url) {
      const urlResolved = resolveOutletFromUrl(review.url);
      if (urlResolved) {
        review.outlet = urlResolved.displayName;
        review._outletResolvedFrom = 'url-domain';
      }
    }
    if (!review.outlet && review.author) {
      console.warn(`    WARNING: Could not resolve outlet for critic "${review.author}" — will be "unknown"`);
    }

    // Only add if we have meaningful data
    if (review.outlet || review.author) {
      result.criticReviews.push(review);
    }
  });

  // Cross-show contamination guard: if extracted URLs don't mention the show
  // title at all, the page was likely serving cross-show content (Show Score's
  // mid-upgrade state — KENREX 2026-04-28 returned Lost Boys URLs in KENREX's
  // own critic-reviews block). Reject the contaminated set rather than poison
  // downstream review-text records.
  const probeTokens = _showProbeTokens(showId);
  if (probeTokens.length > 0 && result.criticReviews.length > 0) {
    const withUrl = result.criticReviews.filter(r => r.url);
    if (withUrl.length >= 2) {
      const matching = withUrl.filter(r => _criticUrlMatchesShow(r.url, probeTokens));
      // If <30% of URL-bearing reviews mention the show, treat as contamination
      if (matching.length / withUrl.length < 0.3) {
        result.rejectedCriticUrls = result.criticReviews.map(r => r.url || r.author || 'unknown');
        result.criticReviews = [];
        result._rejectionReason = `cross-show-contamination: ${matching.length}/${withUrl.length} URLs mention show probe tokens [${probeTokens.join(',')}]`;
      }
    }
  }

  return result;
}

function main() {
  console.log('Extracting Show Score data from archived HTML pages...\n');

  const showScoreData = {
    _meta: {
      lastUpdated: new Date().toISOString(),
      source: 'show-score.com'
    },
    shows: {}
  };

  // Collect all show IDs to process: URL entries + any archive files without URL entries
  const showIdsFromUrls = new Set(Object.keys(showUrls));
  const archiveFiles = fs.existsSync(archivePath)
    ? fs.readdirSync(archivePath).filter(f => f.endsWith('.html')).map(f => f.replace('.html', ''))
    : [];
  const showIdsFromArchives = new Set(archiveFiles);

  // Merge: process everything that has either a URL or an archive
  const allShowIds = new Set([...showIdsFromUrls, ...showIdsFromArchives]);
  console.log(`Show IDs from URLs: ${showIdsFromUrls.size}, from archives: ${showIdsFromArchives.size}, total unique: ${allShowIds.size}\n`);

  let successCount = 0;
  let failCount = 0;
  const categoryCounts = { broadway: 0, 'off-broadway': 0, 'west-end': 0, 'off-west-end': 0 };
  // Per-show extraction-gap report. Surfaces shows where the carousel scroll
  // didn't load the full critic-review set (Bug 2/3 in the 2026-04-28 fix).
  // KENREX root cause: "Critic Reviews (11)" header but only 8 tiles in static
  // HTML. This file feeds audit-aggregator-coverage and the daily digest so
  // future drift surfaces in <24h.
  const extractionGaps = [];

  for (const showId of [...allShowIds].sort()) {
    const archiveFile = path.join(archivePath, `${showId}.html`);
    const sourceUrl = showUrls[showId] || null;

    console.log(`Processing: ${showId}`);

    if (!fs.existsSync(archiveFile)) {
      console.log(`  SKIP: Archive file not found`);
      failCount++;
      continue;
    }

    try {
      const html = fs.readFileSync(archiveFile, 'utf8');

      // Check if the HTML looks like the correct page
      if (html.includes('NYC Theatre Reviews and Tickets</title>') &&
          !html.includes('(Broadway)')) {
        console.log(`  SKIP: Wrong page content (general listing)`);
        failCount++;
        continue;
      }

      const data = extractShowData(html, showId, sourceUrl);

      if (data) {
        showScoreData.shows[showId] = data;
        categoryCounts[data.category] = (categoryCounts[data.category] || 0) + 1;
        const extracted = data.criticReviews.length;
        const expected = data.criticReviewCount || 0;
        // Surface contamination rejections distinctly from regular gaps
        if (data._rejectionReason) {
          console.log(`  OK: [${data.category}] Score ${data.audienceScore}%, ${data.audienceReviewCount} audience reviews, 0/${expected} critic reviews — ${data._rejectionReason}`);
          console.log(`::warning::[show-score] ${showId} all critic tiles rejected as cross-show contamination (Show Score upgrade state) — see rejectedCriticUrls in show-score.json`);
        } else {
          console.log(`  OK: [${data.category}] Score ${data.audienceScore}%, ${data.audienceReviewCount} audience reviews, ${extracted}/${expected} critic reviews extracted`);
        }
        // Loud-fail when extracted < expected. The page header is authoritative
        // ("Critic Reviews (N)") and the carousel-scroll in fetch-aggregator-pages.ts
        // SHOULD render all N tiles. A shortfall means either (a) carousel-scroll
        // stalled, (b) page format changed, or (c) archive is from a stale fetch
        // that pre-dates current critic count. All three need operator visibility.
        if (expected > 0 && extracted < expected) {
          const ratio = extracted / expected;
          const severity = ratio < 0.5 ? 'error' : 'warning';
          const gap = expected - extracted;
          extractionGaps.push({ showId, category: data.category, expected, extracted, gap, ratio: +ratio.toFixed(2), severity });
          if (severity === 'error') {
            // GitHub Actions surfaces ::error:: in the run summary
            console.log(`::error::[show-score] ${showId} extracted ${extracted}/${expected} critic reviews (${Math.round(ratio*100)}%) — likely carousel-scroll stall or format change`);
          } else {
            console.log(`::warning::[show-score] ${showId} extracted ${extracted}/${expected} critic reviews (${Math.round(ratio*100)}%) — partial`);
          }
        }
        successCount++;
      } else {
        console.log(`  SKIP: Could not extract data`);
        failCount++;
      }
    } catch (error) {
      console.log(`  ERROR: ${error.message}`);
      failCount++;
    }
  }

  // Write main output
  fs.writeFileSync(outputPath, JSON.stringify(showScoreData, null, 2));

  // Write extraction-gap audit (always — empty file is a useful signal of "all good")
  const gapsPath = path.join(__dirname, '../data/audit/show-score-extraction-gaps.json');
  fs.mkdirSync(path.dirname(gapsPath), { recursive: true });
  fs.writeFileSync(gapsPath, JSON.stringify({
    _meta: {
      generatedAt: new Date().toISOString(),
      description: 'Per-show critic-review extraction gaps (extracted < page-stated count). See scripts/fetch-aggregator-pages.ts carousel-scroll logic.',
    },
    totalGaps: extractionGaps.length,
    errorSeverity: extractionGaps.filter(g => g.severity === 'error').length,
    warningSeverity: extractionGaps.filter(g => g.severity === 'warning').length,
    gaps: extractionGaps,
  }, null, 2));

  console.log(`\n=== Summary ===`);
  console.log(`Successful: ${successCount} (Broadway: ${categoryCounts.broadway}, Off-Broadway: ${categoryCounts['off-broadway']}, West End: ${categoryCounts['west-end']}, Off-West End: ${categoryCounts['off-west-end']})`);
  console.log(`Failed/Skipped: ${failCount}`);
  if (extractionGaps.length > 0) {
    console.log(`Critic-review extraction gaps: ${extractionGaps.length} shows (${extractionGaps.filter(g => g.severity === 'error').length} error, ${extractionGaps.filter(g => g.severity === 'warning').length} warning)`);
    console.log(`  Top 5 gaps: ${extractionGaps.slice().sort((a,b) => b.gap - a.gap).slice(0,5).map(g => `${g.showId} (${g.extracted}/${g.expected})`).join(', ')}`);
  }
  console.log(`Output written to: ${outputPath}`);
  console.log(`Extraction gaps written to: ${gapsPath}`);
}

try {
  main();
} catch (err) {
  console.error('Fatal error:', err);
  process.exit(1);
}
