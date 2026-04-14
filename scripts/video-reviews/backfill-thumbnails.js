#!/usr/bin/env node
/**
 * Backfill missing thumbnails in data/video-reviews.json.
 *
 * For each review with thumbnail === null, download the video's thumbnail via
 * yt-dlp, save as /images/video-reviews/{handle}-{showId}.jpg, and update the
 * JSON in place.
 *
 * Usage: node scripts/video-reviews/backfill-thumbnails.js [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '../..');
const DATA_PATH = path.join(REPO_ROOT, 'data/video-reviews.json');
const OUT_DIR = path.join(REPO_ROOT, 'public/images/video-reviews');

const DRY = process.argv.includes('--dry-run');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const raw = fs.readFileSync(DATA_PATH, 'utf8');
const data = JSON.parse(raw);

const missing = [];
for (const [showId, value] of Object.entries(data)) {
  if (showId === '_meta') continue;
  if (!Array.isArray(value)) continue;
  for (let i = 0; i < value.length; i++) {
    const r = value[i];
    if (!r || r.thumbnail) continue;
    missing.push({ showId, index: i, review: r });
  }
}

console.log(`Found ${missing.length} reviews with missing thumbnails`);

let ok = 0;
let fail = 0;
const failures = [];

for (const { showId, index, review } of missing) {
  const fileBase = `${review.handle}-${showId}`;
  const finalPath = path.join(OUT_DIR, `${fileBase}.jpg`);
  const publicRel = `/images/video-reviews/${fileBase}.jpg`;

  if (fs.existsSync(finalPath)) {
    console.log(`  ✓ [${showId}] ${review.creatorName}: file already exists, just updating JSON`);
    data[showId][index].thumbnail = publicRel;
    ok++;
    continue;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vthumb-'));
  const tmpTemplate = path.join(tmpDir, 'thumb.%(ext)s');
  try {
    console.log(`  ↓ [${showId}] ${review.creatorName} (${review.platform})`);
    if (DRY) { ok++; continue; }
    execFileSync('yt-dlp', [
      '--write-thumbnail',
      '--skip-download',
      '--no-warnings',
      '-o', tmpTemplate,
      review.videoUrl,
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });

    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('thumb.'));
    if (files.length === 0) throw new Error('no thumbnail written by yt-dlp');
    const src = path.join(tmpDir, files[0]);

    fs.copyFileSync(src, finalPath);
    data[showId][index].thumbnail = publicRel;
    ok++;
    console.log(`    → saved ${publicRel}`);
  } catch (e) {
    fail++;
    failures.push({ showId, creator: review.creatorName, url: review.videoUrl, error: String(e.message || e).split('\n')[0] });
    console.log(`    ✗ failed: ${String(e.message || e).split('\n')[0]}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

if (!DRY && ok > 0) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`\nWrote ${DATA_PATH}`);
}

console.log(`\nDone. ok=${ok} fail=${fail}`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - [${f.showId}] ${f.creator}: ${f.error}\n    ${f.url}`);
}
process.exit(fail > 0 && ok === 0 ? 1 : 0);
