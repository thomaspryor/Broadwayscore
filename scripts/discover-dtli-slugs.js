#!/usr/bin/env node
/**
 * Discover DTLI show slugs from WordPress sitemaps and match to our shows.
 *
 * DTLI uses unpredictable slugs (e.g. "frozen-3", "company-2", "cabaret-at-the-kit-kat-club")
 * that can't be guessed algorithmically. This script scrapes all 13 sitemaps to build
 * a persistent slug map in data/dtli-slug-map.json.
 *
 * Usage:
 *   node scripts/discover-dtli-slugs.js              # Full discovery
 *   node scripts/discover-dtli-slugs.js --dry-run    # Print matches without writing
 *   node scripts/discover-dtli-slugs.js --verify     # Check mapped URLs still work
 *   node scripts/discover-dtli-slugs.js --force      # Re-discover even for mapped shows
 *                                                    # (re-probes each mapped id's current
 *                                                    # slug through the year rule too)
 *   node scripts/discover-dtli-slugs.js --force --shows=hamlet-2026,bug-2026
 *                                                    # Limit (re-)matching to these ids
 *
 * Year rule (BRO-4204 S7-T9): before a slug is assigned to a show whose year
 * is known (opening year, else previews year, else the id's trailing year),
 * the candidate page is fetched and its review-item years read. A page whose
 * dated reviews ALL predate the show is a different production's page and is
 * rejected — every-brilliant-thing-2026 had been mapped to the 2014 page,
 * hamlet-2026 to the 2008 one. Under --force a mapped id whose current slug
 * fails the rule is unmapped (logged), so the next gather stops reading the
 * wrong production's notices. Decision logic: pickBestDtliSlug /
 * dtliSlugPredatesShow / extractDtliReviewYears in scripts/lib/review-guards.js.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { pickBestDtliSlug, dtliSlugPredatesShow, extractDtliReviewYears, dtliShowYear } = require('./lib/review-guards');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const SLUG_MAP_PATH = path.join(__dirname, '..', 'data', 'dtli-slug-map.json');
const SITEMAP_INDEX_URL = 'https://didtheylikeit.com/sitemap_index.xml';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERIFY = args.includes('--verify');
const FORCE = args.includes('--force');
// --shows=a,b (or --shows a,b): only these show ids are (re-)matched and probed.
const SHOW_FILTER = (() => {
  const eq = args.find(a => a.startsWith('--shows='));
  const idx = args.indexOf('--shows');
  const raw = eq ? eq.slice('--shows='.length) : (idx >= 0 ? args[idx + 1] : null);
  if (!raw) return null;
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
})();

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const options = {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0; +https://broadwayscorecard.com)',
        'Accept': 'text/xml, application/xml, text/html, */*'
      }
    };
    const req = https.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = res.headers.location;
        if (redirectUrl) {
          httpGet(redirectUrl.startsWith('http') ? redirectUrl : `https://didtheylikeit.com${redirectUrl}`)
            .then(resolve).catch(reject);
          return;
        }
      }
      if (res.statusCode !== 200) {
        resolve({ ok: false, status: res.statusCode });
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ ok: true, body: data }));
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Load shows from shows.json
 */
function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return data.shows || data;
}

/**
 * Load existing slug map
 */
function loadSlugMap() {
  try {
    return JSON.parse(fs.readFileSync(SLUG_MAP_PATH, 'utf8'));
  } catch {
    return { _meta: { lastUpdated: null, source: 'DTLI WordPress sitemaps', totalDtliSlugs: 0, matchedShows: 0, unmatchedSlugs: [] }, shows: {} };
  }
}

/**
 * Fetch sitemap index to find all show sitemap URLs
 */
