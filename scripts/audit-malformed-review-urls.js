#!/usr/bin/env node
/**
 * BRO-5162: list review-text files whose `url` is not an absolute http(s) URL
 * with a dotted host, and which of them ship in data/reviews.json.
 * Usage: node scripts/audit-malformed-review-urls.js [--json] [--strict]
 * --strict exits 1 when any malformed url ships in reviews.json.
 */
const fs = require('fs');
const path = require('path');
const { classifyUrlField } = require('./lib/malformed-review-url');
const { listShowDirs } = require('./lib/list-show-dirs');

function findMalformed(textsDir) {
  const out = [];
  if (!fs.existsSync(textsDir)) return out;
  for (const show of listShowDirs(textsDir, { silent: true })) {
    const dir = path.join(textsDir, show);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      const c = classifyUrlField(j.url);
      if (!c.ok) out.push({ showId: show, file: f, url: String(j.url).slice(0, 80), recovered: c.recovered });
    }
  }
  return out;
}

/** reviews.json rows (data/reviews.json shape: { reviews: [{showId, url, outletId}] }) with a bad url. */
function findShippedMalformed(reviewsJson) {
  const rows = Array.isArray(reviewsJson) ? reviewsJson : (reviewsJson && reviewsJson.reviews) || [];
  return rows.filter(r => !classifyUrlField(r.url).ok)
    .map(r => ({ showId: r.showId, outletId: r.outletId, url: String(r.url).slice(0, 80) }));
}

if (require.main === module) {
  const root = path.join(__dirname, '..', 'data');
  const bad = findMalformed(path.join(root, 'review-texts'));
  let shipped = [];
  try { shipped = findShippedMalformed(JSON.parse(fs.readFileSync(path.join(root, 'reviews.json'), 'utf8'))); } catch { /* no reviews.json */ }
  if (process.argv.includes('--json')) console.log(JSON.stringify({ files: bad, shipped }, null, 2));
  else {
    console.log(`malformed url files: ${bad.length} (${bad.filter(b => b.recovered).length} recoverable); shipped in reviews.json: ${shipped.length}`);
    for (const s of shipped) console.log(`  shipped: ${s.showId} ${s.outletId} ${s.url}`);
  }
  if (process.argv.includes('--strict') && shipped.length) process.exit(1);
}

module.exports = { findMalformed, findShippedMalformed };
