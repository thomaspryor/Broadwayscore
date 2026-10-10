#!/usr/bin/env node
/**
 * fetch-tour-tickets.js (BRO-4601 phase 3): TodayTix ticket links for
 * national-tour engagements, for the per-stop "Tickets" links in the tour
 * schedule and the ticket button on tour pages (affiliate-wrapped at click
 * time by src/lib/affiliate-utils.ts, platform 'TodayTix').
 *
 * Reads the TodayTix public listings for its US tour metros
 * (scripts/lib/todaytix-tour-tickets.js TOUR_LOCATIONS) and matches them to
 * the stops in data/tour-schedules.json. Run after fetch-tour-schedules.js.
 *
 * Writes data/tour-tickets.json:
 *   { tours: { <id>: [{ city, start, url, onSale, todaytixId, locationId }] } }
 * only when the links changed. Exits 1 when every location failed.
 *
 * Usage: node scripts/fetch-tour-tickets.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { TOUR_LOCATIONS, matchTourTickets, mergeTickets } = require('./lib/todaytix-tour-tickets');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const SCHEDULES_PATH = path.join(ROOT, 'data', 'tour-schedules.json');
const OUT_PATH = path.join(ROOT, 'data', 'tour-tickets.json');
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} ${url}`)); return; }
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(`Bad JSON from ${url}`)); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout ${url}`)); });
  });
}

async function fetchLocation(id) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await fetchJson(`https://api.todaytix.com/api/v2/shows?location=${id}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`);
    const batch = Array.isArray(data?.data) ? data.data : [];
    rows.push(...batch.map(r => ({ ...r, _locationId: id })));
    if (batch.length < PAGE_SIZE) break;
    await new Promise(r => setTimeout(r, 500));
  }
  return rows;
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log('fetch-tour-tickets.js [--dry-run]'); return; }
  const dryRun = argv.includes('--dry-run');

  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows;
  const schedules = JSON.parse(fs.readFileSync(SCHEDULES_PATH, 'utf8')).tours;
  const tours = shows.filter(s => s.category === 'tour' && s.status !== 'closed' && schedules[s.id]);

  const listings = [];
  const failed = [];
  for (const id of Object.keys(TOUR_LOCATIONS).map(Number)) {
    try {
      const rows = await fetchLocation(id);
      console.log(`location ${id} (${TOUR_LOCATIONS[id]}): ${rows.length} listings`);
      listings.push(...rows);
    } catch (e) {
      failed.push(id);
      console.log(`::warning::TodayTix location ${id} failed: ${e.message}`);
    }
  }
  if (failed.length === Object.keys(TOUR_LOCATIONS).length) {
    console.error('::error::every TodayTix location failed; tour ticket links left as they were');
    process.exit(1);
  }

  const prev = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')).tours : {};
  const next = mergeTickets(prev, matchTourTickets(listings, tours, schedules), failed);
  for (const [id, links] of Object.entries(next)) {
    console.log(`${id}: ${links.length} stops, ${links.filter(l => l.onSale).length} on sale`);
  }
  if (JSON.stringify(prev) === JSON.stringify(next)) { console.log('unchanged'); return; }
  if (dryRun) { console.log('(dry run: not written)'); return; }
  fs.writeFileSync(OUT_PATH, JSON.stringify({ tours: next }, null, 2) + '\n');
  console.log(`wrote ${path.relative(ROOT, OUT_PATH)}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
