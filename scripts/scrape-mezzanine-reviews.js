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
 *   --force-recheck-empty  Re-process productions that returned 0 entries (recovery from token expiry)
 *   --dry-run          Print what would be fetched without fetching
 *   --verbose          Print detailed progress
 *   --verify           Cross-validate fetched data against expected counts
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
const forceRecheckEmpty = args.includes('--force-recheck-empty');

// ---- Config ----
const APP_ID = process.env.MEZZANINE_APP_ID;
const SESSION_TOKEN = process.env.MEZZANINE_SESSION_TOKEN;

const BATCH_SIZE = 1000; // Parse max per query
const DELAY_WITHIN_PRODUCTION_MS = 500; // between paginated requests for same production
const DELAY_BETWEEN_PRODUCTIONS_MS = 2000; // between different productions
const MAX_RETRIES = 3;
const CANARY_INTERVAL = 50; // re-check auth every N productions
const PARSE_MAX_SKIP = 10000; // Parse Server hard limit on skip parameter

// ---- Paths ----
const dataDir = path.join(__dirname, '../data');
const rawCachePath = path.join(dataDir, 'mezzanine-productions-raw.json');
const reviewsDir = path.join(dataDir, 'audience-reviews', 'mezzanine');
const indexPath = path.join(reviewsDir, '_index.json');
const checkpointPath = path.join(reviewsDir, '_checkpoint.json');

// ---- Helpers ----

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const TRANSIENT_ERRORS = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'EAI_AGAIN', 'socket hang up'];

function isTransientError(err) {
  return TRANSIENT_ERRORS.some(code => err.message.includes(code)) || err.message.includes('Request timeout');
}

let totalRequests = 0;

// [FIX: P0 #2 — renamed inner 'body' to 'resBody' to avoid shadowing the request payload]
// [FIX: P0 #1 — added retry for transient network errors (ECONNRESET, timeout, etc.)]
// [FIX: P1 #16 — retry on 500/503 server errors]
function queryParse(className, requestBody, retries = 0) {
  return new Promise((resolve, reject) => {
    totalRequests++;
    if (totalRequests > maxRequests) {
      reject(new Error(`Request cap reached (${maxRequests}). Use --max-requests to increase.`));
      return;
    }

    const data = JSON.stringify(requestBody);
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
      let resBody = '';
      res.on('data', c => resBody += c);
      res.on('end', async () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error(`Authentication failed (${res.statusCode}). Session token may have expired.\nRe-intercept Mezzanine iOS app via mitmproxy to get a fresh token.`));
          return;
        }
        // Retry on 429, 500, 502, 503
        if (res.statusCode === 429 || res.statusCode >= 500) {
          if (retries < MAX_RETRIES) {
            const backoff = Math.min(30000 * Math.pow(2, retries), 300000);
            console.warn(`  Server ${res.statusCode}. Backing off ${backoff / 1000}s (retry ${retries + 1}/${MAX_RETRIES})...`);
            await sleep(backoff);
            totalRequests--;
            try {
              resolve(await queryParse(className, requestBody, retries + 1));
            } catch (e) { reject(e); }
            return;
          }
          reject(new Error(`Server error ${res.statusCode} after max retries.`));
          return;
        }
        try { resolve(JSON.parse(resBody)); }
        catch (e) { reject(new Error('JSON parse error: ' + resBody.substring(0, 200))); }
      });
    });

    // Retry transient network errors
    req.on('error', async (err) => {
      if (isTransientError(err) && retries < MAX_RETRIES) {
        const backoff = Math.min(5000 * Math.pow(2, retries), 60000);
        console.warn(`  Network error: ${err.message}. Retrying in ${backoff / 1000}s (${retries + 1}/${MAX_RETRIES})...`);
        await sleep(backoff);
        totalRequests--;
        try {
          resolve(await queryParse(className, requestBody, retries + 1));
        } catch (e) { reject(e); }
        return;
      }
      reject(err);
    });

    req.setTimeout(30000, () => { req.destroy(); });
    req.write(data);
    req.end();
  });
}

/**
 * Write JSON file atomically — write to .tmp then rename.
 * [FIX: P1 #6/#7 — prevents corrupt files on crash]
 */
