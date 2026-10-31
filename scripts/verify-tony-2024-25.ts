/**
 * One-shot verifier: prints the new tonyComposite ranking for the 2024-25
 * Tony season alongside critic + Tony-audience + awards score components,
 * and confirms the actual winners (Maybe Happy Ending, Purpose, Sunset
 * Boulevard, Eureka Day) rank #1 in their categories.
 *
 * Run: npx tsx scripts/verify-tony-2024-25.ts
 */

import { getBroadwayShows } from '../src/lib/data-core';
import {
  getEligibleShowsForPastSeason,
  getTonySeasonWindowFor,
  groupIntoCategories,
} from '../src/lib/data-tony-predictions';

// Map by Tony category key → expected #1 SHOW SLUG (not show id; the slug is
// what the SerializedTonyShow exposes).
const EXPECTED_WINNERS: Record<string, string> = {
  'best-musical': 'maybe-happy-ending',
  'best-play': 'purpose-2025',
  'best-revival-musical': 'sunset-boulevard-2024',
  'best-revival-play': 'eureka-day-2024',
};

function fmt(n: number | null | undefined): string {
  if (n == null) return ' --- ';
  return n.toFixed(1).padStart(5);
}

function main(): void {
  const season = getTonySeasonWindowFor(2025);
  const allShows = getBroadwayShows();
  const eligible = getEligibleShowsForPastSeason(allShows, season);
  const categories = groupIntoCategories(eligible, { nomineesOnly: true, season });

  let allCorrect = true;

  for (const cat of categories) {
    console.log('\n=== ' + cat.title + ' ===');
    console.log(' rk  comp   crit   aud   aws  slug');
    cat.shows.slice(0, 8).forEach((show, i) => {
      const flag = i === 0 ? ' <--' : '';
      console.log(
        ` ${(i + 1).toString().padStart(2)}  ${fmt(show.blendedScore)}  ${fmt(show.compositeScore)}  ${fmt(show.tonyAudienceGrade)}  ${fmt(show.awardsScore)}  ${show.slug}${flag}`,
      );
    });
    const expected = EXPECTED_WINNERS[cat.key];
    const top = cat.shows[0];
    const ok = top && top.slug === expected;
    if (!ok) {
      allCorrect = false;
      console.log(`  FAIL: expected #1 = ${expected}, got = ${top?.slug ?? '(none)'}`);
    } else {
      console.log(`  OK: #1 = ${expected}`);
    }
  }

  if (!allCorrect) {
    console.error('\nGROUND-TRUTH MISMATCH');
    process.exit(1);
  }
  console.log('\nAll 4 categories match ground truth.');
}

main();
