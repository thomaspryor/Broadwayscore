#!/usr/bin/env node
/**
 * Extract star ratings from WE outlet pages.
 * Fetches each review URL and runs score extraction on the HTML.
 * Only processes reviews that currently have no originalScore.
 */

const fs = require('fs');
const path = require('path');
const { extractScore } = require('./lib/score-extractors');
const { fetchPage } = require('./lib/scraper');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'archives', 'reviews');

// Outlets that DON'T use star ratings — skip them
const NO_STARS = new Set([
  'times-uk', 'financialtimes', 'variety', 'nytimes', 'nytg', 'observer',
  'washpost', 'latimes', 'hollywoodreporter', 'ap', 'deadline',
  'british-theatre', 'britishtheatreguide',  // BTG doesn't publish star ratings
]);

const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.slice(8) || '999');
const DRY_RUN = process.argv.includes('--dry-run');
const SHOW_FILTER = process.argv.find(a => a.startsWith('--show='))?.slice(7);

async function main() {
  const shows = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(d => {
      if (SHOW_FILTER) return d === SHOW_FILTER;
      return d.includes('west-end') || d.includes('off-west-end');
    })
    .filter(d => fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory());

  let processed = 0, extracted = 0, failed = 0, skipped = 0;

  for (const show of shows) {
    if (processed >= LIMIT) break;
    const showDir = path.join(REVIEW_TEXTS_DIR, show);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      if (processed >= LIMIT) break;
      const fp = path.join(showDir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }

      // Skip if already has verified score
      if (data.originalScore) { continue; }
      // Skip no-star outlets
      if (NO_STARS.has(data.outletId)) { continue; }
      // Need a URL to fetch
      if (!data.url) { continue; }

      processed++;
      const label = `${show}/${file}`;

      if (DRY_RUN) {
        console.log(`WOULD FETCH: ${label} → ${data.url}`);
        continue;
      }

      try {
        // Fetch the page
        const result0 = await fetchPage(data.url, {
          timeout: 15000,
          retries: 1,
        });
        const html = typeof result0 === 'string' ? result0 : (result0?.content || '');

        if (!html || html.length < 200) {
          console.log(`  ✗ ${label}: empty/short response`);
          failed++;
          continue;
        }

        // Extract star rating
        const result = extractScore(html, data.fullText || '', data.outletId);

        if (result && result.originalScore) {
          console.log(`  ✓ ${label}: ${result.originalScore} [${result.source}]`);
          data.originalScore = result.originalScore;
          data.originalScoreNormalized = result.normalizedScore;
          data.scoreSource = result.source;

          // Save archive
          const archDir = path.join(ARCHIVE_DIR, show);
          if (!fs.existsSync(archDir)) fs.mkdirSync(archDir, { recursive: true });
          const archFile = file.replace('.json', `_${new Date().toISOString().slice(0,10)}.html`);
          fs.writeFileSync(path.join(archDir, archFile), html);
          data.archivePath = path.join(archDir, archFile);

          fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n');
          extracted++;
        } else {
          console.log(`  - ${label}: no stars found`);
          skipped++;
        }
      } catch (err) {
        console.log(`  ✗ ${label}: ${(err.message || '').substring(0, 60)}`);
        failed++;
      }

      // Rate limiting
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Processed: ${processed}`);
  console.log(`Extracted: ${extracted}`);
  console.log(`No stars found: ${skipped}`);
  console.log(`Failed: ${failed}`);
}

main().catch(err => { console.error(err); process.exit(1); });
