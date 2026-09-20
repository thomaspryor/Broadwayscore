// TESTS-VS-DERIVED-DATA-EXEMPT: structural check against the shows.json
// entry itself — there is no separate precursor source; the entry IS the
// fact being pinned.
/**
 * Notion card / task #1939: "standing at the sky's edge" was searched 1x in
 * 7 days with zero results. Confirmed via Wikipedia + Playbill + Olivier
 * Awards coverage that the real production is "Standing at the Sky's Edge"
 * (Richard Hawley / Chris Bush), which transferred from Sheffield's Crucible
 * Theatre and the National Theatre to the Gillian Lynne Theatre in the West
 * End (previews 2024-02-09, opened 2024-02-29, closed 2024-08-03). Winner of
 * the 2023 Olivier Award for Best New Musical. validate-show-venue.js
 * resolved a matching Playbill /production/ page for this entry (SERP +
 * Playwright, opening date within the 30-day tolerance), so unlike a
 * no-Playbill-page entry this one needs no isExemptFromPlaybillCheck escape
 * hatch — it is expected to keep passing ordinary --all-provisional sweeps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const SHOW_ID = 'standing-at-the-skys-edge-west-end-2024';

function loadShow() {
  const data = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'shows.json'), 'utf8'));
  const list = Array.isArray(data) ? data : (data.shows || []);
  return list.find((s) => s.id === SHOW_ID);
}

test("Standing at the Sky's Edge has a shows.json entry", () => {
  const show = loadShow();
  assert.ok(show, `${SHOW_ID} must exist in data/shows.json`);
});

test("Standing at the Sky's Edge entry has the fields CLAUDE.md rule 3 requires for a closed show", () => {
  const show = loadShow();
  assert.equal(show.title, "Standing at the Sky's Edge");
  assert.equal(show.slug, 'standing-at-the-skys-edge-west-end');
  assert.equal(show.status, 'closed');
  assert.ok(show.venue, 'closed shows still need a venue on record');
});

test("Standing at the Sky's Edge is correctly classified as West End, not Broadway", () => {
  const show = loadShow();
  assert.equal(show.category, 'west-end');
  assert.equal(show.market, 'west-end');
  assert.equal(show.venue, 'Gillian Lynne Theatre');
});

test("Standing at the Sky's Edge dates match the Playbill-cross-validated West End transfer run", () => {
  const show = loadShow();
  assert.equal(show.previewsStartDate, '2024-02-09');
  assert.equal(show.openingDate, '2024-02-29');
  assert.equal(show.closingDate, '2024-08-03');
});

test("Standing at the Sky's Edge is flagged provisional with its manual-verification source recorded", () => {
  const show = loadShow();
  assert.equal(show.discoverySource, 'manual-user-request');
  assert.equal(show.provisional, true);
});
