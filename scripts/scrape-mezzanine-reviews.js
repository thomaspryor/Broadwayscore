#!/usr/bin/env node
/**
 * Scrape individual audience reviews from Mezzanine (theaterdiary.com) Parse API.
 *
 * This script fetches individual diary entries (ratings, text, dates) per production
 * for private data analysis. Data is NOT displayed on the site.
 *
 * Modes:
 *   --discover         Probe Parse API for the correct class name and print schema
 *   --max-productions=N  Limit to N productions (for testing)
 *   --max-requests=N   Cap total API requests (default: 15000)
 *   --resume           Resume from checkpoint
 *   --dry-run          Print what would be fetched without fetching
 *   --verbose          Print detailed progress
 *
 * Environment variables:
 *   MEZZANINE_APP_ID       - Parse Application ID (required)
 *   MEZZANINE_SESSION_TOKEN - Parse Session Token (required)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ---- CLI args ----
const args = process.argv.slice(2);
const discoverMode = args.includes('--discover');
const resumeMode = args.includes('--resume');
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const maxProdArg = args.find(a => a.startsWith('--max-productions='));
const maxProductions = maxProdArg ? parseInt(maxProdArg.split('=')[1]) : null;
const maxReqArg = args.find(a => a.startsWith('--max-requests='));
const maxRequests = maxReqArg ? parseInt(maxReqArg.split('=')[1]) : 15000;

// ---- Config ----
const APP_ID = process.env.MEZZANINE_APP_ID;
const SESSION_TOKEN = process.env.MEZZANINE_SESSION_TOKEN;

const BATCH_SIZE = 1000; // Parse max per query
const DELAY_WITHIN_PRODUCTION_MS = 500; // between paginated requests for same production
const DELAY_BETWEEN_PRODUCTIONS_MS = 2000; // between different productions
const MAX_RETRIES = 3;

// ---- Paths ----
const dataDir = path.join(__dirname, '../data');
const rawCachePath = path.join(dataDir, 'mezzanine-productions-raw.json');
const reviewsDir = path.join(dataDir, 'audience-reviews', 'mezzanine');
const indexPath = path.join(reviewsDir, '_index.json');
const checkpointPath = path.join(reviewsDir, '_checkpoint.json');

// ---- Helpers ----

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let totalRequests = 0;

function queryParse(className, body, retries = 0) {
  return new Promise((resolve, reject) => {
    totalRequests++;
    if (totalRequests > maxRequests) {
      reject(new Error(`Request cap reached (${maxRequests}). Use --max-requests to increase.`));
      return;
    }

    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.theaterdiary.com',
      path: '/parse/classes/' + className,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Parse-Application-Id': APP_ID,
        'X-Parse-Session-Token': SESSION_TOKEN,
        'Content-Length': Buffer.byteLength(data),
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', async () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error(`Authentication failed (${res.statusCode}). Session token may have expired.\nRe-intercept Mezzanine iOS app via mitmproxy to get a fresh token.`));
          return;
        }
        if (res.statusCode === 429) {
          if (retries < MAX_RETRIES) {
            const backoff = Math.min(30000 * Math.pow(2, retries), 300000);
            console.warn(`  Rate limited (429). Backing off ${backoff / 1000}s (retry ${retries + 1}/${MAX_RETRIES})...`);
            await sleep(backoff);
            totalRequests--; // don't count retries against cap
            try {
              resolve(await queryParse(className, body, retries + 1));
            } catch (e) { reject(e); }
            return;
          }
          reject(new Error('Rate limited after max retries. Try again later.'));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JSON parse error: ' + body.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(data);
    req.end();
  });
}

function queryParseGet(path_) {
  return new Promise((resolve, reject) => {
    totalRequests++;
    const req = https.request({
      hostname: 'api.theaterdiary.com',
      path: path_,
      method: 'GET',
      headers: {
        'X-Parse-Application-Id': APP_ID,
        'X-Parse-Session-Token': SESSION_TOKEN,
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body.substring(0, 500) }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---- Discovery Mode ----

async function runDiscovery() {
  console.log('Mezzanine Parse API — Class Discovery');
  console.log('======================================\n');

  // 1. Test auth
  console.log('Testing authentication...');
  try {
    const test = await queryParse('Production', { limit: 1, _method: 'GET' });
    if (test.results && test.results.length > 0) {
      console.log('  Auth OK\n');
    } else {
      console.log('  Auth OK (no results returned, but no error)\n');
    }
  } catch (e) {
    console.error('  AUTH FAILED:', e.message);
    process.exit(1);
  }

  // 2. Try schema endpoint
  console.log('Trying /parse/schemas (lists all classes)...');
  try {
    const schema = await queryParseGet('/parse/schemas');
    if (schema.status === 200 && schema.data.results) {
      console.log('  Schema endpoint accessible! Classes found:');
      for (const cls of schema.data.results) {
        const fieldCount = Object.keys(cls.fields || {}).length;
        console.log(`    ${cls.className} (${fieldCount} fields)`);
      }
      console.log('');
    } else {
      console.log(`  Schema endpoint returned ${schema.status} — not accessible (expected)\n`);
    }
  } catch (e) {
    console.log(`  Schema endpoint error: ${e.message}\n`);
  }

  // 3. Probe class names
  const classNames = ['DiaryEntry', 'Diary', 'Rating', 'Review', 'Entry', 'UserRating', 'WatchlistEntry', 'Watchlist'];
  console.log('Probing class names...');

  for (const cls of classNames) {
    try {
      const res = await queryParse(cls, { limit: 1, _method: 'GET' });
      if (res.results && res.results.length > 0) {
        console.log(`\n  ✓ ${cls} — HIT! (${res.results.length} result)`);
        console.log('  Fields found:');
        const sample = res.results[0];
        for (const [key, val] of Object.entries(sample)) {
          const type = val && val.__type ? val.__type : typeof val;
          const preview = typeof val === 'string' ? val.substring(0, 60) :
                         (val && val.__type === 'Pointer') ? `→ ${val.className}` :
                         (val && val.__type === 'Date') ? val.iso :
                         JSON.stringify(val).substring(0, 60);
          console.log(`    ${key}: (${type}) ${preview}`);
        }

        // Try to get a count
        const countRes = await queryParse(cls, { limit: 0, count: 1, _method: 'GET' });
        if (countRes.count !== undefined) {
          console.log(`\n  Total records in ${cls}: ${countRes.count.toLocaleString()}`);
        }
      } else if (res.results) {
        console.log(`  ○ ${cls} — exists but empty`);
      } else if (res.error) {
        console.log(`  ✗ ${cls} — error: ${res.error}`);
      }
    } catch (e) {
      console.log(`  ✗ ${cls} — ${e.message.split('\n')[0]}`);
    }
    await sleep(500);
  }

  console.log('\nDiscovery complete.');
}

// ---- Full Scraper ----

function filterNYCOrLondon(productions) {
  return productions.filter(p => {
    const theater = p.theater;
    if (!theater) return false;
    if (theater.isBroadway === true) return true;
    const loc = (theater.location || '').toLowerCase();
    const city = (theater.geocodedCity || '').toLowerCase();
    if (loc === 'newyork' || loc === 'nyc') return true;
    if (loc.includes('new york') || loc.includes('brooklyn') || loc.includes('manhattan')) return true;
    if (city === 'new york' || city === 'brooklyn' || city === 'manhattan') return true;
    if (loc === 'london' || city === 'london') return true;
    return false;
  });
}

async function fetchEntriesForProduction(productionId, className) {
  const allEntries = [];
  let skip = 0;

  while (true) {
    const res = await queryParse(className, {
      limit: BATCH_SIZE,
      skip,
      where: {
        production: { __type: 'Pointer', className: 'Production', objectId: productionId }
      },
      _method: 'GET',
    });

    if (!res.results || res.results.length === 0) break;
    allEntries.push(...res.results);
    skip += res.results.length;

    if (res.results.length < BATCH_SIZE) break;

    await sleep(DELAY_WITHIN_PRODUCTION_MS);
  }

  return allEntries;
}

async function runFullScrape(className) {
  console.log('Mezzanine Individual Review Scraper');
  console.log('====================================\n');
  console.log(`Class: ${className}`);
  console.log(`Max requests: ${maxRequests}`);
  if (maxProductions) console.log(`Max productions: ${maxProductions}`);
  if (dryRun) console.log('DRY RUN — no data will be saved');
  console.log('');

  // 1. Test auth
  console.log('Testing authentication...');
  try {
    await queryParse('Production', { limit: 1, _method: 'GET' });
    console.log('  Auth OK\n');
  } catch (e) {
    console.error('AUTH FAILED:', e.message);
    process.exit(1);
  }

  // 2. Load productions
  if (!fs.existsSync(rawCachePath)) {
    console.error(`Missing ${rawCachePath}. Run scrape-mezzanine-audience.js or import-mezzanine-historical.js first.`);
    process.exit(1);
  }
  const allProductions = JSON.parse(fs.readFileSync(rawCachePath, 'utf8'));
  console.log(`Loaded ${allProductions.length} cached productions`);

  // 3. Filter to NYC + London with diary entries
  let productions = filterNYCOrLondon(allProductions)
    .filter(p => (p.diaryEntriesCount || p.ratingsCount || 0) > 0);

  // Sort by entry count descending (big shows first — most valuable data)
  productions.sort((a, b) => (b.diaryEntriesCount || b.ratingsCount || 0) - (a.diaryEntriesCount || a.ratingsCount || 0));

  console.log(`Filtered to ${productions.length} NYC/London productions with entries\n`);

  // 4. Load checkpoint / index
  ensureDir(reviewsDir);
  let index = {};
  if (fs.existsSync(indexPath)) {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  }

  let checkpoint = { completedIds: [], totalRequests: 0 };
  if (resumeMode && fs.existsSync(checkpointPath)) {
    checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    console.log(`Resuming from checkpoint: ${checkpoint.completedIds.length} completed, ${checkpoint.totalRequests} requests so far`);
  }

  const completedSet = new Set(checkpoint.completedIds);

  // 5. Filter out already-completed
  productions = productions.filter(p => !completedSet.has(p.objectId));
  if (maxProductions) productions = productions.slice(0, maxProductions);
  console.log(`To process: ${productions.length} productions\n`);

  if (dryRun) {
    console.log('Would fetch entries for:');
    for (const p of productions.slice(0, 20)) {
      const name = p.show?.name || p.showName || 'Unknown';
      const count = p.diaryEntriesCount || p.ratingsCount || '?';
      console.log(`  ${name} — ${count} expected entries`);
    }
    if (productions.length > 20) console.log(`  ... and ${productions.length - 20} more`);
    return;
  }

  // 6. Scrape each production
  let fetched = 0;
  let errors = 0;
  let totalEntries = 0;
  const startTime = Date.now();

  for (let i = 0; i < productions.length; i++) {
    const p = productions[i];
    const name = p.show?.name || p.showName || 'Unknown';
    const expectedCount = p.diaryEntriesCount || p.ratingsCount || 0;

    try {
      const entries = await fetchEntriesForProduction(p.objectId, className);

      // Save per-production file
      const outFile = path.join(reviewsDir, `${p.objectId}.json`);
      const outData = {
        productionId: p.objectId,
        showName: name,
        showObjectId: p.show?.objectId || null,
        theater: p.theater?.name || '',
        theaterLocation: p.theater?.location || p.theater?.geocodedCity || '',
        isBroadway: p.theater?.isBroadway || false,
        averageRating: p.averageRating,
        expectedEntryCount: expectedCount,
        fetchedAt: new Date().toISOString(),
        totalEntries: entries.length,
        entries: entries,
      };
      fs.writeFileSync(outFile, JSON.stringify(outData, null, 2));

      // Update index
      index[p.objectId] = {
        showName: name,
        expectedCount,
        fetchedCount: entries.length,
        lastFetched: new Date().toISOString(),
        status: 'complete',
      };

      // Update checkpoint
      checkpoint.completedIds.push(p.objectId);
      checkpoint.totalRequests = totalRequests;
      fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint));
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

      fetched++;
      totalEntries += entries.length;

      const mismatch = Math.abs(entries.length - expectedCount) > 2 ? ' ⚠ MISMATCH' : '';
      if (verbose || (i + 1) % 25 === 0 || mismatch) {
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        console.log(`  [${i + 1}/${productions.length}] ${name}: ${entries.length}/${expectedCount} entries (${elapsed}min)${mismatch}`);
      }
    } catch (e) {
      errors++;
      console.error(`  ERROR [${i + 1}/${productions.length}] ${name}: ${e.message}`);

      // Save checkpoint on error
      checkpoint.totalRequests = totalRequests;
      fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint));
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

      // If it's an auth or cap error, stop entirely
      if (e.message.includes('Authentication') || e.message.includes('Request cap')) {
        console.error('\nStopping due to critical error. Use --resume to continue later.');
        break;
      }
    }

    // Rate limit between productions
    if (i < productions.length - 1) {
      await sleep(DELAY_BETWEEN_PRODUCTIONS_MS);
    }
  }

  // 7. Summary
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log('\n=== Results ===');
  console.log(`Productions fetched: ${fetched}`);
  console.log(`Total entries: ${totalEntries.toLocaleString()}`);
  console.log(`Errors: ${errors}`);
  console.log(`Total API requests: ${totalRequests}`);
  console.log(`Elapsed: ${elapsed} minutes`);
  console.log(`Data saved to: ${reviewsDir}/`);

  if (errors > 0) {
    console.log(`\n${errors} productions had errors. Use --resume to retry.`);
  }
}

// ---- Verification helpers ----

function runVerification() {
  console.log('Mezzanine Review Data Verification');
  console.log('===================================\n');

  if (!fs.existsSync(indexPath)) {
    console.error('No index file found. Run the scraper first.');
    process.exit(1);
  }

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const entries = Object.entries(index);
  let totalEntries = 0;
  let mismatches = 0;
  let ratingMismatches = 0;

  for (const [prodId, meta] of entries) {
    totalEntries += meta.fetchedCount;
    if (Math.abs(meta.fetchedCount - meta.expectedCount) > 2) {
      mismatches++;
      if (verbose) {
        console.log(`  MISMATCH ${meta.showName}: expected ${meta.expectedCount}, got ${meta.fetchedCount}`);
      }
    }

    // Cross-validate average rating
    const filePath = path.join(reviewsDir, `${prodId}.json`);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data.entries.length > 0 && data.entries[0].rating !== undefined) {
        const calcAvg = data.entries.reduce((sum, e) => sum + (e.rating || 0), 0) / data.entries.length;
        if (data.averageRating && Math.abs(calcAvg - data.averageRating) > 0.05) {
          ratingMismatches++;
          if (verbose) {
            console.log(`  RATING MISMATCH ${meta.showName}: stored ${data.averageRating}, calculated ${calcAvg.toFixed(3)}`);
          }
        }
      }
    }
  }

  console.log(`Productions indexed: ${entries.length}`);
  console.log(`Total entries: ${totalEntries.toLocaleString()}`);
  console.log(`Count mismatches: ${mismatches}`);
  console.log(`Rating mismatches: ${ratingMismatches}`);
}

// ---- Main ----

async function main() {
  if (!APP_ID) {
    console.error('Error: MEZZANINE_APP_ID environment variable must be set');
    process.exit(1);
  }
  if (!SESSION_TOKEN) {
    console.error('Error: MEZZANINE_SESSION_TOKEN environment variable must be set');
    console.error('To get a fresh token, intercept Mezzanine iOS app traffic via mitmproxy.');
    process.exit(1);
  }

  if (discoverMode) {
    await runDiscovery();
    return;
  }

  if (args.includes('--verify')) {
    runVerification();
    return;
  }

  // Default class name — update this after running --discover
  const className = args.find(a => a.startsWith('--class='))?.split('=')[1] || 'DiaryEntry';
  await runFullScrape(className);
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
