/**
 * Regression test for the Tony eligibility canary fix.
 *
 * Pins three invariants:
 *   1. just-for-us-2023 has tony.eligible: false in awards.json (Sprint 2 canary)
 *   2. The accompanying tony.note is non-empty (so the ineligible footer renders something)
 *   3. The pure isTonyEligible() predicate logic — mirrored here per CLAUDE.md §15
 *      test extraction pattern — returns false for just-for-us-2023 + 2023-24.
 *
 * If any of these flips, the prediction page silently re-acquires the false
 * positive that Sprint 2 of the tony-eligibility plan was built to fix.
 *
 * Run with: node --test tests/unit/tony-eligibility-canary.test.mjs
 *
 * The source-of-truth predicate is src/lib/data-awards.ts:isTonyEligible.
 * If you change the logic there, update the mirror below to match.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AWARDS_PATH = resolve(__dirname, '../../data/awards.json');

// ──────────────────────────────────────────────────────────────────────────────
// Mirror of src/lib/data-awards.ts:isTonyEligible (pure logic only).
// If you change isTonyEligible in data-awards.ts, update this to match.
// ──────────────────────────────────────────────────────────────────────────────
function isTonyEligible(awardsShows, showId, awardsSeason) {
  const ruling = awardsShows[showId]?.tony;
  if (!ruling || ruling.season !== awardsSeason) return undefined;
  return ruling.eligible;
}

const awards = JSON.parse(readFileSync(AWARDS_PATH, 'utf8'));

describe('Tony eligibility canary — just-for-us-2023', () => {
  it('has a tony block in awards.json', () => {
    assert.ok(
      awards.shows?.['just-for-us-2023']?.tony,
      'just-for-us-2023.tony is missing — Sprint 2 canary has been removed. The show will re-appear in 2023-24 Best Play predictions.'
    );
  });

  it('is marked tony.eligible: false', () => {
    const tony = awards.shows['just-for-us-2023'].tony;
    assert.equal(
      tony.eligible,
      false,
      `just-for-us-2023.tony.eligible is ${JSON.stringify(tony.eligible)}, expected false. Solo storytelling specials are not eligible for competitive Best Play.`
    );
  });

  it('has a non-empty tony.note explaining the ruling', () => {
    const note = awards.shows['just-for-us-2023'].tony.note;
    assert.ok(
      typeof note === 'string' && note.length > 0,
      'just-for-us-2023.tony.note is missing or empty — the ineligible footer needs a reason to display.'
    );
  });

  it('isTonyEligible() predicate returns false for the 2023-24 season', () => {
    const ruling = isTonyEligible(awards.shows, 'just-for-us-2023', '2023-24');
    assert.equal(
      ruling,
      false,
      `isTonyEligible('just-for-us-2023', '2023-24') = ${JSON.stringify(ruling)}, expected false. ` +
      `Check that tony.season is "2023-24" and tony.eligible is false.`
    );
  });
});

describe('Tony eligibility — predicate back-compat (no ruling → undefined)', () => {
  it('returns undefined when the show has no tony block', () => {
    // Use a show id that's guaranteed not to exist.
    assert.equal(
      isTonyEligible(awards.shows, 'nonexistent-show-id', '2023-24'),
      undefined
    );
  });

  it('returns undefined when tony.season does not match', () => {
    // hamilton-2015 has a tony block for 2015-16. Asking for 2023-24 → undefined.
    if (awards.shows['hamilton-2015']?.tony?.season) {
      const ruling = isTonyEligible(awards.shows, 'hamilton-2015', '2023-24');
      assert.equal(ruling, undefined);
    }
  });
});
