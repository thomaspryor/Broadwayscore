// BRO-5384 live acceptance (RECHECK-AFTER probe; not in the unit batches, see
// scripts/lib/unit-test-collection.js): since the parallel Codex slots landed, the runner's
// summaries on BRO-4745 (newest 50, listIssueComments) show >= 4 cards worked per firing and
// >= 40% of worked cards landed. Before: 24 cards in ~11 firings, 5 landed (2026-10-13/15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('./lib/load-env').loadEnv();
const linear = require('./lib/linear-client.js');
const { firingThroughput } = require('./lib/codex-runner.js');

// Window starts after the disk-full fix (eb488bc02, 2026-10-16 13:58 UTC). The 10-15..10-16
// morning firings stopped early on a full disk; the first read over them (16 firings, 4.7
// cards/firing, 21% landed, 33 of 75 cards rejected by the check, 20 out of time) is not the lane's
// steady state.
const SINCE = process.env.CODEX_THROUGHPUT_SINCE || '2026-10-16T14:00:00Z';
// = the card's RECHECK-AFTER: 48h of firings first. Land's colocated-tests gate runs every
// changed test file, so the probe skips until then (verify-codex-runner-health.test.mjs pattern).
const CHECKABLE_FROM = Date.parse('2026-10-18T14:00:00Z');

test('Codex runner: >= 4 cards per firing and >= 40% landed since the parallel slots (BRO-5384)', {
  skip: Date.now() < CHECKABLE_FROM && !process.env.CODEX_THROUGHPUT_SINCE ? 'not checkable before 2026-10-18 14:00 UTC (48h of firings after the disk fix)' : false,
}, async () => {
  const comments = ((await linear.listIssueComments(['BRO-4745'])).get('BRO-4745') || []).filter((c) => c.createdAt >= SINCE);
  const t = firingThroughput(comments);
  // Newest 50 comments only (~36 runner summaries a day): run it the day after, not weeks later.
  const facts = `${t.firings} firing(s), ${t.worked} worked, ${t.landed} landed (${t.perFiring.toFixed(1)}/firing, ${Math.round(t.landedShare * 100)}% landed; newest 50 comments)`;
  assert.ok(t.firings >= 3, `too few firings to judge: ${facts}`);
  assert.ok(t.perFiring >= 4, `under 4 cards per firing: ${facts}`);
  assert.ok(t.landedShare >= 0.4, `under 40% landed: ${facts}`);
});
