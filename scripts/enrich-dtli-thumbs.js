#!/usr/bin/env node
/**
 * enrich-dtli-thumbs.js
 *
 * Post-ingest DTLI thumb + URL enrichment pass.
 *
 * Problem (card 34c637c5-416f-8147-b7de-dcc260d0a151):
 * On opening night, reviews are often ingested individually (by the poller, by
 * manual CLI, by the BWW RR fallback path) WITHOUT going through the DTLI
 * extractor. That means per-critic `dtliThumb` values never get populated, and
 * the per-critic DTLI outlet URL is missing too. fix-scores.js can't cross-check
 * the LLM score against the thumb, and consumers that use dtliThumb miss half
 * the signal.
 *
 * Fix: this script fetches the DTLI show page (or uses --url override), runs
 * the same extractor we use in weekly DTLI scraping, then MERGES `dtliThumb`
 * and outlet `url` into existing review files. It never overwrites scores,
 * fullText, or any field other than dtliThumb/url/dtliExcerpt.
 *
 * Usage:
 *   node scripts/enrich-dtli-thumbs.js --show=beaches-2026
 *   node scripts/enrich-dtli-thumbs.js --show=beaches-2026 --url=https://didtheylikeit.com/shows/beaches/
 *   node scripts/enrich-dtli-thumbs.js --show=beaches-2026 --dry-run
 *
 * Wiring: called from scripts/opening-night-poller.js after the rebuild phase
 * so late-arriving thumbs are always reconciled onto freshly-ingested reviews.
 */

const fs = require('fs');
const path = require('path');

const { extractReviewsFromDTLI } = require('./extract-dtli-reviews');
const { findExistingReviewFile, normalizeOutlet, normalizeCritic, areCriticsSimilar } = require('./lib/review-normalization');

const ROOT = path.join(__dirname, '..');
const SLUG_MAP_PATH = path.join(ROOT, 'data', 'dtli-slug-map.json');

/**
 * Fallback matcher for files whose filename year-suffix prevents
 * findExistingReviewFile from matching. Example:
 *   filename: amny--matt-windman-2026.json  (fileCritic = "matt-windman-2026")
 *   internal criticName: "Matt Windman"     (normalized "matt-windman")
 * findExistingReviewFile's Pass 1 skips (critic mismatch via filename) and
 * Pass 2 skips (because filename-outlet matched Pass 1). This helper reads
 * each file's internal outletId + criticName fields directly.
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

function resolveDtliUrl(showId, overrideUrl) {
  if (overrideUrl) return overrideUrl;
  if (!fs.existsSync(SLUG_MAP_PATH)) return null;
  try {
    const map = JSON.parse(fs.readFileSync(SLUG_MAP_PATH, 'utf-8'));
    const slug = map.shows && map.shows[showId];
    if (!slug) return null;
    return `https://didtheylikeit.com/shows/${slug}/`;
  } catch {
    return null;
  }
}

/**
 * Enrich an already-ingested show's review files with DTLI thumb + outlet URL.
 * Never overwrites scores, fullText, or any existing URL. Only sets dtliThumb
 * when missing or stale, and sets url when the existing file has none.
 *
 * @param {string} showId
 * @param {object} opts
 * @param {string} [opts.url] - Override DTLI page URL (if not in slug map)
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.verbose]
 * @param {Function} [opts.fetchPage] - Injected for testing; defaults to scripts/lib/scraper.fetchPage
 * @returns {Promise<{extracted, enrichedThumb, enrichedUrl, skippedMissing}>}
 */
async function enrichDtliThumbsForShow(showId, opts = {}) {
  const { url: overrideUrl, dryRun = false, verbose = false } = opts;
  const fetchPage = opts.fetchPage || require('./lib/scraper').fetchPage;
  const showDir = path.join(ROOT, 'data', 'review-texts', showId);
  if (!fs.existsSync(showDir)) {
    throw new Error(`No review-texts dir for show: ${showDir}`);
  }

  const dtliUrl = resolveDtliUrl(showId, overrideUrl);
  if (!dtliUrl) {
    throw new Error(`No DTLI URL resolved for ${showId}. Pass url or run discover-dtli-slugs first.`);
  }

  console.log(`Fetching DTLI page: ${dtliUrl}`);
  const result = await fetchPage(dtliUrl, { renderJs: false });
  if (!result || !result.content) throw new Error('Fetch returned no content');

  const extracted = extractReviewsFromDTLI(result.content, showId);
  console.log(`Extracted ${extracted.length} critic blocks from DTLI`);

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

    if (ex.dtliThumb && data.dtliThumb !== ex.dtliThumb) {
      changes.push(`dtliThumb: ${data.dtliThumb || 'null'} → ${ex.dtliThumb}`);
      data.dtliThumb = ex.dtliThumb;
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
  console.log(`DTLI enrichment summary for ${showId}:`);
  console.log(`  Extracted from DTLI:  ${extracted.length}`);
  console.log(`  Thumbs enriched:      ${enrichedThumb}`);
  console.log(`  URLs enriched:        ${enrichedUrl}`);
  console.log(`  Skipped (no match):   ${skippedMissing}`);
  if (dryRun) console.log('  (dry-run — no files written)');

  return { extracted: extracted.length, enrichedThumb, enrichedUrl, skippedMissing };
}

module.exports = { enrichDtliThumbsForShow, resolveDtliUrl };

if (require.main === module) {
  const argv = process.argv.slice(2);
  function getFlag(name) {
    const prefix = `--${name}=`;
    const match = argv.find(a => a.startsWith(prefix));
    if (match) return match.slice(prefix.length);
    return argv.includes(`--${name}`) ? true : null;
  }
  const showId = getFlag('show');
  if (!showId) {
    console.error('Usage: node scripts/enrich-dtli-thumbs.js --show=SHOW_ID [--url=URL] [--dry-run]');
    process.exit(1);
  }
  enrichDtliThumbsForShow(showId, {
    url: typeof getFlag('url') === 'string' ? getFlag('url') : undefined,
    dryRun: !!getFlag('dry-run'),
    verbose: !!getFlag('verbose'),
  }).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}
