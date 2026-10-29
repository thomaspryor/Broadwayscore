// BRO-6532: the hourly gap audit's gather dispatch goes through the cap, and
// once the cap defers a non-urgent show it stops re-counting for later shows
// in the same run (each count is 3 API calls). Own file: it stubs
// child_process before audit-show-review-gap.js loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const gh = [];
cp.execFileSync = (cmd, args) => { gh.push(args.join(' ')); return Buffer.from('[]'); };
const capMod = require('./workflow-queue-cap.js');
const lane = require('./scoring-lane.js');
const { dispatchGatherFor } = require('../audit-show-review-gap.js');

test('a full cap defers non-urgent shows with one count, and urgent shows still dispatch', async () => {
  let counts = 0;
  capMod.checkCap = ({ priority }) => { counts++; return priority ? { ok: true, reason: 'priority' } : { ok: false, reason: 'full' }; };
  lane.isUrgentShowId = (id) => id === 'opening-tonight';
  assert.equal(await dispatchGatherFor('old-show-a'), false);
  assert.equal(await dispatchGatherFor('old-show-b'), false);
  assert.equal(counts, 1);
  assert.equal(gh.some((a) => a.startsWith('workflow run')), false);
  assert.equal(await dispatchGatherFor('opening-tonight'), true);
  assert.ok(gh.includes('workflow run gather-reviews.yml -f shows=opening-tonight'));
});
