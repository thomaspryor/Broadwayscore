#!/usr/bin/env node

/**
 * Audit TodayTix mappings for mismatches.
 *
 * Compares every todaytix-ids.json slug against its show title using word-overlap
 * analysis. Flags entries where the TodayTix slug doesn't match the show title.
 *
 * Two-tier threshold:
 *   <30% overlap → auto-clean (clearly wrong)
 *   30-60% overlap → manual review (borderline)
 *   >60% overlap → trusted (keep)
 *
 * Output: data/audit/bad-todaytix-mappings.json
 *
 * Usage: node scripts/audit-todaytix-mappings.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

// PINNED_IMAGES — shows whose images are never overwritten
const PINNED_IMAGES = new Set([
  'sunset-boulevard-2024', 'an-enemy-of-the-people-2024', 'waiting-for-godot-2025',
  'good-night-and-good-luck-2025', 'parade-2023', 'redwood-2025', 'smash-2025',
  'once-upon-a-mattress-2024', 'maybe-happy-ending-2024', 'romeo-juliet-2024', 'art-2025',
  'aladdin-2014', 'all-out-2025', 'and-juliet-2022', 'book-of-mormon-2011',
  'buena-vista-social-club-2025', 'bug-2026', 'chess-2025', 'chicago-1996',
  'death-becomes-her-2024', 'hadestown-2019', 'hamilton-2015', 'harry-potter-2021',
  'hells-kitchen-2024', 'just-in-time-2025', 'marjorie-prime-2025', 'mj-2022',
  'moulin-rouge-2019', 'oedipus-2025', 'oh-mary-2024', 'operation-mincemeat-2025',
  'ragtime-2025', 'six-2021', 'stranger-things-2024', 'the-great-gatsby-2024',
  'the-lion-king-1997', 'the-outsiders-2024', 'two-strangers-bway-2025', 'wicked-2003',
  'the-cripple-of-inishmaan-2014', 'november-2008', 'private-lives-2011',
]);

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[''""":!?,.\-–—()&]/g, '')
    .replace(/\bon broadway\b/g, '')
    .replace(/\bthe musical\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripYearSuffix(id) {
  return id.replace(/-\d{4}$/, '');
}

function getWordOverlap(showId, showTitle, todaytixSlug) {
  // Normalize slug: replace hyphens with spaces
  const slugWords = todaytixSlug.replace(/-/g, ' ').toLowerCase().split(/\s+/).filter(w => w.length > 0);

  // Normalize show title
  const titleWords = normalizeTitle(showTitle).split(/\s+/).filter(w => w.length > 0);

  if (titleWords.length === 0) return 1; // No words to match

  // What fraction of title words appear in the slug?
  const matched = titleWords.filter(w => slugWords.includes(w));
  return matched.length / titleWords.length;
}

function main() {
  // Load data files
  const todaytixIds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/todaytix-ids.json'), 'utf8'));
  const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));
  const shows = showsRaw.shows || showsRaw;
  const imageSources = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/image-sources.json'), 'utf8'));

  // Build show title lookup
  const showTitles = {};
  for (const show of shows) {
    showTitles[show.id] = show.title;
  }

  const badMappings = [];
  const borderline = [];
  const good = [];
  let noSlug = 0;

  for (const [showId, mapping] of Object.entries(todaytixIds.shows || {})) {
    if (!mapping.slug) {
      noSlug++;
      continue;
    }

    const showTitle = showTitles[showId];
    if (!showTitle) continue; // Unknown show

    const overlap = getWordOverlap(showId, showTitle, mapping.slug);
    const isPinned = PINNED_IMAGES.has(showId);

    // Check for image files
    const imageDir = path.join(ROOT, 'public/images/shows', showId);
    const hasPoster = fs.existsSync(path.join(imageDir, 'poster.webp'));
    const hasHero = fs.existsSync(path.join(imageDir, 'hero.webp'));
    const hasThumbnailWebp = fs.existsSync(path.join(imageDir, 'thumbnail.webp'));
    const hasThumbnailJpg = fs.existsSync(path.join(imageDir, 'thumbnail.jpg'));
    const hasThumbnail = hasThumbnailWebp || hasThumbnailJpg;

    // Check if thumbnail came from TodayTix (ctfassets.net)
    const sources = imageSources[showId] || {};
    const thumbnailFromTodayTix = !!(
      sources.thumbnail && sources.thumbnail.includes('ctfassets.net')
    );
    const posterFromTodayTix = !!(
      sources.poster && sources.poster.includes('ctfassets.net')
    );

    const entry = {
      showId,
      showTitle,
      slug: mapping.slug,
      todaytixId: mapping.id,
      matchRatio: Math.round(overlap * 100) / 100,
      hasPoster,
      hasHero,
      hasThumbnail,
      thumbnailFromTodayTix,
      posterFromTodayTix,
      isPinned,
    };

    if (overlap < 0.3) {
      entry.tier = 'auto-clean';
      badMappings.push(entry);
    } else if (overlap < 0.6) {
      entry.tier = 'manual-review';
      borderline.push(entry);
    } else {
      entry.tier = 'trusted';
      good.push(entry);
    }
  }

  // Combine bad + borderline for output
  const allBad = [...badMappings, ...borderline];

  // Write output
  const auditDir = path.join(ROOT, 'data/audit');
  if (!fs.existsSync(auditDir)) {
    fs.mkdirSync(auditDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(auditDir, 'bad-todaytix-mappings.json'),
    JSON.stringify(allBad, null, 2) + '\n'
  );

  // Summary
  console.log('=== TodayTix Mapping Audit ===\n');
  console.log(`Total mappings: ${Object.keys(todaytixIds.shows || {}).length}`);
  console.log(`  With slug: ${Object.values(todaytixIds.shows || {}).filter(m => m.slug).length}`);
  console.log(`  Without slug: ${noSlug}`);
  console.log('');
  console.log(`Trusted (>60% overlap): ${good.length}`);
  console.log(`Borderline (30-60%): ${borderline.length}`);
  console.log(`Auto-clean (<30%): ${badMappings.length}`);
  console.log('');

  // Image impact
  const autoWithPoster = badMappings.filter(e => e.hasPoster);
  const autoWithHero = badMappings.filter(e => e.hasHero);
  const autoWithThumbnailTtx = badMappings.filter(e => e.thumbnailFromTodayTix);
  const autoPinned = badMappings.filter(e => e.isPinned);

  console.log('Auto-clean image impact:');
  console.log(`  With wrong poster: ${autoWithPoster.length}`);
  console.log(`  With wrong hero: ${autoWithHero.length}`);
  console.log(`  With TodayTix thumbnail: ${autoWithThumbnailTtx.length}`);
  console.log(`  Protected by PINNED: ${autoPinned.length}`);
  console.log('');

  const borderWithPoster = borderline.filter(e => e.hasPoster);
  const borderWithHero = borderline.filter(e => e.hasHero);
  const borderPinned = borderline.filter(e => e.isPinned);

  console.log('Borderline image impact:');
  console.log(`  With poster: ${borderWithPoster.length}`);
  console.log(`  With hero: ${borderWithHero.length}`);
  console.log(`  Protected by PINNED: ${borderPinned.length}`);
  console.log('');

  // Show worst offenders
  console.log('=== Worst Mismatches (auto-clean with images) ===\n');
  const worstWithImages = badMappings
    .filter(e => e.hasPoster || e.hasHero)
    .sort((a, b) => a.matchRatio - b.matchRatio)
    .slice(0, 20);

  for (const e of worstWithImages) {
    console.log(`  ${e.showId} → ${e.slug} (${Math.round(e.matchRatio * 100)}%${e.isPinned ? ' PINNED' : ''})`);
  }

  console.log(`\nOutput: data/audit/bad-todaytix-mappings.json (${allBad.length} entries)`);
}

main();
