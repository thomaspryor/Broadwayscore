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
 * Covers broadway/off-broadway and west-end/off-west-end (task #1737 — off-Broadway
 * and off-West-End were originally excluded, matching #1735's category-exclusion bug).
 *
 * Exit codes:
 *   0 = healthy (or no openings yesterday)
 *   1 = at least one opening with no scored entries — caller should file an issue
 */

const fs = require('fs');
const path = require('path');
const {
  etDateToday, etDateYesterday, selectOpeningWindowShows, scoredShowIds, reviewEvidenceShowIds,
  needsEvidence, findMissingScored,
} = require('./lib/opening-night-scored-check.js');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const LATENCY_FILE = path.join(__dirname, '..', 'data', 'audit', 'stage-latency.jsonl');

const today = etDateToday();
const yesterday = etDateYesterday();

const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
const shows = data.shows || data;
const openingShows = selectOpeningWindowShows(shows, { today, yesterday });

if (openingShows.length === 0) {
  console.log(`No openings on ${yesterday} — nothing to check (today's ${today} openings are checked tomorrow).`);
  process.exit(0);
}

// Which of those shows have a "scored" entry within the last 48h?
const cutoffMs = Date.now() - 48 * 60 * 60 * 1000;
const latencyLines = fs.existsSync(LATENCY_FILE)
  ? fs.readFileSync(LATENCY_FILE, 'utf8').split('\n').filter(Boolean)
  : [];
const scoredSet = scoredShowIds(latencyLines, cutoffMs);

const evidenceSet = reviewEvidenceShowIds(latencyLines);
const missing = findMissingScored(openingShows, scoredSet, evidenceSet);
console.log(`Opening day checked: ${yesterday}`);
console.log(`Shows in window: ${openingShows.map((s) => s.id).join(', ')}`);
console.log(`Shows with a "scored" entry in the last 48h: ${openingShows.filter((s) => scoredSet.has(s.id)).map((s) => s.id).join(', ') || '(none)'}`);
const noReviews = openingShows.filter((s) => !scoredSet.has(s.id) && needsEvidence(s, evidenceSet));
if (noReviews.length > 0) {
  console.log(`No collected reviews yet (nothing to score, not this alert's signature): ${noReviews.map((s) => s.id).join(', ')}`);
}

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
