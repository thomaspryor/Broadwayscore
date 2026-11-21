/**
 * Daily step in commercial-stale-closures.yml (BRO-6335): appends today's
 * per-season payback estimate (season-profile.ts returnedCapital) to
 * data/season-payback-history.json. Same show list and record join as the
 * site's getSeasonProfiles, so the history matches what /biz prints.
 *
 *   npx tsx scripts/append-season-payback-history.ts [--dry-run] [--date=YYYY-MM-DD]
 */
import fs from 'fs';
import path from 'path';
import { buildSeasonProfiles } from '../src/lib/season-profile';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HISTORY_FILE, rowsFromProfiles, appendRows } = require('./lib/season-payback-history');

const dataDir = path.join(__dirname, '..', 'data');
const readJson = (name: string) => JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));

const dryRun = process.argv.includes('--dry-run');
const date = process.argv.find((a) => a.startsWith('--date='))?.slice(7) ?? new Date().toISOString().slice(0, 10);

const rawShows = readJson('shows.json').shows as Array<Record<string, any>>;
const commercial = readJson('commercial.json').shows as Record<string, any>;
const profiles = buildSeasonProfiles(
  rawShows
    // Intentionally NOT isBroadwayCategory: the same strict filter as getSeasonProfiles (src/lib/data-commercial.ts), so the history matches what /biz prints.
    .filter((s) => s.category === 'broadway' && !!s.openingDate)
    .map((s) => ({
      id: s.slug,
      type: s.type,
      isRevival: s.isRevival,
      openingDate: s.openingDate,
      status: s.status,
      // No weeklyCost: the payback estimate does not use running cost.
      commercial: commercial[s.slug] ?? null,
    })),
);

const rows = rowsFromProfiles(profiles, date);
if (rows.length === 0) {
  console.error('no season produced a payback row; refusing to write an empty day');
  process.exit(1);
}
const file = path.join(dataDir, HISTORY_FILE);
const history = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
const next = appendRows(history, rows);
console.log(`${date}: ${rows.length} season rows (history ${history.length} -> ${next.length})`);
for (const r of rows.slice(0, 4)) console.log(`  ${r.season} capital ${r.capital} back ${r.returnedLow}/${r.returnedMid}/${r.returnedHigh} (${r.shows}/${r.of})`);
if (!dryRun) {
  // Write beside, then rename: an interrupted write never leaves a torn history.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 1) + '\n');
  fs.renameSync(tmp, file);
}
