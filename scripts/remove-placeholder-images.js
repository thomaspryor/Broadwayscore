#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const PLACEHOLDER_FILE_HASHES = new Set([
  'b4d7d1bdb443e0a94e69ac8a5abd6f40',
  'ac3ea27f64c633474ad93fd826f614e7',
  '4aed489bb69c5c49be3315e3f85b342f',
]);

const SHOWS_DIR = path.join(__dirname, '../public/images/shows');
const SHOWS_JSON = path.join(__dirname, '../data/shows.json');

const showDirs = fs.readdirSync(SHOWS_DIR).filter(d =>
  fs.statSync(path.join(SHOWS_DIR, d)).isDirectory()
);

const affectedShows = new Set();
let removed = 0;

for (const dir of showDirs) {
  const dirPath = path.join(SHOWS_DIR, dir);
  const files = fs.readdirSync(dirPath).filter(f => /\.(webp|jpg|png)$/i.test(f));
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const buf = fs.readFileSync(filePath);
    const hash = crypto.createHash('md5').update(buf).digest('hex');
    if (PLACEHOLDER_FILE_HASHES.has(hash)) {
      fs.unlinkSync(filePath);
      removed++;
      affectedShows.add(dir);
      console.log(`  Removed: ${dir}/${file}`);
    }
  }
  // Remove empty dirs
  const remaining = fs.readdirSync(dirPath);
  if (remaining.length === 0) {
    fs.rmdirSync(dirPath);
    console.log(`  Removed empty dir: ${dir}/`);
  }
}

console.log(`\nRemoved ${removed} placeholder files from ${affectedShows.size} shows.`);

// Clear image refs in shows.json
const data = loadShows();
let updated = 0;
for (const show of data.shows) {
  if (!affectedShows.has(show.id)) continue;
  if (!show.images) continue;
  const dirPath = path.join(SHOWS_DIR, show.id);
  const dirExists = fs.existsSync(dirPath);
  const remaining = dirExists ? fs.readdirSync(dirPath) : [];
  for (const key of ['hero', 'poster', 'thumbnail']) {
    const imgPath = show.images[key];
    if (!imgPath || !imgPath.startsWith('/images/')) continue;
    const localFile = path.join(__dirname, '../public', imgPath);
    if (!fs.existsSync(localFile)) {
      show.images[key] = null;
      updated++;
    }
  }
}

if (updated > 0) {
  saveShows(data);
  console.log(`Cleared ${updated} image references in shows.json.`);
}
