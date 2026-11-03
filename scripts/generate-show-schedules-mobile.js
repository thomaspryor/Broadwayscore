#!/usr/bin/env node
/**
 * Writes public/data/show-schedules.json for the iOS app (BRO-6783): the
 * weekly performance schedule the Matinee/Evening picker reads its default
 * curtain times from. Same data the web bundles via src/lib/data-showtimes.ts,
 * minified. Runs in prebuild (gitignored output), so it always matches the
 * build's data.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/generate-show-schedules-mobile.js\nWrites public/data/show-schedules.json and public/data/show-schedule-history.json from data/ (no flags).');
  process.exit(0);
}

const ROOT = path.resolve(__dirname, '..');
const src = path.join(ROOT, 'data', 'show-schedules.json');
const outPath = path.join(ROOT, 'public', 'data', 'show-schedules.json');
const data = JSON.parse(fs.readFileSync(src, 'utf8'));
const shows = {};
for (const [id, s] of Object.entries(data.shows || {})) {
  if (s && s.weeks && Object.keys(s.weeks).length) shows[id] = { weeks: s.weeks };
}
const out = { lastUpdated: data.lastUpdated, currentMonday: data.currentMonday, shows };
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`show-schedules-mobile: ${Object.keys(shows).length} shows, ${(fs.statSync(outPath).size / 1024).toFixed(0)} KB`);

// Past weeks (BRO-6877): the web diary form lazy-fetches this for dates before
// the live window, and the app reads the same URL. Never bundled.
const histSrc = path.join(ROOT, 'data', 'show-schedule-history.json');
const histOut = path.join(ROOT, 'public', 'data', 'show-schedule-history.json');
const hist = fs.existsSync(histSrc) ? JSON.parse(fs.readFileSync(histSrc, 'utf8')) : { shows: {} };
fs.writeFileSync(histOut, JSON.stringify({
  lastUpdated: hist.lastUpdated || null,
  firstWeek: hist.firstWeek || null,
  throughMonday: hist.throughMonday || null,
  shows: hist.shows || {},
}));
console.log(`show-schedule-history: ${Object.keys(hist.shows || {}).length} shows, ${(fs.statSync(histOut).size / 1024).toFixed(0)} KB`);
