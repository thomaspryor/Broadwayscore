#!/usr/bin/env node
/**
 * Fetch actor headshot images from Wikipedia + BroadwayWorld.
 *
 * Tier 1: Wikipedia API (free, CC-licensed, batch-friendly)
 *   - Queries pageimages endpoint, 50 actors per API call
 *   - ~125 calls total, takes ~2 minutes
 *
 * Tier 2: BroadwayWorld og:image extraction (for actors not on Wikipedia)
 *   - Scrapes /people/{First-Last}/ pages
 *   - Downloads headshot to public/images/actors/
 *
 * Output: data/actor-images.json
 *   { [ibdbPersonId]: { name, imageUrl, source, license?, attribution? } }
 *
 * Usage:
 *   node scripts/fetch-actor-images.js [--wikipedia-only] [--bww-only] [--limit N]
 */

const fs = require('fs');
const path = require('path');

const CAST_DIR = path.join(__dirname, '..', 'data', 'cast');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'actor-images.json');
const IMAGE_DIR = path.join(__dirname, '..', 'public', 'images', 'actors');
const BATCH_SIZE = 50; // Wikipedia API max per request
const BWW_RATE_MS = 500; // ms between BroadwayWorld requests

// ─── Collect all unique actors ──────────────────────────────────────────────

function getAllActors() {
  const actors = new Map(); // ibdbPersonId -> name
  const files = fs.readdirSync(CAST_DIR).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(CAST_DIR, file), 'utf8'));
    for (const section of ['openingNightCast', 'currentCast', 'replacements']) {
      if (!data[section]) continue;
      for (const m of data[section]) {
        if (m.ibdbPersonId && !actors.has(m.ibdbPersonId)) {
          actors.set(m.ibdbPersonId, m.name);
        }
      }
    }
  }

  return actors;
}

// ─── Wikipedia Tier ─────────────────────────────────────────────────────────

/**
 * Query Wikipedia pageimages API for a batch of actor names.
 * Returns map of name -> { imageUrl, attribution }
 */
async function queryWikipediaBatch(names) {
  const titles = names.map(n => n.replace(/ /g, '_')).join('|');
  const url = `https://en.wikipedia.org/w/api.php?` +
    `action=query&titles=${encodeURIComponent(titles)}` +
    `&prop=pageimages&format=json&pithumbsize=400&redirects=1`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'BroadwayScorecard/1.0 (broadwayscorecard.com)' }
  });

  if (!resp.ok) {
    console.error(`  Wikipedia API error: ${resp.status}`);
    return new Map();
  }

  const data = await resp.json();
  const results = new Map();

  // Build redirect map (Wikipedia often redirects e.g. "Idina_Menzel" -> "Idina Menzel")
  const redirectMap = new Map();
  if (data.query?.redirects) {
    for (const r of data.query.redirects) {
      redirectMap.set(r.from.replace(/_/g, ' '), r.to.replace(/_/g, ' '));
    }
  }
  // Also handle normalized titles
  const normalizedMap = new Map();
  if (data.query?.normalized) {
    for (const n of data.query.normalized) {
      normalizedMap.set(n.from.replace(/_/g, ' '), n.to.replace(/_/g, ' '));
    }
  }

  if (data.query?.pages) {
    for (const page of Object.values(data.query.pages)) {
      if (page.thumbnail?.source) {
        // Skip SVG files (logos, icons — not actual headshots)
        if (/\.svg/i.test(page.thumbnail.source)) continue;
        const pageTitle = page.title;
        results.set(pageTitle, {
          imageUrl: page.thumbnail.source,
          source: 'wikipedia',
          license: 'CC BY-SA',
        });
      }
    }
  }

  // Map back to original names using redirect/normalized maps
  const nameResults = new Map();
  for (const name of names) {
    const normalized = normalizedMap.get(name) || name;
    const redirected = redirectMap.get(normalized) || normalized;

    if (results.has(redirected)) {
      nameResults.set(name, results.get(redirected));
    } else if (results.has(normalized)) {
      nameResults.set(name, results.get(normalized));
    } else if (results.has(name)) {
      nameResults.set(name, results.get(name));
    }
  }

  return nameResults;
}

async function fetchWikipediaImages(actors, existingImages = {}) {
  const names = [];
  const nameToId = new Map();

  for (const [id, name] of actors) {
    // Skip actors we already have images for
    if (existingImages[id]) continue;
    names.push(name);
    // Handle name collisions — multiple actors with same name
    if (!nameToId.has(name)) nameToId.set(name, []);
    nameToId.get(name).push(id);
  }

  console.log(`\n📚 Wikipedia: Querying ${names.length} actors in batches of ${BATCH_SIZE}...`);
  const results = {};
  let found = 0;
  let batchNum = 0;

  // Deduplicate names for API queries
  const uniqueNames = [...new Set(names)];

  for (let i = 0; i < uniqueNames.length; i += BATCH_SIZE) {
    const batch = uniqueNames.slice(i, i + BATCH_SIZE);
    batchNum++;

    try {
      const batchResults = await queryWikipediaBatch(batch);

      for (const [name, imageData] of batchResults) {
        const ids = nameToId.get(name);
        if (ids) {
          for (const id of ids) {
            results[id] = { name, ...imageData };
            found++;
          }
        }
      }

      if (batchNum % 10 === 0) {
        console.log(`  Batch ${batchNum}/${Math.ceil(uniqueNames.length / BATCH_SIZE)} — ${found} images found so far`);
      }
    } catch (e) {
      console.error(`  Batch ${batchNum} failed: ${e.message}`);
    }

    // Small delay to be polite
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`  ✅ Wikipedia: ${found} images found out of ${uniqueNames.length} unique actors`);
  return results;
}