function writeJsonAtomic(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
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

/**
 * Canary check: fetch a known-good production to verify auth is still valid.
 * Parse Server returns {"results": []} on expired tokens instead of 401,
 * so we must verify against a production we KNOW has entries.
 * [CHANGED: detect silent token expiry — Claude + Pre-mortem P0]
 */
let canaryProductionId = null;
let canaryExpectedMin = 0;

function setCanaryProduction(productions) {
  // Pick the production with the most entries as canary
  const best = productions.reduce((a, b) =>
    (a.diaryEntriesCount || 0) > (b.diaryEntriesCount || 0) ? a : b
  );
  canaryProductionId = best.objectId;
  canaryExpectedMin = Math.max(1, Math.floor((best.diaryEntriesCount || 1) * 0.5));
  console.log(`Canary production: ${best.show?.name || best.showName} (${best.objectId}, expect ≥${canaryExpectedMin} entries)`);
}

async function runCanaryCheck(className) {
  if (!canaryProductionId) return;
  const res = await queryParse(className, {
    limit: 1,
    where: {
      production: { __type: 'Pointer', className: 'Production', objectId: canaryProductionId }
    },
    count: 1,
    _method: 'GET',
  });
  const count = res.count !== undefined ? res.count : (res.results || []).length;
  if (count < canaryExpectedMin) {
    throw new Error(
      `CANARY FAILED: Expected ≥${canaryExpectedMin} entries for canary production, got ${count}. ` +
      `Session token has likely expired. Re-intercept via mitmproxy.`
    );
  }
  if (verbose) console.log(`  Canary check passed (${count} entries)`);
}

/**
 * Fetch all entries for a production, handling Parse's 10K skip limit
 * by using createdAt-based cursor pagination for large collections.
 * [CHANGED: handle >10K entries per production — Claude P1]
 */
async function fetchEntriesForProduction(productionId, className) {
  const allEntries = [];
  let skip = 0;
  let lastCreatedAt = null; // cursor for >10K fallback

  while (true) {
    // If we're approaching the 10K skip limit, switch to cursor-based pagination
    const where = {
      production: { __type: 'Pointer', className: 'Production', objectId: productionId }
    };

    let useSkip = skip;
    if (skip >= PARSE_MAX_SKIP && lastCreatedAt) {
      // Cursor-based: fetch entries created after the last one we saw
      // [FIX: P1 #5 — use $gte not $gt to avoid losing entries with identical timestamps]
      where.createdAt = { '$gte': { __type: 'Date', iso: lastCreatedAt } };
      useSkip = 0;
    }

    const res = await queryParse(className, {
      limit: BATCH_SIZE,
      skip: useSkip,
      where,
      order: 'createdAt', // consistent ordering for cursor pagination
      _method: 'GET',
    });

    if (!res.results || res.results.length === 0) break;

    // Deduplicate by objectId in case of overlap
    const existingIds = new Set(allEntries.map(e => e.objectId));
    const newEntries = res.results.filter(e => !existingIds.has(e.objectId));
    allEntries.push(...newEntries);

    // Track cursor for >10K fallback
    const lastEntry = res.results[res.results.length - 1];
    lastCreatedAt = lastEntry.createdAt;

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

  // Sort by most recent first — if we get cut off, we want current shows covered
  // Falls back to entry count for shows without dates
  productions.sort((a, b) => {
    const dateA = a.updatedAt || a.createdAt || '';
    const dateB = b.updatedAt || b.createdAt || '';
    if (dateA && dateB) return dateB.localeCompare(dateA); // newest first
    if (dateA) return -1;
    if (dateB) return 1;
    return (b.diaryEntriesCount || 0) - (a.diaryEntriesCount || 0); // fallback: biggest first
  });

  console.log(`Filtered to ${productions.length} NYC/London productions with entries\n`);

  // 4. Set up canary production for auth verification
  // [CHANGED: canary check to detect silent token expiry — Claude + Pre-mortem P0]
  if (productions.length > 0) {
    setCanaryProduction(productions);
  }

  // Log max diaryEntriesCount to verify 10K skip limit concern
  const maxEntries = Math.max(...productions.map(p => p.diaryEntriesCount || 0));
  console.log(`Largest production has ${maxEntries} expected entries`);
  if (maxEntries > PARSE_MAX_SKIP) {
    console.log(`  ⚠ Exceeds Parse 10K skip limit — will use cursor-based pagination`);
  }

  // 5. Load checkpoint / index
  ensureDir(reviewsDir);
  let index = {};
  if (fs.existsSync(indexPath)) {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  }

  // [CHANGED: checkpoint stores {id, fetchedCount} not just IDs — Pre-mortem P0]
  let checkpoint = { completed: {}, totalRequests: 0 };
  if (resumeMode && fs.existsSync(checkpointPath)) {
    checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    // Migrate old format (completedIds array → completed object)
    if (checkpoint.completedIds && !checkpoint.completed) {
      checkpoint.completed = {};
      for (const id of checkpoint.completedIds) {
        checkpoint.completed[id] = { fetchedCount: -1 }; // unknown from old format
      }
      delete checkpoint.completedIds;
    }
    console.log(`Resuming from checkpoint: ${Object.keys(checkpoint.completed).length} completed, ${checkpoint.totalRequests} requests so far`);
  }

  const completedSet = new Set(Object.keys(checkpoint.completed));

  // [CHANGED: --force-recheck-empty re-processes productions with 0 entries — Pre-mortem]
  if (forceRecheckEmpty) {
    let rechecked = 0;
    for (const [id, meta] of Object.entries(checkpoint.completed)) {
      if (meta.fetchedCount === 0) {
        completedSet.delete(id);
        delete checkpoint.completed[id];
        rechecked++;
      }
    }
    if (rechecked > 0) console.log(`Force-rechecking ${rechecked} productions that had 0 entries`);
  }

  // 6. Filter out already-completed
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

  // 7. Run initial canary check before starting
  // [CHANGED: canary check to detect silent token expiry — Claude + Pre-mortem P0]
  console.log('Running initial canary check...');
  try {
    await runCanaryCheck(className);
  } catch (e) {
    console.error('CANARY FAILED:', e.message);
    process.exit(1);
  }

  // 8. Set up graceful shutdown on Ctrl+C
  // [FIX: P2 #12 — save checkpoint on SIGINT instead of losing progress]
  let shuttingDown = false;
  function saveCheckpointAndExit() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n\nSIGINT received — saving checkpoint...');
    checkpoint.totalRequests = totalRequests;
    writeJsonAtomic(checkpointPath, checkpoint);
    writeJsonAtomic(indexPath, index);
    console.log(`Checkpoint saved. ${Object.keys(checkpoint.completed).length} productions completed. Use --resume to continue.`);
    process.exit(0);
  }
  process.on('SIGINT', saveCheckpointAndExit);
  process.on('SIGTERM', saveCheckpointAndExit);

  // 9. Set up log file for monitoring
  // [FIX: P2 #14 — write log to file so overnight runs can be monitored]
  const logPath = path.join(reviewsDir, '_run.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  function log(msg) {
    console.log(msg);
    logStream.write(`[${new Date().toISOString()}] ${msg}\n`);
  }

  log(`\n=== Run started at ${new Date().toISOString()} ===`);
  log(`Productions to process: ${productions.length}`);

  // 10. Scrape each production
  let fetched = 0;
  let errors = 0;
  let totalEntries = 0;
  const startTime = Date.now();

  for (let i = 0; i < productions.length; i++) {
    if (shuttingDown) break;

    const p = productions[i];
    const name = p.show?.name || p.showName || 'Unknown';
    const expectedCount = p.diaryEntriesCount || p.ratingsCount || 0;

    // Periodic canary check to detect mid-run token expiry
    if (i > 0 && i % CANARY_INTERVAL === 0) {
      try {
        await runCanaryCheck(className);
      } catch (e) {
        log(`CANARY FAILED at production ${i}: ${e.message}`);
        log('Stopping to prevent writing empty data. Use --resume to continue with a fresh token.');
        checkpoint.totalRequests = totalRequests;
        writeJsonAtomic(checkpointPath, checkpoint);
        writeJsonAtomic(indexPath, index);
        break;
      }
    }

    try {
      const entries = await fetchEntriesForProduction(p.objectId, className);

      // Warn if we got 0 entries for a production that should have them
      if (entries.length === 0 && expectedCount > 10) {
        log(`  ⚠ SUSPICIOUS: ${name} returned 0 entries but expected ${expectedCount}. Possible auth issue.`);
      }

      // Save per-production file atomically
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
      writeJsonAtomic(outFile, outData);

      // Update index (metadata only — no nested review arrays)
      index[p.objectId] = {
        showName: name,
        expectedCount,
        fetchedCount: entries.length,
        lastFetched: new Date().toISOString(),
        status: 'complete',
      };

      // Update checkpoint with fetchedCount for corruption detection
      checkpoint.completed[p.objectId] = { fetchedCount: entries.length };
      checkpoint.totalRequests = totalRequests;
      writeJsonAtomic(checkpointPath, checkpoint);
      writeJsonAtomic(indexPath, index);

      fetched++;
      totalEntries += entries.length;

      // Progress with ETA [FIX: P2 #11]
      const mismatch = Math.abs(entries.length - expectedCount) > 2 ? ' ⚠ MISMATCH' : '';
      const shouldLog = verbose || (i + 1) % 25 === 0 || mismatch;
      if (shouldLog) {
        const elapsedMin = (Date.now() - startTime) / 1000 / 60;
        const rate = fetched / elapsedMin; // productions per minute
        const remaining = productions.length - (i + 1);
        const etaMin = rate > 0 ? (remaining / rate).toFixed(0) : '?';
        const etaHrs = rate > 0 ? (remaining / rate / 60).toFixed(1) : '?';
        log(`  [${i + 1}/${productions.length}] ${name}: ${entries.length}/${expectedCount} entries | ${elapsedMin.toFixed(1)}min elapsed, ~${etaHrs}h remaining | ${totalEntries.toLocaleString()} total${mismatch}`);
      }
    } catch (e) {
      errors++;
      log(`  ERROR [${i + 1}/${productions.length}] ${name}: ${e.message}`);

      // Save checkpoint on error
      checkpoint.totalRequests = totalRequests;
      writeJsonAtomic(checkpointPath, checkpoint);
      writeJsonAtomic(indexPath, index);

      // If it's an auth, canary, or cap error, stop entirely
      if (e.message.includes('Authentication') || e.message.includes('Request cap') || e.message.includes('CANARY')) {
        log('Stopping due to critical error. Use --resume to continue later.');
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
