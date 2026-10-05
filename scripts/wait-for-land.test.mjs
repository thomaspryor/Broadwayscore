// BRO-4671: the land waiter must report a refused land run, not just the ref
// disappearing. Each case below is a poll result seen during real landings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { landVerdict, parseArgs } = require('./wait-for-land.js');

const TIP = '057156419a666b690b937354092729af67ceb092';
const run = (over) => ({ id: 1, head_sha: TIP, status: 'completed', conclusion: 'success', ...over });

test('ref gone after being seen means landed, whatever the last run says', () => {
  assert.equal(landVerdict({ refSha: null, run: run({ status: 'in_progress', conclusion: null }) }).verdict, 'landed');
  assert.equal(landVerdict({ refSha: null, run: null }).verdict, 'landed');
});

test('a ref missing from the start with no land run is a typo, never "landed"', () => {
  assert.equal(landVerdict({ refSha: null, run: null, seenRef: false }).verdict, 'unknown');
  assert.equal(landVerdict({ refSha: null, run: run(), seenRef: false }).verdict, 'landed', 'landed before the wait began');
});

test('a red run for the current tip is a refusal (the case the ref-only loop missed for ~1h)', () => {
  for (const conclusion of ['failure', 'timed_out', 'startup_failure', 'action_required']) {
    const v = landVerdict({ refSha: TIP, run: run({ conclusion }) });
    assert.equal(v.verdict, 'refused', conclusion);
    assert.match(v.why, new RegExp(conclusion));
  }
});

test('a cancelled run is an eviction: keep waiting and name the retry', () => {
  const v = landVerdict({ refSha: TIP, run: run({ id: 37260205885, conclusion: 'cancelled' }) });
  assert.equal(v.verdict, 'waiting');
  assert.match(v.why, /land-retry-cancelled\.js --run=37260205885/);
});

test('a red run for an OLDER tip says nothing about a fresh push', () => {
  const v = landVerdict({ refSha: TIP, run: run({ head_sha: 'f'.repeat(40), conclusion: 'failure' }) });
  assert.equal(v.verdict, 'waiting');
});

test('queued, in-progress, missing and green-but-ref-still-there all keep waiting', () => {
  assert.equal(landVerdict({ refSha: TIP, run: run({ status: 'queued', conclusion: null }) }).verdict, 'waiting');
  assert.equal(landVerdict({ refSha: TIP, run: run({ status: 'in_progress', conclusion: null }) }).verdict, 'waiting');
  assert.equal(landVerdict({ refSha: TIP, run: null }).verdict, 'waiting');
  assert.equal(landVerdict({ refSha: TIP, run: run({ conclusion: 'success' }) }).verdict, 'waiting');
});

test('parseArgs takes a land/ ref and a positive whole-minute timeout', () => {
  assert.deepEqual(parseArgs(['land/bro-4619-welcome-onboarding']), { ref: 'land/bro-4619-welcome-onboarding', timeoutMin: 60 });
  assert.deepEqual(parseArgs(['land/job/linear-BRO-2067-muuqf9tn', '30']), { ref: 'land/job/linear-BRO-2067-muuqf9tn', timeoutMin: 30 });
  assert.equal(parseArgs([]), null);
  assert.equal(parseArgs(['bro-4619-welcome-onboarding']), null, 'bare branch name, the same mistake that broke a land.yml dispatch');
  assert.equal(parseArgs(['land/x', '0']), null);
  assert.equal(parseArgs(['land/x', '08']), null);
  assert.equal(parseArgs(['land/x;rm -rf /']), null);
});
