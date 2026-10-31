/**
 * Freeze Tony audience grades for completed seasons.
 *
 * WHY: The Tony predictions model blends critic + audience + awards signal.
 * The audience term (computeTonyAudienceGrade = mean of Show Score + Mezzanine)
 * is read LIVE from data/audience-buzz.json, which crons keep refreshing — even
 * for shows that closed years ago. New 2026 ratings of a 2023 show are
 * irrelevant to the 2023 Tonys, yet they silently re-rank completed seasons and
 * move the published track-record accuracy. (2026-05-31: a single Mezzanine
 * point on Kimberly Akimbo, 78→77, flipped the 2022-23 Best Musical pick and
 * dropped headline accuracy 93%→90.7%.)
 *
 * FIX: once a Tony season is complete, snapshot every top-category nominee's
 * audience grade and freeze it. computeTonyAudienceGrade() reads the frozen
 * value when present (past seasons) and live data otherwise (current season,
 * still relevant pre-ceremony). This script writes that snapshot.
 *
 * USAGE
 *   # Season-end run (going forward): snapshot from current live audience data.
 *   npx tsx scripts/freeze-tony-audience-grades.ts
 *
 *   # Backfill historical seasons from the oldest audience-buzz we have:
 *   npx tsx scripts/freeze-tony-audience-grades.ts --audience-buzz=/tmp/ab_oldest.json
 *
 * FREEZE-ONCE: existing frozen entries are never overwritten. The first time a
 * season is captured wins — that is the value closest to the ceremony. Pass
 * --overwrite to force a re-snapshot of all completed seasons.
 *
 * Output: data/tony-frozen-audience-grades.json
 */
import fs from 'fs';
import path from 'path';
import { getTonySeasonWindow } from '../src/lib/data-tony-predictions';

const TOP_CATEGORIES = [
  'Best Musical',
  'Best Play',
  'Best Revival of a Musical',
  'Best Revival of a Play',
];

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'tony-frozen-audience-grades.json');

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
}
const overwrite = process.argv.includes('--overwrite');
const buzzPath = arg('audience-buzz') || path.join(ROOT, 'data', 'audience-buzz.json');

/** Our label format "2024-2025" → awards.json format "2024-25". */
function toAwardsSeason(label: string): string {
  const parts = label.split('-');
  return `${parts[0]}-${parts[1].slice(2)}`;
}

/** Mean of Show Score + Mezzanine, matching computeTonyAudienceGrade(). */
function tonyAudFromBuzz(entry: any): number | null {
  const ss = entry?.sources?.showScore?.score;
  const mz = entry?.sources?.mezzanine?.score;
  const vals: number[] = [];
  if (typeof ss === 'number' && ss >= 0 && ss <= 100) vals.push(ss);
  if (typeof mz === 'number' && mz >= 0 && mz <= 100) vals.push(mz);
  if (vals.length === 0) return null;
  return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100) / 100;
}

function load(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  const awards = load(path.join(ROOT, 'data', 'awards.json'));
  const awardsShows: Record<string, any> = awards.shows || awards;
  const buzz = load(buzzPath);
  const buzzShows: Record<string, any> = buzz.shows || buzz;

  const currentAwardsSeason = toAwardsSeason(getTonySeasonWindow().label);

  // Existing frozen snapshot (freeze-once unless --overwrite).
  let frozen: { _meta?: any; grades: Record<string, { grade: number; season: string }> } = {
    grades: {},
  };
  if (fs.existsSync(OUT)) {
    const prev = load(OUT);
    frozen.grades = prev.grades || {};
  }
  if (overwrite) frozen.grades = {};

  let added = 0;
  let skippedExisting = 0;
  let missingBuzz = 0;
  const seasonsTouched = new Set<string>();

  for (const [showId, data] of Object.entries(awardsShows)) {
    const season: string | undefined = data?.tony?.season;
    if (!season) continue;
    // Only COMPLETED seasons. The current season stays on live audience data.
    if (season >= currentAwardsSeason) continue;
    const noms: string[] = data?.tony?.nominatedFor || [];
    if (!noms.some((n) => TOP_CATEGORIES.includes(n))) continue;

    if (frozen.grades[showId] && !overwrite) {
      skippedExisting++;
      continue;
    }
    const grade = tonyAudFromBuzz(buzzShows[showId]);
    if (grade == null) {
      missingBuzz++;
      continue;
    }
    frozen.grades[showId] = { grade, season };
    seasonsTouched.add(season);
    added++;
  }

  frozen._meta = {
    description:
      'Frozen Tony audience grades for completed seasons. Read by computeTonyAudienceGrade() so post-ceremony rating drift cannot re-rank past Tony seasons. Regenerate at each season end: npx tsx scripts/freeze-tony-audience-grades.ts',
    source: path.relative(ROOT, buzzPath),
    currentSeason: currentAwardsSeason,
    totalFrozen: Object.keys(frozen.grades).length,
  };

  fs.writeFileSync(OUT, JSON.stringify(frozen, null, 2) + '\n');

  console.log(`[freeze-tony-audience] source: ${path.relative(ROOT, buzzPath)}`);
  console.log(`  added: ${added}  skipped(existing): ${skippedExisting}  missing-buzz: ${missingBuzz}`);
  console.log(`  seasons captured this run: ${[...seasonsTouched].sort().join(', ') || '(none)'}`);
  console.log(`  total frozen: ${Object.keys(frozen.grades).length}`);
  console.log(`  wrote ${path.relative(ROOT, OUT)}`);
}

main();
