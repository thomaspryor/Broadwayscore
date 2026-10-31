import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildAction, canonicalVenue, siteSeesUkRegional, headlineFallback } = require('../../scripts/lib/uk-regional-add-plan.js');
const { resolveMetroInfo } = require('../../scripts/lib/venue-metro.js');
const { isExemptFromPlaybillCheck } = require('../../scripts/validate-show-venue.js');

const row = (over) => ({ title: 'King Lear', venue: 'Crucible theatre, Sheffield', hub: 'yorkshire', date: '2026-09-06', guardianUrl: 'https://www.theguardian.com/stage/2026/sep/06/king-lear-review-sheffield-crucible', ...over });

test('venue is canonical house + its own town', () => {
  const cv = (raw) => canonicalVenue(raw, resolveMetroInfo(raw)).venue;
  assert.equal(cv('Bolton Octagon'), 'Octagon Theatre, Bolton');
  assert.equal(cv('Royal Shakespeare theatre, Stratford-upon-Avon'), 'Royal Shakespeare Theatre, Stratford-upon-Avon');
  assert.equal(cv('Tron, Glasgow'), 'Tron Theatre, Glasgow');
  assert.equal(cv('The Lowry, Salford'), 'The Lowry, Salford');
});

test('builds a regional row with city, house-keyed id and Guardian evidence', () => {
  const { action } = buildAction(row(), []);
  assert.equal(action.show.id, 'king-lear-crucible-regional-2026');
  assert.equal(action.show.city, 'sheffield-uk');
  assert.equal(action.show.market, 'regional');
  assert.deepEqual(action.show.evidenceUrls, [row().guardianUrl]);
  assert.ok(isExemptFromPlaybillCheck(action.show), 'Guardian-evidenced backfill row skips the Playbill check');
});

test('skips a production already in shows.json and non-hub venues', () => {
  const existing = [{ id: 'king-lear-x-regional-2026', title: 'King Lear', city: 'sheffield-uk', openingDate: '2026-09-01' }];
  assert.match(buildAction(row(), existing).skip, /exists/);
  assert.match(buildAction(row({ venue: 'Old Vic, London' }), []).skip, /not a hub/);
});

test('a title the corpus knows keeps its type', () => {
  const { action } = buildAction(row({ title: 'Fun Home', venue: 'Royal Exchange theatre, Manchester' }), [{ id: 'fun-home', title: 'Fun Home', type: 'musical' }]);
  assert.equal(action.show.type, 'musical');
});

test('the Playbill exemption needs the Guardian evidence', () => {
  assert.equal(isExemptFromPlaybillCheck({ category: 'regional', discoverySource: 'uk-regional-guardian-backfill', evidenceUrls: [] }), false);
});

test('venues the site would not file under Beyond London are skipped', () => {
  assert.equal(siteSeesUkRegional('Royal Exchange Theatre, Manchester'), true);
  assert.equal(siteSeesUkRegional('Opera House, Manchester'), false);
  assert.match(buildAction(row({ venue: 'Opera House, Manchester' }), []).skip, /uk-regional-venues/);
});

test('Observer roundups are skipped and a standfirst title falls back to the URL slug', () => {
  assert.match(buildAction(row({ title: 'The week in theatre: Hamlet; Othello –' }), []).skip, /roundup/);
  const url = 'https://www.theguardian.com/stage/2026/oct/23/lanny-review-bristol-old-vic-max-porter';
  assert.equal(headlineFallback('Stranger things turn an English village upside down in Max Porter’s rural noir Lanny', url), 'Lanny');
  assert.equal(headlineFallback('The Complete Works of William Shakespeare (Abridged)', url), 'The Complete Works of William Shakespeare (Abridged)');
});

test('skips a production whose title differs only by and/& or opens in the previous year (BRO-6578)', () => {
  const bath = (over) => row({ title: 'Tristan Yseult', venue: 'Theatre Royal Bath', hub: 'south-west', date: '2026-10-02', ...over });
  const existing = [{ id: 'tristan-and-yseult-royal-bath-regional-2026', title: 'Tristan & Yseult', city: 'bath-uk', venue: 'Theatre Royal Bath, Bath', openingDate: '2026-09-19' }];
  assert.match(buildAction(bath(), existing).skip, /exists as tristan-and-yseult/);
  const lear = [{ id: 'king-lear-crucible-regional-2025', title: 'The King Lear', city: 'sheffield-uk', venue: 'Crucible Theatre, Sheffield', openingDate: '2025-12-20' }];
  assert.match(buildAction(row({ date: '2026-01-08' }), lear).skip, /exists/);
  // Another house in the same city is a different production.
  const lyceum = [{ id: 'king-lear-lyceum-regional-2025', title: 'The King Lear', city: 'sheffield-uk', venue: 'Lyceum Theatre, Sheffield', openingDate: '2025-12-20' }];
  assert.ok(buildAction(row({ date: '2026-01-08' }), lyceum).action);
  // A same-house run that opened over 200 days before the review is a different production.
  const earlier = [{ id: 'king-lear-crucible-regional-2025', title: 'The King Lear', city: 'sheffield-uk', venue: 'Crucible Theatre, Sheffield', openingDate: '2025-12-30' }];
  assert.ok(buildAction(row(), earlier).action, '250 days before');
  assert.match(buildAction(row({ date: '2026-07-10' }), earlier).skip, /exists/, '192 days before');
  // No opening date: fall back to the id year.
  const undated = (y) => [{ id: `king-lear-crucible-regional-${y}`, title: 'The King Lear', city: 'sheffield-uk', venue: 'Crucible Theatre, Sheffield' }];
  assert.match(buildAction(row(), undated(2026)).skip, /exists/);
  assert.ok(buildAction(row(), undated(2024)).action);
});
