#!/usr/bin/env node
/**
 * Backfill unknown outlets and critics across ALL review sources.
 *
 * Phase A: Outlet resolution (local, no HTTP) — resolves "unknown" outletId from URL domain
 * Phase B: Critic enrichment (HTTP fetch) — extracts author from review page HTML
 *
 * Usage:
 *   node scripts/backfill-unknown-critics.js [options]
 *
 * Options:
 *   --dry-run         Show what would change without modifying files
 *   --limit=N         Process at most N files per phase
 *   --outlets-only    Run only Phase A (outlet resolution)
 *   --critics-only    Run only Phase B (critic enrichment)
 *   --skip-http       Skip HTTP fetches in Phase B (only use existing extractedByline)
 *   --source=X        Filter to specific source (e.g., playbill-verdict, showscore)
 *   --show=X          Filter to specific show directory
 */

const fs = require('fs');
const path = require('path');
const { safeWriteReview, shouldSkipLockedEnrichment } = require('./lib/review-write-guard');

let lockedSkipCount = 0;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const outletsOnly = args.includes('--outlets-only');
const criticsOnly = args.includes('--critics-only');
const skipHttp = args.includes('--skip-http');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 0;
const sourceArg = args.find(a => a.startsWith('--source='));
const sourceFilter = sourceArg ? sourceArg.split('=')[1] : null;
const showArg = args.find(a => a.startsWith('--show='));
const showFilter = showArg ? showArg.split('=')[1] : null;

const reviewsDir = 'data/review-texts';
const normalization = require('./lib/review-normalization');
const { extractAuthorFromHtml, isValidAuthorName, cleanAuthorName } = require('./lib/content-quality');
const { resolveOutletFromUrl, getOutletDisplayName } = require('./lib/review-normalization');
const { fetchPage, cleanup: cleanupScraper } = require('./lib/scraper');

// --- Names that are NOT theater critics (outlet names, wire service labels, etc.) ---
const REJECT_NAMES = new Set([
  'condé nast', 'conde nast', 'the associated press', 'associated press',
  'ap', 'reuters', 'staff', 'staff writer', 'editorial', 'editor',
  'admin', 'administrator', 'contributor', 'guest', 'anonymous',
  'broadway world', 'broadwayworld', 'broadway.com', 'playbill',
  'the new yorker', 'the guardian', 'variety', 'the wrap',
  'the hollywood reporter', 'the daily beast', 'entertainment weekly',
  'ny1', 'time out', 'timeout', 'new york times', 'the new york times',
  'bww news desk', 'broadway news desk', 'news desk',
  'financial times', 'the stage', 'the playlist', 'the reviews hub',
]);

function isRejectName(name) {
  if (!name || name.length < 4) return true;
  if (REJECT_NAMES.has(name.toLowerCase())) return true;
  if (/^(the |a |an )/i.test(name) && !name.includes(' ')) return true;
  if (name.includes(',') && name.split(',').length > 2) return true;
  if (/\band\b/i.test(name) && name.split(/\band\b/i).length > 2) return true;
  if (name.includes('http') || name.includes('.com')) return true;
  if (name === name.toUpperCase() && name.length > 5) return true;
  if (name === name.toLowerCase()) return true;
  if (/^(reviewed by|written by|by |photo |image |credit)/i.test(name)) return true;
  if (/^(staff|desk|team|wire|bureau|press|agency|service)/i.test(name)) return true;
  if (/^(updated|originally|published|posted|modified|created)\s/i.test(name)) return true;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s/i.test(name)) return true;
  if (!name.includes(' ')) return true;
  return false;
}

// --- Scan all review files ---
function scanReviewFiles() {
  const dirs = fs.readdirSync(reviewsDir).filter(d => {
    if (showFilter && d !== showFilter) return false;
    try { return fs.statSync(path.join(reviewsDir, d)).isDirectory(); } catch { return false; }
  });

  const unknownOutlets = [];
  const unknownCritics = [];

  for (const d of dirs) {
    const files = fs.readdirSync(path.join(reviewsDir, d)).filter(f =>
      f.endsWith('.json') && f !== 'failed-fetches.json'
    );
    for (const f of files) {
      try {
        const filePath = path.join(reviewsDir, d, f);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        if (sourceFilter && data.source !== sourceFilter) continue;

        const entry = { dir: d, file: f, filePath, outletId: data.outletId, url: data.url || '', data };

        if ((!data.outletId || data.outletId === 'unknown') && data.url) {
          unknownOutlets.push(entry);
        }

        if ((!data.criticName || data.criticName === 'Unknown') && data.url) {
          unknownCritics.push(entry);
        }
      } catch {}
    }
  }

  return { unknownOutlets, unknownCritics };
}

// --- HTTP fetch via scraper infrastructure (Bright Data → ScrapingBee → Playwright) ---
async function fetchHtml(url) {
  try {
    const result = await fetchPage(url);
    if (result && result.content && result.content.length > 100) {
      return { html: result.content };
    }
    return { html: null };
  } catch (e) {
    return { html: null, error: e.message };
  }
}

