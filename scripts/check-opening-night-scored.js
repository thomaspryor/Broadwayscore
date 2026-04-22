#!/usr/bin/env node
/**
 * Opening-night scored-stage alert.
 *
 * 6 of 8 recent Broadway opening nights had ZERO "scored" entries in
 * data/audit/stage-latency.jsonl on the opening day itself. Broadcasts
 * fired against stale data. See ~/Documents/claude-outputs/opening-night-bucket-analysis.md
 * (bucket D, data-flow race).
 *
 * This script runs post-opening and alerts when it sees that failure signature.
 *
 * Exit codes:
 *   0 = healthy (or no openings today)
 *   1 = at least one opening with no scored entries — caller should file an issue
 */

const fs = require('fs');
const path = require('path');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const LATENCY_FILE = path.join(__dirname, '..', 'data', 'audit', 'stage-latency.jsonl');

// ET calendar day is what "opening night" means — not UTC.
function etDateToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function etDateYesterday() {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - 24);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const today = etDateToday();
const yesterday = etDateYesterday();

const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
const shows = data.shows || data;
// Covered window: shows that opened today OR yesterday (accounts for late-evening ET
// openings where reviews don't stage-latency-log until the next UTC day).
const openingShows = shows.filter(
  (s) => (s.openingDate === today || s.openingDate === yesterday)
    && (s.category === 'broadway' || s.category === 'west-end'),
);

if (openingShows.length === 0) {
  console.log(`No Broadway/West End openings on ${yesterday} or ${today} — nothing to check.`);
  process.exit(0);
}

// Which of those shows have a "scored" entry within the last 48h?
const cutoffMs = Date.now() - 48 * 60 * 60 * 1000;
const scoredSet = new Set();
if (fs.existsSync(LATENCY_FILE)) {
  const lines = fs.readFileSync(LATENCY_FILE, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.stage !== 'scored') continue;
      if (!e.at || new Date(e.at).getTime() < cutoffMs) continue;
      scoredSet.add(e.showId);
    } catch { /* skip malformed line */ }
  }
}

const missing = openingShows.filter((s) => !scoredSet.has(s.id));
console.log(`Opening window: ${yesterday} → ${today}`);
console.log(`Shows in window: ${openingShows.map((s) => s.id).join(', ')}`);
console.log(`Shows with a "scored" entry in the last 48h: ${openingShows.filter((s) => scoredSet.has(s.id)).map((s) => s.id).join(', ') || '(none)'}`);

if (missing.length === 0) {
  console.log('All opening-night shows have scored entries. Healthy.');
  process.exit(0);
}

console.error('');
console.error('ALERT: the following openings have NO "scored" stage entries in the last 48h:');
for (const s of missing) {
  console.error(`  - ${s.id} (${s.title}) opened ${s.openingDate}, category=${s.category}`);
}
console.error('');
console.error('Likely cause: bucket D (data-flow race) — rebuild-all-reviews did not stage');
console.error('scored entries, or the rebuild never ran. Check the orchestrator + rebuild workflows.');
process.exit(1);
