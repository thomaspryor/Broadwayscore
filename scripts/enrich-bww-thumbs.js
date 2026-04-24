#!/usr/bin/env node
/**
 * enrich-bww-thumbs.js
 *
 * Post-ingest BWW Review Roundup thumb + URL enrichment pass.
 *
 * Problem (card 34c637c5-416f-8147-b7de-dcc260d0a151):
 * On opening night, BWW RR fetches often fail (Cloudflare block + slug
 * mismatch — see companion title-match card). When they do land, reviews
 * are ingested via `extractBWWRoundupReviews`, which writes `bwwThumb`.
 * But if reviews arrive via manual ingestion or a different discovery
 * path, `bwwThumb` never gets populated.
 *
 * Fix: given a known-good BWW RR URL, fetch it, run the same extractor,
 * and MERGE `bwwThumb` and outlet `url` into existing review files. Never
 * overwrites scores, fullText, or any field other than bwwThumb/url/bwwExcerpt.
 *
 * Usage:
 *   node scripts/enrich-bww-thumbs.js --show=beaches-2026 --url=https://www.broadwayworld.com/article/Review-Roundup-BEACHES-Opens-on-Broadway-20260422
 *   node scripts/enrich-bww-thumbs.js --show=beaches-2026 --url=URL --dry-run
 *
 * Wiring: called from scripts/opening-night-poller.js after the rebuild phase
 * when a BWW RR URL has been discovered, so late-arriving thumbs are always
 * reconciled onto freshly-ingested reviews.
 */

const fs = require('fs');
const path = require('path');

const { findExistingReviewFile, normalizeOutlet, normalizeCritic, areCriticsSimilar } = require('./lib/review-normalization');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');

/**
 * Fallback matcher for files whose filename year-suffix prevents
 * findExistingReviewFile from matching. See enrich-dtli-thumbs.js for full
 * explanation. Catches amny--matt-windman-2026.json-style filenames.
 */
function findByInternalFields(showDir, outletId, criticName) {
  if (!fs.existsSync(showDir)) return null;
  const targetOutlet = normalizeOutlet(outletId);
  const targetCritic = criticName && criticName.toLowerCase() !== 'unknown'
    ? normalizeCritic(criticName) : null;
  for (const file of fs.readdirSync(showDir)) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(showDir, file);
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
    catch { continue; }
    if (!data || data.wrongProduction || data.duplicateOf) continue;
    if (!data.outletId) continue;
    if (normalizeOutlet(data.outletId) !== targetOutlet) continue;
    if (targetCritic && data.criticName) {
      const dataCritic = normalizeCritic(data.criticName);
      if (dataCritic !== targetCritic && !areCriticsSimilar(criticName, data.criticName)) {
        continue;
      }
    }
    return { path: filePath, filename: file, data };
  }
  return null;
}

function resolveShowTitle(showId) {
  try {
    const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf-8'));
    const arr = Array.isArray(shows) ? shows : (shows.shows || []);
    const show = arr.find(s => s.id === showId);
    return show ? show.title : showId;
  } catch {
    return showId;
  }
}

/**
 * Enrich an already-ingested show's review files with BWW RR thumb + outlet URL.
 * Never overwrites scores, fullText, or any existing URL. Only sets bwwThumb
 * when missing or stale, and sets url when the existing file has none.
 *
 * @param {string} showId
 * @param {object} opts
 * @param {string} opts.url - BWW Review Roundup article URL (required)
 * @param {string} [opts.title] - Show title override
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.verbose]
 * @param {Function} [opts.fetchPage] - Injected for testing
 * @param {Function} [opts.extractBWWRoundupReviews] - Injected for testing
 * @returns {Promise<{extracted, enrichedThumb, enrichedUrl, skippedMissing}>}
 */