async function fetchSitemapUrls() {
  console.log('Fetching sitemap index...');
  const result = await httpGet(SITEMAP_INDEX_URL);
  if (result.ok) {
    const urls = [];
    const regex = /<loc>(https:\/\/didtheylikeit\.com\/shows-sitemap\d+\.xml)<\/loc>/g;
    let match;
    while ((match = regex.exec(result.body)) !== null) {
      urls.push(match[1]);
    }
    if (urls.length > 0) {
      console.log(`  Found ${urls.length} show sitemaps from index`);
      return urls;
    }
  }

  // Fallback: try individual sitemap URLs directly (1-20)
  console.log(`Sitemap index unavailable (${result.error || result.status}), trying individual sitemaps...`);
  const urls = [];
  for (let i = 1; i <= 20; i++) {
    const url = `https://didtheylikeit.com/shows-sitemap${i}.xml`;
    const res = await httpGet(url);
    if (res.ok && res.body && res.body.includes('<loc>')) {
      urls.push(url);
    } else {
      // Once we hit a missing one, stop probing
      if (i > 5) break;
    }
    await sleep(500);
  }
  console.log(`  Found ${urls.length} show sitemaps via direct probe`);
  return urls;
}

/**
 * Extract show-level slugs from a sitemap XML
 * Show pages match /shows/{slug}/ but NOT /shows/{slug}/{review-slug}/
 */
function extractShowSlugs(xml) {
  const slugs = [];
  const regex = /<loc>https:\/\/didtheylikeit\.com\/shows\/([^/]+)\/<\/loc>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const slug = match[1];
    // Skip the /shows/ index page itself (empty slug or "all")
    if (slug && slug !== 'all') {
      slugs.push(slug);
    }
  }
  return [...new Set(slugs)]; // deduplicate
}

/**
 * Build lookup indices for matching DTLI slugs to our shows
 */
function buildMatchIndices(shows) {
  const indices = {
    bySlugBase: new Map(),      // show slug without year → [shows]
    byTitleSlug: new Map(),     // slugified title → [shows]
    byTitleNoArticle: new Map() // title without leading article → [shows]
  };

  for (const show of shows) {
    // slug base: "hamilton-2015" → "hamilton"
    const slugBase = show.id.replace(/-\d{4}$/, '');
    if (!indices.bySlugBase.has(slugBase)) indices.bySlugBase.set(slugBase, []);
    indices.bySlugBase.get(slugBase).push(show);

    // title slug: "The Book of Mormon" → "the-book-of-mormon"
    const titleSlug = slugify(show.title);
    if (!indices.byTitleSlug.has(titleSlug)) indices.byTitleSlug.set(titleSlug, []);
    indices.byTitleSlug.get(titleSlug).push(show);

    // title without article: "The Lion King" → "lion-king"
    const titleNoArticle = slugify(show.title.replace(/^(the|a|an)\s+/i, ''));
    if (!indices.byTitleNoArticle.has(titleNoArticle)) indices.byTitleNoArticle.set(titleNoArticle, []);
    indices.byTitleNoArticle.get(titleNoArticle).push(show);
  }

  return indices;
}

/**
 * Strip common DTLI suffixes to get the base show name
 */
function stripDtliSuffixes(slug) {
  return slug
    .replace(/-bway$/, '')
    .replace(/-broadway$/, '')
    .replace(/-review$/, '')
    .replace(/-reviews$/, '')
    .replace(/-the-musical$/, '')
    .replace(/-revival$/, '');
}

/**
 * Try to match a DTLI slug to one of our shows
 * Returns { showId, confidence } or null
 */
