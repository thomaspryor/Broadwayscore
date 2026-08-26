/**
 * Unit tests for detectEssayIntroFalsePositive (BRO-57).
 *
 * Logic is require()'d from scripts/lib/essay-intro-nonreview-fp.js — never
 * copied (CLAUDE.md §15).
 *
 * Fixtures are the pre-clear shape of the two confirmed real-corpus
 * instances (music-city-review--gimena-cante.json,
 * around-the-town-chicago--alan-bresloff.json), reconstructed from their
 * manual-clear contentVerification.reasoning notes.
 *
 * Run: node --test tests/unit/essay-intro-nonreview-fp.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectEssayIntroFalsePositive } = require('../../scripts/lib/essay-intro-nonreview-fp');

const DOLLY_BIO_INTRO = 'Dolly Rebecca Parton is an American singer, songwriter, musician, actress, and philanthropist, widely recognized for her significant contributions to country music. '.repeat(3);
const DOLLY_BODY = 'ABOUT THE MUSICAL Directed by Tony Award winner Bartlett Sher, DOLLY: A True Original Musical premiered at the Fisher Center for the Performing Arts at Belmont University in Nashville. '
  + 'The cast delivers performances that remain faithful to the essence of each character. '.repeat(30)
  + 'A production filled with music, emotion, and talent that no theater lover should miss.';

const DOLLY_FIXTURE = {
  showId: 'dolly-a-true-original-musical-regional-2025',
  showTitle: 'Dolly: A True Original Musical',
  venue: 'Fisher Center for the Performing Arts, Nashville, TN',
  isNonReview: true,
  nonReviewType: 'preview',
  nonReviewClassifiedBy: 'gemini',
  classifiedAt: '2026-07-16T05:29:56.979Z',
  fullText: DOLLY_BIO_INTRO + DOLLY_BODY,
};

const STEPPENWOLF_BODY = 'This is the case in the current Steppenwolf Theatre production of "Little Bear Ridge Road", directed by Joe Mantello, now having its World Premiere. '
  + 'Sarah (Laurie Metcalf) and her nephew Ethan (Micah Stock) navigate the difficult settlement of an estate. '.repeat(30)
  + 'This is a solid performance piece. Chicago gets the treat of watching Metcalf at her best — you should see this. You will be glad you did.';

const LBR_FIXTURE = {
  showId: 'little-bear-ridge-road-regional-2024',
  showTitle: 'Little Bear Ridge Road',
  venue: 'Steppenwolf Theatre Company, Chicago, IL',
  isNonReview: true,
  nonReviewType: 'interview',
  nonReviewClassifiedBy: 'gemini',
  classifiedAt: '2026-07-10T17:13:36.271Z',
  fullText: STEPPENWOLF_BODY,
};

describe('detectEssayIntroFalsePositive — confirmed real-corpus classes match', () => {
  it('Dolly (essay/bio-intro, type=preview) matches', () => {
    const match = detectEssayIntroFalsePositive(DOLLY_FIXTURE, DOLLY_FIXTURE.showId);
    assert.ok(match, 'expected a match');
    assert.equal(match.nonReviewType, 'preview');
    assert.equal(match.venueChecked, true);
  });

  it('Little Bear Ridge Road (combined review+interview, type=interview) matches', () => {
    const match = detectEssayIntroFalsePositive(LBR_FIXTURE, LBR_FIXTURE.showId);
    assert.ok(match, 'expected a match');
    assert.equal(match.nonReviewType, 'interview');
  });
});

describe('detectEssayIntroFalsePositive — negative cases do not match', () => {
  it('isNonReview:false is not a candidate at all', () => {
    assert.equal(detectEssayIntroFalsePositive({ ...DOLLY_FIXTURE, isNonReview: false }, 'x'), null);
  });

  it('already nonReviewManualClear:true is skipped (avoid re-processing)', () => {
    assert.equal(detectEssayIntroFalsePositive({ ...DOLLY_FIXTURE, nonReviewManualClear: true }, 'x'), null);
  });

  it('definitive junk type (press_release) never matches, even with strong text', () => {
    assert.equal(detectEssayIntroFalsePositive({ ...DOLLY_FIXTURE, nonReviewType: 'press_release' }, 'x'), null);
  });

  it('short text (below MIN_WORD_COUNT) does not match', () => {
    const short = { ...DOLLY_FIXTURE, fullText: 'Dolly is a musical. You should see it.' };
    assert.equal(detectEssayIntroFalsePositive(short, 'x'), null);
  });

  it('no ending recommendation does not match', () => {
    const noRec = { ...DOLLY_FIXTURE, fullText: DOLLY_BIO_INTRO + DOLLY_BODY.replace(/no theater lover should miss\.?/, '') };
    assert.equal(detectEssayIntroFalsePositive(noRec, 'x'), null);
  });

  it('show title never mentioned does not match (genuine non-review)', () => {
    const noTitle = { ...DOLLY_FIXTURE, fullText: 'A long unrelated article about country music history. '.repeat(60) + 'You should not miss this.' };
    assert.equal(detectEssayIntroFalsePositive(noTitle, 'x'), null);
  });

  it('venue present but never mentioned does not match', () => {
    const noVenue = { ...DOLLY_FIXTURE, fullText: DOLLY_BIO_INTRO + DOLLY_BODY.replace(/Fisher Center for the Performing Arts at Belmont University in Nashville\.?/, 'a theater in Nashville.') };
    assert.equal(detectEssayIntroFalsePositive(noVenue, 'x'), null);
  });

  it('missing fullText does not match', () => {
    assert.equal(detectEssayIntroFalsePositive({ ...DOLLY_FIXTURE, fullText: '' }, 'x'), null);
  });

  it('genuine promotional preview article (title+venue+recommendation, no review language) does not match', () => {
    // The exact counter-example the ship-check adversarial review found: a
    // preview piece that names the show/venue, runs long, and closes with
    // promotional language indistinguishable from a review's verdict — but
    // never uses review-only language and explicitly flags itself as a
    // preview ("before it opens").
    const promo = {
      showId: 'some-show-regional-2025',
      showTitle: 'Some Show',
      venue: 'Fisher Center for the Performing Arts, Nashville, TN',
      isNonReview: true,
      nonReviewType: 'preview',
      fullText: 'Everything you need to know before Some Show opens at the Fisher Center. '.repeat(40)
        + 'Some Show is coming to the Fisher Center this fall and it looks like a must-see production.',
    };
    assert.equal(detectEssayIntroFalsePositive(promo, 'x'), null);
  });

  it('no review-language signal (only promotional recommendation) does not match', () => {
    const noReviewLanguage = {
      ...DOLLY_FIXTURE,
      fullText: (DOLLY_BIO_INTRO + DOLLY_BODY)
        .replace(/Directed by Tony Award winner Bartlett Sher, /, ''),
    };
    assert.equal(detectEssayIntroFalsePositive(noReviewLanguage, 'x'), null);
  });

  it('pre-existing contentVerification.wrongArticle:true is never cleared', () => {
    const wrongArticle = { ...DOLLY_FIXTURE, contentVerification: { wrongArticle: true } };
    assert.equal(detectEssayIntroFalsePositive(wrongArticle, 'x'), null);
  });

  it('generic venue words alone (theater/company/center) do not fabricate a venue match', () => {
    const genericVenue = {
      ...DOLLY_FIXTURE,
      venue: 'Performing Arts Theater Company Center',
      fullText: DOLLY_BIO_INTRO + DOLLY_BODY.replace(/Fisher Center for the Performing Arts at Belmont University in Nashville\.?/, 'a theater in Nashville.'),
    };
    assert.equal(detectEssayIntroFalsePositive(genericVenue, 'x'), null);
  });
});