// --- Update file and optionally rename ---
// Joe Turner postmortem P0 #2 (2026-04-26): criticName + outletId are
// non-PROTECTED — safeWriteReview's lockedOverride does not block them.
// shouldSkipLockedEnrichment short-circuits the whole update on locked files
// so a manually-canonical record can't have its byline silently rewritten by
// HTML extraction or domain re-aliasing.
function updateReviewFile(filePath, dir, oldFile, outletId, criticName, data) {
  const skip = shouldSkipLockedEnrichment(data);
  if (skip.skip) {
    lockedSkipCount++;
    return { renamed: false, lockedSkipped: true };
  }

  if (criticName) data.criticName = criticName;
  if (outletId && typeof outletId === 'string' && outletId !== data.outletId) {
    data.outletId = outletId;
    data.outlet = getOutletDisplayName(outletId) || outletId;
  }

  const crit = typeof data.criticName === 'string' ? data.criticName : 'unknown';
  const out = typeof data.outletId === 'string' ? data.outletId : 'unknown';
  const normalizedCritic = normalization.normalizeCritic(crit);
  const normalizedOutlet = normalization.normalizeOutlet(out);
  const newFile = `${normalizedOutlet}--${normalizedCritic}.json`;
  const newPath = path.join(reviewsDir, dir, newFile);

  if (oldFile === newFile) {
    if (!dryRun) {
      const r = safeWriteReview(filePath, data);
      if (r.lockedSkipped) lockedSkipCount++;
    }
    return { renamed: false, newFile };
  }

  if (fs.existsSync(newPath)) {
    return { renamed: false, duplicate: true, newFile };
  }

  if (!dryRun) {
    // TOPOLOGY: rename paths do not honor _locked — see S1-T5.
    // Stop-gap (ship-check P0 2026-04-26): the source is already gated by
    // shouldSkipLockedEnrichment at function entry. The newPath collision
    // is caught above by `if (fs.existsSync(newPath))`. This guard covers
    // the case where another writer created a locked file at newPath
    // between the existsSync check and our rename (TOCTOU narrow window).
    if (fs.existsSync(newPath)) {
      try {
        const targetData = JSON.parse(fs.readFileSync(newPath, 'utf8'));
        if (targetData._locked === true) {
          lockedSkipCount++;
          return { renamed: false, lockedSkipped: true };
        }
      } catch { /* corrupt target — fall through */ }
    }
    fs.writeFileSync(newPath, JSON.stringify(data, null, 2) + '\n');
    fs.unlinkSync(filePath);
  }

  return { renamed: true, newFile };
}

module.exports = { updateReviewFile };

// --- Phase A: Outlet resolution (local, no HTTP) ---
function phaseA(unknownOutlets) {
  console.log('\n=== PHASE A: Outlet Resolution (local) ===');
  const toProcess = limit ? unknownOutlets.slice(0, limit) : unknownOutlets;
  console.log(`Found ${unknownOutlets.length} files with unknown outlet, processing ${toProcess.length}`);

  let resolved = 0;
  let duplicatesRemoved = 0;
  let renamed = 0;
  let noMatch = 0;
  const unresolvedDomains = new Map(); // domain → count

  for (let i = 0; i < toProcess.length; i++) {
    const u = toProcess[i];
    const urlResult = resolveOutletFromUrl(u.url);
    const newOutletId = urlResult ? urlResult.outletId : null;

    if (!newOutletId) {
      noMatch++;
      try {
        const hostname = new URL(u.url).hostname.replace(/^www\./, '');
        unresolvedDomains.set(hostname, (unresolvedDomains.get(hostname) || 0) + 1);
      } catch {}
      continue;
    }

    const fileResult = updateReviewFile(u.filePath, u.dir, u.file, newOutletId, null, u.data);
    resolved++;

    if (fileResult.duplicate) {
      duplicatesRemoved++;
      if (!dryRun) fs.unlinkSync(u.filePath);
      if (duplicatesRemoved <= 10) {
        console.log(`  [${i+1}] DUPE: ${u.dir}/${u.file} → ${fileResult.newFile} already exists`);
      }
      continue;
    }

    if (fileResult.renamed) renamed++;

    if (i < 20 || i % 100 === 0) {
      console.log(`  [${i+1}] ${fileResult.renamed ? 'RENAME' : 'UPDATE'}: ${u.dir}/${u.file} → ${newOutletId}`);
    }
  }

  console.log(`\nPhase A Results${dryRun ? ' (DRY RUN)' : ''}:`);
  console.log(`  Resolved: ${resolved}`);
  console.log(`  Renamed: ${renamed}`);
  console.log(`  Duplicates removed: ${duplicatesRemoved}`);
  console.log(`  No match: ${noMatch}`);

  if (unresolvedDomains.size > 0) {
    const sorted = Array.from(unresolvedDomains.entries()).sort((a, b) => b[1] - a[1]);
    console.log(`\n  Unresolved domains (add to outlet-registry.json):`);
    for (const [domain, count] of sorted.slice(0, 20)) {
      console.log(`    ${domain}: ${count} files`);
    }
  }

  return { resolved, renamed, duplicatesRemoved, noMatch, unresolvedDomains };
}

