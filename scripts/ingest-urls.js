#!/usr/bin/env node
/**
 * ingest-urls.js — Manual URL ingestion for opening night reviews
 *
 * "Break glass" fallback: paste a file of review URLs, and the system
 * fetches text, detects outlets, creates review files, and optionally
 * triggers scoring + rebuild + deploy.
 *
 * Usage:
 *   node scripts/ingest-urls.js --show=dog-day-afternoon-2026 --urls=urls.txt
 *   node scripts/ingest-urls.js --show=dog-day-afternoon-2026 --urls=urls.txt --dry-run
 *   node scripts/ingest-urls.js --show=dog-day-afternoon-2026 --urls=urls.txt --no-rebuild
 *
 * URL file format: one URL per line. Blank lines and lines starting with # are skipped.
 * Optionally, append outlet ID after a space: https://example.com/review outlet-id
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { createOrMergeReviewFile } = require('./lib/review-file-writer');
const { resolveOutletFromUrl } = require('./lib/review-normalization');

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name) => {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=').slice(1).join('=') : null;
};
const hasFlag = (name) => args.includes(`--${name}`);

const showId = getArg('show');
const urlsFile = getArg('urls');
const dryRun = hasFlag('dry-run');
const noRebuild = hasFlag('no-rebuild');
const noFetch = hasFlag('no-fetch');
const defaultOutlet = getArg('default-outlet');
const verbose = hasFlag('verbose') || dryRun;

if (!showId || !urlsFile) {
  console.error('Usage: node scripts/ingest-urls.js --show=SHOW_ID --urls=FILE');
  console.error('');
  console.error('Options:');
  console.error('  --dry-run         Show what would happen without creating files');
  console.error('  --no-rebuild      Skip triggering scoring/rebuild/deploy after ingestion');
  console.error('  --no-fetch        Skip text fetching (create stub files for later collection)');
  console.error('  --default-outlet=ID  Fallback outlet ID for URLs that can\'t be auto-detected');
  console.error('  --verbose         Show detailed progress');
  console.error('');
  console.error('URL file format: one URL per line. # comments and blank lines ignored.');
  console.error('Optional: append outlet ID after space: https://example.com/review my-outlet');
  process.exit(1);
}

// Verify show exists
const showsData = require('../data/shows.json');
const show = showsData.shows.find(s => s.id === showId);
if (!show) {
  console.error(`Show not found: ${showId}`);
  console.error('Hint: check data/shows.json for the correct show ID');
  process.exit(1);
}

// Read and parse URL file
if (!fs.existsSync(urlsFile)) {
  console.error(`URL file not found: ${urlsFile}`);
  process.exit(1);
}

const rawLines = fs.readFileSync(urlsFile, 'utf8').split('\n');
const entries = rawLines
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#'))
  .map(line => {
    // Support "URL outletId" format
    const parts = line.split(/\s+/);
    return { url: parts[0], outletOverride: parts[1] || null };
  });

if (entries.length === 0) {
  console.log('No URLs found in file (blank or all comments)');
  process.exit(0);
}

console.log(`\n╔══════════════════════════════════════════════╗`);
console.log(`║  URL Ingestion${dryRun ? ' (DRY RUN)' : ''}`)
console.log(`║  Show: ${show.title} (${showId})`);
console.log(`║  URLs: ${entries.length}`);
console.log(`║  Fetch text: ${noFetch ? 'no' : 'yes'}`);
console.log(`║  Trigger rebuild: ${noRebuild ? 'no' : 'yes'}`);
console.log(`╚══════════════════════════════════════════════╝\n`);

async function main() {
  // Lazy-load fetchPage only when needed (it has heavy dependencies)
  let fetchPage;
  if (!noFetch) {
    try {
      ({ fetchPage } = require('./lib/scraper'));
    } catch (e) {
      console.warn('Warning: scraper.js not available, running in --no-fetch mode');
      fetchPage = null;
    }
  }

  const results = { created: 0, updated: 0, skipped: 0, failed: 0, warnings: [] };

  for (let i = 0; i < entries.length; i++) {
    const { url, outletOverride } = entries[i];
    const prefix = `[${i + 1}/${entries.length}]`;

    // Resolve outlet
    let outletId = outletOverride;
    let outletName = outletOverride;

    if (!outletId) {
      const resolved = resolveOutletFromUrl(url);
      if (resolved) {
        outletId = resolved.outletId;
        outletName = resolved.displayName;
      } else if (defaultOutlet) {
        outletId = defaultOutlet;
        outletName = defaultOutlet;
        results.warnings.push(`${prefix} Unknown domain for ${url} — using default outlet: ${defaultOutlet}`);
      } else {
        console.log(`${prefix} ⚠️  SKIPPED (unknown outlet): ${url}`);
        console.log(`    Hint: use "URL outlet-id" format or --default-outlet=ID`);
        results.warnings.push(`Unknown outlet: ${url}`);
        results.failed++;
        continue;
      }
    }

    if (verbose) {
      console.log(`${prefix} ${outletName} (${outletId}): ${url}`);
    }

    // Fetch text if requested
    let fullText = null;
    let fetchMethod = null;
    if (fetchPage && !noFetch) {
      try {
        if (verbose) console.log(`    Fetching text...`);
        const result = await fetchPage(url);
        if (result && result.content) {
          fullText = result.content;
          fetchMethod = result.source;
          if (verbose) console.log(`    ✓ Fetched ${fullText.length} chars via ${fetchMethod}`);
        }
      } catch (e) {
        if (verbose) console.log(`    ⚠️  Fetch failed: ${e.message}`);
        results.warnings.push(`Fetch failed for ${url}: ${e.message}`);
      }
    }

    // Create/merge review file
    const input = {
      outletId,
      outlet: outletName,
      criticName: 'Unknown', // Will be populated by collect-review-texts later
      url,
      source: 'ingest-urls',
      fields: {},
    };

    if (fullText) {
      input.fields.fullText = fullText;
      input.fields.textFetchedAt = new Date().toISOString();
      input.fields.fetchMethod = fetchMethod;
    }

    const writeResult = createOrMergeReviewFile(showId, input, { dryRun });

    if (writeResult.action === 'new') {
      results.created++;
      if (verbose) console.log(`    ✓ Created: ${path.basename(writeResult.filepath || '')}`);
    } else if (writeResult.action === 'updated') {
      results.updated++;
      if (verbose) console.log(`    ✓ Updated: ${path.basename(writeResult.filepath || '')}`);
    } else {
      results.skipped++;
      if (verbose) console.log(`    — Skipped: ${writeResult.reason || 'already exists'}`);
    }

    console.log('');
  }

  // Summary
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  RESULTS${dryRun ? ' (DRY RUN)' : ''}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Created: ${results.created}`);
  console.log(`  Updated: ${results.updated}`);
  console.log(`  Skipped: ${results.skipped}`);
  console.log(`  Failed:  ${results.failed}`);
  if (results.warnings.length) {
    console.log(`  Warnings: ${results.warnings.length}`);
    results.warnings.forEach(w => console.log(`    ⚠️  ${w}`));
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Trigger downstream pipelines
  const newReviews = results.created + results.updated;
  if (newReviews > 0 && !noRebuild && !dryRun) {
    console.log('\nTriggering downstream pipelines...');

    const workflows = [
      { name: 'LLM Ensemble Score', file: 'llm-ensemble-score.yml', args: `-f show=${showId}` },
      { name: 'Rebuild Reviews', file: 'rebuild-reviews.yml', args: `-f reason="ingest-urls: ${newReviews} reviews for ${showId}"` },
    ];

    for (const wf of workflows) {
      try {
        const cmd = `gh workflow run ${wf.file} ${wf.args}`;
        if (verbose) console.log(`  $ ${cmd}`);
        execSync(cmd, { stdio: 'pipe' });
        console.log(`  ✓ ${wf.name} triggered`);
      } catch (e) {
        console.log(`  ⚠️  ${wf.name} failed to trigger: ${e.message}`);
      }
    }

    console.log('\nMonitor with:');
    console.log(`  gh run list --workflow=llm-ensemble-score.yml --limit=1`);
    console.log(`  gh run list --workflow=rebuild-reviews.yml --limit=1`);
  } else if (newReviews > 0 && noRebuild) {
    console.log('\n--no-rebuild: skipping scoring/rebuild/deploy triggers');
    console.log('When ready, run:');
    console.log(`  gh workflow run llm-ensemble-score.yml -f show=${showId}`);
    console.log(`  gh workflow run rebuild-reviews.yml -f reason="Manual ingest for ${showId}"`);
  } else if (dryRun && newReviews > 0) {
    console.log(`\nWould trigger: scoring for ${showId}, rebuild, deploy`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
