// LIVE-DATA-LANE: reads data/critic-registry.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-4874: (a) capture junk bylines ("View my Complete", "nick730", "The Recs IT")
// reached the site as critics; (b) undated reviews of an earlier run were never
// carried onto the returning entry. Real functions are required (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { displayCriticName } = require('../../scripts/lib/critic-display-name.js');
const { isJunkCriticName } = require('../../scripts/lib/byline-recovery.js');
const { inheritPriorRunReviews, collectCarriedFiles } = require('../../scripts/lib/prior-run-sibling.js');

test('junk capture strings display as no critic', () => {
  for (const [raw, outlet] of [
    ['View my Complete', 'Partially Obstructed View'],
    ['nick730', 'Partially Obstructed View'],
    ['Sam - Admin', 'All That Dazzles (UK)'],
    ['The Recs IT', 'The Recs'],
    ['The Recs JDH', 'The Recs'],
    ['View more posts', "Khambay's Words Words Words"],
  ]) assert.equal(displayCriticName(raw, outlet), null, raw);
});

test('real bylines are untouched, including The Recs initials that map to a person', () => {
  assert.equal(isJunkCriticName('The Recs IT'), true);
  assert.equal(displayCriticName('Ben Brantley', 'The New York Times'), 'Ben Brantley');
  assert.equal(displayCriticName('Sarah Crompton', 'WhatsOnStage'), 'Sarah Crompton');
  assert.equal(displayCriticName('The Recs RDC - Randall David Cook', 'The Recs'), 'Randall David Cook');
});

const older = { id: 'x-2025', title: 'X', openingDate: '2025-03-01', closingDate: '2025-06-01' };
const newer = { id: 'x-2026', title: 'X', previewsStartDate: '2026-09-01', openingDate: '2026-09-10',
  priorRuns: [{ id: 'x-2025', openingDate: '2025-03-01', closingDate: '2025-06-01' }] };
const rev = (showId, outlet, date) => ({ showId, outletId: outlet, criticName: outlet, publishDate: date, url: `https://${outlet}.com/${showId}` });

test('an undated review of the closed earlier run is carried; a dated one outside the window is not', () => {
  const reviews = [rev('x-2025', 'a', '2025-03-05'), rev('x-2025', 'b', null), rev('x-2025', 'c', '2026-09-20')];
  const { inherited } = inheritPriorRunReviews(reviews, [older, newer]);
  assert.deepEqual(inherited.map(r => r.outletId).sort(), ['a', 'b']);
  const deps = { loadFiles: id => reviews.filter(r => r.showId === id), isCovered: () => true };
  assert.deepEqual(collectCarriedFiles(newer, [older, newer], deps).map(r => r.outletId).sort(), ['a', 'b']);
});

test('undated rows stay put when the earlier entry had not closed before the return began', () => {
  const stillOpen = { ...older, closingDate: '2026-12-01' };
  const ret = { ...newer, priorRuns: [{ id: 'x-2025', openingDate: '2025-03-01', closingDate: '2026-12-01' }] };
  const { inherited } = inheritPriorRunReviews([rev('x-2025', 'b', null)], [stillOpen, ret]);
  assert.equal(inherited.length, 0);
});

test('undated rows stay put when the window is one of several runs the entry declares', () => {
  const multi = { ...newer, priorRuns: [{ id: 'x-2025', openingDate: '2024-01-01', closingDate: '2024-02-01' }] };
  const { inherited } = inheritPriorRunReviews([rev('x-2025', 'b', null)], [older, multi]);
  assert.equal(inherited.length, 0);
});

test('guard paths: no closingDate or no start for the return means undated rows stay put; a dateless window uses the entry own run', () => {
  const noClose = { ...older, closingDate: undefined };
  const retNoClose = { ...newer, priorRuns: [{ id: 'x-2025', openingDate: '2025-03-01' }] };
  assert.equal(inheritPriorRunReviews([rev('x-2025', 'b', null)], [noClose, retNoClose]).inherited.length, 0, 'no closingDate');
  const noStart = { ...newer, previewsStartDate: undefined, openingDate: undefined };
  assert.equal(inheritPriorRunReviews([rev('x-2025', 'b', null)], [older, noStart]).inherited.length, 0, 'no start');
  const winNoOpen = { ...newer, priorRuns: [{ id: 'x-2025', closingDate: '2025-06-01' }] };
  // findPriorRunSiblings fills a dateless window from the entry's own dates, so
  // the window IS the entry's run and the undated row carries.
  assert.equal(inheritPriorRunReviews([rev('x-2025', 'b', null)], [older, winNoOpen]).inherited.length, 1, 'window without openingDate');
});

test('The Recs junk pattern is case-sensitive on the initials', () => {
  assert.equal(isJunkCriticName('The Recs Mark'), false);
  assert.equal(isJunkCriticName('the recs IT'), true);
  assert.equal(isJunkCriticName('The Recs Jdh'), true, 'live row, title-cased initials');
});
