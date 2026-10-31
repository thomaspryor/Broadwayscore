import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { applyOwnVenueTourCarveout, reviewedAtOwnVenue, outsideRun, tourStopAllowFields } = require('./tour-stop-carveout.js');
const { buildVerificationPrompt } = require('./content-verifier.js');

const curtains = { id: 'curtains-west-end-2019', title: 'Curtains', venue: "Wyndham's Theatre", openingDate: '2019-12-13', closingDate: '2020-01-11' };
const tourReason = "This is a competent review, but it identifies the production as Paul Foster's touring company performing at Wyndham's as a tour stop.";

test('a touring-based flag is cleared when the critic attended this record\'s own venue', () => {
  const out = applyOwnVenueTourCarveout({ wrongProduction: true, reasoning: tourReason, reviewedVenue: "Wyndham's Theatre" }, curtains, { publishDate: '2019-12-18' });
  assert.deepEqual(out, { wrongProduction: false, tourStopCarveoutApplied: true });
  // Undated reviews are not ruled out by the date check.
  assert.equal(applyOwnVenueTourCarveout({ wrongProduction: true, reasoning: tourReason, reviewedVenue: 'Wyndhams' }, curtains, {}).tourStopCarveoutApplied, true);
});

test('a review of the tour at another theatre stays flagged', () => {
  const twotwo = { id: '2-22-a-ghost-story-west-end-2021', venue: 'Gielgud Theatre', openingDate: '2021-08-03', closingDate: '2022-01-02' };
  const out = applyOwnVenueTourCarveout({ wrongProduction: true, reasoning: 'reviews the Sheffield Lyceum touring production, not the West End production at Gielgud Theatre', reviewedVenue: 'Sheffield’s Lyceum Theatre' }, twotwo, {});
  assert.equal(out.wrongProduction, true);
  assert.equal(out.tourStopCarveoutApplied, false);
});

test('no reported venue, a non-tour reason, or a date far outside the run keeps the flag', () => {
  assert.equal(applyOwnVenueTourCarveout({ wrongProduction: true, reasoning: tourReason, reviewedVenue: null }, curtains, {}).wrongProduction, true);
  assert.equal(applyOwnVenueTourCarveout({ wrongProduction: true, reasoning: 'reviews the 2006 Broadway production', reviewedVenue: "Wyndham's Theatre" }, curtains, {}).wrongProduction, true);
  // The same tour back at the same theatre years later is another run.
  assert.equal(applyOwnVenueTourCarveout({ wrongProduction: true, reasoning: tourReason, reviewedVenue: "Wyndham's Theatre" }, curtains, { publishDate: '2023-03-01' }).wrongProduction, true);
  assert.equal(applyOwnVenueTourCarveout({ wrongProduction: false, reasoning: '', reviewedVenue: "Wyndham's Theatre" }, curtains, {}).tourStopCarveoutApplied, false);
});

test('venue matching is whole-word and tolerant of "Park Theatre 200" style names', () => {
  const park = { venue: 'Park Theatre' };
  assert.equal(reviewedAtOwnVenue('Park Theatre 200', park), true);
  assert.equal(reviewedAtOwnVenue('Regent’s Park Open Air Theatre', park), false);
  // Same-named houses in tour cities are other stops.
  assert.equal(reviewedAtOwnVenue('Lyceum Theatre, Sheffield', { venue: 'Lyceum Theatre' }), false);
  assert.equal(reviewedAtOwnVenue('Sheffield’s Lyceum Theatre', { venue: 'Lyceum Theatre' }), false);
  assert.equal(reviewedAtOwnVenue('Palace Theatre, Manchester', { venue: 'Palace Theatre' }), false);
  assert.equal(reviewedAtOwnVenue('Lyceum Theatre', { venue: 'Lyceum Theatre' }), true);
  // A record that IS in one of those cities still matches its own house.
  assert.equal(reviewedAtOwnVenue('Edinburgh Playhouse', { venue: 'Edinburgh Playhouse' }), true);
  assert.equal(outsideRun('2019-11-20', curtains), false);
  assert.equal(outsideRun('2019-09-01', curtains), true);
});

