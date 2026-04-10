#!/usr/bin/env node
/**
 * Remediate duplicate cross-production images.
 *
 * Background:
 *   fetchFromMezzanine had a bug where p.openedAt is a Parse Date object
 *   ({__type:'Date', iso:...}) but was being read as a string. parseInt of
 *   '[object Object]' is NaN, so the year-distance tiebreaker died and the
 *   first Broadway-flagged candidate won for every production of the same title.
 *   Result: ~256 shows across 100+ titles ended up sharing images with their
 *   sibling productions.
 *
 * What this script does:
 *   1. Identify shows whose poster.* / thumbnail.* / hero.* files are byte-identical
 *      to another production of the same base title (md5 collision).
 *   2. For each affected show, look up the correct Mezzanine entry by year using
 *      the FIXED selection logic (year proximity primary).
 *   3. Download the production-specific poster URL and save it as poster + thumbnail
 *      under that show's image directory (Mezzanine doesn't provide hero).
 *   4. Update data/image-sources.json with the corrected URLs.
 *   5. Update data/shows.json image paths.
 *   6. For shows with no Mezzanine match (or year too far off), clear the bad
 *      cached entries so a fresh fetch-show-images-auto.js run can repopulate them.
 *
 * Usage:
 *   node scripts/remediate-duplicate-images.js                # apply
 *   node scripts/remediate-duplicate-images.js --dry-run      # preview only
 *   node scripts/remediate-duplicate-images.js --show=ID      # one show
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const SOURCES_PATH = path.join(ROOT, 'data', 'image-sources.json');
const MEZZ_CACHE_PATH = path.join(ROOT, 'data', 'mezzanine-image-cache.json');
const IMG_ROOT = path.join(ROOT, 'public', 'images', 'shows');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ONE_SHOW = args.find(a => a.startsWith('--show='))?.split('=')[1] || null;

// ---- Mezzanine matching (mirrors the fixed fetchFromMezzanine logic) ----

function normalizeMezzTitle(s) {
  return s.toLowerCase()
    .replace(/['\u2018\u2019\u201C\u201D!:,.;\-\u2013\u2014&+()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^the\s+/, '')
    .trim();
}

function buildMezzIndex(records) {
  const byNormTitle = new Map();
  for (const r of records) {
    if (!r.name || !r.artUrl) continue;
    const norm = normalizeMezzTitle(r.name);
    if (!byNormTitle.has(norm)) byNormTitle.set(norm, []);
    byNormTitle.get(norm).push(r);
  }
  return byNormTitle;
}

function extractMezzYear(openedAt) {
  if (!openedAt) return 0;
  if (typeof openedAt === 'object' && openedAt !== null) {
    const iso = openedAt.iso || '';
    const y = parseInt(String(iso).substring(0, 4));
    return Number.isFinite(y) && y > 1900 ? y : 0;
  }
  if (typeof openedAt === 'string') {
    const y = parseInt(openedAt.substring(0, 4));
    return Number.isFinite(y) && y > 1900 ? y : 0;
  }
  return 0;
}

function pickMezzBest(show, candidates) {
  const showYear = show.openingDate ? parseInt(show.openingDate.substring(0, 4)) : 0;
  let best = null;
  let bestDist = Infinity;
  for (const p of candidates) {
    const mYear = extractMezzYear(p.openedAt);
    const dist = showYear && mYear ? Math.abs(showYear - mYear) : 999;
    if (!best ||
        dist < bestDist ||
        (dist === bestDist && p.isBroadway && !best.isBroadway) ||
        (dist === bestDist && p.isBroadway === best.isBroadway && (p.ratingsCount || 0) > (best.ratingsCount || 0))) {
      best = p;
      bestDist = dist;
    }
  }
  if (!best || !best.artUrl) return null;
  const bestYear = extractMezzYear(best.openedAt);
  if (showYear && bestYear && bestDist > 2) return null;
  if (candidates.length > 1 && !showYear) return null;
  return { record: best, dist: bestDist };
}

// ---- Conflict detection ----

function baseTitleKey(t) {
  return (t || '').toLowerCase()
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/['\u2018\u2019\u201C\u201D!:,.;\-\u2013\u2014&+()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^the\s+/, '')
    .trim();
}

function md5OfFile(p) {
  try {
    return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
  } catch { return null; }
}

function findFile(showId, format) {
  for (const ext of ['webp', 'jpg', 'jpeg', 'png']) {
    const p = path.join(IMG_ROOT, showId, `${format}.${ext}`);
    if (fs.existsSync(p)) return { path: p, ext };
  }
  return null;
}

function detectConflicts(shows) {
  const byBase = new Map();
  for (const s of shows) {
    if (!s.title) continue;
    const b = baseTitleKey(s.title);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(s);
  }
  // affected = set of show IDs whose files duplicate ANOTHER production
  // protected = the newest production in each duplicate group (its image is kept)
  const affected = new Set();
  const protectedIds = new Set();
  for (const group of byBase.values()) {
    if (group.length < 2) continue;
    // Collect IDs that share at least one image hash with another production in this group
    const groupAffected = new Set();
    for (const format of ['hero', 'poster', 'thumbnail']) {
      const byHash = new Map();
      for (const s of group) {
        const f = findFile(s.id, format);
        if (!f) continue;
        const h = md5OfFile(f.path);
        if (!h) continue;
        if (!byHash.has(h)) byHash.set(h, []);
        byHash.get(h).push(s.id);
      }
      for (const ids of byHash.values()) {
        if (ids.length > 1) ids.forEach(id => groupAffected.add(id));
      }
    }
    if (groupAffected.size === 0) continue;
    // The newest production (latest openingDate) in the affected set keeps its
    // image — that's presumed to be the correct one that the older productions
    // wrongly inherited via the buggy fetcher.
    const affectedShows = group.filter(s => groupAffected.has(s.id));
    const newest = [...affectedShows].sort((a, b) => {
      const ay = a.openingDate || '0000';
      const by = b.openingDate || '0000';
      return by.localeCompare(ay);
    })[0];
    protectedIds.add(newest.id);
    for (const id of groupAffected) {
      if (id !== newest.id) affected.add(id);
    }
  }
  return { affected, protectedIds };
}

// ---- Download helper ----

async function downloadImage(url, filepath) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1000) throw new Error(`Suspiciously small (${buffer.length} bytes)`);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, buffer);
  return buffer.length;
}

function localExtFromUrl(url) {
  const m = url.match(/\.(webp|png|jpe?g|gif)(\?|$)/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

// ---- Main ----

async function main() {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const allShows = showsData.shows;
  const sources = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
  const mezzCache = JSON.parse(fs.readFileSync(MEZZ_CACHE_PATH, 'utf8'));
  const mezzIndex = buildMezzIndex(mezzCache.records);

  let affectedIds;
  let protectedIds = new Set();
  if (ONE_SHOW) {
    affectedIds = new Set([ONE_SHOW]);
  } else {
    console.log('Scanning for shows with byte-identical images shared across productions...');
    const r = detectConflicts(allShows);
    affectedIds = r.affected;
    protectedIds = r.protectedIds;
    console.log(`Found ${affectedIds.size} affected shows (excluding ${protectedIds.size} newest-in-group preserved).\n`);
  }

  const stats = {
    total: affectedIds.size,
    fixed: 0,
    cleared: 0,
    skipped: 0,
    failed: 0,
  };
  const fixedShows = [];
  const clearedShows = [];

  for (const id of [...affectedIds].sort()) {
    const show = allShows.find(s => s.id === id);
    if (!show) {
      console.log(`  ! ${id}: not found in shows.json`);
      stats.skipped++;
      continue;
    }

    const norm = normalizeMezzTitle(show.title || '');
    const candidates = mezzIndex.get(norm) || [];
    const picked = pickMezzBest(show, candidates);

    if (!picked) {
      // No Mezzanine match — clear the bad cached image-sources entry so a
      // fresh fetch-show-images-auto.js run can re-populate from IBDB/Google.
      // Also delete the duplicate local files so the user notices.
      if (sources[id]) {
        if (!DRY_RUN) {
          delete sources[id];
        }
        clearedShows.push(id);
        stats.cleared++;
      } else {
        stats.skipped++;
      }
      // Delete duplicate local files
      for (const format of ['hero', 'poster', 'thumbnail']) {
        const f = findFile(id, format);
        if (f && !DRY_RUN) {
          fs.unlinkSync(f.path);
        }
      }
      // Clear shows.json image refs
      if (show.images && !DRY_RUN) {
        show.images = { thumbnail: null, poster: null, hero: null };
      }
      console.log(`  ⊘ ${id}: no Mezzanine match — cleared (will re-fetch)`);
      continue;
    }

    const url = picked.record.artUrl;
    const ext = localExtFromUrl(url);
    const posterPath = path.join(IMG_ROOT, id, `poster.${ext}`);
    const thumbPath = path.join(IMG_ROOT, id, `thumbnail.${ext}`);

    try {
      // Delete old duplicate files first (any extension)
      for (const format of ['hero', 'poster', 'thumbnail']) {
        const f = findFile(id, format);
        if (f && !DRY_RUN) {
          fs.unlinkSync(f.path);
        }
      }
      // Download new poster + thumbnail (both from same URL — Mezzanine has one image)
      if (!DRY_RUN) {
        const size = await downloadImage(url, posterPath);
        // Reuse same buffer instead of double-downloading
        fs.copyFileSync(posterPath, thumbPath);
        // Update sources
        sources[id] = {
          poster: url,
          thumbnail: url,
          hero: null,
        };
        // Update shows.json paths
        if (!show.images) show.images = {};
        show.images.poster = `/images/shows/${id}/poster.${ext}`;
        show.images.thumbnail = `/images/shows/${id}/thumbnail.${ext}`;
        show.images.hero = null;
      }
      console.log(`  ✓ ${id} (${show.openingDate?.slice(0,4)}): ${picked.record.theater} (dist=${picked.dist})`);
      fixedShows.push(id);
      stats.fixed++;
      // Rate limit
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.error(`  ✗ ${id}: ${e.message}`);
      stats.failed++;
    }
  }

  if (!DRY_RUN) {
    fs.writeFileSync(SOURCES_PATH, JSON.stringify(sources, null, 2) + '\n');
    fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsData, null, 2) + '\n');
  }

  console.log('\n--- Summary ---');
  console.log(`Affected: ${stats.total}`);
  console.log(`Fixed (Mezzanine match): ${stats.fixed}`);
  console.log(`Cleared (no match — needs re-fetch): ${stats.cleared}`);
  console.log(`Skipped: ${stats.skipped}`);
  console.log(`Failed: ${stats.failed}`);
  if (DRY_RUN) console.log('\n(dry run — no files written)');
}

main().catch(e => { console.error(e); process.exit(1); });