// --- Phase B: Critic enrichment (HTTP fetch) ---
async function phaseB(unknownCritics) {
  console.log('\n=== PHASE B: Critic Enrichment ===');
  const toProcess = limit ? unknownCritics.slice(0, limit) : unknownCritics;
  console.log(`Found ${unknownCritics.length} files with unknown critic, processing ${toProcess.length}`);

  let bylineResolved = 0;
  let httpResolved = 0;
  let failedNoAuthor = 0;
  let failedError = 0;
  let duplicatesRemoved = 0;
  let renamed = 0;
  let skippedNoUrl = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const u = toProcess[i];
    let critic = null;
    let method = '';

    // Strategy 1: Use existing extractedByline from source file
    if (u.data.extractedByline && u.data.extractedByline !== 'Unknown' && !isRejectName(u.data.extractedByline)) {
      critic = u.data.extractedByline;
      method = 'extractedByline';
      bylineResolved++;
    }

    // Strategy 2: Fetch HTML via scraper infrastructure (Bright Data → ScrapingBee → Playwright)
    if (!critic && !skipHttp && u.url) {
      const result = await fetchHtml(u.url);

      if (result.html) {
        critic = extractAuthorFromHtml(result.html);
        if (critic && isRejectName(critic)) {
          critic = null; // Reject outlet names, metadata artifacts, etc.
        }
        if (critic) {
          method = 'http-fetch';
          httpResolved++;
        } else {
          failedNoAuthor++;
        }
      } else {
        failedError++;
      }

      // Rate limit: 1 request/second (scraper infrastructure is heavier than bare fetch)
      await new Promise(r => setTimeout(r, 1000));
    } else if (!critic && skipHttp) {
      skippedNoUrl++;
      continue;
    }

    if (!critic) {
      if (i < 5 || i % 200 === 0) {
        console.log(`  [${i+1}/${toProcess.length}] no author: ${u.outletId} ${u.url.slice(0, 60)}`);
      }
      continue;
    }

    // Store provenance
    if (method === 'http-fetch') {
      u.data.criticEnrichedFrom = 'html-extraction';
    }

    // Update file
    const result = updateReviewFile(u.filePath, u.dir, u.file, null, critic, u.data);

    if (result.duplicate) {
      duplicatesRemoved++;
      if (!dryRun) fs.unlinkSync(u.filePath);
      if (duplicatesRemoved <= 10) {
        console.log(`  [${i+1}] DUPE: ${u.dir}/${u.file} → ${result.newFile} already exists`);
      }
      continue;
    }

    if (result.renamed) renamed++;

    if (i < 20 || i % 100 === 0) {
      const action = result.renamed ? 'RENAME' : 'UPDATE';
      console.log(`  [${i+1}] ${action} (${method}): ${u.dir}/${u.file} → ${critic}`);
    }

    // Checkpoint every 50 files
    if (!dryRun && (bylineResolved + httpResolved) % 50 === 0 && (bylineResolved + httpResolved) > 0) {
      console.log(`  ... checkpoint: ${bylineResolved + httpResolved} resolved so far`);
    }
  }

  const totalResolved = bylineResolved + httpResolved;
  console.log(`\nPhase B Results${dryRun ? ' (DRY RUN)' : ''}:`);
  console.log(`  From extractedByline: ${bylineResolved}`);
  console.log(`  From HTTP fetch: ${httpResolved}`);
  console.log(`  Total resolved: ${totalResolved}`);
  console.log(`  Renamed: ${renamed}`);
  console.log(`  Duplicates removed: ${duplicatesRemoved}`);
  console.log(`  Failed - no author: ${failedNoAuthor}`);
  console.log(`  Failed - error: ${failedError}`);
  if (skippedNoUrl) console.log(`  Skipped (--skip-http): ${skippedNoUrl}`);
  if (toProcess.length > 0) {
    console.log(`  Success rate: ${(totalResolved / toProcess.length * 100).toFixed(1)}%`);
  }

  return { bylineResolved, httpResolved, totalResolved, renamed, duplicatesRemoved };
}

// --- Main ---
async function main() {
  console.log('Scanning review files...');
  const { unknownOutlets, unknownCritics } = scanReviewFiles();
  console.log(`Unknown outlets: ${unknownOutlets.length} files`);
  console.log(`Unknown critics: ${unknownCritics.length} files`);

  if (dryRun) console.log('DRY RUN — no files will be modified');
  if (sourceFilter) console.log(`Source filter: ${sourceFilter}`);
  if (showFilter) console.log(`Show filter: ${showFilter}`);

  if (!criticsOnly) {
    phaseA(unknownOutlets);
  }

  if (!outletsOnly) {
    await phaseB(unknownCritics);
  }

  await cleanupScraper();
  console.log('\nDone.');
}

if (require.main === module) {
  main()
    .then(() => console.log(`[LOCKED-SKIP-COUNT] backfill-unknown-critics: ${lockedSkipCount}`))
    .catch(console.error);
}
