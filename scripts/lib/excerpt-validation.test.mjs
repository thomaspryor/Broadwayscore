/**
 * excerpt-validation regression tests — tour-contamination other-show carve-out.
 *
 * Bug (2026-08-01, the-comedy-about-spies-west-end-2026): the Times' Dominic
 * Maxwell review opens with a comparison lede — "Noises Off is on tour on its
 * umpteenth revival; Fawlty Towers is back in London soon before going on
 * tour." — before getting to The Comedy About Spies. isTourReviewExcerpt had
 * no other-show awareness, so that lede tripped the "on tour" pattern and the
 * review was excluded from reviews.json (skippedTourContamination) even
 * though it never describes ITSELF as touring.
 *
 * Per CLAUDE.md rule 15 this require()s the real function — no logic copied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isTourReviewExcerpt } = require('./excerpt-validation.js');

const CURRENT = {
  currentShowId: 'the-comedy-about-spies-west-end-2026',
  currentShowTitle: 'The Comedy About Spies',
};

test('comparison lede mentioning a different show on tour is not flagged as contamination', () => {
  const excerpt = "Noises Off is on tour on its umpteenth revival; Fawlty Towers is back in "
    + "London soon before going on tour. The Play That Goes Wrong is in its 11th year in the "
    + "West End. I was much more of a fan of Magic Goes Wrong... So I was greasing my chuckle "
    + "chops for their similar-sounding new one, The Comedy About Spies.";
  const result = isTourReviewExcerpt(excerpt, CURRENT);
  assert.equal(result.isTourReview, false);
  // "back in London soon before going on tour" is also forward tense
  // (BRO-4185 follow-up), which is checked first.
  assert.ok(result.otherShowComparison === true || result.forwardTenseOnly === true);
});

test('comparison lede without any forward-tense clause still hits the other-show branch', () => {
  const excerpt = "Noises Off is on tour on its umpteenth revival. The Play That Goes Wrong is in its "
    + "11th year in the West End. So I was greasing my chuckle chops for their similar-sounding "
    + "new one, The Comedy About Spies.";
  const result = isTourReviewExcerpt(excerpt, CURRENT);
  assert.equal(result.isTourReview, false);
  assert.equal(result.otherShowComparison, true);
  assert.equal(result.mentionedTitle, 'Noises Off');
});

test('without context, the same excerpt still trips the tour pattern (no regression to the raw signal)', () => {
  const excerpt = "Noises Off is on tour on its umpteenth revival.";
  const result = isTourReviewExcerpt(excerpt);
  assert.equal(result.isTourReview, true);
});

test('a genuine touring-production review of THIS show is still flagged (no false negative)', () => {
  const excerpt = "This touring production of The Comedy About Spies is currently on tour, "
    + "playing regional houses across the UK before a West End transfer.";
  const result = isTourReviewExcerpt(excerpt, CURRENT);
  assert.equal(result.isTourReview, true);
});

test('other-show mention well outside the proximity window does not suppress a genuine signal', () => {
  const excerpt = "Fans of Noises Off, a very different sort of farce entirely, will find plenty else to enjoy "
    + "in London this season, from small fringe houses to the big commercial West End transfers everyone "
    + "keeps talking about at length in every publication. Meanwhile, this touring production of "
    + "The Comedy About Spies is currently on tour around regional theatres.";
  const result = isTourReviewExcerpt(excerpt, CURRENT);
  assert.equal(result.isTourReview, true);
});

test('BRO-4185: own venue, earlier-year history and company names are not tour signals', () => {
  const ctx = { currentShowId: '11-to-midnight-off-broadway-2026', currentShowTitle: '11 to Midnight',
    currentShowVenue: 'Orpheum Theatre', currentShowYear: 2026 };
  assert.equal(isTourReviewExcerpt('a new dance play at the Orpheum Theatre.', ctx).isTourReview, false);
  const shop = { currentShowId: 'little-shop-of-horrors-off-broadway-2019', currentShowTitle: 'Little Shop of Horrors',
    currentShowVenue: 'Westside Theatre', currentShowYear: 2019 };
  assert.equal(isTourReviewExcerpt('when the show first opened off-Broadway at the Orpheum Theatre in 1982.', shop).isTourReview, false);
  assert.equal(isTourReviewExcerpt('directed by Neil Bettles for touring company ThickSkin, seems', { currentShowYear: 2026 }).isTourReview, false);
  assert.equal(isTourReviewExcerpt('Bush Theatre in association with Actors Touring Company', { currentShowYear: 2026 }).isTourReview, false);
  assert.equal(isTourReviewExcerpt("Red Fox Theatre's Catch of the Day", { currentShowYear: 2026 }).isTourReview, false);
  assert.equal(isTourReviewExcerpt('Fresh off a national tour, this myth-based musical', { currentShowYear: 2019 }).isTourReview, false);
});

test('BRO-4185: real tour reviews still trip', () => {
  const suffs = { currentShowId: 'suffs-2024', currentShowTitle: 'Suffs', currentShowVenue: 'Music Box Theatre', currentShowYear: 2024 };
  assert.equal(isTourReviewExcerpt('Fresh from Broadway, the national tour of the musical Suffs is in San Diego through Sunday', suffs).isTourReview, true);
  assert.equal(isTourReviewExcerpt('Review of the North American Tour of Suffs: The Musical September 20, 2025', suffs).isTourReview, true);
  const purple = { currentShowId: 'the-color-purple-2015', currentShowTitle: 'The Color Purple', currentShowVenue: 'Bernard B. Jacobs Theatre', currentShowYear: 2015 };
  assert.equal(isTourReviewExcerpt('and then the touring production at the Ahmanson Theatre, I was in no rush', purple).isTourReview, true);
  assert.equal(isTourReviewExcerpt('The touring company toured 20 cities.').isTourReview, true);
});

test('BRO-4185: a tour review naming the original Broadway year still trips', () => {
  const wiz = { currentShowId: 'the-wiz-2024', currentShowTitle: 'The Wiz', currentShowVenue: 'Marquis Theatre', currentShowYear: 2024 };
  assert.equal(isTourReviewExcerpt('The Wiz, currently playing in a newly-mounted, disco revival on its national tour at the Hobby Center, opened on Broadway in 1975, played', wiz).isTourReview, true);
  const pi = { currentShowId: 'life-of-pi-2023', currentShowTitle: 'Life of Pi', currentShowVenue: 'Gerald Schoenfeld Theatre', currentShowYear: 2023 };
  assert.equal(isTourReviewExcerpt('the 2012 film that earned director Ang Lee an Academy Award, this national tour of Life of Pi succeeds', pi).isTourReview, true);
});

test('BRO-4563: a tour production\'s own review is not tour contamination', () => {
  const { tourContextForShow } = require('./excerpt-validation.js');
  const { explainExclusion } = require('./review-guards.js');
  const intro = "Baltimore's theater scene benefits once again with the national tour debut of Maybe Happy Ending at the Hippodrome";
  const tour = { id: 'maybe-happy-ending-tour-2026', title: 'Maybe Happy Ending', category: 'tour', status: 'open', venue: 'North American Tour', openingDate: '2026-09-15' };
  const broadway = { id: 'maybe-happy-ending-2024', title: 'Maybe Happy Ending', category: 'broadway', status: 'open', venue: 'Belasco Theatre', openingDate: '2024-11-12' };
  assert.equal(isTourReviewExcerpt(intro, tourContextForShow(tour)).isTourReview, false);
  assert.equal(isTourReviewExcerpt(intro, tourContextForShow(broadway)).isTourReview, true);
  // The review-guards fullText net (the rebuild's inclusion check) agrees.
  const review = { showId: tour.id, outletId: 'baltimoresun', outlet: 'The Baltimore Sun', url: 'https://www.baltimoresun.com/2026/09/17/maybe-happy-ending-review/', fullText: intro + '. '.repeat(5), textFetchedAt: '2026-10-04T01:41:12.047Z' };
  assert.notEqual(explainExclusion(review, tour, '/nonexistent/maybe-happy-ending-tour-2026/baltimoresun--luke-parker.json'), 'tourContaminationInText');
  assert.equal(explainExclusion({ ...review, showId: broadway.id }, broadway, '/nonexistent/maybe-happy-ending-2024/baltimoresun--luke-parker.json'), 'tourContaminationInText');
});

test('BRO-4563: a special engagement\'s own tour wording is exempt in every caller, not just two', () => {
  const { tourContextForShow } = require('./excerpt-validation.js');
  const { contaminationKindsNeeded } = require('./contamination-allow-signal.js');
  const intro = 'The national tour of this concert staging stops at the Beacon Theatre for one week only, and it is a delight.';
  const special = { id: 'x-special-2026', title: 'X In Concert', type: 'special', category: 'off-broadway', status: 'open', openingDate: '2026-05-01' };
  const tour = { id: 'x-tour-2026', title: 'X', category: 'tour', status: 'open', openingDate: '2026-05-01' };
  const plain = { id: 'x-2026', title: 'X', category: 'broadway', status: 'open', openingDate: '2026-05-01' };
  assert.equal(isTourReviewExcerpt(intro, tourContextForShow(special)).isTourReview, false);
  assert.equal(isTourReviewExcerpt(intro, tourContextForShow(plain)).isTourReview, true);
  // The allow-signal backfill asks the same question through the same context.
  assert.deepEqual(contaminationKindsNeeded({ fullText: intro }, tour), []);
  assert.deepEqual(contaminationKindsNeeded({ fullText: intro }, special), []);
  assert.deepEqual(contaminationKindsNeeded({ fullText: intro }, plain), ['tour']);
});

test('BRO-4963: a plot mention of ANOTHER show\'s tour at a tour venue is not contamination', () => {
  const { tourContextForShow } = require('./excerpt-validation.js');
  const show = { id: 'good-time-charlie-off-broadway-2026', title: 'Good Time Charlie', venue: 'The Public Theater/Martinson Hall', category: 'off-broadway', status: 'open', openingDate: '2026-10-08' };
  const gtc = "An early scene in Ryan J. Haddad's Good Time Charlie, now making its world premiere at the Public Theater, depicts just such a conversion. Uncle Charlie takes young Ryan to the touring production of The Phantom of the Opera at Playhouse Square.";
  const r = isTourReviewExcerpt(gtc, tourContextForShow(show));
  assert.equal(r.isTourReview, false);
  // Venue-only variant (title before the venue) is covered by the same window.
  assert.equal(isTourReviewExcerpt(gtc.replace('the touring production of ', ''), tourContextForShow(show)).isTourReview, false);
  // Still a tour review when the tour named IS the show under review.
  const phantom = { id: 'the-phantom-of-the-opera-1988', title: 'The Phantom of the Opera', venue: 'Majestic Theatre', category: 'broadway', status: 'open', openingDate: '1988-01-26' };
  const own = 'The touring production of The Phantom of the Opera at Playhouse Square is a thrill for a new generation of fans.';
  assert.equal(isTourReviewExcerpt(own, tourContextForShow(phantom)).isTourReview, true);
  // And when no other show is named, a bare tour signal still flags.
  assert.equal(isTourReviewExcerpt('The touring production at Playhouse Square is a thrill.', tourContextForShow(show)).isTourReview, true);
});