function matchDtliSlug(dtliSlug, indices) {
  // Strip numeric suffixes like -2, -3 (used for revivals)
  const withoutNumSuffix = dtliSlug.replace(/-\d+$/, '');
  const stripped = stripDtliSuffixes(dtliSlug);
  const strippedNoNum = stripDtliSuffixes(withoutNumSuffix);

  // Try direct matches first (most reliable)
  const candidates = [dtliSlug, withoutNumSuffix, stripped, strippedNoNum];

  for (const candidate of candidates) {
    // Match by slug base
    const bySlug = indices.bySlugBase.get(candidate);
    if (bySlug && bySlug.length === 1) {
      return { showId: bySlug[0].id, confidence: 'high', matchType: 'slug-base' };
    }

    // Match by title slug
    const byTitle = indices.byTitleSlug.get(candidate);
    if (byTitle && byTitle.length === 1) {
      return { showId: byTitle[0].id, confidence: 'high', matchType: 'title-slug' };
    }

    // Match by title without article
    const byNoArticle = indices.byTitleNoArticle.get(candidate);
    if (byNoArticle && byNoArticle.length === 1) {
      return { showId: byNoArticle[0].id, confidence: 'high', matchType: 'title-no-article' };
    }
  }

  // For ambiguous matches (multiple shows with same title), pick the most recent
  for (const candidate of candidates) {
    const bySlug = indices.bySlugBase.get(candidate);
    if (bySlug && bySlug.length > 1) {
      // DTLI numeric suffix correlates with production order
      // -2 = second production, -3 = third, etc.
      const numSuffix = dtliSlug.match(/-(\d+)$/);
      if (numSuffix) {
        const n = parseInt(numSuffix[1]);
        // Sort by opening date ascending, pick nth
        const sorted = [...bySlug].sort((a, b) => {
          const dateA = a.openingDate || a.previewsStartDate || '9999';
          const dateB = b.openingDate || b.previewsStartDate || '9999';
          return dateA.localeCompare(dateB);
        });
        if (n <= sorted.length) {
          return { showId: sorted[n - 1].id, confidence: 'medium', matchType: 'numeric-suffix-order' };
        }
      }

      // No numeric suffix — pick most recent (most likely what DTLI's base slug refers to)
      const sorted = [...bySlug].sort((a, b) => {
        const dateA = a.openingDate || a.previewsStartDate || '0000';
        const dateB = b.openingDate || b.previewsStartDate || '0000';
        return dateB.localeCompare(dateA);
      });
      return { showId: sorted[0].id, confidence: 'low', matchType: 'most-recent-ambiguous' };
    }

    const byTitle = indices.byTitleSlug.get(candidate);
    if (byTitle && byTitle.length > 1) {
      const numSuffix = dtliSlug.match(/-(\d+)$/);
      if (numSuffix) {
        const n = parseInt(numSuffix[1]);
        const sorted = [...byTitle].sort((a, b) => {
          const dateA = a.openingDate || a.previewsStartDate || '9999';
          const dateB = b.openingDate || b.previewsStartDate || '9999';
          return dateA.localeCompare(dateB);
        });
        if (n <= sorted.length) {
          return { showId: sorted[n - 1].id, confidence: 'medium', matchType: 'numeric-suffix-title-order' };
        }
      }
      const sorted = [...byTitle].sort((a, b) => {
        const dateA = a.openingDate || a.previewsStartDate || '0000';
        const dateB = b.openingDate || b.previewsStartDate || '0000';
        return dateB.localeCompare(dateA);
      });
      return { showId: sorted[0].id, confidence: 'low', matchType: 'most-recent-title-ambiguous' };
    }

    const byNoArticle = indices.byTitleNoArticle.get(candidate);
    if (byNoArticle && byNoArticle.length > 1) {
      const sorted = [...byNoArticle].sort((a, b) => {
        const dateA = a.openingDate || a.previewsStartDate || '0000';
        const dateB = b.openingDate || b.previewsStartDate || '0000';
        return dateB.localeCompare(dateA);
      });
      return { showId: sorted[0].id, confidence: 'low', matchType: 'most-recent-no-article-ambiguous' };
    }
  }

  return null;
}

/**
 * Year-rule probe: fetch each candidate's DTLI page and read its review-item
 * years. A failed fetch yields null (= no evidence; pickBestDtliSlug never
 * rejects on a null), an empty page yields [] (same treatment).
 *
 * @param {string[]} slugs
 * @param {(url: string) => Promise<{ok: boolean, body?: string}>} [fetchFn] - injectable for tests
 * @returns {Promise<Record<string, number[]|null>>}
 */
