/**
 * verify-reddit-review-check.test.mjs: the RECHECK-AFTER acceptance command for
 * BRO-5887 ("a Sonnet review check runs before every Reddit draft email"). Like
 * verify-reddit-update-emails.test.mjs it asserts LIVE repo data
 * (data/audit/reddit-post-drafts.json), not a fixture: the claim can only be
 * checked after the daily reddit-engagement-digest run has gone through the new
 * check step on its own schedule. A red run is the claim being disproven (or no
 * draft having come due yet), not a code regression; the logic is unit-tested in
 * scripts/lib/reddit-review-check.test.mjs.
 *
 * The scheduled-run check is skipped before CHECKABLE_FROM (the card's
 * RECHECK-AFTER): land's colocated-tests gate runs every test a branch adds, so
 * a probe that is red by design would refuse its own landing. Top-level
 * scripts/verify-* are not collected into CI; only
 * scripts/autonomous-acceptance-recheck.js runs this, after that date.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRAFTS = path.join(HERE, '..', 'data', 'audit', 'reddit-post-drafts.json');
// The check step reached main at about 04:21 UTC on 2026-10-22.
const LIVE_SINCE = '2026-10-22T04:21:00Z';
// The owner's manual resends ran 04:22-05:05 UTC on the 22nd; the first
// scheduled run after them (run 39734765252, 06:34 UTC) checked two drafts.
// Anything checked after 06:00 UTC that day came from a scheduled run or later.
const SCHEDULED_FROM = '2026-10-22T06:00:00Z';
const CHECKABLE_FROM = Date.parse(SCHEDULED_FROM);

function load() {
  try {
    return Object.values(JSON.parse(fs.readFileSync(DRAFTS, 'utf8')).drafts || {});
  } catch {
    assert.fail(`no readable ${DRAFTS}: the draft job has not run on this tree`);
  }
}

test('every draft emailed since the check went live carries a review-check record', () => {
  const emailed = load().filter(d => d.emailedAt && d.emailedAt >= LIVE_SINCE);
  assert.ok(emailed.length > 0, 'no draft has been emailed since the check went live');
  const bare = emailed.filter(d => !d.verification || !d.verification.status).map(d => d.showId);
  assert.deepEqual(bare, [], 'drafts emailed with no review-check record');
});

test('a scheduled run (not a manual resend) has run the check', { skip: Date.now() < CHECKABLE_FROM && 'not checkable before the RECHECK-AFTER date' }, () => {
  const checked = load().filter(d => d.verification && d.verification.mode === 'apply' && d.verification.checkedAt >= SCHEDULED_FROM);
  assert.ok(checked.length > 0, 'no draft has been checked since scheduled runs resumed: no draft has come due yet, or the step is not running');
});

test('the check is not failing wholesale', () => {
  const recent = load().map(d => d.verification).filter(v => v && v.mode === 'apply' && v.checkedAt >= LIVE_SINCE);
  assert.ok(recent.length > 0, 'no check records yet');
  const failed = recent.filter(v => v.status === 'failed');
  assert.ok(failed.length < recent.length, `every one of ${recent.length} checks failed (${[...new Set(failed.map(v => v.error))].slice(0, 2).join(' | ')})`);
});
