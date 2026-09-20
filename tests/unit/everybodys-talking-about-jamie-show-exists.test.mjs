// TESTS-VS-DERIVED-DATA-EXEMPT: structural check against the shows.json
// entry itself — there is no separate precursor source; the entry IS the
// fact being pinned.
/**
 * Task #1938 / Notion 3d4637c5-416f-810b-b23c-c84ffab9531f: "everybody's
 * talking about jamie" was searched with zero results. The well-known
 * production is the West End musical (Sheffield Crucible 2017 -> Apollo
 * Theatre 2017-2021). Playbill has no /production/ page for that original
 * Apollo run, but it does index the 2024 limited-run revival at the Peacock
 * Theatre (8 Feb - 23 Mar 2024) — confirmed via
 * playbill.com/production/everybodys-talking-about-jamie-london-peacock-theatre-2024
 * and validate-show-venue.js --show (clean match, no mismatch). Added that
 * production rather than the un-indexed 2017 Apollo run so the entry passes
 * real Playbill cross-validation instead of a manual no-Playbill-page
 * exemption (CLAUDE.md rule 3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const SHOW_ID = 'everybodys-talking-about-jamie-west-end-2024';

function loadShow() {
  const data = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'shows.json'), 'utf8'));
  const list = Array.isArray(data) ? data : (data.shows || []);
  return list.find((s) => s.id === SHOW_ID);
}

test("Everybody's Talking About Jamie has a shows.json entry", () => {
  const show = loadShow();
  assert.ok(show, `${SHOW_ID} must exist in data/shows.json`);
});

test("Everybody's Talking About Jamie entry matches the Playbill-confirmed Peacock Theatre revival", () => {
  const show = loadShow();
  assert.equal(show.title, "Everybody's Talking About Jamie");
  assert.equal(show.venue, 'Peacock Theatre');
  assert.equal(show.status, 'closed');
});

test("Everybody's Talking About Jamie is correctly classified as West End / off-West-End", () => {
  const show = loadShow();
  assert.equal(show.market, 'west-end');
  assert.equal(show.category, 'off-west-end');
});

test("Everybody's Talking About Jamie dates match the Playbill production page", () => {
  const show = loadShow();
  assert.equal(show.previewsStartDate, '2024-02-08');
  assert.equal(show.openingDate, '2024-02-08');
  assert.equal(show.closingDate, '2024-03-23');
});

test("Everybody's Talking About Jamie is flagged with its manual-verification source recorded", () => {
  const show = loadShow();
  assert.equal(show.discoverySource, 'manual-user-request');
  assert.equal(show.provisional, true);
});
