#!/usr/bin/env node
/**
 * Import historical show data from Mezzanine (theaterdiary.com) Parse API.
 *
 * Fetches ALL productions with ratings from Mezzanine, classifies by location,
 * deduplicates against existing shows.json, and writes to diary-shows.json.
 *
 * Also saves the raw API response to data/mezzanine-productions-raw.json
 * so we never need to re-fetch this data.
 *
 * Usage:
 *   node scripts/import-mezzanine-historical.js [--dry-run] [--resume] [--min-ratings=3] [--verbose]
 *
 * Environment variables:
 *   MEZZANINE_APP_ID       - Parse Application ID (required)
 *   MEZZANINE_SESSION_TOKEN - Parse Session Token (required)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { classifyProduction, slugify, parseDate } = require('./lib/mezzanine-classify.js');

// Parse CLI args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const resume = args.includes('--resume');
const verbose = args.includes('--verbose');
const minRatingsArg = args.find(a => a.startsWith('--min-ratings='));
const MIN_RATINGS = minRatingsArg ? parseInt(minRatingsArg.split('=')[1]) : 3;

// Config
const APP_ID = process.env.MEZZANINE_APP_ID;
const SESSION_TOKEN = process.env.MEZZANINE_SESSION_TOKEN;

if (!APP_ID || !SESSION_TOKEN) {
  console.error('Error: MEZZANINE_APP_ID and MEZZANINE_SESSION_TOKEN must be set');
  console.error('Run: source .env');
  process.exit(1);
}

// Paths
const dataDir = path.join(__dirname, '../data');
const showsPath = path.join(dataDir, 'shows.json');
const diaryShowsPath = path.join(dataDir, 'diary-shows.json');
const rawCachePath = path.join(dataDir, 'mezzanine-productions-raw.json');
const checkpointPath = path.join(dataDir, 'diary-import-checkpoint.json');

// Load existing shows for dedup
const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const existingSlugs = new Set();
const existingIds = new Set();
for (const show of showsData.shows) {
  existingSlugs.add(show.slug);
  existingIds.add(show.id);
}

// Load existing diary shows for dedup by mezzanineId
let existingDiary = { shows: [] };
try {
  existingDiary = JSON.parse(fs.readFileSync(diaryShowsPath, 'utf8'));
} catch { /* doesn't exist yet */ }
const existingMezzIds = new Set(existingDiary.shows.map(s => s.mezzanineId).filter(Boolean));

/**
 * Query Parse Server API with rate limiting
 */
