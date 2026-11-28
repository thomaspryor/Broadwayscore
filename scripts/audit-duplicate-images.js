#!/usr/bin/env node
// Audit: find all multi-production shows where productions share image files (md5 collision)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHOWS = JSON.parse(fs.readFileSync('./data/shows.json', 'utf8')).shows;
const IMG_ROOT = './public/images/shows';

// Group shows by base title (strip year suffix)
function baseTitle(t) {
  return (t || '').toLowerCase()
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/['\u2018\u2019\u201C\u201D!:,.;\-\u2013\u2014&+()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^the\s+/, '')
    .trim();
}

const byBase = new Map();
for (const s of SHOWS) {
  if (!s.title) continue;
  const b = baseTitle(s.title);
  if (!byBase.has(b)) byBase.set(b, []);
  byBase.get(b).push(s);
}

function md5OfFile(p) {
  try {
    return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
  } catch { return null; }
}

const conflicts = []; // [{title, format, hash, ids: [...]}]
let groupsChecked = 0;
for (const [base, shows] of byBase.entries()) {
  if (shows.length < 2) continue;
  groupsChecked++;
  for (const format of ['hero', 'poster', 'thumbnail']) {
    const byHash = new Map();
    for (const s of shows) {
      const dir = path.join(IMG_ROOT, s.id);
      if (!fs.existsSync(dir)) continue;
      // try common extensions
      let file = null;
      for (const ext of ['webp','jpg','jpeg','png']) {
        const p = path.join(dir, `${format}.${ext}`);
        if (fs.existsSync(p)) { file = p; break; }
      }
      if (!file) continue;
      const h = md5OfFile(file);
      if (!h) continue;
      if (!byHash.has(h)) byHash.set(h, []);
      byHash.get(h).push(s.id);
    }
    for (const [hash, ids] of byHash.entries()) {
      if (ids.length > 1) {
        conflicts.push({ base, format, hash, ids });
      }
    }
  }
}

console.log(`Multi-production groups: ${groupsChecked}`);
console.log(`Conflicts (same hash across productions): ${conflicts.length}\n`);
const byBaseConflicts = new Map();
for (const c of conflicts) {
  if (!byBaseConflicts.has(c.base)) byBaseConflicts.set(c.base, []);
  byBaseConflicts.get(c.base).push(c);
}
for (const [base, list] of byBaseConflicts.entries()) {
  console.log(`== ${base} ==`);
  for (const c of list) {
    console.log(`  ${c.format}: ${c.ids.join(', ')}`);
  }
}

// Save list of unique affected show IDs
const affected = new Set();
for (const c of conflicts) c.ids.forEach(id => affected.add(id));
fs.writeFileSync('/tmp/affected_image_shows.json', JSON.stringify({
  count: affected.size,
  shows: [...affected].sort(),
  conflicts,
}, null, 2));
console.log(`\nUnique affected shows: ${affected.size} → /tmp/affected_image_shows.json`);