async function enrichBwwThumbsForShow(showId, opts = {}) {
  const { url: bwwUrl, dryRun = false, verbose = false } = opts;
  if (!bwwUrl) throw new Error('url is required');
  const showDir = path.join(ROOT, 'data', 'review-texts', showId);
  if (!fs.existsSync(showDir)) {
    throw new Error(`No review-texts dir for show: ${showDir}`);
  }
  const fetchPage = opts.fetchPage || require('./lib/scraper').fetchPage;
  const extractBWWRoundupReviews = opts.extractBWWRoundupReviews
    || require('./gather-reviews').extractBWWRoundupReviews;
  const showTitle = opts.title || resolveShowTitle(showId);

  console.log(`Fetching BWW RR page: ${bwwUrl}`);
  const result = await fetchPage(bwwUrl, { renderJs: false });
  if (!result || !result.content) throw new Error('Fetch returned no content');

  const extracted = extractBWWRoundupReviews(result.content, showId, bwwUrl, showTitle) || [];
  console.log(`Extracted ${extracted.length} critic blocks from BWW RR`);

  let enrichedThumb = 0;
  let enrichedUrl = 0;
  let skippedMissing = 0;

  for (const ex of extracted) {
    if (!ex.outletId) continue;

    let existing = findExistingReviewFile(showDir, ex.outletId, ex.criticName);
    if (!existing || !existing.path || !existing.data) {
      existing = findByInternalFields(showDir, ex.outletId, ex.criticName);
    }
    if (!existing || !existing.path || !existing.data) {
      if (verbose) {
        console.log(`  [miss] No existing file for outletId=${ex.outletId} critic=${ex.criticName || '?'}`);
      }
      skippedMissing++;
      continue;
    }

    const data = existing.data;
    const changes = [];

    if (ex.bwwThumb && data.bwwThumb !== ex.bwwThumb) {
      changes.push(`bwwThumb: ${data.bwwThumb || 'null'} → ${ex.bwwThumb}`);
      data.bwwThumb = ex.bwwThumb;
      enrichedThumb++;
    }

    if (ex.url && !data.url) {
      changes.push(`url: null → ${ex.url}`);
      data.url = ex.url;
      enrichedUrl++;
    }

    if (!changes.length) continue;

    const filename = path.basename(existing.path);
    if (dryRun) {
      console.log(`  [dry-run] ${filename}: ${changes.join(', ')}`);
    } else {
      fs.writeFileSync(existing.path, JSON.stringify(data, null, 2));
      console.log(`  ✓ ${filename}: ${changes.join(', ')}`);
    }
  }

  console.log('');
  console.log('='.repeat(60));
  console.log(`BWW RR enrichment summary for ${showId}:`);
  console.log(`  Extracted from BWW RR: ${extracted.length}`);
  console.log(`  Thumbs enriched:       ${enrichedThumb}`);
  console.log(`  URLs enriched:         ${enrichedUrl}`);
  console.log(`  Skipped (no match):    ${skippedMissing}`);
  if (dryRun) console.log('  (dry-run — no files written)');

  return { extracted: extracted.length, enrichedThumb, enrichedUrl, skippedMissing };
}

module.exports = { enrichBwwThumbsForShow };

if (require.main === module) {
  const argv = process.argv.slice(2);
  function getFlag(name) {
    const prefix = `--${name}=`;
    const match = argv.find(a => a.startsWith(prefix));
    if (match) return match.slice(prefix.length);
    return argv.includes(`--${name}`) ? true : null;
  }
  const showId = getFlag('show');
  const bwwUrl = typeof getFlag('url') === 'string' ? getFlag('url') : null;
  if (!showId || !bwwUrl) {
    console.error('Usage: node scripts/enrich-bww-thumbs.js --show=SHOW_ID --url=BWW_RR_URL [--dry-run]');
    process.exit(1);
  }
  enrichBwwThumbsForShow(showId, {
    url: bwwUrl,
    dryRun: !!getFlag('dry-run'),
    verbose: !!getFlag('verbose'),
  }).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}
