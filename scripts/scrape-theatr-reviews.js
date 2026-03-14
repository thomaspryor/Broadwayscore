#!/usr/bin/env node
/**
 * Scrape individual audience comments from Theatr (theatr-app.com) API.
 *
 * Uses POST /comments/query to fetch user comments per show.
 * Data is for private analysis only — not displayed on the site.
 *
 * Modes:
 *   (default)          Scrape all show comments via /comments/query
 *   --discover         Probe API for additional endpoints
 *   --max-shows=N      Limit to N shows (for testing)
 *   --max-requests=N   Cap total API requests (default: 5000)
 *   --resume           Resume from checkpoint
 *   --dry-run          Print what would be fetched without fetching
 *   --verbose          Print detailed progress
 *
 * Environment variables:
 *   THEATR_REFRESH_TOKEN  - Theatr refresh token (required, rotates on use)
 *   THEATR_ACCESS_TOKEN   - Direct access token (alternative to refresh token)
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
const maxShowsArg = args.find(a => a.startsWith('--max-shows='));
const maxShows = maxShowsArg ? parseInt(maxShowsArg.split('=')[1]) : null;
const maxReqArg = args.find(a => a.startsWith('--max-requests='));
const maxRequests = maxReqArg ? parseInt(maxReqArg.split('=')[1]) : 5000;

// ---- Config ----
const USER_AGENT = 'Theatr/184 CFNetwork/3860.400.51 Darwin/25.3.0';
const DELAY_BETWEEN_REQUESTS_MS = 3000; // conservative — 3s between requests
const MAX_RETRIES = 3;

// ---- Paths ----
const dataDir = path.join(__dirname, '../data');
const tokenPath = path.join(dataDir, 'theatr-refresh-token.tmp');
const reviewsDir = path.join(dataDir, 'audience-reviews', 'theatr');
const indexPath = path.join(reviewsDir, '_index.json');
const checkpointPath = path.join(reviewsDir, '_checkpoint.json');
const discoveryLogPath = path.join(reviewsDir, '_discovery.json');

// ---- Helpers ----

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

let totalRequests = 0;

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    totalRequests++;
    if (totalRequests > maxRequests) {
      reject(new Error(`Request cap reached (${maxRequests}). Use --max-requests to increase.`));
      return;
    }

    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'content-type': 'application/json',
        'accept': '*/*',
        'user-agent': USER_AGENT,
        ...options.headers,
      },
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); }
        catch { parsed = data.substring(0, 500); }
        resolve({ status: res.statusCode, data: parsed });
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// ---- Auth ----

let accessToken = null;
let latestRefreshToken = null;

