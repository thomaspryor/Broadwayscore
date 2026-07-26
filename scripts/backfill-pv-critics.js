#!/usr/bin/env node
/**
 * Backfill critic names for Playbill Verdict reviews with "unknown" critic.
 *
 * Strategy:
 * 1. Extract from URL patterns (HuffPost author slugs)
 * 2. Direct HTTP fetch + meta tag / JSON-LD / byline extraction
 * 3. ScrapingBee fallback for pages that block direct access
 *
 * Usage:
 *   node scripts/backfill-pv-critics.js [--dry-run] [--limit=N] [--outlet=X]
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 0;
const outletArg = args.find(a => a.startsWith('--outlet='));
const outletFilter = outletArg ? outletArg.split('=')[1] : null;

const reviewsDir = 'data/review-texts';
const normalization = require('./lib/review-normalization');
const { extractAuthorFromHtml, isValidAuthorName, cleanAuthorName } = require('./lib/content-quality');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `backfill-pv-critics.js — Backfill critic names for Playbill Verdict reviews with "unknown" critic.

Usage:
  node scripts/backfill-pv-critics.js [options]
  node scripts/backfill-pv-critics.js --help, -h    print this usage and exit
`;
// --- Collect PV unknown-critic reviews ---
function collectUnknowns() {
  const dirs = fs.readdirSync(reviewsDir).filter(d => {
    try { return fs.statSync(path.join(reviewsDir, d)).isDirectory(); } catch { return false; }
  });

  const unknowns = [];
  for (const d of dirs) {
    const files = fs.readdirSync(path.join(reviewsDir, d)).filter(f =>
      f.endsWith('.json') && f !== 'failed-fetches.json'
    );
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(reviewsDir, d, f), 'utf8'));
        if (data.source === 'playbill-verdict' && (data.criticName || '').toLowerCase() === 'unknown') {
          if (outletFilter && data.outletId !== outletFilter) continue;
          unknowns.push({
            dir: d,
            file: f,
            filePath: path.join(reviewsDir, d, f),
            outletId: data.outletId,
            url: data.url || '',
            data
          });
        }
      } catch {}
    }
  }
  return unknowns;
}

// --- URL pattern extraction ---
function extractCriticFromUrl(url) {
  const lower = url.toLowerCase();

  // HuffPost: huffingtonpost.com/author-name/article
  const huffMatch = lower.match(/huffingtonpost\.com\/([a-z]+-[a-z]+(?:-[a-z]+)*)\//);
  if (huffMatch) {
    const slug = huffMatch[1];
    const skip = ['entry', 'news', 'post', 'blog', 'article', 'life', 'entertainment',
                  'culture', 'arts', 'theater', 'comedy', 'style', 'travel', 'food',
                  'tech', 'politics', 'business', 'world', 'us', 'media'];
    if (!skip.includes(slug)) {
      return slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    }
  }

  return null;
}

// extractAuthorFromHtml, isValidAuthorName, cleanAuthorName imported from shared lib (content-quality.js)

// --- HTTP fetch with timeout ---
async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow'
    });

    clearTimeout(timer);

    if (!resp.ok) return { status: resp.status, html: null };

    const html = await resp.text();
    return { status: resp.status, html };
  } catch (e) {
    clearTimeout(timer);
    return { status: 'error', error: e.message, html: null };
  }
}

// --- File operations ---
function updateReviewFile(filePath, dir, oldFile, outletId, criticName, data) {
  // Update the data
  data.criticName = criticName;

  // Generate new filename
  const normalizedCritic = normalization.normalizeCritic(criticName);
  const normalizedOutlet = normalization.normalizeOutlet(outletId);
  const newFile = `${normalizedOutlet}--${normalizedCritic}.json`;
  const newPath = path.join(reviewsDir, dir, newFile);

  if (oldFile === newFile) {
    // Same filename, just update content
    if (!dryRun) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    }
    return { renamed: false, newFile };
  }

  // Check if target file already exists (would be a duplicate)
  if (fs.existsSync(newPath)) {
    return { renamed: false, duplicate: true, newFile };
  }

  if (!dryRun) {
    // Write to new path, delete old
    fs.writeFileSync(newPath, JSON.stringify(data, null, 2) + '\n');
    fs.unlinkSync(filePath);
  }

  return { renamed: true, newFile };
}

// --- Main ---
async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const unknowns = collectUnknowns();
  console.log(`Found ${unknowns.length} PV reviews with unknown critic`);
  if (outletFilter) console.log(`Filtering to outlet: ${outletFilter}`);
  if (dryRun) console.log('DRY RUN — no files will be modified');

  const toProcess = limit ? unknowns.slice(0, limit) : unknowns;
  console.log(`Processing ${toProcess.length} reviews\n`);

  let urlExtracted = 0;
  let httpExtracted = 0;
  let failed404 = 0;
  let failedNoAuthor = 0;
  let failedError = 0;
  let duplicatesSkipped = 0;
  let renamed = 0;
  let updated = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const u = toProcess[i];
    let critic = null;
    let method = '';

    // Step 1: URL pattern extraction
    critic = extractCriticFromUrl(u.url);
    if (critic) {
      method = 'url-pattern';
      urlExtracted++;
    }

    // Step 2: Direct HTTP fetch
    if (!critic && u.url) {
      const result = await fetchWithTimeout(u.url);

      if (result.status === 404 || result.status === 410) {
        failed404++;
        if (i < 5 || i % 200 === 0) console.log(`  [${i+1}/${toProcess.length}] 404: ${u.outletId} ${u.url.slice(0, 60)}`);
        continue;
      }

      if (result.html) {
        critic = extractAuthorFromHtml(result.html);
        if (critic) {
          method = 'http-fetch';
          httpExtracted++;
        } else {
          failedNoAuthor++;
        }
      } else {
        failedError++;
      }

      // Rate limit: 5 requests/second
      await new Promise(r => setTimeout(r, 200));
    }

    if (!critic) {
      if (i % 200 === 0) console.log(`  [${i+1}/${toProcess.length}] no author: ${u.outletId} ${u.url.slice(0, 60)}`);
      continue;
    }

    // Update file
    const result = updateReviewFile(u.filePath, u.dir, u.file, u.outletId, critic, u.data);

    if (result.duplicate) {
      duplicatesSkipped++;
      if (duplicatesSkipped <= 10) {
        console.log(`  [${i+1}] DUPE SKIP: ${u.dir}/${u.file} → ${result.newFile} already exists`);
      }
      // Delete the unknown file since the named one already exists
      if (!dryRun) {
        fs.unlinkSync(u.filePath);
      }
      continue;
    }

    if (result.renamed) {
      renamed++;
    } else {
      updated++;
    }

    if (i < 20 || i % 100 === 0) {
      const action = result.renamed ? 'RENAME' : 'UPDATE';
      console.log(`  [${i+1}] ${action} (${method}): ${u.dir}/${u.file} → ${critic}${result.renamed ? ' → ' + result.newFile : ''}`);
    }
  }

  console.log(`\n=== RESULTS ${dryRun ? '(DRY RUN)' : ''} ===`);
  console.log(`Processed: ${toProcess.length}`);
  console.log(`Critic extracted from URL: ${urlExtracted}`);
  console.log(`Critic extracted from HTTP: ${httpExtracted}`);
  console.log(`Total resolved: ${urlExtracted + httpExtracted}`);
  console.log(`Renamed files: ${renamed}`);
  console.log(`Updated in-place: ${updated}`);
  console.log(`Duplicates removed: ${duplicatesSkipped}`);
  console.log(`Failed - 404: ${failed404}`);
  console.log(`Failed - no author found: ${failedNoAuthor}`);
  console.log(`Failed - error: ${failedError}`);
  console.log(`Success rate: ${((urlExtracted + httpExtracted) / toProcess.length * 100).toFixed(1)}%`);
}

main().catch(console.error);
