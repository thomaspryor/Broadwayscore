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

const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');

function slugifyTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’`´']/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function resolveShowTitle(showId) {
  try {
    const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf-8'));
    const arr = Array.isArray(shows) ? shows : (shows.shows || []);
    const show = arr.find(s => s.id === showId);
    return show ? show.title : null;
  } catch {
    return null;
  }
}

/**
 * Build DTLI URL candidates for a show, in priority order:
 *   1. overrideUrl (CLI or caller)
 *   2. dtli-slug-map.json (authoritative, weekly-discovered)
 *   3. Convention-based from shows.json title (for brand-new shows not yet
 *      in the slug map — opening night case). Typical DTLI slugs:
 *        "Beaches, A New Musical" → beaches
 *        "The Rocky Horror Show" → the-rocky-horror-show
 *      Try both with-and-without "the-" prefix.
 *   4. Convention-based from showId (strip trailing -YYYY).
 */
function buildDtliUrlCandidates(showId, overrideUrl) {
  if (overrideUrl) return [overrideUrl];
  const candidates = [];
  try {
    if (fs.existsSync(SLUG_MAP_PATH)) {
      const map = JSON.parse(fs.readFileSync(SLUG_MAP_PATH, 'utf-8'));
      const slug = map.shows && map.shows[showId];
      if (slug) candidates.push(`https://didtheylikeit.com/shows/${slug}/`);
    }
  } catch { /* fall through */ }

  const title = resolveShowTitle(showId);
  if (title) {
    // Title-based conventional slug: try full title, then comma-short.
    const titleSlug = slugifyTitle(title);
    if (titleSlug) candidates.push(`https://didtheylikeit.com/shows/${titleSlug}/`);
    const commaIdx = title.indexOf(',');
    if (commaIdx > 0) {
      const shortSlug = slugifyTitle(title.slice(0, commaIdx));
      if (shortSlug && shortSlug !== titleSlug) {
        candidates.push(`https://didtheylikeit.com/shows/${shortSlug}/`);
      }
    }
    // Strip leading "The " for shows like "The Rocky Horror Show" → "rocky-horror-show".
    const noThe = title.replace(/^the\s+/i, '');
    if (noThe !== title) {
      const noTheSlug = slugifyTitle(noThe);
      if (noTheSlug && !candidates.some(c => c.endsWith(`/${noTheSlug}/`))) {
        candidates.push(`https://didtheylikeit.com/shows/${noTheSlug}/`);
      }
    }
  }

  // Show-id based as last resort (strip year suffix).
  const idSlug = showId.replace(/-\d{4}$/, '');
  if (idSlug && !candidates.some(c => c.endsWith(`/${idSlug}/`))) {
    candidates.push(`https://didtheylikeit.com/shows/${idSlug}/`);
  }

  return candidates;
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

  const candidates = buildDtliUrlCandidates(showId, overrideUrl);
  if (!candidates.length) {
    throw new Error(`No DTLI URL candidates for ${showId}. Pass url or run discover-dtli-slugs first.`);
  }

  let dtliUrl = null;
  let extracted = [];
  let anyFetchSucceeded = false;
  for (const candidate of candidates) {
    console.log(`Fetching DTLI page: ${candidate}`);
    try {
      const r = await fetchPage(candidate, { renderJs: false });
      if (!r || !r.content) continue;
      anyFetchSucceeded = true;
      const rows = extractReviewsFromDTLI(r.content, showId);
      if (rows && rows.length > 0) {
        dtliUrl = candidate;
        extracted = rows;
        break;
      }
      if (verbose) console.log(`  [candidate] ${candidate} returned 0 review blocks — trying next`);
    } catch (e) {
      if (verbose) console.log(`  [candidate] ${candidate} failed: ${e.message}`);
    }
  }
  if (!anyFetchSucceeded) {
    throw new Error(`No DTLI URL fetched for ${showId} (tried ${candidates.length} candidates)`);
  }
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

module.exports = { enrichDtliThumbsForShow, buildDtliUrlCandidates, slugifyTitle };

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
