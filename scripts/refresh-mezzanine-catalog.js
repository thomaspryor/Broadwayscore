#!/usr/bin/env node
/**
 * Weekly delta refresh for data/diary-shows.json.
 *
 * import-mezzanine-historical.js did a one-off March 2026 snapshot of
 * ratingsCount>0 productions and never runs again — so a show a user rates
 * for the first time next month never enters the catalog on its own (Notion
 * 39d637c5). This script queries Mezzanine for Productions updated since the
 * last watermark (any rating activity bumps `updatedAt`), merges them into
 * diary-shows.json by mezzanineId, and advances the watermark.
 *
 * min-ratings=1 (vs. the historical import's 3) — a weekly delta is small
 * enough to afford being more inclusive; catching a show the day it gets its
 * first rating matters more here than filtering noise does.
 *
 * Usage:
 *   node scripts/refresh-mezzanine-catalog.js [--dry-run] [--verbose]
 *
 * Environment variables:
 *   MEZZANINE_APP_ID, MEZZANINE_SESSION_TOKEN — Mezzanine Parse API
 *
 * Exit codes: 0 success, 1 unexpected error, 2 Mezzanine auth failure.
 */

const fs = require('fs');
const path = require('path');
const { queryParse, sleep } = require('./lib/mezzanine-parse-client.js');
const { productionToDiaryEntry, buildDiarySlug } = require('./lib/mezzanine-classify.js');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const MIN_RATINGS = 1;
const BATCH_SIZE = 1000;

const dataDir = path.join(__dirname, '..', 'data');
const showsPath = path.join(dataDir, 'shows.json');
const diaryShowsPath = path.join(dataDir, 'diary-shows.json');
const watermarkPath = path.join(dataDir, 'audit', 'mezzanine-catalog-watermark.json');

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function loadWatermark() {
  const state = loadJson(watermarkPath, null);
  if (state?.updatedAt) return state.updatedAt;
  // No prior watermark — this only happens on the very first run or if the
  // state file was lost/reset. Bootstrapping from "24h ago" would silently
  // convert a lost-state event into "skip everything older than yesterday"
  // (ship-check finding) with no visible symptom. 8 days covers a full missed
  // weekly run plus a buffer, and we log loudly so a lost watermark is at
  // least visible in the run output instead of a silent scope-narrowing.
  console.warn('No prior watermark found — bootstrapping from 8 days ago (safe default, not a normal steady-state path).');
  return new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
}

async function fetchUpdatedProductions(sinceIso) {
  const all = [];
  let skip = 0;
  while (true) {
    const res = await queryParse('Production', {
      limit: BATCH_SIZE,
      skip,
      where: {
        updatedAt: { $gt: { __type: 'Date', iso: sinceIso } },
        ratingsCount: { $gte: MIN_RATINGS },
      },
      include: 'show,theater',
      _method: 'GET',
    });
    const results = res.results || [];
    if (results.length === 0) break;
    all.push(...results);
    skip += results.length;
    if (results.length < BATCH_SIZE) break;
    await sleep(500);
  }
  return all;
}

async function main() {
  console.log('Refresh Mezzanine Catalog (weekly delta)');
  console.log('=========================================\n');

  const runStartedAt = new Date().toISOString();
  const sinceIso = loadWatermark();
  console.log(`Delta since: ${sinceIso}`);
  console.log(`Dry run: ${dryRun}\n`);

  const showsData = loadJson(showsPath, { shows: [] });
  const existingIds = new Set(showsData.shows.map((s) => s.id));
  const existingSlugs = new Set(showsData.shows.map((s) => s.slug));

  const diaryData = loadJson(diaryShowsPath, { shows: [] });
  const diaryShows = diaryData.shows;
  const byMezzId = new Map(diaryShows.filter((s) => s.mezzanineId).map((s) => [s.mezzanineId, s]));
  const usedSlugs = new Set([...existingIds, ...existingSlugs, ...diaryShows.map((s) => s.slug)]);

  const productions = await fetchUpdatedProductions(sinceIso);
  console.log(`Fetched ${productions.length} updated production(s) from Mezzanine\n`);

  const stats = { added: 0, updated: 0, broadwaySkip: 0, noShow: 0 };

  for (const p of productions) {
    const entry = productionToDiaryEntry(p);
    if (!entry) { stats.broadwaySkip++; continue; }
    if (!entry.title) { stats.noShow++; continue; }

    const existing = byMezzId.get(entry.mezzanineId);
    if (existing) {
      // Refresh the fields Mezzanine can actually change post-creation.
      existing.audienceScore = entry.audienceScore;
      existing.audienceRatingsCount = entry.audienceRatingsCount;
      existing.venue = entry.venue || existing.venue;
      existing.city = entry.city || existing.city;
      existing.country = entry.country || existing.country;
      if (entry.posterUrl) existing.posterUrl = entry.posterUrl;
      stats.updated++;
      if (verbose) console.log(`  updated: ${existing.title} (${existing.id})`);
      continue;
    }

    if (existingIds.has(entry.mezzanineId)) continue; // already a scored show, not diary-only

    const slug = buildDiarySlug(entry.title, entry.category, entry.mezzanineId, usedSlugs);
    entry.id = slug;
    entry.slug = slug;
    diaryShows.push(entry);
    byMezzId.set(entry.mezzanineId, entry);
    usedSlugs.add(slug);
    stats.added++;
    if (verbose) console.log(`  added: ${entry.title} (${slug})`);
  }

  console.log('\n=== Stats ===');
  console.log(JSON.stringify(stats, null, 2));

  if (dryRun) {
    console.log('\n[DRY RUN] No writes to diary-shows.json or watermark.');
    return;
  }

  if (stats.added > 0 || stats.updated > 0) {
    const output = { shows: diaryShows, lastUpdated: new Date().toISOString() };
    fs.writeFileSync(diaryShowsPath, JSON.stringify(output, null, 2));
    console.log(`\nWrote ${diaryShowsPath} (${diaryShows.length} total shows)`);
  } else {
    console.log('\nNo changes to diary-shows.json.');
  }

  fs.mkdirSync(path.dirname(watermarkPath), { recursive: true });
  fs.writeFileSync(watermarkPath, JSON.stringify({ updatedAt: runStartedAt }, null, 2));
  console.log(`Advanced watermark to ${runStartedAt}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  if (err.authFailed) process.exit(2);
  process.exit(1);
});
