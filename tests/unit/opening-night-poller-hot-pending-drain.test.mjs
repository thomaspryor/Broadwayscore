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

test('poll_one drains the hot show pending stubs before HOT_AFTER is counted', () => {
  const start = wf.indexOf('poll_one() {');
  assert.ok(start > 0, 'poll_one present');
  const body = wf.slice(start, wf.indexOf('LAST_POLL[$SHOW_ID]=$SECONDS', start));
  const drain = body.indexOf('replay-pending-bylines.js --shows="$SHOW_ID"');
  const after = body.indexOf('HOT_AFTER=$(');
  const guard = body.indexOf('if [ -n "$HOT_BEFORE" ]');
  assert.ok(drain > 0, 'per-show drain present');
  assert.ok(guard < drain && drain < after, 'drain runs inside the hot-show branch, before HOT_AFTER');
  assert.match(body.slice(drain - 90, drain), /BD_OPENING_NIGHT=1/);
  assert.match(body.slice(drain, drain + 160), /--skip-empty-body-retry/, 'retry phase must not eat the drain budget');
});