async function probeCandidateYears(slugs, fetchFn = httpGet) {
  const out = {};
  for (const slug of slugs) {
    const result = await fetchFn(`https://didtheylikeit.com/shows/${slug}/`);
    out[slug] = result && result.ok && result.body ? extractDtliReviewYears(result.body) : null;
    await sleep(200); // Be gentle
  }
  return out;
}

function describeYears(years) {
  if (years === null || years === undefined) return 'probe failed';
  if (years.length === 0) return 'no dated reviews';
  const uniq = [...new Set(years)].sort();
  return `${years.length} review(s), ${uniq.join('/')}`;
}

/**
 * Verify that mapped URLs still return 200
 */
async function verifyMappedUrls(slugMap) {
  const entries = Object.entries(slugMap.shows);
  console.log(`\nVerifying ${entries.length} mapped URLs...`);
  let working = 0;
  let broken = 0;
  const brokenList = [];

  for (const [showId, dtliSlug] of entries) {
    const url = `https://didtheylikeit.com/shows/${dtliSlug}/`;
    const result = await httpGet(url);
    if (result.ok) {
      working++;
    } else {
      broken++;
      brokenList.push({ showId, dtliSlug, status: result.status || result.error });
    }
    if ((working + broken) % 50 === 0) {
      console.log(`  Checked ${working + broken}/${entries.length}...`);
    }
    await sleep(200); // Be gentle
  }

  console.log(`\n  Working: ${working}, Broken: ${broken}`);
  if (brokenList.length > 0) {
    console.log('  Broken URLs:');
    for (const b of brokenList) {
      console.log(`    ${b.showId} → ${b.dtliSlug} (${b.status})`);
    }
  }
}

