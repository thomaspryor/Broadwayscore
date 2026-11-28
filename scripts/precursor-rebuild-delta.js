#!/usr/bin/env node
/**
 * precursor-rebuild-delta.js — show per-show before/after diff of precursor
 * wins after a year-page rebuild.
 *
 * Mirrors the scoring-delta.js pattern that gates scoring-logic changes.
 * Run BEFORE committing a year-page scrape + enrich cycle so a human can
 * inspect the changes.
 *
 * Usage:
 *   node scripts/precursor-rebuild-delta.js <before.json> <after.json>
 *
 * Output:
 *   Per-show categories added / removed across dramadesk + outerCriticsCircle
 *   + dramaLeague + lortel. Summary table at the bottom.
 */

const fs = require('fs');

const beforeArg = process.argv[2];
const afterArg = process.argv[3] || 'data/awards.json';
if (!beforeArg) {
  console.error('Usage: node precursor-rebuild-delta.js <before.json> [<after.json>]');
  process.exit(1);
}

const before = JSON.parse(fs.readFileSync(beforeArg, 'utf8'));
const after = JSON.parse(fs.readFileSync(afterArg, 'utf8'));

const FIELDS = ['dramadesk', 'outerCriticsCircle', 'dramaLeague', 'lortel'];
const FIELD_DISPLAY = {
  dramadesk: 'DD',
  outerCriticsCircle: 'OCC',
  dramaLeague: 'DL',
  lortel: 'Lortel',
};

const allIds = new Set([
  ...Object.keys(before.shows || {}),
  ...Object.keys(after.shows || {}),
]);

const changes = []; // { id, field, added: [], removed: [] }
const stats = { added: 0, removed: 0, addedShows: 0, removedShows: 0 };
const perField = {};
for (const f of FIELDS) perField[f] = { added: 0, removed: 0 };

for (const id of allIds) {
  const b = (before.shows || {})[id];
  const a = (after.shows || {})[id];
  for (const f of FIELDS) {
    const bw = new Set((b && b[f] && b[f].wins) || []);
    const aw = new Set((a && a[f] && a[f].wins) || []);
    const added = [...aw].filter((x) => !bw.has(x));
    const removed = [...bw].filter((x) => !aw.has(x));
    if (added.length === 0 && removed.length === 0) continue;
    changes.push({ id, field: f, added, removed });
    stats.added += added.length;
    stats.removed += removed.length;
    perField[f].added += added.length;
    perField[f].removed += removed.length;
  }
}
const showsChanged = new Set(changes.map((c) => c.id)).size;

// Group by show for legible output
const byShow = {};
for (const c of changes) {
  byShow[c.id] = byShow[c.id] || [];
  byShow[c.id].push(c);
}

console.log('=== Precursor Rebuild Delta ===');
console.log(`Compare: ${beforeArg}  →  ${afterArg}`);
console.log(`Shows changed: ${showsChanged}  |  +${stats.added} wins added  |  -${stats.removed} wins removed\n`);

const sortedIds = Object.keys(byShow).sort();
for (const id of sortedIds) {
  console.log(id);
  for (const c of byShow[id]) {
    const label = FIELD_DISPLAY[c.field];
    for (const a of c.added) console.log(`  + [${label}] ${a}`);
    for (const r of c.removed) console.log(`  - [${label}] ${r}`);
  }
}

console.log('\n=== Per-ceremony summary ===');
for (const f of FIELDS) {
  const p = perField[f];
  if (p.added === 0 && p.removed === 0) continue;
  console.log(`  ${FIELD_DISPLAY[f].padEnd(8)} +${p.added}  -${p.removed}`);
}

if (stats.removed > stats.added * 2 && stats.removed > 20) {
  console.error('\n⚠️  WARNING: removals significantly outweigh additions. Inspect carefully — possible mass data loss.');
  process.exit(2);
}
