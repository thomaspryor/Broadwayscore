/**
 * The Season Report's show list says "the N productions counted above": it
 * must list exactly the shows getSeasonProfiles counts, group for group
 * (BRO-5808 review: the list once came from a different show source that
 * coerces a missing isRevival to false).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSeasonProfiles, getSeasonShowList } from '../../src/lib/data-commercial';
import { mix, showGroup } from '../../src/lib/season-profile';

test('every season: the show list matches the profile count and its 2x2 mix', () => {
  const profiles = getSeasonProfiles();
  assert.ok(profiles.length > 10);
  for (const p of profiles) {
    const { dated } = getSeasonShowList(p.season);
    assert.equal(dated.length, p.productions, p.season);
    const m = mix(p);
    const count = (id: string) => dated.filter((s) => showGroup(s.type, s.isRevival) === id).length;
    assert.deepEqual(
      [count('original-musicals'), count('musical-revivals'), count('original-plays'), count('play-revivals'), count('specials')],
      [m.originalMusicals, m.musicalRevivals, m.originalPlays, m.playRevivals, m.other],
      p.season,
    );
  }
});

test('undated list holds only Broadway shows with no opening date', () => {
  const { undated } = getSeasonShowList('2026-2027');
  for (const s of undated) assert.equal(s.openingDate, null, s.slug);
});
