// BRO-5266: live-data acceptance, run by check-corpus-drift.js AUDITS.
/**
 * Task #1938 / Notion 3d4637c5-416f-810b-b23c-c84ffab9531f: "everybody's
 * talking about jamie" was searched with zero results. The well-known
 * production is the West End musical (Sheffield Crucible 2017 -> Apollo
 * Theatre 2017-2021). Playbill has no /production/ page for that original
 * Apollo run, but it does index the 2024 limited-run revival at the Peacock
 * Theatre (8 Feb - 23 Mar 2024) - confirmed via
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
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isProvisional } = require('../../../scripts/validate-show-venue.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
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

// BRO-5186: 8 Feb 2024 is the FIRST PREVIEW (londontheatre.co.uk, WhatsOnStage),
// not press night; reviews ran 15-16 Feb. Playbill's page gives only the run
// span. So pin the sourced dates and bound openingDate by them, never an
// exact press night no source states (the date repair now infers it from
// reviews, and a pinned 2024-02-08 turned main red when it did).
const FIRST_REVIEW_DATE = '2024-02-15';

test("Everybody's Talking About Jamie dates match the sourced run (first preview, press night window, closing)", () => {
  const show = loadShow();
  assert.equal(show.previewsStartDate, '2024-02-08');
  assert.equal(show.closingDate, '2024-03-23');
  assert.match(String(show.openingDate), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(show.openingDate >= show.previewsStartDate, `openingDate ${show.openingDate} is before the first preview`);
  assert.ok(show.openingDate <= FIRST_REVIEW_DATE, `openingDate ${show.openingDate} is after the first review (${FIRST_REVIEW_DATE})`);
});

test("Everybody's Talking About Jamie is flagged with its manual-verification source recorded", () => {
  const show = loadShow();
  assert.equal(show.discoverySource, 'manual-user-request');
  // The row started life provisional; the 2026 data audit (S2-T12) verified
  // its venue and dates against Playbill and cleared the flag with a
  // provisionalClearedBy breadcrumb. Either state is the tracked one - what
  // must never happen is a silent clear with no record.
  if (show.provisional !== true) {
    assert.match(String(show.provisionalClearedBy || ''), /Playbill/i,
      'provisional was cleared without a recorded Playbill verification (provisionalClearedBy)');
  }
});

test("Everybody's Talking About Jamie is correctly classified provisional by the canonical predicate (isProvisional)", () => {
  const show = loadShow();
  assert.equal(isProvisional(show), true,
    'isProvisional() in scripts/validate-show-venue.js drives --all-provisional sweeps - the raw provisional:true field alone does not prove this entry is actually picked up by that check');
});