// ─── BroadwayWorld Tier ─────────────────────────────────────────────────────

function nameToBWWSlug(name) {
  // BroadwayWorld uses /people/First-Last/ with hyphens
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove accents
    .replace(/'/g, '')     // remove apostrophes
    .replace(/\./g, '')    // remove periods
    .replace(/\s+/g, '-')  // spaces to hyphens
    .replace(/[^a-zA-Z0-9-]/g, '') // remove other special chars
    .replace(/-+/g, '-');  // collapse multiple hyphens
}

async function fetchBWWImage(name) {
  const slug = nameToBWWSlug(name);
  const url = `https://www.broadwayworld.com/people/${slug}/`;

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      redirect: 'follow',
    });

    if (!resp.ok) return null;

    const html = await resp.text();

    // Extract og:image meta tag
    const ogMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)
      || html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i);

    if (ogMatch && ogMatch[1]) {
      const imageUrl = ogMatch[1];
      // Filter out generic/logo images
      if (imageUrl.includes('headshots') || imageUrl.includes('cloudimages')) {
        return {
          imageUrl,
          source: 'broadwayworld',
        };
      }
    }

    return null;
  } catch (e) {
    return null;
  }
}

async function fetchBWWImages(actors, existingImages = {}, limit = 0) {
  const missing = [];
  for (const [id, name] of actors) {
    if (!existingImages[id]) {
      missing.push({ id, name });
    }
  }

  const toFetch = limit > 0 ? missing.slice(0, limit) : missing;
  console.log(`\n🌐 BroadwayWorld: Fetching ${toFetch.length} actors (${missing.length} total missing)...`);

  const results = {};
  let found = 0;
  let failed = 0;

  for (let i = 0; i < toFetch.length; i++) {
    const { id, name } = toFetch[i];

    const imageData = await fetchBWWImage(name);
    if (imageData) {
      results[id] = { name, ...imageData };
      found++;
    } else {
      failed++;
    }

    if ((i + 1) % 100 === 0) {
      console.log(`  Progress: ${i + 1}/${toFetch.length} — ${found} found, ${failed} not found`);
      // Checkpoint save
      saveResults({ ...existingImages, ...results });
    }

    await new Promise(r => setTimeout(r, BWW_RATE_MS));
  }

  console.log(`  ✅ BroadwayWorld: ${found} images found, ${failed} not found`);
  return results;
}

// ─── Output ─────────────────────────────────────────────────────────────────

function saveResults(images) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(images, null, 2));
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const wikiOnly = args.includes('--wikipedia-only');
  const bwwOnly = args.includes('--bww-only');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 0;

  // Load existing images
  let existingImages = {};
  if (fs.existsSync(OUTPUT_FILE)) {
    existingImages = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    console.log(`📦 Loaded ${Object.keys(existingImages).length} existing actor images`);
  }

  const actors = getAllActors();
  console.log(`🎭 Found ${actors.size} unique actors across ${fs.readdirSync(CAST_DIR).filter(f => f.endsWith('.json')).length} cast files`);

  // Tier 1: Wikipedia
  if (!bwwOnly) {
    const wikiResults = await fetchWikipediaImages(actors, existingImages);
    Object.assign(existingImages, wikiResults);
    saveResults(existingImages);
    console.log(`💾 Saved — total: ${Object.keys(existingImages).length} images`);
  }

  // Tier 2: BroadwayWorld (for actors not found on Wikipedia)
  if (!wikiOnly) {
    const bwwResults = await fetchBWWImages(actors, existingImages, limit);
    Object.assign(existingImages, bwwResults);
    saveResults(existingImages);
    console.log(`💾 Saved — total: ${Object.keys(existingImages).length} images`);
  }

  // Summary
  const total = Object.keys(existingImages).length;
  const wikiCount = Object.values(existingImages).filter(v => v.source === 'wikipedia').length;
  const bwwCount = Object.values(existingImages).filter(v => v.source === 'broadwayworld').length;
  const missing = actors.size - total;

  console.log(`\n📊 Summary:`);
  console.log(`  Total actors: ${actors.size}`);
  console.log(`  Images found: ${total} (${(total / actors.size * 100).toFixed(1)}%)`);
  console.log(`    Wikipedia: ${wikiCount}`);
  console.log(`    BroadwayWorld: ${bwwCount}`);
  console.log(`  Still missing: ${missing}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