function queryParse(className, body) {
  return new Promise((resolve, reject) => {
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
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error(`Auth failed (${res.statusCode}). Token may have expired.`));
          return;
        }
        if (res.statusCode === 429) {
          reject(new Error('Rate limited (429). Wait and retry.'));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Parse error: ' + body.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Fetch all productions with ratings, paginated. Saves raw data to cache.
 */
async function fetchAllProductions() {
  // Check for cached raw data
  if (fs.existsSync(rawCachePath)) {
    console.log('Loading cached raw productions from', rawCachePath);
    const cached = JSON.parse(fs.readFileSync(rawCachePath, 'utf8'));
    console.log(`  Loaded ${cached.length} cached productions`);
    return cached;
  }

  // Check for checkpoint (resume support)
  let all = [];
  let startSkip = 0;
  if (resume && fs.existsSync(checkpointPath)) {
    const cp = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    all = cp.productions || [];
    startSkip = cp.skip || 0;
    console.log(`Resuming from checkpoint: ${all.length} productions, skip=${startSkip}`);
  }

  const batchSize = 1000;
  let skip = startSkip;

  while (true) {
    console.log(`  Fetching productions ${skip}–${skip + batchSize}...`);

    let res;
    try {
      res = await queryParse('Production', {
        limit: batchSize,
        skip,
        where: { ratingsCount: { '$gt': 0 } },
        include: 'show,theater',
        _method: 'GET',
      });
    } catch (err) {
      console.error(`Error at skip=${skip}: ${err.message}`);
      // Save checkpoint before bailing
      fs.writeFileSync(checkpointPath, JSON.stringify({ productions: all, skip }, null, 2));
      console.log(`Checkpoint saved (${all.length} productions, skip=${skip}). Run with --resume to continue.`);
      process.exit(1);
    }

    const results = res.results || [];
    if (results.length === 0) break;

    all.push(...results);
    skip += results.length;

    // Checkpoint every 5000 records
    if (all.length % 5000 < batchSize) {
      fs.writeFileSync(checkpointPath, JSON.stringify({ productions: all, skip }, null, 2));
      if (verbose) console.log(`  Checkpoint: ${all.length} productions`);
    }

    if (results.length < batchSize) break;

    // Rate limiting — 500ms between batches to be respectful
    await sleep(500);
  }

  console.log(`Fetched ${all.length} total rated productions`);

  // Save raw cache so we never need to re-fetch
  console.log('Saving raw productions cache...');
  fs.writeFileSync(rawCachePath, JSON.stringify(all));
  const sizeMB = (fs.statSync(rawCachePath).size / 1024 / 1024).toFixed(1);
  console.log(`  Saved ${rawCachePath} (${sizeMB}MB)`);

  // Clean up checkpoint
  if (fs.existsSync(checkpointPath)) fs.unlinkSync(checkpointPath);

  return all;
}

/**
 * Process raw productions into diary show entries
 */
function processProductions(productions) {
  const diaryShows = [];
  const usedSlugs = new Set([...existingSlugs]);
  const stats = { broadway: 0, skipped: 0, lowRatings: 0, noTitle: 0, duplicate: 0 };

  for (const p of productions) {
    // Extract show name
    const showName = (typeof p.show === 'object' ? p.show?.name : null) || p.showName;
    if (!showName) { stats.noTitle++; continue; }

    // Skip low-rating entries
    if ((p.ratingsCount || 0) < MIN_RATINGS) { stats.lowRatings++; continue; }

    // Classify
    const category = classifyProduction(p);
    if (category === 'broadway') { stats.broadway++; continue; }

    // Dedup by Mezzanine objectId
    const mezzId = p.objectId;
    if (existingMezzIds.has(mezzId)) { stats.duplicate++; continue; }

    // Extract data
    const opened = parseDate(p.opened || p.firstPreview);
    const year = opened ? opened.substring(0, 4) : null;
    const theater = typeof p.theater === 'object' ? p.theater : {};
    const venue = theater.name || p.theaterName || '';
    const city = theater.geocodedCity || '';
    const country = theater.geocodedCountryCode || '';

    // Generate slug — include category and year for uniqueness
    let baseSlug = slugify(showName);
    if (!baseSlug) baseSlug = 'show';

    let suffix = category;
    if (year) suffix += `-${year}`;
    else suffix += `-mz${mezzId.substring(0, 8)}`;

    let slug = `${baseSlug}-${suffix}`;

    // Skip if this exact slug/ID already exists in scored shows.json
    if (existingIds.has(slug) || existingSlugs.has(slug)) {
      stats.duplicate++;
      continue;
    }

    // Handle collisions with other diary shows in this batch
    if (usedSlugs.has(slug)) {
      // Try adding venue
      const vSlug = slugify(venue);
      if (vSlug) slug = `${baseSlug}-${vSlug}-${suffix}`;
      // Still colliding? Add mezzanine ID
      if (usedSlugs.has(slug)) {
        slug = `${baseSlug}-${suffix}-mz${mezzId.substring(0, 8)}`;
      }
    }

    // Final collision check
    if (usedSlugs.has(slug)) {
      if (verbose) console.log(`  SKIP collision: ${slug} (${showName})`);
      continue;
    }

    usedSlugs.add(slug);

    const audienceScore = p.averageRating
      ? Math.round((p.averageRating / 5) * 100)
      : null;

    const entry = {
      id: slug,
      title: showName,
      slug,
      venue,
      city,
      country,
      category,
      openingDate: opened,
      status: 'closed',
      audienceScore,
      audienceRatingsCount: p.ratingsCount || 0,
      mezzanineId: mezzId,
    };

    // Extract poster art if available
    if (p.art && p.art.url) {
      entry.posterUrl = p.art.url;
    }

    diaryShows.push(entry);
  }

  return { diaryShows, stats };
}

async function main() {
  console.log('Mezzanine Historical Show Import');
  console.log('================================\n');
  console.log(`Min ratings: ${MIN_RATINGS}`);
  console.log(`Dry run: ${dryRun}\n`);

  // 1. Fetch all productions
  const productions = await fetchAllProductions();

  // 2. Process into diary shows
  console.log('\nProcessing productions...');
  const { diaryShows, stats } = processProductions(productions);

  // 3. Stats
  console.log('\n=== Import Stats ===');
  console.log(`Total raw productions: ${productions.length}`);
  console.log(`Broadway (skipped): ${stats.broadway}`);
  console.log(`Low ratings < ${MIN_RATINGS} (skipped): ${stats.lowRatings}`);
  console.log(`No title (skipped): ${stats.noTitle}`);
  console.log(`Already imported (skipped): ${stats.duplicate}`);
  console.log(`New diary shows: ${diaryShows.length}`);

  // Category breakdown
  const catCounts = {};
  for (const s of diaryShows) {
    catCounts[s.category] = (catCounts[s.category] || 0) + 1;
  }
  console.log('\nBy category:', catCounts);

  // Date coverage
  const withDates = diaryShows.filter(s => s.openingDate).length;
  console.log(`With dates: ${withDates}/${diaryShows.length} (${Math.round(withDates/diaryShows.length*100)}%)`);

  if (dryRun) {
    console.log('\n[DRY RUN] No files written.');
    // Show a few samples
    console.log('\nSample entries:');
    for (const s of diaryShows.slice(0, 5)) {
      console.log(`  ${s.title} | ${s.category} | ${s.venue} | ${s.openingDate || 'no date'} | ${s.audienceScore}/100 (${s.audienceRatingsCount} ratings)`);
    }
    return;
  }

  // 4. Merge with existing diary shows and write
  const merged = [...existingDiary.shows, ...diaryShows];
  const output = { shows: merged, lastUpdated: new Date().toISOString() };

  fs.writeFileSync(diaryShowsPath, JSON.stringify(output, null, 2));
  const sizeMB = (fs.statSync(diaryShowsPath).size / 1024 / 1024).toFixed(1);
  console.log(`\nWrote ${diaryShowsPath} (${merged.length} total shows, ${sizeMB}MB)`);

  // 5. Validate — no slug collisions with shows.json
  const collisions = merged.filter(s => existingIds.has(s.id) || existingSlugs.has(s.slug));
  if (collisions.length > 0) {
    console.error(`\nWARNING: ${collisions.length} slug collisions with shows.json!`);
    for (const c of collisions.slice(0, 10)) {
      console.error(`  ${c.slug}: ${c.title}`);
    }
  } else {
    console.log('No slug collisions with shows.json');
  }

  console.log('\nDone! Next steps:');
  console.log('  1. Review diary-shows.json');
  console.log('  2. npm run build (verify build succeeds)');
  console.log('  3. Commit diary-shows.json to private data repo');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
