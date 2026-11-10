// BRO-7291 class 3 (wrong production / wrong show). Replays the BRO-7256/7257 cases with short location
// lines (no review prose): a review of the same title at another theatre in another state, a stored venue
// that every outlet contradicts, and TheatreIn<City> listing pages ingested as reviews.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { regionalVenueMismatch, showVenueDisagreement } = require('./regional-venue-mismatch.js');
const { isRoundupUrl } = require('./review-guards.js');

const FILL = ' The company sings the opening number with real energy and the band is tight throughout the evening.'.repeat(5);
const review = (lines, url = 'https://example.com/review') => ({ url, fullText: lines.join(FILL) + FILL });

const CFA_NORTH = { id: 'come-from-away-north-regional-2026', localOnly: true, city: 'boston-ma', venue: 'North Shore Music Theatre, Beverly, MA' };

test('replay come-from-away-north: a Sharon Playhouse (CT) review filed under North Shore (MA) is caught', () => {
  const r = review([
    'Sharon Playhouse, a bastion of celebrated musicals, opens its season.',
    'Many cast members are veterans of Sharon Playhouse.',
    'Come From Away runs September 11-27, 2026, at the Sharon Playhouse, 44 Amenia Road in Sharon, CT.',
    'Chelsie Nectow as Beverly/Annette and others.',
  ], 'https://berkshireonstage.com/2026/09/15/come-from-away/');
  const hit = regionalVenueMismatch(r, CFA_NORTH);
  assert.ok(hit, 'expected a mismatch');
  assert.match(hit.venue, /Sharon Playhouse/);
  assert.equal(hit.state, 'CT');
});

test('the same review naming our own theatre is not flagged', () => {
  const r = review([
    'North Shore Music Theatre opens its season with Come From Away.',
    'The Sharon Playhouse staged it last year; Sharon Playhouse veterans fill the cast.',
    'Sharon Playhouse, Sharon, CT, lent the set.',
  ]);
  assert.equal(regionalVenueMismatch(r, CFA_NORTH), null);
});

test('company named instead of building in the SAME state is not flagged (BrightSide at Meiley-Swallow Hall)', () => {
  const show = { id: 'x', localOnly: true, city: 'chicago-il', venue: 'Meiley-Swallow Hall, Naperville, IL' };
  const r = review([
    'BrightSide Theatre opens its season.',
    'BrightSide Theatre has a loyal audience.',
    'At BrightSide Theatre, Naperville, IL, through Oct. 5.',
  ]);
  assert.equal(regionalVenueMismatch(r, show), null);
});

test('a Broadway show is out of scope (localOnly only)', () => {
  const r = review(['Sharon Playhouse.', 'Sharon Playhouse.', 'Sharon Playhouse, Sharon, CT.']);
  assert.equal(regionalVenueMismatch(r, { ...CFA_NORTH, localOnly: false }), null);
});

test('replay octet-regional-2026: stored Goodman Theatre, outlets agree on Raven Theatre (show-level)', () => {
  const show = { id: 'octet-regional-2026', localOnly: true, city: 'chicago-il', venue: 'Goodman Theatre, Chicago, IL' };
  const r = (o) => ({ outletId: o, ...review(['Octet plays at Raven Theatre.', 'Raven Theatre, 6157 N. Clark St., through Dec. 14.']) });
  const hit = showVenueDisagreement(show, [r('chicago-reader'), r('chicagotribune'), r('new-city-stage')], ['Raven Theatre, Chicago, IL', 'Goodman Theatre, Chicago, IL']);
  assert.ok(hit);
  assert.match(hit.venue, /Raven Theatre/);
  assert.equal(hit.outlets.length, 3);
  // a producing company that is not a known city venue is not evidence the building is wrong
  assert.equal(showVenueDisagreement(show, [r('a'), r('b')], ['Steppenwolf Theatre, Chicago, IL']), null);
});

test('TheatreIn<City> review listings and production pages are roundups, articles are not', () => {
  for (const u of [
    'https://www.theatreinla.com/heartbreak-house/reviews/11447/',
    'https://www.theatreinchicago.com/king-of-the-yees/reviews/9168/',
    'https://www.theatreindc.com/the-second-best-school-shooting/reviews/5319/',
    'https://www.theatreinla.com/the-case-book-of-c-auguste-dupin/11417',
  ]) assert.equal(isRoundupUrl(u).isRoundup, true, u);
  assert.equal(isRoundupUrl('https://www.theatreinchicago.com/reviewlistings.php').isRoundup, false);
  assert.equal(isRoundupUrl('https://chicagoreader.com/arts/reviews/123/').isRoundup, false);
});
