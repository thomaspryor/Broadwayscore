#!/usr/bin/env node
/**
 * One-time script to compress existing oversized images in public/images/shows/.
 * Targets: thumbnail ≤50KB, poster ≤150KB, hero ≤300KB.
 *
 * Usage: node scripts/compress-existing-images.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { compressImage, SIZE_LIMITS } = require('./lib/compress-image');

const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images', 'shows');
const dryRun = process.argv.includes('--dry-run');

function getImageType(filename) {
  if (filename.startsWith('thumbnail')) return 'thumbnail';
  if (filename.startsWith('poster')) return 'poster';
  if (filename.startsWith('hero')) return 'hero';
  return null;
}

async function main() {
  const showDirs = fs.readdirSync(IMAGES_DIR).filter(d =>
    fs.statSync(path.join(IMAGES_DIR, d)).isDirectory()
  );

  let totalBefore = 0;
  let totalAfter = 0;
  let compressed = 0;
  let skipped = 0;

  for (const showId of showDirs) {
    const showDir = path.join(IMAGES_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));

    for (const file of files) {
      const filePath = path.join(showDir, file);
      const type = getImageType(file);
      if (!type) continue;

      const limits = SIZE_LIMITS[type];
      const stat = fs.statSync(filePath);

      if (stat.size <= limits.maxBytes) {
        skipped++;
        continue;
      }

      const buffer = fs.readFileSync(filePath);
      totalBefore += buffer.length;

      const result = await compressImage(buffer, type);
      totalAfter += result.length;

      if (result.length < buffer.length) {
        const savings = ((1 - result.length / buffer.length) * 100).toFixed(0);
        console.log(`${showId}/${file}: ${(buffer.length/1024).toFixed(0)}KB → ${(result.length/1024).toFixed(0)}KB (-${savings}%)`);
        if (!dryRun) {
          fs.writeFileSync(filePath, result);
        }
        compressed++;
      } else {
        console.log(`${showId}/${file}: ${(buffer.length/1024).toFixed(0)}KB — already optimal`);
        totalAfter = totalAfter - result.length + buffer.length; // restore original size
        skipped++;
      }
    }
  }

  console.log(`\n${dryRun ? '[DRY RUN] ' : ''}Done: ${compressed} compressed, ${skipped} already within limits`);
  if (compressed > 0) {
    console.log(`Total savings: ${((totalBefore - totalAfter) / 1024 / 1024).toFixed(1)}MB (${((1 - totalAfter / totalBefore) * 100).toFixed(0)}%)`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
