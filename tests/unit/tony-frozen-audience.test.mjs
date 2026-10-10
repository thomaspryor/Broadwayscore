// TESTS-VS-DERIVED-DATA-EXEMPT: pins the frozen-audience-grade snapshot invariants — a
// deliberate freeze artifact, not a value derivable from live audience data (live data
// is exactly what this fix freezes out).
/**
 * Regression test for the frozen Tony audience grade fix (2026-05-31).
 *
 * THE BUG: computeTonyAudienceGrade() read live data/audience-buzz.json for ALL
 * seasons. Crons refresh those scores even for shows closed years ago, so a
 * single Mezzanine point on Kimberly Akimbo (78→77) flipped the 2022-23 Best
 * Musical pick and dropped published accuracy 93%→90.7% overnight. New 2026
 * ratings of a 2023 show are irrelevant to the 2023 Tonys.
 *
 * THE FIX: completed-season nominees have their audience grade frozen in
 * data/tony-frozen-audience-grades.json; computeTonyAudienceGrade() returns the
 * frozen value when present. The current season stays on live data.
 *
 * These invariants pin the fix. If any flips, post-ceremony rating drift can
 * once again silently re-rank past Tony seasons.
 *
 * Run with: node --test tests/unit/tony-frozen-audience.test.mjs
 *
 * Source of truth: src/lib/data-tony-predictions.ts (computeTonyAudienceGrade,
 * FROZEN_TONY_AUDIENCE) + scripts/freeze-tony-audience-grades.ts (generator).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FROZEN_PATH = resolve(__dirname, '../../data/tony-frozen-audience-grades.json');
const AWARDS_PATH = resolve(__dirname, '../../data/awards.json');

const frozen = JSON.parse(readFileSync(FROZEN_PATH, 'utf8'));
const grades = frozen.grades || {};
const awards = JSON.parse(readFileSync(AWARDS_PATH, 'utf8'));
const awardsShows = awards.shows || awards;

const TOP_CATEGORIES = [
  'Best Musical',
  'Best Play',
  'Best Revival of a Musical',
  'Best Revival of a Play',
];

/** "2024-2025" → "2024-25" (awards.json season format). */
const toAwardsSeason = (label) => {
  const p = label.split('-');
  return `${p[0]}-${p[1].slice(2)}`;
};

describe('frozen Tony audience grades', () => {
  it('freezes the 2022-23 Best Musical winner above the runner-up margin', () => {
    // The exact pair that broke: Kimberly Akimbo (winner) vs Some Like It Hot.
    // Frozen from the oldest snapshot we have (Apr 2026), Kimberly = 82.
    const kimberly = grades['kimberly-akimbo-2022'];
    assert.ok(kimberly, 'kimberly-akimbo-2022 must be frozen');
    assert.equal(typeof kimberly.grade, 'number');
    assert.ok(
      kimberly.grade >= 82,
      `Kimberly Akimbo frozen audience grade regressed to ${kimberly.grade} (<82). ` +
        `This is the value that keeps it #1 over Some Like It Hot in the model. ` +
        `Re-freeze from the oldest audience-buzz snapshot, do not snapshot drifted live data.`,
    );
  });

  it('every frozen grade is a number in [0,100]', () => {
    for (const [id, v] of Object.entries(grades)) {
      assert.equal(typeof v.grade, 'number', `${id} grade must be a number`);
      assert.ok(v.grade >= 0 && v.grade <= 100, `${id} grade ${v.grade} out of range`);
      assert.equal(typeof v.season, 'string', `${id} must record its season`);
    }
  });

  it('does NOT freeze current-season shows (they must stay on live data)', () => {
    const currentSeason = frozen._meta?.currentSeason;
    assert.ok(currentSeason, '_meta.currentSeason must be recorded');
    for (const [id, v] of Object.entries(grades)) {
      assert.ok(
        v.season < currentSeason,
        `${id} is frozen for season ${v.season} >= current ${currentSeason}. ` +
          `The active season must use live audience data until it completes.`,
      );
    }
  });

  it('covers every top-category nominee from completed tracked seasons', () => {
    // Tracked prediction seasons start 2013-14. Any completed-season top-category
    // nominee missing from the freeze would silently fall back to live data and
    // re-introduce the drift bug for that show.
    const currentSeason = frozen._meta?.currentSeason;
    const missing = [];
    for (const [showId, data] of Object.entries(awardsShows)) {
      const season = data?.tony?.season;
      if (!season || season >= currentSeason) continue;
      if (season < '2013-14') continue; // only the seasons the track record renders
      const noms = data?.tony?.nominatedFor || [];
      if (!noms.some((n) => TOP_CATEGORIES.includes(n))) continue;
      if (!grades[showId]) missing.push(`${showId} (${season})`);
    }
    assert.deepEqual(
      missing,
      [],
      `Completed-season top-category nominees missing from the freeze (will drift on live data): ${missing.join(', ')}. ` +
        `Run: npx tsx scripts/freeze-tony-audience-grades.ts`,
    );
  });
});