async function refreshAccessToken() {
  if (process.env.THEATR_ACCESS_TOKEN) {
    accessToken = process.env.THEATR_ACCESS_TOKEN;
    console.log('  Using direct access token from THEATR_ACCESS_TOKEN');
    return;
  }

  const refreshToken = latestRefreshToken || process.env.THEATR_REFRESH_TOKEN ||
    (fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf8').trim() : null);

  if (!refreshToken) {
    throw new Error('THEATR_REFRESH_TOKEN or THEATR_ACCESS_TOKEN environment variable must be set');
  }

  const { status, data } = await httpsRequest('https://appapi.theatr-app.com/v1/auth/access-tokens', {
    method: 'POST',
    body: { refreshToken },
  });

  if (!data.success) {
    throw new Error(`Auth refresh failed: ${JSON.stringify(data)}`);
  }

  accessToken = data.content.accessToken;
  latestRefreshToken = data.content.refreshToken;
  console.log('  Access token refreshed');

  // Persist new refresh token immediately
  fs.writeFileSync(tokenPath, latestRefreshToken);
}

function authHeaders() {
  return { authorization: `Bearer ${accessToken}` };
}

// ---- Discovery Mode ----

async function runDiscovery() {
  console.log('Theatr API — Endpoint Discovery');
  console.log('================================\n');

  // 1. Auth
  console.log('Refreshing access token...');
  await refreshAccessToken();

  // 2. Get a popular show ID to test with
  console.log('\nFetching shows to find a test ID...');
  const { data: showsData } = await httpsRequest('https://appapi.theatr-app.com/shows/query', {
    method: 'POST',
    headers: authHeaders(),
    body: {
      filters: [{ field: 'genreCategory', op: '==', value: 'Theatre' }],
      orderBy: [{ field: 'totalWatchedUsers', direction: 'desc' }],
      pageSize: 5,
    },
  });

  if (!showsData.success || !showsData.content.records.length) {
    console.error('Could not fetch shows. Auth may have failed.');
    process.exit(1);
  }

  const testShow = showsData.content.records[0];
  console.log(`Using test show: "${testShow.name}" (id: ${testShow.id})`);

  // Log all fields from the show object
  console.log('\nShow object fields:');
  for (const [key, val] of Object.entries(testShow)) {
    const preview = typeof val === 'string' ? val.substring(0, 80) :
                   typeof val === 'object' ? JSON.stringify(val).substring(0, 80) :
                   val;
    console.log(`  ${key}: ${preview}`);
  }

  // 3. Probe endpoints
  // [CHANGED: reduced from 20+ to ~12 most likely endpoints — GPT-4o]
  const endpoints = [
    // Show-level endpoints (most likely based on REST conventions)
    `/shows/${testShow.id}/reviews`,
    `/shows/${testShow.id}/reactions`,
    `/shows/${testShow.id}/comments`,
    `/shows/${testShow.id}/feed`,
    // V1 variants
    `/v1/shows/${testShow.id}/reviews`,
    `/v1/shows/${testShow.id}/reactions`,
    `/v1/shows/${testShow.id}/feed`,
    // Show detail (might embed review data)
    `/shows/${testShow.id}`,
    `/v1/shows/${testShow.id}`,
    // Alternate naming patterns
    `/show-reactions/${testShow.id}`,
    `/show-reviews/${testShow.id}`,
    `/show-comments/${testShow.id}`,
  ];

  console.log(`\nProbing ${endpoints.length} potential endpoints...\n`);

  const results = [];

  for (const endpoint of endpoints) {
    const url = `https://appapi.theatr-app.com${endpoint}`;
    try {
      const { status, data } = await httpsRequest(url, { headers: authHeaders() });

      const hasData = status === 200 && data && (data.success || (typeof data === 'object' && !data.error));
      const symbol = status === 200 ? '✓' : status === 404 ? '✗' : '?';

      console.log(`  ${symbol} ${status} ${endpoint}`);

      if (status === 200 && verbose) {
        const preview = typeof data === 'string' ? data.substring(0, 200) : JSON.stringify(data).substring(0, 200);
        console.log(`    Response: ${preview}`);
      }

      results.push({ endpoint, status, hasData, sample: status === 200 ? data : null });

      // Also try POST for some endpoints
      if (status === 404 || status === 405) {
        const postUrl = url;
        try {
          const postRes = await httpsRequest(postUrl, {
            method: 'POST',
            headers: authHeaders(),
            body: { showId: testShow.id, pageSize: 10 },
          });
          if (postRes.status === 200) {
            console.log(`  ✓ ${postRes.status} POST ${endpoint}`);
            results.push({ endpoint: `POST ${endpoint}`, status: postRes.status, hasData: true, sample: postRes.data });
          }
        } catch { /* ignore POST failures */ }
      }
    } catch (e) {
      console.log(`  ! ERROR ${endpoint}: ${e.message}`);
      results.push({ endpoint, status: 'error', error: e.message });
    }

    await sleep(1000); // 1s between probes
  }

  // 4. Save discovery results
  ensureDir(reviewsDir);
  fs.writeFileSync(discoveryLogPath, JSON.stringify({
    testShow: { id: testShow.id, name: testShow.name },
    discoveredAt: new Date().toISOString(),
    results: results.filter(r => r.status === 200),
    allResults: results,
  }, null, 2));

  // 5. Summary
  const hits = results.filter(r => r.status === 200);
  console.log(`\n=== Discovery Summary ===`);
  console.log(`Endpoints probed: ${endpoints.length}`);
  console.log(`200 OK responses: ${hits.length}`);

  if (hits.length > 0) {
    console.log('\nWorking endpoints:');
    for (const h of hits) {
      const preview = h.sample ? JSON.stringify(h.sample).substring(0, 150) : '';
      console.log(`  ${h.endpoint}: ${preview}`);
    }
    console.log(`\nFull results saved to: ${discoveryLogPath}`);
  } else {
    console.log('\nNo individual review endpoints found.');
    console.log('Theatr likely only stores aggregate sentiment (like/dislike/mixed counts).');
    console.log('Individual reviews may not exist as queryable resources.');
  }
}

// ---- Comments Scraper via POST /comments/query ----

/**
 * Fetch all comments for a show using POST /comments/query
 * The API uses body-based filtering (not URL path), with pagination via `current` (1-indexed).
 */
async function fetchShowComments(showId) {
  const allComments = [];
  let page = 1;
  const pageSize = 50;
  const MAX_PAGES = 100; // safety limit — no show should have 5000+ comments

  while (page <= MAX_PAGES) {
    const { status, data } = await httpsRequest('https://appapi.theatr-app.com/comments/query', {
      method: 'POST',
      headers: authHeaders(),
      body: {
        filters: [
          { field: 'showId', op: '==', value: showId },
          { field: 'rootId', op: '==', value: '' },
        ],
        orderBy: [{ field: 'uploadedAt', direction: 'desc' }],
        pageSize,
        current: page,
      },
    });

    if (status !== 200) {
      if (verbose) console.log(`    Page ${page} returned ${status}, stopping`);
      break;
    }

    // Parse response — try all possible shapes
    const content = data.content || data;
    const records = content.records || content.data || content.comments || content.items || [];

    if (verbose && page === 1) {
      // Log response shape on first page to debug pagination
      const keys = Object.keys(content);
      console.log(`    Response keys: ${keys.join(', ')} | records: ${records.length} | total: ${content.total || '?'}`);
    }

    if (!Array.isArray(records) || records.length === 0) break;

    allComments.push(...records);

    // Stop conditions: got fewer than pageSize, or reached total
    if (records.length < pageSize) break;
    if (content.total && allComments.length >= content.total) break;

    page++;
    await sleep(DELAY_BETWEEN_REQUESTS_MS);
  }

  if (page > MAX_PAGES) {
    console.warn(`    Hit MAX_PAGES (${MAX_PAGES}) for show ${showId} — may have more comments`);
  }

  return allComments;
}

/**
 * Write JSON file atomically
 */
function writeJsonAtomic(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

async function runFullScrape() {
  console.log('Theatr Comment Scraper');
  console.log('======================\n');
  console.log(`Max requests: ${maxRequests}`);
  if (maxShows) console.log(`Max shows: ${maxShows}`);
  console.log('');

  // 1. Auth
  console.log('Refreshing access token...');
  await refreshAccessToken();

  // 2. Test comments endpoint with a quick probe
  console.log('Testing /comments/query endpoint...');
  const { status: testStatus, data: testData } = await httpsRequest('https://appapi.theatr-app.com/comments/query', {
    method: 'POST',
    headers: authHeaders(),
    body: {
      filters: [
        { field: 'showId', op: '==', value: 'ZtXH4K6KAnrR6Map97PB' }, // Hamilton (popular)
        { field: 'rootId', op: '==', value: '' },
      ],
      orderBy: [{ field: 'uploadedAt', direction: 'desc' }],
      pageSize: 1,
      current: 1,
    },
  });
  if (testStatus !== 200) {
    console.error(`Comments endpoint returned ${testStatus}. Aborting.`);
    process.exit(1);
  }
  const testRecords = testData.content?.records || testData.content?.data || [];
  console.log(`  Endpoint works! Sample comment: "${(testRecords[0]?.text || '').substring(0, 80)}..."\n`);

  // 3. Fetch all shows
  console.log('Fetching all Theatr shows...');
  const { data: showsResp } = await httpsRequest('https://appapi.theatr-app.com/shows/query', {
    method: 'POST',
    headers: authHeaders(),
    body: {
      filters: [{ field: 'genreCategory', op: '==', value: 'Theatre' }],
      orderBy: [{ field: 'totalWatchedUsers', direction: 'desc' }],
      pageSize: 9999,
    },
  });

  if (!showsResp.success) {
    console.error('Failed to fetch shows');
    process.exit(1);
  }

  let shows = showsResp.content.records;
  console.log(`Fetched ${shows.length} shows`);

  // 4. Load checkpoint
  ensureDir(reviewsDir);
  let checkpoint = { completed: {}, totalRequests: 0 };
  if (resumeMode && fs.existsSync(checkpointPath)) {
    checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    // Migrate old format
    if (checkpoint.completedIds && !checkpoint.completed) {
      checkpoint.completed = {};
      for (const id of checkpoint.completedIds) checkpoint.completed[id] = { commentCount: -1 };
      delete checkpoint.completedIds;
    }
    console.log(`Resuming: ${Object.keys(checkpoint.completed).length} completed`);
  }
  const completedSet = new Set(Object.keys(checkpoint.completed));

  shows = shows.filter(s => !completedSet.has(s.id));
  if (maxShows) shows = shows.slice(0, maxShows);
  console.log(`To process: ${shows.length} shows\n`);

  if (dryRun) {
    for (const s of shows.slice(0, 20)) {
      console.log(`  ${s.name} (watched: ${s.totalWatchedUsers || 0})`);
    }
    return;
  }

  // 5. Set up graceful shutdown
  let shuttingDown = false;
  let index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : {};
  process.on('SIGINT', () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nSIGINT — saving checkpoint...');
    checkpoint.totalRequests = totalRequests;
    writeJsonAtomic(checkpointPath, checkpoint);
    writeJsonAtomic(indexPath, index);
    process.exit(0);
  });

  // 6. Fetch comments for each show
  let fetched = 0;
  let totalComments = 0;
  let showsWithComments = 0;
  const startTime = Date.now();

  for (let i = 0; i < shows.length; i++) {
    if (shuttingDown) break;
    const show = shows[i];
    try {
      const comments = await fetchShowComments(show.id);

      // Save even if 0 comments (so we don't re-query on resume)
      const outFile = path.join(reviewsDir, `${show.id}.json`);
      writeJsonAtomic(outFile, {
        showId: show.id,
        showName: show.name,
        eventCategory: show.eventCategory,
        fetchedAt: new Date().toISOString(),
        totalComments: comments.length,
        comments,
      });

      index[show.id] = {
        showName: show.name,
        commentCount: comments.length,
        lastFetched: new Date().toISOString(),
      };

      checkpoint.completed[show.id] = { commentCount: comments.length };
      checkpoint.totalRequests = totalRequests;
      writeJsonAtomic(checkpointPath, checkpoint);
      writeJsonAtomic(indexPath, index);

      fetched++;
      totalComments += comments.length;
      if (comments.length > 0) showsWithComments++;

      if (verbose || (i + 1) % 25 === 0) {
        const elapsedMin = (Date.now() - startTime) / 1000 / 60;
        const rate = fetched / elapsedMin;
        const etaMin = rate > 0 ? ((shows.length - (i + 1)) / rate).toFixed(0) : '?';
        console.log(`  [${i + 1}/${shows.length}] ${show.name}: ${comments.length} comments | ${totalComments} total | ~${etaMin}min remaining`);
      }
    } catch (e) {
      console.error(`  ERROR ${show.name}: ${e.message}`);
      checkpoint.totalRequests = totalRequests;
      writeJsonAtomic(checkpointPath, checkpoint);
      if (e.message.includes('Request cap')) break;
    }

    if (i < shows.length - 1) await sleep(DELAY_BETWEEN_REQUESTS_MS);
  }

  console.log(`\n=== Results ===`);
  console.log(`Shows processed: ${fetched}`);
  console.log(`Shows with comments: ${showsWithComments}`);
  console.log(`Total comments: ${totalComments}`);
  console.log(`API requests: ${totalRequests}`);
  console.log(`Elapsed: ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutes`);
}

// ---- Main ----

async function main() {
  if (discoverMode) {
    await runDiscovery();
    return;
  }

  // Default mode: scrape comments via POST /comments/query
  await runFullScrape();
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
