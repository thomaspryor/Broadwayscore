#!/usr/bin/env node

/**
 * audit-tony-attribution.js
 *
 * Finds Tony award data attached to the wrong show ID. Cross-references
 * `tony.season` against the show's `openingDate` from shows.json. A Tony
 * season's eligibility window covers shows opening between ~late April of
 * year N-1 and ~late April of year N (i.e. season "N-1 — N"). Anything
 * more than 1 year outside that window is a misattribution.
 *
 * Root-cause class: pre-2005 awards.json data was bootstrapped from a
 * source that title-matched without verifying production year. Modern
 * scrape-tony-awards.js only re-scrapes 2005+, so fossilized misattributions
 * persist.
 *
 * Known examples:
 *   - the-boy-from-oz-2003 tagged 1969-70 (Hugh Jackman won 2003-04)
 *   - a-view-from-the-bridge-2010 has 1998 revival's data
 *   - a-day-in-the-death-of-joe-egg-2003 has 1985 revival's data
 *
 * Usage:
 *   node scripts/audit-tony-attribution.js              # human-readable
 *   node scripts/audit-tony-attribution.js --json       # machine-readable
 *   node scripts/audit-tony-attribution.js --strict     # exit 1 on any finding (CI gate)
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');
const AWARDS_FILE = path.join(DATA_DIR, 'awards.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'awards-attribution-overrides.json');

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const STRICT = args.includes('--strict');

function parseSeason(s) {
  // "2003-04" → { startYear: 2003, endYear: 2004 }
  const m = /^(\d{4})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const endShort = parseInt(m[2], 10);
  const end = start - (start % 100) + endShort;
  return { startYear: start, endYear: end > start ? end : end + 100 };
}

function expectedTonySeasonsForOpening(openingDate) {
  // Tony eligibility: opening before ~late April of year N → eligible for N's ceremony (season N-1 — N).
  // A show opening in late April–December of year Y is typically eligible for the (Y — Y+1) season.
  // A show opening Jan–late April of year Y is typically eligible for the (Y-1 — Y) season.
  // Allow both bracketing seasons since the cutoff date moves.
  if (!openingDate) return [];
  const d = new Date(openingDate);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const seasons = new Set();
  if (m <= 5) {
    seasons.add(`${y - 1}-${String(y).slice(-2).padStart(2, '0')}`);
    seasons.add(`${y}-${String(y + 1).slice(-2).padStart(2, '0')}`);
  } else {
    seasons.add(`${y}-${String(y + 1).slice(-2).padStart(2, '0')}`);
    seasons.add(`${y - 1}-${String(y).slice(-2).padStart(2, '0')}`);
  }
  return Array.from(seasons);
}

function loadOverrides() {
  if (!fs.existsSync(OVERRIDES_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')).overrides || {};
  } catch {
    return {};
  }
}

const shows = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
const awards = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
const overrides = loadOverrides();

const showsById = new Map();
for (const sh of shows.shows || []) showsById.set(sh.id, sh);

const findings = [];

for (const [showId, awardsEntry] of Object.entries(awards.shows || {})) {
  if (!awardsEntry.tony || !awardsEntry.tony.season) continue;

  const tonySeason = awardsEntry.tony.season;
  const show = showsById.get(showId);

  if (!show) continue; // orphan — separate check
  if (!show.openingDate) continue; // unknown opening — separate check
  if (overrides[showId] && overrides[showId].season === tonySeason) continue;

  const expectedSeasons = expectedTonySeasonsForOpening(show.openingDate);
  if (expectedSeasons.includes(tonySeason)) continue;

  // Also accept seasons within 1 year of expected (for late-opening eligibility edge cases)
  const tonyStart = parseSeason(tonySeason)?.startYear;
  const expectedStarts = expectedSeasons.map(s => parseSeason(s)?.startYear).filter(Boolean);
  if (expectedStarts.some(es => Math.abs(es - tonyStart) <= 1)) continue;

  findings.push({
    showId,
    title: show.title,
    openingDate: show.openingDate,
    storedSeason: tonySeason,
    storedCeremony: awardsEntry.tony.ceremony,
    expectedSeasons,
    yearGap: Math.min(...expectedStarts.map(es => Math.abs(es - tonyStart))),
    storedWins: awardsEntry.tony.wins || [],
    storedNominations: awardsEntry.tony.nominations
  });
}

findings.sort((a, b) => b.yearGap - a.yearGap);

if (JSON_OUT) {
  console.log(JSON.stringify({ count: findings.length, findings }, null, 2));
} else {
  console.log(`\nTony attribution audit: ${findings.length} misattribution(s) found\n`);
  for (const f of findings) {
    console.log(`  ${f.showId} (opened ${f.openingDate})`);
    console.log(`    stored: season=${f.storedSeason} ceremony=${f.storedCeremony}`);
    console.log(`    expected season: ${f.expectedSeasons.join(' or ')}`);
    console.log(`    gap: ${f.yearGap} years`);
    console.log(`    stored wins: [${f.storedWins.join(', ')}]`);
    console.log('');
  }
  if (findings.length === 0) {
    console.log('  ✅ No misattributions detected.\n');
  }
}

if (STRICT && findings.length > 0) {
  console.error(`\n❌ ${findings.length} Tony attribution misattribution(s) — failing strict mode.`);
  console.error('   Fix the underlying data OR add an entry to data/awards-attribution-overrides.json.');
  process.exit(1);
}