test('the verification prompt asks for the attended venue', () => {
  const { prompt } = buildVerificationPrompt({ scrapedText: 'x'.repeat(400), showTitle: 'Curtains', outletName: 'The Arts Desk', criticName: 'Matt Wolf', openingDate: '2019-12-13', venue: "Wyndham's Theatre", market: 'west-end' });
  assert.match(prompt, /"reviewedVenue":/);
});

test('tourStopAllowFields: a carve-out verdict records the text-scan stand-down once', () => {
  const cv = { tourStopCarveoutApplied: true, reviewedVenue: "Wyndham's Theatre" };
  assert.deepEqual(tourStopAllowFields(cv, {}), { allowTourSignal: true, allowTourSignalReason: `own-venue tour stop: critic attended "Wyndham's Theatre"` });
  assert.deepEqual(tourStopAllowFields(cv, { allowTourSignal: true }), {});
  assert.deepEqual(tourStopAllowFields({ tourStopCarveoutApplied: false }, {}), {});
  assert.deepEqual(tourStopAllowFields(null, {}), {});
});

test('venue-taxonomy objections at the record\'s own theatre are cleared too', () => {
  const translations = { id: 'translations-west-end-2019', venue: 'Olivier Theatre', openingDate: '2019-10-15', closingDate: '2019-12-18' };
  const nt = 'The scraped review evaluates a National Theatre production of Translations, not the West End Olivier Theatre production.';
  assert.equal(applyOwnVenueTourCarveout({ wrongProduction: true, reasoning: nt, reviewedVenue: 'Olivier Theatre, National Theatre' }, translations, { publishDate: '2019-10-23' }).wrongProduction, false);
  // Undated with a taxonomy objection: cleared (the objection is about the record, not the review).
  assert.equal(applyOwnVenueTourCarveout({ wrongProduction: true, reasoning: nt, reviewedVenue: 'National Theatre' }, translations, {}).wrongProduction, false);
  // Undated, same house, objection is a different staging: kept.
  assert.equal(applyOwnVenueTourCarveout({ wrongProduction: true, reasoning: "reviews Ian Rickson's 2018 production", reviewedVenue: 'Olivier Theatre' }, translations, {}).wrongProduction, true);
  // Dated in the earlier run at the same house: kept.
  assert.equal(applyOwnVenueTourCarveout({ wrongProduction: true, reasoning: nt, reviewedVenue: 'Olivier Theatre' }, translations, { publishDate: '2018-06-01' }).wrongProduction, true);
  // Royal Court record, Royal Court review called a pre-West End tryout.
  const glass = { venue: 'Royal Court', openingDate: '2019-09-18', closingDate: '2019-10-12' };
  assert.equal(applyOwnVenueTourCarveout({ wrongProduction: true, reasoning: 'reviews the Royal Court (pre-West End tryout) production, not the West End one', reviewedVenue: 'Royal Court Theatre' }, glass, { publishDate: '2019-09-30' }).wrongProduction, false);
});

test('reviewedAtOwnVenue accepts the building\'s other names (venue-aliases)', () => {
  assert.equal(reviewedAtOwnVenue("Duke of York's Theatre", { venue: 'Tom Stoppard Theatre', category: 'west-end' }), true);
  assert.equal(reviewedAtOwnVenue('Trafalgar Studios', { venue: 'Trafalgar Theatre', category: 'west-end' }), true);
  assert.equal(reviewedAtOwnVenue('Comedy Theatre', { venue: 'Harold Pinter Theatre', category: 'west-end' }), true);
  assert.equal(reviewedAtOwnVenue("Wyndham's Theatre", { venue: 'Tom Stoppard Theatre', category: 'west-end' }), false);
  // City words that are also London names do not reject London houses.
  assert.equal(reviewedAtOwnVenue("Duke of York's Theatre", { venue: "Duke of York's Theatre" }), true);
  assert.equal(reviewedAtOwnVenue('Cambridge Theatre', { venue: 'Cambridge Theatre' }), true);
  assert.equal(reviewedAtOwnVenue('York Theatre Royal', { venue: 'Theatre Royal Haymarket' }), false);
});
