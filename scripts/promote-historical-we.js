#!/usr/bin/env node
/**
 * promote-historical-we.js
 *
 * WE historical pilot S1 (plan v2.2): promote reviewed candidates from
 * data/audit/we-historical-candidates.json into shows.json with closed-show
 * historical metadata. Mirrors promote-ob-historical.js's shape.
 *
 * Only candidates with corroborated:true are promotable by default — a
 * human who has hand-verified an uncorroborated candidate (the plan's "hand-
 * check the first 10 candidates" probe) can force one through with
 * --allow-uncorroborated=<title>, passed once per title to promote.
 *
 * Usage:
 *   node scripts/promote-historical-we.js --season=2024-2025 --dry-run   (default)
 *   node scripts/promote-historical-we.js --season=2024-2025 --apply
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { AtomicWriteShrinkError } = require('./lib/atomic-shows-write');
const { buildVenueTitlePool, findExactDuplicate, findSubtitleDuplicateTitle } = require('./lib/venue-title-dedup-pool');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `promote-historical-we.js — Promote corroborated WE historical candidates into shows.json.

Usage:
  node scripts/promote-historical-we.js --season=YYYY-YYYY [options]

Options:
  --apply                          Write changes (default: dry run)
  --allow-uncorroborated=<title>   Promote this uncorroborated title anyway (repeatable)
  --help, -h    print this usage and exit
`;

if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const args = process.argv.slice(2);
const seasonArg = args.find(a => a.startsWith('--season='))?.split('=')[1];
const apply = args.includes('--apply');
const allowUncorroborated = new Set(
  args.filter(a => a.startsWith('--allow-uncorroborated=')).map(a => a.split('=').slice(1).join('='))
);

if (!seasonArg) {
  console.error('Usage: node scripts/promote-historical-we.js --season=YYYY-YYYY [--apply]');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const CANDIDATES_PATH = path.join(ROOT, 'data', 'audit', 'we-historical-candidates.json');
const LOG_PATH = path.join(ROOT, 'data', 'audit', 'we-historical-promotion-log.jsonl');

function slugify(s) {
  return String(s || '').toLowerCase()
    .replace(/[''""''""]/g, '')
    .replace(/[&]/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildShowEntry(candidate) {
  const titleSlug = slugify(candidate.title);
  const [seasonStartYear] = candidate.season.split('-');
  const id = `${titleSlug}-west-end-${seasonStartYear}`;
  return {
    id,
    title: candidate.title,
    slug: id,
    venue: candidate.venue,
    openingDate: candidate.openingDate,
    previewsStartDate: null,
    closingDate: null,
    status: 'closed',
    category: 'west-end',
    market: 'west-end',
    type: null,
    tags: ['historical'],
    season: candidate.season,
    discoverySource: 'historical-backfill',
    discoveredAt: new Date().toISOString(),
  };
}

function logEntry(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.warn(`Failed to append promotion log: ${e.message}`);
  }
}

function main() {
  if (!fs.existsSync(CANDIDATES_PATH)) {
    console.error(`No candidates file at ${CANDIDATES_PATH} — run discover-historical-shows-we.js first.`);
    process.exit(1);
  }
  const audit = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));
  if (audit.season !== seasonArg) {
    console.error(`Candidates file is for season ${audit.season}, not ${seasonArg}. Re-run discovery for the requested season.`);
    process.exit(1);
  }

  const promotable = (audit.candidates || []).filter(
    c => c.corroborated || allowUncorroborated.has(c.title)
  );
  console.log(`Candidates: ${audit.candidates?.length || 0}; promotable (corroborated or explicitly allowed): ${promotable.length}`);

  const showsData = loadShows();
  const existingIds = new Set(showsData.shows.map(s => s.id));
  // Live pool of {title, venue} — see promote-ob-historical.js and
  // venue-title-dedup-pool.js for the full rationale (BRO-243).
  const knownShows = buildVenueTitlePool(showsData.shows);

  const toPromote = [];
  const skipped = [];
  for (const c of promotable) {
    if (!c.venue) { skipped.push({ candidate: c, reason: 'no venue' }); continue; }
    const entry = buildShowEntry(c);
    const exactDup = findExactDuplicate(knownShows, entry.title, entry.venue);
    const subtitleDup = !exactDup && findSubtitleDuplicateTitle(knownShows, entry.title, entry.venue);
    if (exactDup) { skipped.push({ candidate: c, reason: 'duplicate title+venue' }); continue; }
    if (subtitleDup) { skipped.push({ candidate: c, reason: `subtitle-stripped duplicate of "${subtitleDup}"` }); continue; }
    if (existingIds.has(entry.id)) { skipped.push({ candidate: c, reason: 'duplicate id' }); continue; }
    if (!entry.openingDate) { skipped.push({ candidate: c, reason: 'no opening date parsed' }); continue; }
    toPromote.push(entry);
    knownShows.push({ title: entry.title, venue: entry.venue });
    existingIds.add(entry.id);
  }

  console.log('');
  console.log(`Will promote: ${toPromote.length}`);
  for (const e of toPromote) {
    console.log(`  + ${e.id} | ${e.title} | ${e.venue} | ${e.openingDate}`);
  }
  if (skipped.length) {
    console.log(`Skipped: ${skipped.length}`);
    for (const s of skipped) console.log(`  - ${s.candidate.title} (${s.reason})`);
  }

  if (!apply) {
    console.log('');
    console.log('[DRY RUN — pass --apply to write shows.json]');
    return;
  }

  if (toPromote.length === 0) {
    console.log('Nothing to promote.');
    return;
  }

  for (const entry of toPromote) {
    showsData.shows.push(entry);
    logEntry({ kind: 'promote-historical-we', id: entry.id, title: entry.title, venue: entry.venue, season: entry.season });
  }
  try {
    const r = saveShows(showsData);
    console.log(`Wrote shows.json: ${r.lineCountBefore} → ${r.lineCountAfter} lines.`);
  } catch (e) {
    if (e instanceof AtomicWriteShrinkError) {
      console.error(`::error::${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

main();
