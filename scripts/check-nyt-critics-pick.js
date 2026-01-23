#!/usr/bin/env node

/**
 * Check NYT reviews for Critics' Pick designation
 * Fetches each NYT review URL and looks for the Critics' Pick badge
 * Updates review files with designation field
 *
 * Usage:
 *   node scripts/check-nyt-critics-pick.js [--dry-run] [--show=showId]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const reviewsDir = path.join(__dirname, '../data/review-texts');

// Parse args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];

// Rate limiting
const DELAY_MS = 2000; // 2 seconds between requests to be polite

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    };

    const req = protocol.get(url, options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchPage(res.headers.location).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

function checkForCriticsPick(html) {
  // NYT Critics' Pick indicators to look for
  const indicators = [
    /critic['']?s['']?\s*pick/i,
    /criticsPick/i,
    /class="[^"]*critic[s]?-pick[^"]*"/i,
    /data-testid="[^"]*critics-pick[^"]*"/i,
    /"criticsPick"\s*:\s*true/i,
    /NYT\s+Critic['']?s\s+Pick/i,
  ];

  for (const pattern of indicators) {
    if (pattern.test(html)) {
      return true;
    }
  }

  return false;
}

async function main() {
  // Find all NYT review files
  const shows = fs.readdirSync(reviewsDir).filter(f =>
    fs.statSync(path.join(reviewsDir, f)).isDirectory()
  );

  const targetShows = showFilter ? shows.filter(s => s === showFilter) : shows;

  const nytFiles = [];
  for (const show of targetShows) {
    const showDir = path.join(reviewsDir, show);
    const files = fs.readdirSync(showDir).filter(f => f.startsWith('nytimes--'));
    for (const file of files) {
      nytFiles.push({ show, file, path: path.join(showDir, file) });
    }
  }

  console.log(`Found ${nytFiles.length} NYT review files`);
  if (dryRun) console.log('DRY RUN - no files will be modified\n');

  let checked = 0;
  let criticsPicks = 0;
  let noUrl = 0;
  let errors = 0;

  for (const { show, file, path: filePath } of nytFiles) {
    const review = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    if (!review.url || review.url === null) {
      console.log(`  ${show}/${file}: No URL - skipping`);
      noUrl++;
      continue;
    }

    // Skip if already has designation
    if (review.designation !== undefined) {
      console.log(`  ${show}/${file}: Already checked (${review.designation || 'none'})`);
      continue;
    }

    process.stdout.write(`  ${show}/${file}: `);

    try {
      const html = await fetchPage(review.url);
      const isCriticsPick = checkForCriticsPick(html);

      review.designation = isCriticsPick ? 'Critics_Pick' : null;

      if (!dryRun) {
        fs.writeFileSync(filePath, JSON.stringify(review, null, 2));
      }

      if (isCriticsPick) {
        console.log('✓ CRITICS\' PICK');
        criticsPicks++;
      } else {
        console.log('no designation');
      }

      checked++;
      await sleep(DELAY_MS);

    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      errors++;
    }
  }

  console.log('\n========================================');
  console.log(`Checked: ${checked}`);
  console.log(`Critics' Picks found: ${criticsPicks}`);
  console.log(`Skipped (no URL): ${noUrl}`);
  console.log(`Errors: ${errors}`);
}

main().catch(console.error);
