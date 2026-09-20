// TESTS-VS-DERIVED-DATA-EXEMPT: structural check against the shows.json
// entry itself — there is no separate precursor source; the entry IS the
// fact being pinned.
/**
 * Task #1937 / BRO-3888: "brothers paranormal" was searched 2x in 7 days
 * with zero results. Confirmed via Playbill news article + Pan Asian
 * Repertory Theatre's own site + 7 independent critic reviews (New Yorker,
 * BroadwayWorld, TheaterScene.net, Exeunt, Theatre's Leiter Side, Theater
 * That Matters, NYC Splash) that the real production is "The Brothers
 * Paranormal" by Prince Gomolvilas — a 2019 Off-Broadway world premiere at
 * the Beckett Theatre at Theatre Row (Pan Asian Repertory Theatre), not a
 * Broadway show as the zero-results card guessed. No Playbill
 * /production/ page exists for it (validate-show-venue.js confirmed 0 SERP
 * results), so this asserts the manually cross-verified entry landed with
 * the required provenance fields instead of relying on that script's exit
 * code, which is inherently "unresolved" for shows without a Playbill page.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const SHOW_ID = 'the-brothers-paranormal-off-broadway-2019';

function loadShow() {
  const data = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'shows.json'), 'utf8'));
  const list = Array.isArray(data) ? data : (data.shows || []);
  return list.find((s) => s.id === SHOW_ID);
}

test('The Brothers Paranormal has a shows.json entry', () => {
  const show = loadShow();
  assert.ok(show, `${SHOW_ID} must exist in data/shows.json`);
});

test('The Brothers Paranormal entry has the fields CLAUDE.md rule 3 requires for a closed show', () => {
  const show = loadShow();
  assert.equal(show.title, 'The Brothers Paranormal');
  assert.equal(show.slug, 'the-brothers-paranormal-off-broadway');
  assert.equal(show.status, 'closed');
  assert.ok(show.venue, 'closed shows still need a venue on record');
});

test('The Brothers Paranormal is correctly classified as Off-Broadway, not Broadway', () => {
  const show = loadShow();
  assert.equal(show.category, 'off-broadway');
  assert.equal(show.venue, 'The Beckett Theatre at Theatre Row');
});

test('The Brothers Paranormal dates match the cross-verified Playbill/Pan Asian Rep production run', () => {
  const show = loadShow();
  assert.equal(show.previewsStartDate, '2019-04-28');
  assert.equal(show.openingDate, '2019-05-01');
  assert.equal(show.closingDate, '2019-05-19');
});

test('The Brothers Paranormal is flagged provisional with its manual-verification source recorded', () => {
  const show = loadShow();
  assert.equal(show.discoverySource, 'manual-user-request');
  assert.equal(show.provisional, true);
  assert.equal(show.noPlaybillProductionPage, true,
    'no playbill.com/production/ page exists for this show — validate-show-venue.js cannot resolve it, so this field records that the venue/date match was confirmed by hand instead');
  assert.ok(show.statusBackfillSource && show.statusBackfillSource.length > 0,
    'manual entries without a Playbill production page must record how they were cross-verified');
});
