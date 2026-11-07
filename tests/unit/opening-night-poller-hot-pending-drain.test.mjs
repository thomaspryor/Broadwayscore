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
  const before = body.indexOf('HOT_BEFORE=$(');
  const created = body.indexOf('CREATED=$(');
  assert.ok(drain > 0, 'per-show drain present');
  assert.ok(before > 0 && before < drain && drain < created && drain < after, 'HOT_BEFORE read before the poll, drain before the new-file counts and HOT_AFTER');
  assert.equal(body.indexOf('replay-pending-bylines.js', drain + 10), -1, 'one drain only');
  assert.match(body.slice(drain - 90, drain), /BD_OPENING_NIGHT=1/);
  assert.match(body.slice(drain, drain + 160), /--skip-empty-body-retry/, 'retry phase must not eat the drain budget');
});
