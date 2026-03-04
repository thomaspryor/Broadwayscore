#!/usr/bin/env node
/**
 * Re-collect review HTML from outlet websites to extract explicit scores.
 *
 * Targets reviews that have a URL but no originalScore, for outlets with
 * dedicated score extractors. Fetches the URL, runs the extractor on
 * the raw HTML, and updates the review file if a score is found.
 *
 * Usage:
 *   node scripts/recollect-for-scores.js --outlet=timeout [--limit=5] [--execute] [--delay=2000]
 *
 * Options:
 *   --outlet=X   Required. Outlet ID to re-collect for
 *   --limit=N    Process at most N reviews (default: 5 for safety)
 *   --execute    Actually write changes (default: dry run that still fetches)
 *   --delay=N    Delay between requests in ms (default: 2000)
 *   --dry-run    Don't fetch, just list targets
 */

const fs = require('fs');
const path = require('path');
const { extractScore, OUTLET_EXTRACTORS } = require('./lib/score-extractors');

const REVIEW_DIR = path.join(__dirname, '..', 'data', 'review-texts');

// Parse args
const args = process.argv.slice(2);
const outletArg = args.find(a => a.startsWith('--outlet='));
const limitArg = args.find(a => a.startsWith('--limit='));
const delayArg = args.find(a => a.startsWith('--delay='));
const execute = args.includes('--execute');
const dryRun = args.includes('--dry-run');
const outlet = outletArg ? outletArg.split('=')[1] : null;
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 5;
const delay = delayArg ? parseInt(delayArg.split('=')[1]) : 2000;

if (!outlet) {
  console.error('Usage: node scripts/recollect-for-scores.js --outlet=timeout [--limit=5] [--execute]');
  process.exit(1);
}

if (!OUTLET_EXTRACTORS[outlet]) {
  console.error(`No extractor for outlet "${outlet}". Available outlets with extractors:`);
  const available = Object.keys(OUTLET_EXTRACTORS).filter(k =>
    OUTLET_EXTRACTORS[k] && OUTLET_EXTRACTORS[k].name !== 'noScoreExtractor'
  ).sort();
  console.error(available.join(', '));
  process.exit(1);
}

// Dynamically import the scraper
let fetchUrl;

async function initScraper() {
  // Use a simple fetch approach - the scraper module is complex, let's use playwright directly
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  fetchUrl = async (url) => {
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000); // Let JS render
      const html = await page.content();
      return html;
    } finally {
      await page.close();
    }
  };

  return { browser, context };
}

async function main() {
  console.log(`\n=== Re-collect for Scores: ${outlet} ===`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (listing only)' : execute ? 'EXECUTING' : 'FETCH + PREVIEW (no writes)'}`);
  console.log(`Limit: ${limit} | Delay: ${delay}ms\n`);

  // Find targets
  const showDirs = fs.readdirSync(REVIEW_DIR).filter(d =>
    fs.statSync(path.join(REVIEW_DIR, d)).isDirectory()
  );

  const targets = [];
  for (const dir of showDirs) {
    const files = fs.readdirSync(path.join(REVIEW_DIR, dir))
      .filter(f => f.startsWith(outlet + '--') && f.endsWith('.json'));

    for (const file of files) {
      const fp = path.join(REVIEW_DIR, dir, file);
      try {
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (data.originalScore) continue; // Already has score
        if (!data.url) continue; // No URL to fetch
        targets.push({ dir, file, fp, url: data.url, data });
      } catch (e) { /* skip */ }
    }
  }

  console.log(`Found ${targets.length} reviews without originalScore`);
  const toProcess = targets.slice(0, limit);
  console.log(`Processing ${toProcess.length} of ${targets.length}\n`);

  if (dryRun) {
    toProcess.forEach(t => console.log(`  ${t.dir}/${t.file}: ${t.url}`));
    console.log(`\nUse without --dry-run to fetch and extract.`);
    return;
  }

  // Init browser
  const { browser } = await initScraper();

  let extracted = 0, failed = 0, errors = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const t = toProcess[i];
    const progress = `[${i + 1}/${toProcess.length}]`;

    try {
      console.log(`${progress} Fetching: ${t.dir}/${t.file}`);
      console.log(`  URL: ${t.url}`);

      const html = await fetchUrl(t.url);
      console.log(`  HTML: ${html.length} chars`);

      const result = extractScore(html, t.data.fullText || '', outlet);

      if (result && result.originalScore) {
        extracted++;
        console.log(`  FOUND: ${result.originalScore} → ${result.normalizedScore}`);

        if (execute) {
          t.data.originalScore = result.originalScore;
          t.data.originalScoreNormalized = result.normalizedScore;
          t.data._scoreNote = `Re-collected for score extraction (${new Date().toISOString().split('T')[0]})`;
          // Also store the HTML for archiving
          if (!t.data.htmlContent && html.length > 1000) {
            // Save archive
            const archiveDir = path.join(__dirname, '..', 'data', 'archives', 'reviews', t.dir);
            fs.mkdirSync(archiveDir, { recursive: true });
            const archiveFile = `${outlet}--${t.file.split('--')[1].replace('.json', '')}_${new Date().toISOString().split('T')[0]}.html`;
            fs.writeFileSync(path.join(archiveDir, archiveFile), html);
            t.data.archivePath = `data/archives/reviews/${t.dir}/${archiveFile}`;
          }
          fs.writeFileSync(t.fp, JSON.stringify(t.data, null, 2) + '\n');
        }
      } else {
        failed++;
        console.log(`  NO SCORE FOUND in HTML`);
      }
    } catch (e) {
      errors++;
      console.log(`  ERROR: ${e.message}`);
    }

    // Rate limit
    if (i < toProcess.length - 1) {
      await new Promise(r => setTimeout(r, delay));
    }
  }

  await browser.close();

  console.log(`\n=== SUMMARY ===`);
  console.log(`Extracted: ${extracted} | No score: ${failed} | Errors: ${errors}`);
  if (!execute) {
    console.log('\nPreview mode — no changes written. Use --execute to apply.');
  } else {
    console.log(`\n${extracted} scores extracted. Run rebuild next.`);
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