async function main() {
  const shows = loadShows();
  const slugMap = loadSlugMap();
  const indices = buildMatchIndices(shows);

  console.log(`Loaded ${shows.length} shows, ${Object.keys(slugMap.shows).length} existing mappings`);

  if (VERIFY) {
    await verifyMappedUrls(slugMap);
    return;
  }

  // Step 1: Fetch all sitemaps and extract show slugs
  const sitemapUrls = await fetchSitemapUrls();
  if (sitemapUrls.length === 0) {
    const existingCount = Object.keys(slugMap.shows || {}).length;
    if (existingCount > 0) {
      console.log(`No sitemaps reachable, but existing slug map has ${existingCount} entries. Keeping existing map.`);
      process.exit(0);
    }
    console.error('No sitemaps found and no existing slug map!');
    process.exit(1);
  }

  const allDtliSlugs = [];
  for (const sitemapUrl of sitemapUrls) {
    const result = await httpGet(sitemapUrl);
    if (!result.ok) {
      console.warn(`  Failed to fetch ${sitemapUrl}`);
      continue;
    }
    const slugs = extractShowSlugs(result.body);
    allDtliSlugs.push(...slugs);
    console.log(`  ${path.basename(sitemapUrl)}: ${slugs.length} show pages`);
    await sleep(500);
  }

  const uniqueSlugs = [...new Set(allDtliSlugs)];
  console.log(`\nTotal unique DTLI show slugs: ${uniqueSlugs.length}`);

  // Step 2: Match each slug to our shows
  let newMatches = 0;
  let skippedExisting = 0;
  let unmatched = 0;
  const unmatchedSlugs = [];
  const allMatches = {};

  // Build reverse map: showId → dtliSlug (from existing map)
  const existingReverse = new Map();
  for (const [showId, dtliSlug] of Object.entries(slugMap.shows)) {
    existingReverse.set(showId, dtliSlug);
  }

  // Collect ALL candidate slugs per show before picking the best one.
  // This prevents "first wins" bias where the bare slug (e.g. "giant") locks out
  // the correct revival slug (e.g. "giant-2") for shows that are revivals.
  const candidatesByShow = {}; // showId → [{ dtliSlug, ...match }]
  const showsById = new Map(shows.map(s => [s.id, s]));

  for (const dtliSlug of uniqueSlugs) {
    // Skip if already mapped (unless --force)
    const alreadyMapped = Object.values(slugMap.shows).includes(dtliSlug);
    if (alreadyMapped && !FORCE) {
      skippedExisting++;
      continue;
    }

    const match = matchDtliSlug(dtliSlug, indices);
    if (match) {
      if (SHOW_FILTER && !SHOW_FILTER.has(match.showId)) continue;
      if (!candidatesByShow[match.showId]) candidatesByShow[match.showId] = [];
      candidatesByShow[match.showId].push({ dtliSlug, ...match });
    } else {
      unmatched++;
      unmatchedSlugs.push(dtliSlug);
    }
  }

  // --force re-probes every mapped id's CURRENT slug through the year rule,
  // even when the sitemap matched no other candidate for it (that is the
  // every-brilliant-thing case: the wrong page was the only mapping).
  if (FORCE) {
    for (const [showId, mappedSlug] of existingReverse) {
      if (SHOW_FILTER && !SHOW_FILTER.has(showId)) continue;
      if (!candidatesByShow[showId]) candidatesByShow[showId] = [];
      if (!candidatesByShow[showId].some(c => c.dtliSlug === mappedSlug)) {
        candidatesByShow[showId].push({ dtliSlug: mappedSlug, showId, confidence: 'high', matchType: 'existing-mapping' });
      }
    }
  }

  // Pick the best slug for each show from its candidates.
  // For revival shows (ID has year suffix like -2026), prefer the DTLI slug with a
  // numeric suffix (e.g. "giant-2" over "giant") — the suffix indicates production order.
  // This prevents old-production bare slugs from blocking the correct revival slug.
  //
  // Year rule (S7-T9): when the show's year is known, every candidate page is
  // probed first and a page whose dated reviews all predate the show is
  // rejected — see the header. `unmappedByYear` collects mapped ids whose
  // current slug failed under --force; they are removed at write time.
  const unmappedByYear = {}; // showId → rejected slug
  let yearRuleRejections = 0;
  const probeTargets = Object.entries(candidatesByShow).filter(([showId]) => !(existingReverse.has(showId) && !FORCE));
  const probeCount = probeTargets.reduce((n, [showId, candidates]) => n + (dtliShowYear(showsById.get(showId) || { id: showId }) ? candidates.length : 0), 0);
  if (probeCount > 0) console.log(`\nYear rule: probing ${probeCount} candidate page(s) across ${probeTargets.length} show(s)...`);

  for (const [showId, candidates] of Object.entries(candidatesByShow)) {
    // Don't overwrite high-confidence existing mappings with low-confidence new ones
    if (existingReverse.has(showId) && !FORCE) {
      skippedExisting++;
      continue;
    }

    const show = showsById.get(showId) || { id: showId };
    const showYear = dtliShowYear(show);
    const mappedSlug = existingReverse.get(showId) || null;
    const slugs = candidates.map(c => c.dtliSlug);
    const reviewYearsBySlug = showYear ? await probeCandidateYears(slugs) : null;

    // Revival preference: for shows with a year suffix (e.g. giant-2026), pick the DTLI slug
    // with the highest numeric suffix (e.g. giant-2 over giant). Logic lives in review-guards.js.
    const bestSlug = pickBestDtliSlug(showId, slugs, { reviewYearsBySlug, showYear });
    if (reviewYearsBySlug) {
      for (const s of slugs) {
        if (dtliSlugPredatesShow(reviewYearsBySlug[s], showYear)) {
          yearRuleRejections++;
          console.log(`  ✗ Year rule: ${showId} (${showYear}) rejects ${s} — ${describeYears(reviewYearsBySlug[s])}${s === mappedSlug ? ' [current mapping]' : ''}`);
        }
      }
    }
    if (!bestSlug) {
      if (mappedSlug && dtliSlugPredatesShow(reviewYearsBySlug && reviewYearsBySlug[mappedSlug], showYear)) {
        unmappedByYear[showId] = mappedSlug;
        console.log(`  ⚠ ${showId}: current mapping ${mappedSlug} fails the year rule and no candidate replaces it — will be UNMAPPED`);
      }
      continue;
    }

    let best = candidates.find(c => c.dtliSlug === bestSlug) || candidates[0];
    if (best.dtliSlug === mappedSlug) {
      // Re-probed under --force and the existing mapping still wins — nothing to write.
      continue;
    }
    if (best.dtliSlug !== candidates[0].dtliSlug) {
      console.log(`  ⚡ Revival preference: ${showId} → ${best.dtliSlug} (over ${candidates.map(c => c.dtliSlug).filter(s => s !== best.dtliSlug).join(', ')})`);
    }
    if (mappedSlug) {
      console.log(`  ↻ ${showId}: ${mappedSlug} → ${best.dtliSlug}${reviewYearsBySlug ? ` (${describeYears(reviewYearsBySlug[best.dtliSlug])})` : ''}`);
    }

    allMatches[showId] = best;
    newMatches++;
  }

  console.log(`\nResults:`);
  console.log(`  New matches: ${newMatches}`);
  console.log(`  Already mapped (skipped): ${skippedExisting}`);
  console.log(`  Unmatched DTLI slugs: ${unmatched}`);
  console.log(`  Year-rule rejections: ${yearRuleRejections} (unmapping ${Object.keys(unmappedByYear).length})`);

  // Print confidence breakdown
  const byConfidence = { high: 0, medium: 0, low: 0 };
  for (const m of Object.values(allMatches)) {
    byConfidence[m.confidence]++;
  }
  console.log(`  Confidence: ${byConfidence.high} high, ${byConfidence.medium} medium, ${byConfidence.low} low`);

  if (unmatchedSlugs.length > 0 && unmatchedSlugs.length <= 30) {
    console.log(`\nUnmatched DTLI slugs (may be off-Broadway or not in our DB):`);
    for (const s of unmatchedSlugs) {
      console.log(`  - ${s}`);
    }
  } else if (unmatchedSlugs.length > 30) {
    console.log(`\nFirst 30 unmatched DTLI slugs:`);
    for (const s of unmatchedSlugs.slice(0, 30)) {
      console.log(`  - ${s}`);
    }
  }

  // Print new matches
  if (newMatches > 0 && newMatches <= 50) {
    console.log(`\nNew matches:`);
    for (const [showId, m] of Object.entries(allMatches)) {
      console.log(`  ${showId} → ${m.dtliSlug} (${m.confidence}, ${m.matchType})`);
    }
  }

  if (Object.keys(unmappedByYear).length > 0) {
    console.log(`\nUnmapped by the year rule:`);
    for (const [showId, slug] of Object.entries(unmappedByYear)) {
      console.log(`  ${showId} ✗ ${slug}`);
    }
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No changes written.');
    return;
  }

  // Step 3: Merge new matches into slug map; drop mappings the year rule rejected.
  for (const showId of Object.keys(unmappedByYear)) {
    delete slugMap.shows[showId];
  }
  for (const [showId, m] of Object.entries(allMatches)) {
    slugMap.shows[showId] = m.dtliSlug;
  }

  // Update metadata
  slugMap._meta.lastUpdated = new Date().toISOString();
  slugMap._meta.totalDtliSlugs = uniqueSlugs.length;
  slugMap._meta.matchedShows = Object.keys(slugMap.shows).length;
  slugMap._meta.unmatchedSlugs = unmatchedSlugs;

  // Write atomically
  const tmpPath = SLUG_MAP_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(slugMap, null, 2) + '\n');
  fs.renameSync(tmpPath, SLUG_MAP_PATH);

  console.log(`\nWrote ${Object.keys(slugMap.shows).length} total mappings to ${path.relative(process.cwd(), SLUG_MAP_PATH)}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
