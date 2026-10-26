/**
 * Daily step (commercial-stale-closures.yml): append today's estimated money
 * back per season to data/season-payback-history.json (BRO-6335), for every
 * season that clears the coverage gate (hasReturnedCapital). Same inputs as
 * the site's season pages (toSeasonShowInputs), so the history and the pages
 * agree. Usage: npx tsx scripts/record-season-payback.ts [--dry-run] [--date=YYYY-MM-DD]
 */
import fs from 'node:fs';
import path from 'node:path';
import { rowFor, upsertRows } from './lib/season-payback-history';
import { buildSeasonProfiles, hasReturnedCapital, toSeasonShowInputs } from '../src/lib/season-profile';

const dataDir = path.join(__dirname, '..', 'data');
const readJson = (f: string) => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));

const dryRun = process.argv.includes('--dry-run');
const date = process.argv.find((a) => a.startsWith('--date='))?.slice(7) ?? new Date().toISOString().slice(0, 10);

const shows = readJson('shows.json').shows;
const commercial = readJson('commercial.json').shows;
const profiles = buildSeasonProfiles(toSeasonShowInputs(shows, commercial));
const rows = profiles.filter(hasReturnedCapital).map((p) => rowFor(date, p));
if (rows.length === 0) {
  console.error('::error::no season cleared the returned-capital gate; refusing to write an empty day');
  process.exit(1);
}

const file = path.join(dataDir, 'season-payback-history.json');
const history = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, rows: [] };
const next = upsertRows(history, date, rows);
for (const r of rows) console.log(`${r.season}  in $${(r.capital / 1e6).toFixed(1)}M  back $${(r.returnedLow / 1e6).toFixed(1)}M-$${(r.returnedHigh / 1e6).toFixed(1)}M (mid $${(r.returnedMid / 1e6).toFixed(1)}M)`);
if (dryRun) console.log(`dry run: ${rows.length} rows for ${date}, file untouched`);
else {
  fs.writeFileSync(file, JSON.stringify(next, null, 1) + '\n');
  console.log(`wrote ${rows.length} rows for ${date} (${next.rows.length} total)`);
}
