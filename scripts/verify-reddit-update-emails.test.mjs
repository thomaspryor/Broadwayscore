/**
 * verify-reddit-update-emails.test.mjs: the RECHECK-AFTER acceptance command
 * for BRO-5879 ("an emailed Reddit draft whose score or review count moved
 * gets a fresh Updated email"). Like verify-provider-spend-streak.test.mjs it
 * asserts LIVE repo data (data/audit/reddit-post-drafts.json), not a fixture:
 * the claim can only be checked after the daily reddit-engagement-digest run
 * has gone through the new draft and email steps. A red run is the claim
 * being disproven, not a code regression (the logic is unit-tested in
 * scripts/lib/reddit-opening-post.test.mjs).
 *
 * RECHECK-GREEN-TODAY: no skip-until date needed (BRO-5937). Both tests passed
 * 2/2 on 2026-10-23 against live data: the daily draft job has already run the
 * BRO-5879 code, so a diff touching this file does not refuse its landing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('./lib/reddit-opening-post.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRAFTS = path.join(HERE, '..', 'data', 'audit', 'reddit-post-drafts.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(DRAFTS, 'utf8'));
  } catch {
    assert.fail(`no readable ${DRAFTS}: the draft job has not run on this tree`);
  }
}

test('the daily draft job has run the BRO-5879 code (posted-detection recorded, a send stamped its numbers)', () => {
  const file = load();
  assert.ok(file._meta && ['ok', 'skipped'].includes(file._meta.postedDetection), 'draft step has not recorded _meta.postedDetection yet: the new drafter has not run');
  const stamped = Object.values(file.drafts || {}).filter(d => Number.isFinite(d.emailedScore) && Number.isFinite(d.emailedReviewCount));
  assert.ok(stamped.length > 0, 'no draft carries emailedScore/emailedReviewCount yet: the new sender has not emailed anything');
});

test('no live emailed draft is sitting on moved numbers with no update sent', () => {
  const file = load();
  const pending = Object.values(file.drafts || {}).filter(d =>
    d.status === 'ready' && d.emailedAt
    && (Date.now() - Date.parse(d.createdAt)) / 86400000 <= lib.DRAFT_TTL_DAYS
    && (d.updateCount || 0) < lib.MAX_UPDATE_EMAILS
    && lib.numbersMoved(d));
  // After a completed run the sender has emailed every moved draft, unless
  // posted-detection was skipped that run (updates are held back then).
  if (file._meta && file._meta.postedDetection === 'skipped') return;
  assert.deepEqual(pending.map(d => d.showId), [], 'emailed drafts whose numbers moved but got no Updated email');
});
