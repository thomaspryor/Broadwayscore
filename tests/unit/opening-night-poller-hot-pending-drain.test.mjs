/**
 * BRO-7004: Parcel from America's TheaterMania review was found at 02:12Z but had no byline, so it
 * was routed to _pending/ and only drained by the NEXT poller run (~60 min later): first-live missed
 * the 30 min bar. poll_one must drain a press-night show's pending stubs right after polling it and
 * before counting new files, so the promotion counts as a hot find and ends the loop early.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const wf = fs.readFileSync(new URL('../../.github/workflows/opening-night-poller.yml', import.meta.url), 'utf8');

test('poll_one drains pending stubs before any file count, for hot shows or any show with new stubs', () => {
  const start = wf.indexOf('poll_one() {');
  assert.ok(start > 0, 'poll_one present');
  const body = wf.slice(start, wf.indexOf('LAST_POLL[$SHOW_ID]=$SECONDS', start));
  const drain = body.indexOf('replay-pending-bylines.js --shows="$SHOW_ID"');
  assert.ok(drain > 0, 'per-show drain present');
  assert.equal(body.split('replay-pending-bylines.js --shows="$SHOW_ID"').length, 2, 'exactly one in-loop drain');
  // BRO-7033: the drain must not live inside the hot-only branch (Off-Broadway shows are never hot).
  const hotBranch = body.indexOf('if [ -n "$HOT_BEFORE" ]; then\n              local HOT_AFTER');
  assert.ok(hotBranch > drain, 'drain is outside and before the hot-only HOT_AFTER branch');
  const guard = body.slice(body.lastIndexOf('if [', drain), drain);
  assert.match(guard, /HOT_BEFORE/);
  assert.match(guard, /PENDING_AFTER" -gt "\$PENDING_BEFORE/, 'drain is keyed off new pending stubs');
  // counted in _pending/<show>/ (where stubs live), before the poller runs, with untracked files expanded
  const before = body.indexOf('PENDING_BEFORE=$(');
  assert.ok(before > 0 && before < body.indexOf('node scripts/opening-night-poller.js'), 'pending count taken before the poll');
  assert.match(body.slice(before, before + 220), /--untracked-files=all -- "_pending\/\$SHOW_ID"/);
  assert.ok(drain < body.indexOf('CREATED=$('), 'drain precedes the new-file count');
  assert.ok(drain < body.indexOf('UNSCORED=$('), 'drain precedes the unscored count');
  assert.match(body.slice(drain - 90, drain), /BD_OPENING_NIGHT=1/);
  assert.match(body.slice(drain, drain + 160), /--skip-empty-body-retry/, 'retry phase must not eat the drain budget');
});
