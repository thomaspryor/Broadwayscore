#!/usr/bin/env node
/**
 * validate-restaurant-names.js
 *
 * Optional post-generation validation: spot-checks restaurant names from
 * theater-tips-draft.json against Google Places API to verify they still exist.
 *
 * Requires: GOOGLE_PLACES_API_KEY (skips gracefully if not set)
 *
 * Usage:
 *   node scripts/validate-restaurant-names.js [--sample N]
 *
 * Default: spot-checks 10 random restaurants across all theaters.
 * Outputs: validation report to stdout + data/audit/restaurant-validation.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DRAFT_FILE = path.join(__dirname, '..', 'data', 'theater-tips-draft.json');
const AUDIT_FILE = path.join(__dirname, '..', 'data', 'audit', 'restaurant-validation.json');

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function searchPlace(name) {
  const query = encodeURIComponent(`${name} Times Square New York`);
  const url = `https://places.googleapis.com/v1/places:searchText`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      textQuery: `${name} Times Square New York`,
      maxResultCount: 1,
    });

    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': API_KEY,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.businessStatus',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Parse error: ${e.message}`));
          }
        } else {
          reject(new Error(`Places API ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!API_KEY) {
    console.log('GOOGLE_PLACES_API_KEY not set — skipping restaurant validation.');
    console.log('To enable: add GOOGLE_PLACES_API_KEY as a GitHub secret.');
    process.exit(0);
  }

  const args = process.argv.slice(2);
  const sampleIdx = args.indexOf('--sample');
  const sampleSize = sampleIdx >= 0 ? parseInt(args[sampleIdx + 1]) : 10;

  if (!fs.existsSync(DRAFT_FILE)) {
    console.error(`Draft not found: ${DRAFT_FILE}`);
    process.exit(1);
  }

  const draft = JSON.parse(fs.readFileSync(DRAFT_FILE, 'utf8'));
  const theaters = draft.theaters || {};

  // Collect all unique restaurant names with their theater associations
  const restaurantMap = new Map(); // name -> [theater1, theater2, ...]
  for (const [theater, tips] of Object.entries(theaters)) {
    if (!tips.dining) continue;
    for (const category of ['preShow', 'postShow', 'quickBite']) {
      for (const r of (tips.dining[category] || [])) {
        if (!restaurantMap.has(r.name)) restaurantMap.set(r.name, []);
        restaurantMap.get(r.name).push(theater);
      }
    }
  }

  const allNames = Array.from(restaurantMap.keys());
  console.log(`Found ${allNames.length} unique restaurants across ${Object.keys(theaters).length} theaters`);

  // Random sample
  const shuffled = allNames.sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, Math.min(sampleSize, allNames.length));

  console.log(`Spot-checking ${sample.length} restaurants via Google Places API...\n`);

  const results = [];
  let found = 0, notFound = 0, closed = 0, errors = 0;

  for (const name of sample) {
    try {
      const response = await searchPlace(name);
      const place = response.places?.[0];

      if (!place) {
        console.log(`  ❌ NOT FOUND: "${name}" (in ${restaurantMap.get(name).length} theaters)`);
        results.push({ name, status: 'not_found', theaters: restaurantMap.get(name) });
        notFound++;
      } else if (place.businessStatus === 'CLOSED_PERMANENTLY') {
        console.log(`  🚫 CLOSED: "${name}" → ${place.displayName?.text}`);
        results.push({ name, status: 'closed', placeName: place.displayName?.text, theaters: restaurantMap.get(name) });
        closed++;
      } else {
        console.log(`  ✅ "${name}" → ${place.displayName?.text} (${place.businessStatus || 'OPERATIONAL'})`);
        results.push({ name, status: 'found', placeName: place.displayName?.text });
        found++;
      }
    } catch (err) {
      console.log(`  ⚠️  ERROR: "${name}" — ${err.message}`);
      results.push({ name, status: 'error', error: err.message });
      errors++;
    }

    await sleep(200); // Rate limit
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Found: ${found}, Not Found: ${notFound}, Closed: ${closed}, Errors: ${errors}`);

  if (notFound + closed > 0) {
    console.log(`\n⚠️  ${notFound + closed} restaurant(s) may need replacement.`);
  }

  // Save audit
  const auditDir = path.dirname(AUDIT_FILE);
  if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(AUDIT_FILE, JSON.stringify({
    checkedAt: new Date().toISOString(),
    sampleSize: sample.length,
    totalRestaurants: allNames.length,
    found, notFound, closed, errors,
    results,
  }, null, 2));
  console.log(`Audit saved: ${AUDIT_FILE}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
